import { state, App, UI, Keyboard, $ } from './state.js';
import { applyCam, centerOn, zoomBy, setZoom, worldToScreen } from './camera.js';
import { clamp } from './utils.js';
import { renderAllEdges, highlightSelected, updateStatus, showToast, setMode } from './render.js';
import { snapshot, restoreSnapshot } from './history.js';
import { createNodeEl, selectNode, addNode, deleteNode, startEditNode } from './nodes.js';
import { addEdge, focusEdgeLabelField } from './edges.js';
import { kickPhysics } from './physics.js';
import { serialize, deserialize, syncPhysicsUI, scheduleAutoSave, rememberedDrift, rememberDrift } from './persist.js';
import { setFrameHooks, tweenNode, markLayoutDirty, animateCamera, isAnimating } from './frame.js';
import { getTree, computeTidyLayout, subtreeIds, childSlot } from './layout.js';

// Size of a fresh, empty node (before its label is typed).
const NEW_W = 100, NEW_H = 37;
import { nodeSize, setResizeHandler } from './sizes.js';

// Import ui.js and input.js to trigger their side-effects (event listeners, DOM init)
import './ui.js';
import './input.js';
// Import export.js to attach App.export* methods
import './export.js';
import './markdown.js';
import './share.js';

const physicsBtnEl = $('physics-btn');
const ctxMenu = $('ctx-menu');
const findModal = $('find-modal');

// ─── App.undo / App.redo ──────────────────────────────────────────────────────
App.undo = function() {
  if (state.mode === 'editing') document.activeElement?.blur();
  if (state.historyIndex <= 0) return;
  state.historyIndex--;
  state.historyPaused = true;
  restoreSnapshot(state.history[state.historyIndex]);
  state.historyPaused = false;
  showToast('Undo');
};

App.redo = function() {
  if (state.historyIndex >= state.history.length - 1) return;
  state.historyIndex++;
  state.historyPaused = true;
  restoreSnapshot(state.history[state.historyIndex]);
  state.historyPaused = false;
  showToast('Redo');
};

// ─── Tidy layout runner ───────────────────────────────────────────────────────
// Runs at most once per frame (markLayoutDirty), after any add, delete, move,
// fold or label change. With Drift off every node's logical position becomes
// its tidy-tree slot and the node springs there (frame.js); a node already
// moving keeps its speed, so quick edits flow into each other.
let revealedId = null;
function runLayout() {
  if (state.physics.enabled) { renderAllEdges(); return; }
  const targets = computeTidyLayout();
  for (const [id, t] of targets) {
    const n = state.nodes.get(id);
    if (!n || n.dragging) continue;
    if (Math.abs(n.x - t.x) > 0.01 || Math.abs(n.y - t.y) > 0.01 ||
        Math.abs((n.rx ?? n.x) - t.x) > 0.5 || Math.abs((n.ry ?? n.y) - t.y) > 0.5) {
      n.x = t.x; n.y = t.y; n.vx = 0; n.vy = 0;
      tweenNode(n);
    }
  }
  renderAllEdges();
  revealEditingNode();
}

// A freshly created node that will land off-screen pulls the camera along.
function revealEditingNode() {
  if (state.mode !== 'editing') return;
  const n = state.nodes.get(state.selectedNodeId);
  if (!n || revealedId === n.id) return;
  revealedId = n.id;
  const { w, h } = nodeSize(n);
  const z = state.camera.zoom, m = 70;
  const p = worldToScreen(n.x, n.y);
  const W = window.innerWidth, H = window.innerHeight;
  let dx = 0, dy = 0;
  if (p.x - w * z / 2 < m + 110) dx = (m + 110) - (p.x - w * z / 2);       // toolbar on the left
  else if (p.x + w * z / 2 > W - m) dx = (W - m) - (p.x + w * z / 2);
  if (p.y - h * z / 2 < m) dy = m - (p.y - h * z / 2);
  else if (p.y + h * z / 2 > H - m) dy = (H - m) - (p.y + h * z / 2);
  if (dx || dy) animateCamera({ x: state.camera.x + dx, y: state.camera.y + dy, zoom: z }, 300);
}

setFrameHooks({
  layout: runLayout,
  renderEdges: renderAllEdges,
  applyCam: () => { applyCam(); updateStatus(); },
});
// A node that changes size (label typed, wrapped) re-tidies its neighbours.
setResizeHandler(() => { if (!state.physics.enabled) markLayoutDirty(); else renderAllEdges(); });

