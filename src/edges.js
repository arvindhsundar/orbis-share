import { state, UI, $ } from './state.js';
import { uuid } from './utils.js';
import { renderAllEdges, highlightSelected, updateStatus } from './render.js';
import { snapshot } from './history.js';

const edgePanel = $('edge-panel');
const edgeLabelField = $('edge-label-field');

// ─── Edges ────────────────────────────────────────────────────────────────────
export function addEdge(sourceId, targetId, label = '') {
  const id = uuid();
  const edge = { id, source: sourceId, target: targetId, label, color: 'default', thickness: 'normal', dash: false, bidirectional: false, cp: null };
  state.edges.set(id, edge);
  return edge;
}

export function focusEdgeLabelField() {
  if (edgePanel.classList.contains('visible')) {
    edgeLabelField.focus();
    edgeLabelField.select();
  }
}

// Edge label field listeners
edgeLabelField.addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === 'Escape') {
    e.preventDefault();
    const edge = state.edges.get(state.selectedEdgeId);
    if (edge) {
      edge.label = edgeLabelField.value.trim();
      renderAllEdges();
      snapshot();
    }
    UI.closeEdgePanel();
  }
});

edgeLabelField.addEventListener('input', () => {
  const edge = state.edges.get(state.selectedEdgeId);
  if (edge) {
    edge.label = edgeLabelField.value;
    renderAllEdges();
  }
});
