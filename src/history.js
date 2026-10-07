import { state, UI } from './state.js';
import { applyCam } from './camera.js';
import { renderAllEdges, highlightSelected, updateStatus } from './render.js';
import { createNodeEl } from './nodes.js';
import { kickPhysics } from './physics.js';
import { unobserveNode } from './sizes.js';
import { tweenNode } from './frame.js';
import { resetRenderCaches } from './render.js';

// ─── History ─────────────────────────────────────────────────────────────────
export function snapshot() {
  if (state.historyPaused) return;
  const s = {
    nodes: [...state.nodes.values()].map(n => ({...n, el: undefined, foldEl: undefined, rx: undefined, ry: undefined})),
    edges: [...state.edges.values()].map(e => ({...e})),
    selectedNodeId: state.selectedNodeId,
    camera: {...state.camera},
  };
  state.history.splice(state.historyIndex + 1);
  state.history.push(s);
  if (state.history.length > 100) state.history.shift();
  state.historyIndex = state.history.length - 1;
  // scheduleAutoSave is in persist.js; import lazily to avoid circular top-level dep
  import('./persist.js').then(m => m.scheduleAutoSave());
}

export function restoreSnapshot(s) {
  // Remember where things are on screen so undo/redo glides instead of jumping.
  const onScreen = new Map();
  [...state.nodes.values()].forEach(n => {
    onScreen.set(n.id, { x: n.rx ?? n.x, y: n.ry ?? n.y });
    unobserveNode(n); n.el?.remove(); n.foldEl?.remove();
  });
  state.nodes.clear();
  resetRenderCaches();
  state.edges.clear();
  s.nodes.forEach(nd => {
    const node = {...nd, vx:0, vy:0};
    const prev = onScreen.get(node.id);
    node.rx = prev ? prev.x : node.x;
    node.ry = prev ? prev.y : node.y;
    state.nodes.set(node.id, node);
    state.createdAt.set(node.id, state.createdAt.get(node.id) || Date.now());
    createNodeEl(node);
    tweenNode(node);
  });
  s.edges.forEach(ed => state.edges.set(ed.id, {...ed}));
  state.selectedNodeId = s.selectedNodeId;
  state.selectedEdgeId = null;
  UI.closeEdgePanel();
  applyCam();
  renderAllEdges();
  highlightSelected();
  updateStatus();
  kickPhysics();
}