App.autoArrange = function() {
  if (state.nodes.size === 0) return;
  if (state.physics.enabled) App.togglePhysics();   // Arrange means a tidy map: stop the drift
  snapshot();
  // Clear manual edge curves so they re-flow
  for (const e of state.edges.values()) e.cp = null;
  const targets = computeTidyLayout();
  for (const [id, t] of targets) {
    const n = state.nodes.get(id);
    if (!n) continue;
    n.x = t.x; n.y = t.y; n.vx = 0; n.vy = 0;
    tweenNode(n, 420);
  }
  renderAllEdges();
  App.fitMap();
  snapshot();
  showToast('Arranged');
};

App.fitMap = function(opts = {}) {
  if (state.nodes.size === 0) return;
  const hidden = getTree().hidden;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of state.nodes.values()) {
    if (hidden.has(n.id)) continue;
    const { w, h } = nodeSize(n);
    minX = Math.min(minX, n.x - w/2); minY = Math.min(minY, n.y - h/2);
    maxX = Math.max(maxX, n.x + w/2); maxY = Math.max(maxY, n.y + h/2);
  }
  if (minX === Infinity) return;
  const pad = 70;
  const tb = document.getElementById('toolbar');
  const left = tb ? tb.getBoundingClientRect().right + 10 : 0;   // keep clear of the toolbar
  const bw = maxX - minX, bh = maxY - minY;
  const W = window.innerWidth - left, H = window.innerHeight;
  const zoom = clamp(Math.min((W - pad*2) / (bw||1), (H - pad*2) / (bh||1)), 0.1, 2);
  const to = { zoom, x: left + (W - bw * zoom) / 2 - minX * zoom, y: (H - bh * zoom) / 2 - minY * zoom };
  if (opts.animate === false) { Object.assign(state.camera, to); applyCam(); }
  else animateCamera(to, 420);
  updateStatus();
};

// Drift = the old force physics. Off by default: tidy layout, nothing moves by itself.
App.togglePhysics = function() {
  state.physics.enabled = !state.physics.enabled;
  rememberDrift(state.physics.enabled);
  physicsBtnEl.classList.toggle('active', state.physics.enabled);
  if (state.physics.enabled) {
    kickPhysics();
  } else {
    if (state.physicsRaf) { cancelAnimationFrame(state.physicsRaf); state.physicsRaf = null; }
    state.physicsRunning = false;
    for (const n of state.nodes.values()) { n.vx = 0; n.vy = 0; }
    markLayoutDirty();
  }
  scheduleAutoSave();
  showToast(state.physics.enabled ? 'Drift on: nodes float freely' : 'Drift off: tidy layout');
};

// Menu bar zoom: a factor, or 0 for actual size.
App.zoom = function(factor) { if (factor) zoomBy(factor); else setZoom(1); };

App.updatePhysics = function(key, val) {
  state.physics[key] = val;
  $('val-' + key).textContent = val;
  kickPhysics();
};

// ─── Keyboard methods ─────────────────────────────────────────────────────────
Keyboard.createRoot = function() {
  snapshot();
  const n = addNode('');          // centre of the view
  selectNode(n.id);
  kickPhysics();
  startEditNode(n.id);
  snapshot();
};

Keyboard.createChild = function() {
  const parent = state.nodes.get(state.selectedNodeId);
  if (!parent) return;
  snapshot();
  if (parent.collapsed) { delete parent.collapsed; }
  // Drift off: the child grows out of its parent and glides to a free slot
  // beside it. Nothing else moves.
  let child;
  if (state.physics.enabled) child = addNode('', parent.x + 200, parent.y + 80);
  else {
    const slot = childSlot(parent.id, NEW_W, NEW_H);
    child = addNode('', slot.x, slot.y, { spawnX: parent.rx ?? parent.x, spawnY: parent.ry ?? parent.y });
    tweenNode(child);
  }
  addEdge(parent.id, child.id);
  selectNode(child.id);
  renderAllEdges();
  kickPhysics();
  startEditNode(child.id);
  snapshot();
};

