import { state, UI, $ } from './state.js';
import { applyCam, worldToScreen, screenToWorld, zoomBy } from './camera.js';
import { placeNode, stopNodeTween, tweenNode, markEdgesDirty, markLayoutDirty, easeCameraTo, getCameraTarget, startInertia, stopCameraMotion } from './frame.js';
import { getTree, subtreeIds, childSlot } from './layout.js';
import { nodeSize } from './sizes.js';
import { showToast } from './render.js';
import { renderAllEdges, highlightSelected, updateStatus, setMode } from './render.js';
import { snapshot } from './history.js';
import { selectNode, startEditNode, addNode } from './nodes.js';
import { addEdge, focusEdgeLabelField } from './edges.js';
import { kickPhysics } from './physics.js';
import { showCtxMenu } from './ui.js';
import { snapToGrid } from './persist.js';

const ctxMenu = $('ctx-menu');
const edgePanel = $('edge-panel');
const findModal = $('find-modal');
const container = $('canvas-container');
const selectionRectEl = $('selection-rect');

// ─── H: Drag-to-create-edge ──────────────────────────────────────────────────
export function isNearBorder(el, e) {
  const r = el.getBoundingClientRect();
  const threshold = 10;
  const mx = e.clientX - r.left, my = e.clientY - r.top;
  return mx < threshold || mx > r.width - threshold || my < threshold || my > r.height - threshold;
}

const edgesSvg = $('edges-svg');
let ghostEdgeLine = null;

