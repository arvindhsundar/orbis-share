import { state, UI, Keyboard, $ } from './state.js';
import { uuid, dist } from './utils.js';
import { renderAllEdges, highlightSelected, updateStatus, setMode } from './render.js';
import { snapshot } from './history.js';
import { applyCam, centerOn } from './camera.js';
import { kickPhysics } from './physics.js';
import { onNodeMouseDown, onNodeClick, onNodeDblClick, onNodeContextMenu, isNearBorder } from './input.js';
import { placeNode } from './frame.js';
import { observeNode, unobserveNode, forgetNode } from './sizes.js';

const world = $('world');

// ─── Node DOM ─────────────────────────────────────────────────────────────────
export function applyNodeDataAttrs(el, node) {
  el.dataset.color = node.color || 'default';
  el.dataset.shape = node.shape || 'rect';
  el.dataset.fontsize = node.fontSize || 'md';
  el.dataset.fontweight = node.fontWeight || 'normal';
  el.dataset.fontstyle = node.fontStyle || 'normal';
}

// What a node shows: its icon (optional emoji tag) then its label.
export function nodeText(node) {
  return node.icon ? node.icon + ' ' + node.label : node.label;
}

export function createNodeEl(node, opts = {}) {
  const el = document.createElement('div');
  el.className = 'node';
  if (opts.enter) el.classList.add('node-enter');
  el.dataset.id = node.id;
  applyNodeDataAttrs(el, node);
  el.textContent = nodeText(node);
  el.title = node.label;
  if (node.pinned) el.classList.add('pinned');
  node.el = el;
  node._branch = undefined;   // render caches, tied to this element
  node._hidden = undefined;
  placeNode(node);
  world.appendChild(el);
  observeNode(node);
  if (opts.enter) el.addEventListener('animationend', () => el.classList.remove('node-enter'), { once: true });

  el.addEventListener('mousedown', onNodeMouseDown);
  el.addEventListener('click', onNodeClick);
  el.addEventListener('dblclick', onNodeDblClick);
  el.addEventListener('contextmenu', onNodeContextMenu);
  // H: show crosshair cursor when hovering near node border
  el.addEventListener('mousemove', ev => {
    if (state.mode === 'normal') el.classList.toggle('edge-drag-handle', isNearBorder(el, ev));
  });
  el.addEventListener('mouseleave', () => el.classList.remove('edge-drag-handle'));
  return el;
}

export function updateNodeEl(node) {
  const el = node.el;
  if (!el) return;
  placeNode(node);
  if (!node.editing) { el.textContent = nodeText(node); el.title = node.label; }
  applyNodeDataAttrs(el, node);
  el.classList.toggle('pinned', !!node.pinned);
}

export function addNode(label, x, y, opts = {}) {
  const id = uuid();
  const node = {
    id, label,
    x: x ?? (window.innerWidth/2 - state.camera.x) / state.camera.zoom,
    y: y ?? (window.innerHeight/2 - state.camera.y) / state.camera.zoom,
    color: opts.color || 'default',
    shape: opts.shape || 'rect',
    fontSize: opts.fontSize || 'md',
    fontWeight: opts.fontWeight || 'normal',
    fontStyle: opts.fontStyle || 'normal',
    pinned: false,
    vx: 0, vy: 0,
  };
  if (opts.icon) node.icon = opts.icon;
  // Rendered position: where the node appears first (it then glides to its slot).
  node.rx = opts.spawnX ?? node.x;
  node.ry = opts.spawnY ?? node.y;
  state.nodes.set(id, node);
  state.createdAt.set(id, Date.now());
  createNodeEl(node, { enter: true });
  return node;
}

export function deleteNode(id) {
  const node = state.nodes.get(id);
  if (!node) return;
  unobserveNode(node);
  forgetNode(id);
  node.el?.remove();
  node.foldEl?.remove();
  state.nodes.delete(id);
  for (const [eid, edge] of state.edges) {
    if (edge.source === id || edge.target === id) state.edges.delete(eid);
  }
  if (state.selectedNodeId === id) {
    let nearest = null, best = Infinity;
    for (const n of state.nodes.values()) {
      const d = dist(n, node);
      if (d < best) { best = d; nearest = n; }
    }
    if (nearest) selectNode(nearest.id);
    else if (state.nodes.size === 0) {
      const n = addNode('', 0, 0);
      selectNode(n.id);
      startEditNode(n.id);
      snapshot();
    }
  }
  UI.closeEdgePanel();
  renderAllEdges();
  updateStatus();
}

export function selectNode(id, opts = {}) {
  state.selectedNodeId = id;
  state.selectedNodeIds.clear();   // I: clear multi-select on normal select
  state.selectedEdgeId = null;
  UI.closeEdgePanel();
  highlightSelected();
  updateStatus();
  if (opts.center) {
    const n = state.nodes.get(id);
    if (n) centerOn(n);
  }
}

// ─── Inline node edit ─────────────────────────────────────────────────────────
export function startEditNode(id, initialChar = null) {
  const node = state.nodes.get(id);
  if (!node) return;
  const el = node.el;
  node.editing = true;
  el.classList.add('editing');
  const prev = node.label;

  // Freeze the node in place while editing so physics can't push it off-screen
  const wasPinned = node.pinned;
  node.pinned = true;
  el.innerHTML = '';
  const inp = document.createElement('input');
  inp.className = 'node-input';
  if (initialChar !== null) {
    inp.value = initialChar;
    inp.style.minWidth = Math.max(60, initialChar.length * 8) + 'px';
  } else {
    inp.value = node.label;
    inp.style.minWidth = Math.max(60, node.label.length * 8) + 'px';
  }
  el.appendChild(inp);
  setMode('editing');

  inp.focus();
  if (initialChar === null) inp.select();

  inp.addEventListener('input', () => {
    inp.style.minWidth = Math.max(60, inp.value.length * 8) + 'px';
  });

  function unfreeze() {
    node.pinned = wasPinned;
    el.classList.toggle('pinned', wasPinned);
  }

  function commitEdit() {
    if (!node.editing) return;
    node.editing = false;
    node.label = inp.value.trim() || prev;
    el.classList.remove('editing');
    el.textContent = nodeText(node);
    el.title = node.label;
    unfreeze();
    setMode('normal');
    snapshot();
    updateStatus();
  }

  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.stopPropagation(); e.preventDefault();
      commitEdit();
    } else if (e.key === 'Tab') {
      e.stopPropagation(); e.preventDefault();
      commitEdit();
      setTimeout(() => Keyboard.createChild(), 0);
    } else if (e.key === 'Escape') {
      e.stopPropagation(); e.preventDefault();
      node.editing = false;
      node.label = prev;
      el.classList.remove('editing');
      el.textContent = nodeText(node);
      unfreeze();
      setMode('normal');
    }
  });

  inp.addEventListener('blur', commitEdit);
}
