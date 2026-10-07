import { state, App, UI, Keyboard, $ } from './state.js';
import { worldToScreen } from './camera.js';
import { renderAllEdges, highlightSelected, updateStatus } from './render.js';
import { snapshot } from './history.js';
import { selectNode, updateNodeEl } from './nodes.js';
import { focusEdgeLabelField } from './edges.js';

const edgePanel = $('edge-panel');
const edgeLabelField = $('edge-label-field');
const ctxMenu = $('ctx-menu');
const findModal = $('find-modal');
const findInput = $('find-input');
const findResults = $('find-results');

// ─── Edge panel ──────────────────────────────────────────────────────────────
export const EP_COLORS = [
  { name: 'default', bg: '#4a4080' },
  { name: 'accent',  bg: '#f06820' },
  { name: 'green',   bg: '#3d8c60' },
  { name: 'amber',   bg: '#c08020' },
  { name: 'coral',   bg: '#c04040' },
  { name: 'teal',    bg: '#2a8098' },
];

export const COLOR_DEFS = [
  { name: 'default', bg: '#4a4080' },
  { name: 'purple',  bg: '#7b5ea7' },
  { name: 'green',   bg: '#3d8c60' },
  { name: 'amber',   bg: '#c08020' },
  { name: 'coral',   bg: '#c04040' },
  { name: 'teal',    bg: '#2a8098' },
  { name: 'blue',    bg: '#2060c0' },
  { name: 'pink',    bg: '#b030a0' },
];

// EP_COLORS DOM init
const epColorsEl = $('ep-colors');
EP_COLORS.forEach(cd => {
  const dot = document.createElement('div');
  dot.className = 'ep-color-dot';
  dot.style.background = cd.bg;
  dot.dataset.color = cd.name;
  dot.title = cd.name;
  dot.addEventListener('click', () => App.setEdgeColor(cd.name));
  epColorsEl.appendChild(dot);
});

// COLOR_DEFS DOM init
const ctxColorsEl = $('ctx-colors');
COLOR_DEFS.forEach(cd => {
  const dot = document.createElement('div');
  dot.className = 'ctx-color-dot';
  dot.title = cd.name; dot.style.background = cd.bg; dot.dataset.color = cd.name;
  dot.addEventListener('click', () => App.setColor(cd.name));
  ctxColorsEl.appendChild(dot);
});

// Icon tags shown before a node's label ('' = none)
export const NODE_ICONS = ['✅', '❓', '⭐', '⚠️', '💡', '🔥', '❌', '🎯', ''];
const ctxIconsEl = $('ctx-icons');
NODE_ICONS.forEach(icon => {
  const b = document.createElement('button');
  b.className = 'ctx-icon-btn';
  b.dataset.icon = icon;
  b.textContent = icon || '∅';
  b.title = icon ? 'Add ' + icon : 'No icon';
  b.addEventListener('click', () => App.setIcon(icon));
  ctxIconsEl.appendChild(b);
});

UI.openEdgePanel = function(edgeId) {
  const edge = state.edges.get(edgeId);
  if (!edge) return;

  edgeLabelField.value = edge.label || '';

  epColorsEl.querySelectorAll('.ep-color-dot').forEach(d => {
    d.classList.toggle('active', d.dataset.color === (edge.color || 'default'));
  });

  $('edge-panel').querySelectorAll('[data-thickness]').forEach(b => {
    b.classList.toggle('active', b.dataset.thickness === (edge.thickness || 'normal'));
  });

  $('ep-dash-btn').classList.toggle('active', !!edge.dash);
  $('ep-bidir-btn').classList.toggle('active', !!edge.bidirectional);

  const src = state.nodes.get(edge.source);
  const tgt = state.nodes.get(edge.target);
  if (src && tgt) {
    const sp = worldToScreen((src.x + tgt.x) / 2, (src.y + tgt.y) / 2);
    let px = sp.x + 10, py = sp.y + 10;
    const pw = 250, ph = 150;
    if (px + pw > window.innerWidth - 20) px = sp.x - pw - 10;
    if (py + ph > window.innerHeight - 20) py = sp.y - ph - 10;
    edgePanel.style.left = Math.max(10, px) + 'px';
    edgePanel.style.top = Math.max(60, py) + 'px';
  }

  edgePanel.classList.add('visible');
};