export function startEdgeDrag(sourceNode, startEvent) {
  sourceNode.el.classList.add('edge-source');
  // Pause physics so nodes don't move while the user is drawing an edge
  if (state.physicsRaf) { cancelAnimationFrame(state.physicsRaf); state.physicsRaf = null; }
  state.physicsRunning = false;
  const sx = startEvent.clientX, sy = startEvent.clientY;

  ghostEdgeLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  ghostEdgeLine.setAttribute('stroke', '#f06820');
  ghostEdgeLine.setAttribute('stroke-width', '2');
  ghostEdgeLine.setAttribute('stroke-dasharray', '5 3');
  ghostEdgeLine.setAttribute('pointer-events', 'none');
  ghostEdgeLine.setAttribute('x1', sx); ghostEdgeLine.setAttribute('y1', sy);
  ghostEdgeLine.setAttribute('x2', sx); ghostEdgeLine.setAttribute('y2', sy);
  edgesSvg.appendChild(ghostEdgeLine);

  let dropTarget = null;
  function onMove(ev) {
    ghostEdgeLine.setAttribute('x2', ev.clientX);
    ghostEdgeLine.setAttribute('y2', ev.clientY);
    ghostEdgeLine.style.display = 'none';
    const els = document.elementsFromPoint(ev.clientX, ev.clientY);
    ghostEdgeLine.style.display = '';
    const nodeEl = els.find(el => el.classList.contains('node') && el.dataset.id !== sourceNode.id);
    const prev = dropTarget;
    dropTarget = nodeEl ? nodeEl.dataset.id : null;
    if (prev !== dropTarget) {
      if (prev) state.nodes.get(prev)?.el?.classList.remove('edge-target');
      if (dropTarget) state.nodes.get(dropTarget)?.el?.classList.add('edge-target');
    }
  }
  function onUp(ev) {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    ghostEdgeLine?.remove(); ghostEdgeLine = null;
    sourceNode.el.classList.remove('edge-source');
    // Resume physics after drag
    kickPhysics();
    if (dropTarget) state.nodes.get(dropTarget)?.el?.classList.remove('edge-target');
    if (dropTarget) {
      snapshot();
      const edge = addEdge(sourceNode.id, dropTarget);
      state.selectedEdgeId = edge.id;
      state.selectedNodeId = null;
      renderAllEdges();
      highlightSelected();
      UI.openEdgePanel(edge.id);
      focusEdgeLabelField();
      snapshot();
    }
  }
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

// ─── Mouse ─────────────────────────────────────────────────────────────────────
export let spaceDown = false;
document.addEventListener('keydown', e => { if (e.code === 'Space' && !e.target.matches('input,textarea')) { e.preventDefault(); spaceDown = true; } });
document.addEventListener('keyup', e => { if (e.code === 'Space') spaceDown = false; });

export function onNodeMouseDown(e) {
  if (e.button !== 0) return;
  e.stopPropagation();
  if (state.mode === 'editing') return;

  const nodeId = e.currentTarget.dataset.id;
  const node = state.nodes.get(nodeId);
  if (!node) return;

  if (state.mode === 'edge') {
    state.edgeCandidateId = nodeId;
    selectNode(nodeId);
    return;
  }

  if (e.shiftKey) {
    if (state.selectedNodeIds.size === 0 && state.selectedNodeId) {
      state.selectedNodeIds.add(state.selectedNodeId);
    }
    state.selectedNodeId = null;
    state.selectedEdgeId = null;
    if (state.selectedNodeIds.has(nodeId)) state.selectedNodeIds.delete(nodeId);
    else state.selectedNodeIds.add(nodeId);
    highlightSelected();
    updateStatus();
    return;
  }

  if (state.mode === 'normal' && isNearBorder(e.currentTarget, e)) {
    selectNode(nodeId);
    startEdgeDrag(node, e);
    return;
  }

  selectNode(nodeId);
  if (!state.physics.enabled) { startTidyDrag(node, e); return; }

  const startX = e.clientX, startY = e.clientY;
  const origX = node.x, origY = node.y;
  let moved = false;
  node.dragging = true;
  stopNodeTween(node);
  kickPhysics();

  function onMove(ev) {
    const dx = (ev.clientX - startX) / state.camera.zoom;
    const dy = (ev.clientY - startY) / state.camera.zoom;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) moved = true;
    node.x = snapToGrid(origX + dx); node.y = snapToGrid(origY + dy);
    node.rx = node.x; node.ry = node.y;
    placeNode(node);
    markEdgesDirty();
  }
  function onUp() {
    node.dragging = false;
    if (moved) { snapshot(); kickPhysics(); }
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
  }
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

// ─── Tidy-mode drag: move a branch, drop it on another node to reparent ──────
// The dragged node carries its whole subtree. A ghost branch shows where it
// would attach; dropping on empty space springs it back to its slot. The
// grabbed node follows the pointer; its branch trails behind on springs.
// Dragging a root moves its whole map.
const ghostPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
ghostPath.classList.add('reparent-ghost');
const ghostBox = document.createElement('div');
ghostBox.className = 'reparent-ghost-box';

function startTidyDrag(node, startEvent) {
  const tree = getTree();
  const sub = subtreeIds(node.id, tree);
  const subSet = new Set(sub);
  const isRoot = !tree.parent.has(node.id);
  const origin = new Map(sub.map(id => {
    const n = state.nodes.get(id);
    return [id, { x: n.rx ?? n.x, y: n.ry ?? n.y }];
  }));
  const startX = startEvent.clientX, startY = startEvent.clientY;
  let moved = false, dropTarget = null;

  function setTarget(id) {
    if (id === dropTarget) return;
    if (dropTarget) state.nodes.get(dropTarget)?.el?.classList.remove('drop-target');
    dropTarget = id;
    if (dropTarget) state.nodes.get(dropTarget)?.el?.classList.add('drop-target');
  }

  function findTarget(ev) {
    const els = document.elementsFromPoint(ev.clientX, ev.clientY);
    const under = els.find(el => el.classList?.contains('node') && !subSet.has(el.dataset.id));
    if (under) return under.dataset.id;
    if (isRoot) return null;
    // Proximity: the closest visible node near the dragged node's inner edge.
    const n = node, nx = n.rx, ny = n.ry;
    let best = null, bestD = 130;
    for (const c of state.nodes.values()) {
      if (subSet.has(c.id) || tree.hidden.has(c.id)) continue;
      const d = Math.hypot((c.rx ?? c.x) - nx, (c.ry ?? c.y) - ny);
      if (d < bestD) { bestD = d; best = c.id; }
    }
    return best;
  }

  function onMove(ev) {
    const sdx = ev.clientX - startX, sdy = ev.clientY - startY;
    if (!moved && Math.hypot(sdx, sdy) < 5) return;
    if (!moved) {
      moved = true;
      node.dragging = true; stopNodeTween(node);
      node.el.classList.add('dragging');
      $('edges-world').appendChild(ghostPath);
      $('world').appendChild(ghostBox);
    }
    const dx = sdx / state.camera.zoom, dy = sdy / state.camera.zoom;
    node.rx = origin.get(node.id).x + dx; node.ry = origin.get(node.id).y + dy;
    placeNode(node);
    for (const id of sub) {
      if (id === node.id) continue;
      const n = state.nodes.get(id), o = origin.get(id);
      n.x = o.x + dx; n.y = o.y + dy;
      tweenNode(n);                         // trails the grabbed node
    }
    setTarget(findTarget(ev));
    if (dropTarget && dropTarget !== tree.parent.get(node.id)) {
      // Preview the slot the branch would land in: under the target's last child.
      const p = state.nodes.get(dropTarget);
      const { w: pw } = nodeSize(p);
      const { w: nw, h: nh } = nodeSize(node);
      const slot = childSlot(p.id, nw, nh, subSet, tree);
      const s = slot.side, gx = slot.x, gy = slot.y;
      const sx = p.x + s * pw / 2, sy = p.y;
      const ex = gx - s * nw / 2, ey = gy;
      const k = Math.max(18, Math.abs(ex - sx) * 0.55);
      ghostPath.setAttribute('d', `M${sx},${sy} C${sx + s*k},${sy} ${ex - s*k},${ey} ${ex},${ey}`);
      ghostPath.style.display = '';
      ghostBox.style.width = nw + 'px'; ghostBox.style.height = nh + 'px';
      ghostBox.style.transform = `translate(${gx}px,${gy}px) translate(-50%,-50%)`;
      ghostBox.style.display = '';
    } else {
      ghostPath.style.display = 'none';
      ghostBox.style.display = 'none';
    }
    markEdgesDirty();
  }

  function onUp() {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    if (!moved) return;
    node.dragging = false;
    node.el.classList.remove('dragging');
    ghostPath.remove();
    ghostBox.remove();
    const target = dropTarget;
    setTarget(null);
    const curParent = tree.parent.get(node.id);
    if (target && target !== curParent) {
      snapshot();
      reparent(node.id, target, tree);
      snapshot();
      const t = state.nodes.get(target);
      showToast('Moved under "' + (t?.label || 'node') + '"');
    } else if (isRoot) {
      snapshot();
      node.x = node.rx; node.y = node.ry;      // the anchor moves; the map follows
      snapshot();
    }
    // Everything springs to its tidy slot (a plain drop springs back home).
    for (const id of sub) tweenNode(state.nodes.get(id));
    renderAllEdges();
    markLayoutDirty();
  }
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

function reparent(nodeId, newParentId, tree) {
  const n = state.nodes.get(nodeId);
  const peId = tree.parentEdge.get(nodeId);
  const pe = peId && state.edges.get(peId);
  if (pe) {
    pe.source = newParentId; pe.target = nodeId; pe.cp = null;
    state.edges.delete(peId); state.edges.set(peId, pe);   // becomes the last child
  } else {
    addEdge(newParentId, nodeId);
  }
  delete n.root;
  const p = state.nodes.get(newParentId);
  if (p?.collapsed) delete p.collapsed;
}

export function onNodeClick(e) { e.stopPropagation(); }

export function onNodeDblClick(e) {
  e.stopPropagation();
  const nodeId = e.currentTarget.dataset.id;
  selectNode(nodeId);
  startEditNode(nodeId);
}

export function onNodeContextMenu(e) {
  e.preventDefault(); e.stopPropagation();
  const nodeId = e.currentTarget.dataset.id;
  selectNode(nodeId);
  state.ctxTargetId = nodeId;
  showCtxMenu(e.clientX, e.clientY, nodeId);
}

container.addEventListener('mousedown', e => {
  if (e.button === 1 || (e.button === 0 && spaceDown)) {
    e.preventDefault();
    stopCameraMotion();
    const sx = e.clientX, sy = e.clientY;
    const cx = state.camera.x, cy = state.camera.y;
    let samples = [{ x: sx, y: sy, t: performance.now() }];
    function onMove(ev) {
      state.camera.x = cx + ev.clientX - sx; state.camera.y = cy + ev.clientY - sy; applyCam();
      const now = performance.now();
      samples.push({ x: ev.clientX, y: ev.clientY, t: now });
      while (samples.length > 2 && now - samples[0].t > 80) samples.shift();
    }
    function onUp() {
      window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp);
      // Throw: keep gliding with the release velocity, then ease to a stop.
      const a = samples[0], b = samples[samples.length - 1];
      const dt = b.t - a.t;
      if (dt > 0 && performance.now() - b.t < 60) startInertia((b.x - a.x) / dt, (b.y - a.y) / dt);
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return;
  }
  if (e.button === 0 && state.mode === 'normal') {
    ctxMenu.classList.remove('visible');
    if (!edgePanel.contains(e.target)) {
      state.selectedEdgeId = null;
      UI.closeEdgePanel();
      renderAllEdges();
      highlightSelected();
    }
    if (!e.target.closest('.node') && !edgePanel.contains(e.target)) {
      startRubberBand(e);
    }
  }
});

function startRubberBand(e) {
  if (!e.shiftKey) {
    state.selectedNodeIds.clear();
    state.selectedNodeId = null;
    highlightSelected();
  }
  const startX = e.clientX, startY = e.clientY;
  let active = false;
  function onMove(ev) {
    const dx = ev.clientX - startX, dy = ev.clientY - startY;
    if (!active && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) active = true;
    if (!active) return;
    selectionRectEl.style.display = 'block';
    selectionRectEl.style.left = Math.min(startX, ev.clientX) + 'px';
    selectionRectEl.style.top = Math.min(startY, ev.clientY) + 'px';
    selectionRectEl.style.width = Math.abs(dx) + 'px';
    selectionRectEl.style.height = Math.abs(dy) + 'px';
  }
  function onUp(ev) {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    selectionRectEl.style.display = 'none';
    if (!active) return;
    const x1 = Math.min(startX, ev.clientX), y1 = Math.min(startY, ev.clientY);
    const x2 = Math.max(startX, ev.clientX), y2 = Math.max(startY, ev.clientY);
    if (!e.shiftKey) state.selectedNodeIds.clear();
    for (const n of state.nodes.values()) {
      const sp = worldToScreen(n.x, n.y);
      if (sp.x >= x1 && sp.x <= x2 && sp.y >= y1 && sp.y <= y2) state.selectedNodeIds.add(n.id);
    }
    state.selectedNodeId = null;
    state.selectedEdgeId = null;
    UI.closeEdgePanel();
    highlightSelected();
    updateStatus();
  }
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

container.addEventListener('contextmenu', e => {
  e.preventDefault();
  const wp = screenToWorld(e.clientX, e.clientY);
  snapshot();
  const n = addNode('', wp.x, wp.y);
  selectNode(n.id);
  kickPhysics();
  startEditNode(n.id);
  snapshot();
});

// Wheel / trackpad. Trackpads already send momentum, so their pan and pinch
// are applied directly. Discrete mouse-wheel steps are eased toward a target.
container.addEventListener('wheel', e => {
  e.preventDefault();
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? window.innerHeight : 1;
  const dx = e.deltaX * unit, dy = e.deltaY * unit;
  const stepped = e.deltaMode !== 0 || (dx === 0 && Math.abs(dy) >= 40 && Number.isInteger(dy));
  if (e.ctrlKey || e.metaKey) {
    const factor = Math.exp(-dy * (stepped ? 0.0022 : 0.01));
    if (stepped) zoomBy(factor, e.clientX, e.clientY, { smooth: true });
    else { stopCameraMotion(); zoomBy(factor, e.clientX, e.clientY, { animate: false }); }
  } else if (stepped) {
    const base = getCameraTarget();
    if (e.shiftKey) easeCameraTo({ x: base.x - dy, y: base.y, zoom: base.zoom });
    else easeCameraTo({ x: base.x - dx, y: base.y - dy, zoom: base.zoom });
  } else {
    stopCameraMotion();
    state.camera.x -= dx;
    state.camera.y -= dy;
    applyCam();
  }
}, { passive: false });