Keyboard.createSibling = function() {
  const sel = state.nodes.get(state.selectedNodeId);
  if (!sel) return;
  snapshot();
  const tree = getTree();
  const parentId = tree.parent.get(sel.id);
  let sibling;
  if (parentId) {
    // Same tree parent, inserted right after the selected node (Arrange keeps
    // that order); on screen it lands in the free slot below the siblings.
    if (state.physics.enabled) sibling = addNode('', sel.x + 40, sel.y + 120);
    else {
      const slot = childSlot(parentId, NEW_W, NEW_H, new Set(), tree);
      sibling = addNode('', slot.x, slot.y, { spawnX: sel.rx ?? sel.x, spawnY: (sel.ry ?? sel.y) + 10 });
      tweenNode(sibling);
    }
    const e = addEdge(parentId, sibling.id);
    moveEdgeAfter(e.id, tree.parentEdge.get(sel.id));
  } else {
    // A root: start a new free-standing topic below its whole tree.
    let maxY = sel.y;
    for (const id of subtreeIds(sel.id, tree)) {
      const n = state.nodes.get(id);
      maxY = Math.max(maxY, n.y + nodeSize(n).h / 2);
    }
    sibling = addNode('', sel.x, maxY + 90);
  }
  selectNode(sibling.id);
  renderAllEdges();
  kickPhysics();
  startEditNode(sibling.id);
  snapshot();
};

// Keep sibling order: put edge `id` right after edge `afterId` in the Map.
function moveEdgeAfter(id, afterId) {
  if (!afterId || !state.edges.has(id) || !state.edges.has(afterId)) return;
  const entries = [...state.edges.entries()].filter(([k]) => k !== id);
  const at = entries.findIndex(([k]) => k === afterId);
  entries.splice(at + 1, 0, [id, state.edges.get(id)]);
  state.edges.clear();
  for (const [k, v] of entries) state.edges.set(k, v);
}

Keyboard.deleteSelected = function() {
  if (state.selectedNodeIds.size > 0) {
    snapshot();
    for (const id of state.selectedNodeIds) deleteNode(id);
    state.selectedNodeIds.clear();
    snapshot();
    return;
  }
  if (state.selectedEdgeId) {
    snapshot();
    const edge = state.edges.get(state.selectedEdgeId);
    const fallbackId = edge?.source;
    state.edges.delete(state.selectedEdgeId);
    state.selectedEdgeId = null;
    UI.closeEdgePanel();
    renderAllEdges();
    if (fallbackId && state.nodes.has(fallbackId)) selectNode(fallbackId);
    updateStatus();
    snapshot();
    return;
  }
  if (state.selectedNodeId) {
    snapshot();
    deleteNode(state.selectedNodeId);
    snapshot();
  }
};

Keyboard.moveSelection = function(dir) {
  let ox, oy;
  const selNode = state.nodes.get(state.selectedNodeId);
  const selEdge = state.edges.get(state.selectedEdgeId);
  const hidden = getTree().hidden;
  if (selNode) { ox = selNode.x; oy = selNode.y; }
  else if (selEdge) {
    const s = state.nodes.get(selEdge.source), t = state.nodes.get(selEdge.target);
    if (!s || !t) return;
    ox = (s.x + t.x) / 2; oy = (s.y + t.y) / 2;
  } else { return; }

  const angle = { ArrowRight: 0, ArrowDown: 90, ArrowLeft: 180, ArrowUp: 270 }[dir];
  const rad = angle * Math.PI / 180;

  const candidates = [
    ...[...state.nodes.values()]
      .filter(n => n.id !== state.selectedNodeId && !hidden.has(n.id))
      .map(n => ({ type: 'node', id: n.id, x: n.x, y: n.y })),
    ...[...state.edges.values()]
      .filter(e => e.id !== state.selectedEdgeId && !hidden.has(e.source) && !hidden.has(e.target))
      .map(e => {
        const s = state.nodes.get(e.source), t = state.nodes.get(e.target);
        if (!s || !t) return null;
        return { type: 'edge', id: e.id, x: (s.x + t.x) / 2, y: (s.y + t.y) / 2 };
      })
      .filter(Boolean),
  ];
  if (!candidates.length) return;

  function inCone(c, half) {
    const dx = c.x - ox, dy = c.y - oy;
    let a = Math.atan2(dy, dx) - rad;
    while (a > Math.PI) a -= 2*Math.PI;
    while (a < -Math.PI) a += 2*Math.PI;
    return Math.abs(a) <= half;
  }

  let found = candidates.filter(c => inCone(c, Math.PI/4));
  if (!found.length) found = candidates.filter(c => inCone(c, Math.PI/2));
  if (!found.length) return;

  found.sort((a, b) => Math.hypot(a.x - ox, a.y - oy) - Math.hypot(b.x - ox, b.y - oy));
  const best = found[0];
  if (best.type === 'node') {
    state.selectedEdgeId = null;
    UI.closeEdgePanel();
    selectNode(best.id);
  } else {
    state.selectedNodeId = null;
    state.selectedEdgeId = best.id;
    highlightSelected();
    renderAllEdges();
    UI.openEdgePanel(best.id);
    updateStatus();
  }
};