UI.closeEdgePanel = function() {
  if (edgePanel.classList.contains('visible')) {
    const edge = state.edges.get(state.selectedEdgeId);
    if (edge) {
      const newLabel = edgeLabelField.value.trim();
      if (newLabel !== edge.label) {
        edge.label = newLabel;
        renderAllEdges();
        snapshot();
      }
    }
  }
  edgePanel.classList.remove('visible');
};

// ─── App edge methods ─────────────────────────────────────────────────────────
App.setEdgeColor = function(color) {
  const edge = state.edges.get(state.selectedEdgeId);
  if (!edge) return;
  edge.color = color;
  epColorsEl.querySelectorAll('.ep-color-dot').forEach(d => {
    d.classList.toggle('active', d.dataset.color === color);
  });
  renderAllEdges();
  snapshot();
};

App.setEdgeThickness = function(t) {
  const edge = state.edges.get(state.selectedEdgeId);
  if (!edge) return;
  edge.thickness = t;
  $('edge-panel').querySelectorAll('[data-thickness]').forEach(b => {
    b.classList.toggle('active', b.dataset.thickness === t);
  });
  renderAllEdges();
  snapshot();
};

App.toggleEdgeDash = function() {
  const edge = state.edges.get(state.selectedEdgeId);
  if (!edge) return;
  edge.dash = !edge.dash;
  $('ep-dash-btn').classList.toggle('active', edge.dash);
  renderAllEdges();
  snapshot();
};

App.deleteSelectedEdge = function() {
  if (!state.selectedEdgeId) return;
  snapshot();
  state.edges.delete(state.selectedEdgeId);
  state.selectedEdgeId = null;
  UI.closeEdgePanel();
  renderAllEdges();
  updateStatus();
  snapshot();
};

App.swapEdgeDirection = function() {
  const edge = state.edges.get(state.selectedEdgeId);
  if (!edge) return;
  [edge.source, edge.target] = [edge.target, edge.source];
  renderAllEdges();
  snapshot();
};

App.toggleEdgeBidir = function() {
  const edge = state.edges.get(state.selectedEdgeId);
  if (!edge) return;
  edge.bidirectional = !edge.bidirectional;
  $('ep-bidir-btn').classList.toggle('active', edge.bidirectional);
  renderAllEdges();
  snapshot();
};

App.toggleMinimap = function() {
  const mm = $('minimap');
  const isHidden = mm.style.display === 'none';
  mm.style.display = isHidden ? '' : 'none';
  const btn = $('minimap-btn');
  if (btn) btn.classList.toggle('active', isHidden);
};

App.toggleTheme = function() {
  const isLight = document.documentElement.dataset.theme === 'light';
  const next = isLight ? 'dark' : 'light';
  if (next === 'light') {
    document.documentElement.dataset.theme = 'light';
  } else {
    delete document.documentElement.dataset.theme;
  }
  localStorage.setItem('orbis-theme', next);
  const btn = $('theme-btn');
  if (btn) btn.textContent = next === 'light' ? '☾' : '☀';
};

(function initTheme() {
  const saved = localStorage.getItem('orbis-theme');
  if (saved === 'light') {
    document.documentElement.dataset.theme = 'light';
    const btn = $('theme-btn');
    if (btn) btn.textContent = '☾';
  }
})();