Keyboard.startEdgeMode = function() {
  if (!state.selectedNodeId) return;
  state.edgeSourceId = state.selectedNodeId;
  state.edgeCandidateId = null;
  setMode('edge', 'EDGE MODE — Arrows/click to pick target · Enter to confirm · Esc to cancel');
  highlightSelected();
};

Keyboard.confirmEdge = function() {
  const src = state.edgeSourceId;
  const tgt = state.edgeCandidateId || state.selectedNodeId;
  if (!src || !tgt || src === tgt) { cancelEdge(); return; }
  snapshot();
  const edge = addEdge(src, tgt);
  state.edgeSourceId = null;
  state.edgeCandidateId = null;
  setMode('normal');
  highlightSelected();
  renderAllEdges();
  state.selectedEdgeId = edge.id;
  UI.openEdgePanel(edge.id);
  focusEdgeLabelField();
  snapshot();
};

function cancelEdge() {
  state.edgeSourceId = null;
  state.edgeCandidateId = null;
  setMode('normal');
  highlightSelected();
}

let clipboard = null;
Keyboard.copy = function() {
  const nodeIds = state.selectedNodeIds.size > 0
    ? state.selectedNodeIds
    : state.selectedNodeId ? new Set([state.selectedNodeId]) : new Set();
  if (nodeIds.size === 0) return;
  const nodes = [...nodeIds].map(id => {
    const n = state.nodes.get(id);
    if (!n) return null;
    return { id: n.id, label: n.label, icon: n.icon, color: n.color, shape: n.shape,
             fontSize: n.fontSize, fontWeight: n.fontWeight, fontStyle: n.fontStyle,
             x: n.x, y: n.y };
  }).filter(Boolean);
  const edges = [...state.edges.values()]
    .filter(e => nodeIds.has(e.source) && nodeIds.has(e.target))
    .map(e => ({ source: e.source, target: e.target, label: e.label,
                 color: e.color, thickness: e.thickness, dash: e.dash }));
  clipboard = { nodes, edges };
};

Keyboard.cut = function() { Keyboard.copy(); Keyboard.deleteSelected(); };

Keyboard.paste = function() {
  if (!clipboard) return;
  snapshot();
  const idMap = new Map();
  const minX = Math.min(...clipboard.nodes.map(n => n.x));
  const minY = Math.min(...clipboard.nodes.map(n => n.y));
  const sel = state.nodes.get(state.selectedNodeId);
  const baseX = sel ? sel.x + 40 : (clipboard.nodes[0]?.x ?? 0) + 40;
  const baseY = sel ? sel.y + 40 : (clipboard.nodes[0]?.y ?? 0) + 40;
  clipboard.nodes.forEach(cn => {
    const n = addNode(cn.label, baseX + (cn.x - minX), baseY + (cn.y - minY), cn);
    idMap.set(cn.id, n.id);
  });
  clipboard.edges.forEach(ce => {
    const srcId = idMap.get(ce.source), tgtId = idMap.get(ce.target);
    if (srcId && tgtId) {
      const edge = addEdge(srcId, tgtId, ce.label);
      edge.color = ce.color; edge.thickness = ce.thickness; edge.dash = ce.dash;
    }
  });
  const firstNew = idMap.values().next().value;
  if (firstNew) {
    if (idMap.size > 1) {
      state.selectedNodeId = null;
      state.selectedNodeIds = new Set(idMap.values());
      state.selectedEdgeId = null;
      highlightSelected();
      updateStatus();
    } else {
      selectNode(firstNew);
    }
  }
  renderAllEdges();
  kickPhysics();
  snapshot();
};

Keyboard.selectHub = function() {
  if (state.nodes.size === 0) return;
  let best = null, bestCount = -1;
  for (const n of state.nodes.values()) {
    const count = [...state.edges.values()].filter(e => e.source === n.id || e.target === n.id).length;
    if (count > bestCount) { bestCount = count; best = n; }
  }
  if (!best) best = [...state.nodes.values()][0];
  selectNode(best.id, { center: true });
};

Keyboard.duplicate = function() {
  if (state.selectedNodeIds.size > 1) {
    snapshot();
    const idMap = new Map();
    for (const nid of state.selectedNodeIds) {
      const n = state.nodes.get(nid);
      if (!n) continue;
      const copy = addNode(n.label, n.x + 40, n.y + 40, n);
      idMap.set(nid, copy.id);
    }
    for (const edge of state.edges.values()) {
      const srcNew = idMap.get(edge.source), tgtNew = idMap.get(edge.target);
      if (srcNew && tgtNew) {
        const e = addEdge(srcNew, tgtNew, edge.label);
        e.color = edge.color; e.thickness = edge.thickness; e.dash = edge.dash;
      }
    }
    state.selectedNodeIds = new Set(idMap.values());
    state.selectedNodeId = null;
    renderAllEdges(); highlightSelected(); kickPhysics();
    snapshot();
    return;
  }
  const n = state.nodes.get(state.selectedNodeId);
  if (!n) return;
  snapshot();
  const copy = addNode(n.label, n.x + 40, n.y + 40, n);
  selectNode(copy.id);
  kickPhysics();
  snapshot();
};

// ─── Fold / unfold a branch ───────────────────────────────────────────────────
App.toggleFold = function(id) {
  id = id || state.selectedNodeId;
  const n = state.nodes.get(id);
  if (!n) return;
  const kids = getTree().children.get(id) || [];
  if (!kids.length) { if (n.collapsed) delete n.collapsed; showToast('No branch to fold'); return; }
  snapshot();
  if (n.collapsed) delete n.collapsed; else n.collapsed = true;
  renderAllEdges();
  kickPhysics();
  snapshot();
};

// ─── Keyboard event listeners ─────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  const tag = document.activeElement?.tagName;
  const inInput = tag === 'INPUT' || tag === 'TEXTAREA';

  if (e.ctrlKey || e.metaKey) {
    if (e.key === 'z' && !e.shiftKey) { e.preventDefault(); App.undo(); return; }
    if ((e.key === 'z' && e.shiftKey) || e.key === 'y') { e.preventDefault(); App.redo(); return; }
    if (e.key === 's') { e.preventDefault(); App.saveFile(); return; }
    if (e.key === 'o') { e.preventDefault(); App.openFile(); return; }
    if (e.key === '0') { e.preventDefault(); setZoom(1); return; }
    if (e.key === '.') { e.preventDefault(); App.toggleFold(); return; }
    if (e.key === '=') { e.preventDefault(); zoomBy(1.15); return; }
    if (e.key === '-') { e.preventDefault(); zoomBy(0.87); return; }
    if (e.key === 'f') { e.preventDefault(); UI.openFind(); return; }
    if (!inInput) {
      if (e.key === 'd') { e.preventDefault(); Keyboard.duplicate(); return; }
      if (e.key === 'c') { e.preventDefault(); Keyboard.copy(); return; }
      if (e.key === 'x') { e.preventDefault(); Keyboard.cut(); return; }
      if (e.key === 'v') { e.preventDefault(); Keyboard.paste(); return; }
      if (e.key === 'a') { e.preventDefault(); Keyboard.selectHub(); return; }
    }
  }

  if (inInput) return;
  if (findModal.classList.contains('visible')) return;

  if (state.mode === 'edge') {
    if (e.key === 'Escape') { e.preventDefault(); cancelEdge(); return; }
    if (e.key === 'Enter') { e.preventDefault(); Keyboard.confirmEdge(); return; }
    if (e.key.startsWith('Arrow')) { e.preventDefault(); Keyboard.moveSelection(e.key); return; }
    return;
  }

  if (state.mode === 'editing') return;

  if (e.key === 'Enter' && e.shiftKey) {
    e.preventDefault();
    Keyboard.createRoot();
    return;
  }

  switch (e.key) {
    case 'Tab':     e.preventDefault(); Keyboard.createChild(); break;
    case 'Enter':
      e.preventDefault();
      if (state.selectedNodeId) Keyboard.createSibling();
      else if (state.selectedEdgeId) focusEdgeLabelField();
      break;
    case 'F2':
    case ' ':
      e.preventDefault();
      if (state.selectedNodeId) startEditNode(state.selectedNodeId);
      else if (state.selectedEdgeId) focusEdgeLabelField();
      break;
    case 'Escape':
      document.getElementById('help-overlay')?.classList.remove('visible');
      ctxMenu.classList.remove('visible');
      if (state.selectedEdgeId) {
        UI.closeEdgePanel();
        state.selectedEdgeId = null;
        renderAllEdges();
        highlightSelected();
      }
      break;
    case 'Delete':
    case 'Backspace': e.preventDefault(); Keyboard.deleteSelected(); break;
    case 'ArrowRight':
    case 'ArrowLeft':
    case 'ArrowUp':
    case 'ArrowDown': e.preventDefault(); Keyboard.moveSelection(e.key); break;
    case 'Home': e.preventDefault(); if (state.selectedNodeId) centerOn(state.nodes.get(state.selectedNodeId)); break;
    case '.': e.preventDefault(); App.toggleFold(); break;
    case 'b': case 'B':
      if (state.selectedEdgeId) App.toggleEdgeBidir();
      break;
    case 'e': case 'E': Keyboard.startEdgeMode(); break;
    case 'p': case 'P': App.togglePhysics(); break;
    case 'f': case 'F': App.fitMap(); break;
    case 'g': case 'G': { const cb = $('cb-gridsnap'); cb.checked = !cb.checked; App.toggleGridSnap(cb.checked); break; }
    case 'm': case 'M': App.toggleMinimap(); break;
    default:
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && e.key !== '?' && state.selectedNodeId) {
        e.preventDefault();
        startEditNode(state.selectedNodeId, e.key);
      }
      break;
  }
});