// ─── Context menu ─────────────────────────────────────────────────────────────
export function showCtxMenu(x, y, nodeId) {
  const node = state.nodes.get(nodeId);
  if (!node) return;

  ctxColorsEl.querySelectorAll('.ctx-color-dot').forEach(d => {
    d.classList.toggle('active', d.dataset.color === (node.color || 'default'));
  });
  $('ctx-shapes').querySelectorAll('.ctx-shape-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.shape === (node.shape || 'rect'));
  });
  $('ctx-menu').querySelectorAll('[data-fontsize]').forEach(b => {
    b.classList.toggle('active', b.dataset.fontsize === (node.fontSize || 'md'));
  });
  $('ctx-bold-btn').classList.toggle('active', node.fontWeight === 'bold');
  $('ctx-italic-btn').classList.toggle('active', node.fontStyle === 'italic');
  ctxIconsEl.querySelectorAll('.ctx-icon-btn').forEach(b => {
    b.classList.toggle('active', !!node.icon && b.dataset.icon === node.icon);
  });
  $('ctx-pin-label').textContent = node.pinned ? 'Unpin node' : 'Pin node';

  ctxMenu.style.left = x + 'px'; ctxMenu.style.top = y + 'px';
  ctxMenu.classList.add('visible');

  requestAnimationFrame(() => {
    const r = ctxMenu.getBoundingClientRect();
    if (r.right > window.innerWidth) ctxMenu.style.left = (x - r.width) + 'px';
    if (r.bottom > window.innerHeight) ctxMenu.style.top = (y - r.height) + 'px';
  });
}

document.addEventListener('click', e => {
  if (!ctxMenu.contains(e.target)) ctxMenu.classList.remove('visible');
});

// ─── App node styling methods ─────────────────────────────────────────────────
App.setColor = function(color) {
  if (state.selectedNodeIds.size > 0) {
    snapshot();
    for (const nid of state.selectedNodeIds) {
      const n = state.nodes.get(nid);
      if (n) { n.color = color; if (n.el) n.el.dataset.color = color; }
    }
    ctxMenu.classList.remove('visible');
    renderAllEdges();
    snapshot();
    return;
  }
  const id = state.ctxTargetId || state.selectedNodeId;
  const n = state.nodes.get(id);
  if (!n) return;
  snapshot();
  n.color = color; n.el.dataset.color = color;
  ctxMenu.classList.remove('visible');
  renderAllEdges();
  snapshot();
};

App.setShape = function(shape) {
  if (state.selectedNodeIds.size > 0) {
    snapshot();
    for (const nid of state.selectedNodeIds) {
      const n = state.nodes.get(nid);
      if (n) { n.shape = shape; if (n.el) n.el.dataset.shape = shape; }
    }
    ctxMenu.classList.remove('visible');
    renderAllEdges();
    snapshot();
    return;
  }
  const id = state.ctxTargetId || state.selectedNodeId;
  const n = state.nodes.get(id);
  if (!n) return;
  snapshot();
  n.shape = shape; n.el.dataset.shape = shape;
  ctxMenu.classList.remove('visible');
  renderAllEdges();
  snapshot();
};

App.setIcon = function(icon) {
  const ids = state.selectedNodeIds.size > 0 ? [...state.selectedNodeIds] : [state.ctxTargetId || state.selectedNodeId];
  const nodes = ids.map(id => state.nodes.get(id)).filter(Boolean);
  if (!nodes.length) return;
  snapshot();
  for (const n of nodes) {
    if (icon) n.icon = icon; else delete n.icon;
    updateNodeEl(n);
  }
  ctxMenu.classList.remove('visible');
  renderAllEdges();
  snapshot();
};

App.setFontSize = function(size) {
  const id = state.ctxTargetId || state.selectedNodeId;
  const n = state.nodes.get(id);
  if (!n) return;
  snapshot();
  n.fontSize = size; n.el.dataset.fontsize = size;
  $('ctx-menu').querySelectorAll('[data-fontsize]').forEach(b => b.classList.toggle('active', b.dataset.fontsize === size));
  renderAllEdges();
  snapshot();
};

App.toggleFontWeight = function() {
  const id = state.ctxTargetId || state.selectedNodeId;
  const n = state.nodes.get(id);
  if (!n) return;
  snapshot();
  n.fontWeight = n.fontWeight === 'bold' ? 'normal' : 'bold';
  n.el.dataset.fontweight = n.fontWeight;
  $('ctx-bold-btn').classList.toggle('active', n.fontWeight === 'bold');
  snapshot();
};

App.toggleFontStyle = function() {
  const id = state.ctxTargetId || state.selectedNodeId;
  const n = state.nodes.get(id);
  if (!n) return;
  snapshot();
  n.fontStyle = n.fontStyle === 'italic' ? 'normal' : 'italic';
  n.el.dataset.fontstyle = n.fontStyle;
  $('ctx-italic-btn').classList.toggle('active', n.fontStyle === 'italic');
  snapshot();
};

App.ctxAction = function(action) {
  const id = state.ctxTargetId || state.selectedNodeId;
  ctxMenu.classList.remove('visible');
  if (!id || !state.nodes.has(id)) return;
  switch (action) {
    case 'pin': {
      const n = state.nodes.get(id);
      if (n) { snapshot(); n.pinned = !n.pinned; n.el.classList.toggle('pinned', n.pinned); snapshot(); }
      break;
    }
    case 'fold': App.toggleFold(id); break;
    case 'duplicate': Keyboard.duplicate(); break;
    case 'edge': selectNode(id); Keyboard.startEdgeMode(); break;
    case 'delete': selectNode(id); Keyboard.deleteSelected(); break;
  }
};

// ─── Find ─────────────────────────────────────────────────────────────────────
UI.openFind = function() {
  findModal.classList.add('visible');
  findInput.value = '';
  findResults.innerHTML = '';
  findInput.focus();
};

UI.closeFind = function() {
  findModal.classList.remove('visible');
  for (const n of state.nodes.values()) n.el?.classList.remove('search-hit');
};

findInput.addEventListener('input', () => {
  const q = findInput.value.toLowerCase().trim();
  findResults.innerHTML = '';
  for (const n of state.nodes.values()) n.el?.classList.remove('search-hit');
  if (!q) return;
  const matches = [...state.nodes.values()].filter(n => n.label.toLowerCase().includes(q));
  matches.forEach(n => n.el?.classList.add('search-hit'));
  matches.slice(0, 20).forEach((n, i) => {
    const div = document.createElement('div');
    div.className = 'find-result' + (i===0?' highlighted':'');
    div.textContent = n.label;
    div.addEventListener('click', () => { selectNode(n.id, {center:true}); UI.closeFind(); });
    findResults.appendChild(div);
  });
});

findInput.addEventListener('keydown', e => {
  if (e.key === 'Escape') { e.preventDefault(); UI.closeFind(); }
  if (e.key === 'Enter') { findResults.querySelector('.find-result')?.click(); }
});

// ─── Export menu (toolbar) ───────────────────────────────────────────────────
const exportMenu = $('export-menu');
UI.toggleExportMenu = function(e) {
  e?.stopPropagation();
  if (exportMenu.classList.toggle('visible')) {
    const r = $('export-btn').getBoundingClientRect();
    exportMenu.style.left = (r.right + 8) + 'px';
    exportMenu.style.top = Math.min(r.top, window.innerHeight - 200) + 'px';
  }
};
UI.exportAction = function(kind) {
  exportMenu.classList.remove('visible');
  ({ png: App.exportPNG, pdf: App.exportPDF, svg: App.exportSVG, md: App.exportMarkdown,
     'import-md': App.importMarkdown })[kind]?.();
};
document.addEventListener('click', e => {
  if (!exportMenu.contains(e.target)) exportMenu.classList.remove('visible');
});

UI.toggleSettings = function() { $('settings-panel').classList.toggle('visible'); };