document.addEventListener('keydown', e => {
  if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.repeat) {
    const tag = document.activeElement?.tagName;
    if (tag !== 'INPUT' && tag !== 'TEXTAREA') {
      e.preventDefault();
      document.getElementById('help-overlay')?.classList.toggle('visible');
    }
  }
});

// ─── Init ─────────────────────────────────────────────────────────────────────
function init() {
  state.physics.enabled = rememberedDrift();
  state.camera.x = window.innerWidth / 2;
  state.camera.y = window.innerHeight / 2;
  applyCam();

  // Published view-only page: show the built-in map and nothing else.
  if (window.ORBIS_VIEW) {
    deserialize({ ...window.ORBIS_VIEW.map, physics: { ...window.ORBIS_VIEW.map.physics, drift: false } });
    state.selectedNodeId = null;
    highlightSelected();
    const badge = document.createElement('div');
    badge.id = 'view-badge';
    badge.textContent = window.ORBIS_VIEW.title || 'Concept map';
    const hint = document.createElement('small');
    hint.textContent = 'view only · drag to move · scroll or pinch to zoom';
    badge.appendChild(hint);
    document.body.appendChild(badge);
    requestAnimationFrame(() => App.fitMap({ animate: false }));
    return;
  }

  try {
    const saved = localStorage.getItem('orbis-autosave');
    if (saved) {
      deserialize(JSON.parse(saved));
      const ts = localStorage.getItem('orbis-autosave-ts');
      const ago = ts ? Math.round((Date.now() - +ts) / 60000) : null;
      physicsBtnEl.classList.toggle('active', state.physics.enabled);
      snapshot();
      import('./render.js').then(m => m.updateMinimap());
      showToast('Restored autosave' + (ago !== null ? ' (' + ago + 'm ago)' : ''), 3000);
      setTimeout(() => showToast('Tab=child · Enter=sibling · E=connect · F=fit · P=drift', 4000), 600);
      return;
    }
  } catch {}

  const n = addNode('Main Concept', 0, 0);
  selectNode(n.id);
  physicsBtnEl.classList.toggle('active', state.physics.enabled);
  snapshot();
  updateStatus();
  import('./render.js').then(m => m.updateMinimap());
  setTimeout(() => showToast('Tab=child · Enter=sibling · E=connect · F=fit · P=drift', 4000), 600);
}

init();

// Expose internals for automated testing and HTML onclick handlers
window.state = state;
window.App = App;
window.UI = UI;
window.serialize = serialize;
window.deserialize = deserialize;
window.orbisIsAnimating = isAnimating;   // tests wait for glides to settle
