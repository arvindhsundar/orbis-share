import { state, EDGE_COLORS, UI, App, $ } from './state.js';
import { screenToWorld } from './camera.js';
import { getTree } from './layout.js';
import { nodeSize, clearSizes } from './sizes.js';
import { markEdgesDirty, placeNode } from './frame.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const edgesSvg = $('edges-svg');
const edgesWorld = $('edges-world');
const statusbar = $('statusbar');
const modeIndicator = $('mode-indicator');
const toast = $('toast');
const minimapEl = $('minimap');
const minimapSvg = $('minimap-svg');

// ─── Toast ───────────────────────────────────────────────────────────────────
let toastTimer = null;
export function showToast(msg, dur = 2000) {
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), dur);
}

// ─── Status bar ──────────────────────────────────────────────────────────────
export function updateStatus() {
  const n = state.nodes.size, e = state.edges.size;
  let extra = '';
  if (state.selectedNodeIds.size > 1) {
    extra = ` · ${state.selectedNodeIds.size} selected`;
  } else if (state.selectedEdgeId) {
    const ed = state.edges.get(state.selectedEdgeId);
    extra = ed ? ` · edge "${ed.label || '(unlabeled)'}"` : '';
  } else if (state.selectedNodeId) {
    const nd = state.nodes.get(state.selectedNodeId);
    extra = nd ? ` · "${nd.label || ''}"` : '';
  }
  statusbar.textContent = `${n} node${n!==1?'s':''} · ${e} edge${e!==1?'s':''}${extra} · ${Math.round(state.camera.zoom*100)}%`;
}

// ─── Mode indicator ──────────────────────────────────────────────────────────
export function setMode(m, label) {
  state.mode = m;
  if (m === 'normal') {
    modeIndicator.classList.remove('visible');
  } else {
    modeIndicator.textContent = label || m;
    modeIndicator.classList.add('visible');
  }
}

// ─── Edge rendering ──────────────────────────────────────────────────────────
// One persistent <g> per edge id. Rendering only updates attributes; DOM
// nodes are created once and removed only when the edge is gone.
export const EDGE_OFFSET = 26;

export function getEdgeGroups() {
  const groups = new Map();
  for (const edge of state.edges.values()) {
    const key = edge.source < edge.target ? edge.source + '|' + edge.target : edge.target + '|' + edge.source;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(edge);
  }
  return groups;
}

const rx = n => (n.rx ?? n.x);
const ry = n => (n.ry ?? n.y);

export function nodeEdgePoint(node, tx, ty) {
  const { w, h } = nodeSize(node);
  const hw = w / 2, hh = h / 2;
  const nx = rx(node), ny = ry(node);
  const dx = tx - nx, dy = ty - ny;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  const tx2 = ux !== 0 ? hw / Math.abs(ux) : Infinity;
  const ty2 = uy !== 0 ? hh / Math.abs(uy) : Infinity;
  const t = Math.min(tx2, ty2);
  if (!isFinite(t)) return [nx, ny];            // target sits on the node centre
  return [nx + ux * t, ny + uy * t];
}

function focusEdgeLabelField() {
  const edgePanel = $('edge-panel');
  const edgeLabelField = $('edge-label-field');
  if (edgePanel.classList.contains('visible')) {
    edgeLabelField.focus();
    edgeLabelField.select();
  }
}

function selectEdgeById(id) {
  if (!state.edges.has(id)) return;
  state.selectedNodeId = null;
  state.selectedEdgeId = id;
  highlightSelected();
  renderAllEdges();
  UI.openEdgePanel(id);
  focusEdgeLabelField();
  updateStatus();
}

const edgeEls = new Map();   // edgeId -> { g, hit, path, bg, txt, lhit, handle }

function makeEdgeEls(id) {
  const g = document.createElementNS(SVGNS, 'g');
  g.classList.add('edge-g');
  g.dataset.id = id;

  const hit = document.createElementNS(SVGNS, 'path');
  hit.setAttribute('fill', 'none');
  hit.setAttribute('stroke', 'transparent');
  hit.setAttribute('stroke-width', '12');
  hit.style.cursor = 'pointer';
  hit.style.pointerEvents = 'stroke';

  const path = document.createElementNS(SVGNS, 'path');
  path.classList.add('edge-path');
  path.dataset.id = id;

  const bg = document.createElementNS(SVGNS, 'rect');
  bg.setAttribute('rx', 4);
  bg.classList.add('edge-label-bg');
  const txt = document.createElementNS(SVGNS, 'text');
  txt.classList.add('edge-label-text');
  txt.dataset.id = id;
  const lhit = document.createElementNS(SVGNS, 'rect');
  lhit.classList.add('edge-label-hit');

  const handle = document.createElementNS(SVGNS, 'circle');
  handle.setAttribute('r', 5);
  handle.classList.add('edge-waypoint-handle');
  handle.style.pointerEvents = 'all';
  handle.style.cursor = 'grab';

  // Handlers look the edge up by id at event time: undo/open replace edge objects.
  for (const el of [hit, lhit]) {
    el.addEventListener('mousedown', e => e.stopPropagation());
    el.addEventListener('click', e => { e.stopPropagation(); selectEdgeById(id); });
    el.addEventListener('dblclick', e => { e.stopPropagation(); selectEdgeById(id); });
  }
  handle.addEventListener('mousedown', ev => {
    ev.stopPropagation(); ev.preventDefault();
    const onMove = mv => {
      const edge = state.edges.get(id);
      if (!edge) return;
      const wp = screenToWorld(mv.clientX, mv.clientY);
      edge.cp = { x: wp.x, y: wp.y };
      renderAllEdges();
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      import('./history.js').then(m => m.snapshot());
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });
  handle.addEventListener('dblclick', ev => {
    ev.stopPropagation();
    const edge = state.edges.get(id);
    if (!edge) return;
    edge.cp = null;
    renderAllEdges();
    import('./history.js').then(m => m.snapshot());
  });

  g.append(hit, path, bg, txt, lhit, handle);
  edgesWorld.appendChild(g);
  const els = { g, hit, path, bg, txt, lhit, handle, label: null };
  edgeEls.set(id, els);
  return els;
}

// Branch width by depth of the child end (1 = first level).
function branchWidth(depth) { return Math.max(1.6, 5.2 - 1.2 * (depth - 1)); }
const THICK_MUL = { thin: 0.55, normal: 1, thick: 1.6 };

export function renderAllEdges() {
  const tree = getTree();
  const seen = new Set();
  const groups = getEdgeGroups();

  // Tint default-coloured nodes with their branch colour.
  for (const n of state.nodes.values()) {
    const col = tree.branch.get(n.id) || '';
    if (n._branch !== col && n.el) {
      n._branch = col;
      if (col) n.el.style.setProperty('--branch', col);
      else n.el.style.removeProperty('--branch');
    }
    const hide = tree.hidden.has(n.id);
    if (n.el && n._hidden !== hide) { n._hidden = hide; n.el.classList.toggle('folded-away', hide); }
    updateFoldBadge(n, tree, hide);
  }

  for (const [, edges] of groups) {
    edges.forEach((edge, idx) => {
      const src = state.nodes.get(edge.source);
      const tgt = state.nodes.get(edge.target);
      if (!src || !tgt) return;
      seen.add(edge.id);
      const els = edgeEls.get(edge.id) || makeEdgeEls(edge.id);
      const hidden = tree.hidden.has(src.id) || tree.hidden.has(tgt.id);
      if (els.g.style.display !== (hidden ? 'none' : '')) els.g.style.display = hidden ? 'none' : '';
      if (hidden) return;
      drawEdge(els, edge, src, tgt, idx, edges.length, tree);
    });
  }
  for (const [id, els] of edgeEls) {
    if (!seen.has(id)) { els.g.remove(); edgeEls.delete(id); }
  }
  updateMinimap();
}

// "+N" badge on the outer side of a folded node; click to unfold.
function updateFoldBadge(n, tree, hide) {
  const kids = tree.children.get(n.id) || [];
  if (n.collapsed && kids.length && !hide) {
    if (!n.foldEl) {
      const b = document.createElement('div');
      b.className = 'fold-badge';
      b.title = 'Unfold branch (Ctrl+.)';
      const id = n.id;
      b.addEventListener('mousedown', e => e.stopPropagation());
      b.addEventListener('click', e => { e.stopPropagation(); App.toggleFold(id); });
      $('world').appendChild(b);
      n.foldEl = b;
    }
    let count = 0;
    const stack = [...kids];
    while (stack.length) { const c = stack.pop(); count++; stack.push(...(tree.children.get(c) || [])); }
    const label = '+' + count;
    if (n.foldEl.textContent !== label) n.foldEl.textContent = label;
    const p = tree.parent.get(n.id);
    const pn = p && state.nodes.get(p);
    const side = pn ? ((n.rx ?? n.x) - (pn.rx ?? pn.x) >= 0 ? 1 : -1) : 1;
    n.foldPos = { dx: side * (nodeSize(n).w / 2 + 14), dy: 0 };
    n.foldEl.style.setProperty('--fold', tree.branch.get(n.id) || EDGE_COLORS.default);
    placeNode(n);
  } else if (n.foldEl) {
    n.foldEl.remove(); n.foldEl = null; n.foldPos = null;
  }
}

function setAttr(el, name, val) {
  const s = String(val);
  if (el.getAttribute(name) !== s) el.setAttribute(name, s);
}

const f = v => Math.round(v * 10) / 10;

// Label box size (estimate; the export uses the same numbers).
export function labelBox(label) { return { tw: Math.max(label.length * 7 + 12, 30), th: 17 }; }

// Everything needed to draw one edge, from the nodes' on-screen positions.
// Shared by the screen renderer and the PNG/SVG/PDF export so they match.
export function edgeGeometry(edge, src, tgt, idx, total, tree, selectedId = state.selectedEdgeId) {
  const isSel = edge.id === selectedId;
  const isTree = tree.treeEdges.has(edge.id);
  const explicitColor = edge.color && edge.color !== 'default' ? EDGE_COLORS[edge.color] : null;
  const thick = THICK_MUL[edge.thickness] || 1;
  let d, hitD, midX, midY, tx, ty, fillMode = false, strokeW, color, opacity = 1, bulgeX = 0, bulgeY = 0;

  if (isTree) {
    // Parent -> child, horizontal tangents, tapering ribbon.
    const childIsTarget = tree.parent.get(edge.target) === edge.source;
    const P = childIsTarget ? src : tgt, C = childIsTarget ? tgt : src;
    const sp = nodeSize(P), sc = nodeSize(C);
    const ddx = rx(C) - rx(P), ddy = ry(C) - ry(P);
    // Drift: go vertical when the child sits mostly above/below its parent,
    // so free layouts do not loop.
    const vertical = state.physics.enabled && Math.abs(ddy) > Math.abs(ddx) * 1.2;
    const depth = tree.depth.get(C.id) || 1;
    const w0 = branchWidth(depth) * thick;
    const w1 = Math.max(1.1, w0 * 0.45);
    const a = w0 / 2, b = w1 / 2;
    color = isSel ? '#ffffff' : (explicitColor || tree.branch.get(C.id) || EDGE_COLORS.default);
    let sx, sy, ex, ey, c1x, c1y, c2x, c2y;
    if (!vertical) {
      const s = ddx >= 0 ? 1 : -1;
      sx = rx(P) + s * sp.w / 2; sy = ry(P);
      ex = rx(C) - s * sc.w / 2; ey = ry(C);
      const k = Math.max(18, Math.abs(ex - sx) * 0.55);
      c1x = sx + s*k; c1y = sy; c2x = ex - s*k; c2y = ey;
      d = `M${f(sx)},${f(sy-a)} C${f(c1x)},${f(sy-a)} ${f(c2x)},${f(ey-b)} ${f(ex)},${f(ey-b)}` +
          ` L${f(ex)},${f(ey+b)} C${f(c2x)},${f(ey+b)} ${f(c1x)},${f(sy+a)} ${f(sx)},${f(sy+a)} Z`;
    } else {
      const s = ddy >= 0 ? 1 : -1;
      sx = rx(P); sy = ry(P) + s * sp.h / 2;
      ex = rx(C); ey = ry(C) - s * sc.h / 2;
      const k = Math.max(18, Math.abs(ey - sy) * 0.55);
      c1x = sx; c1y = sy + s*k; c2x = ex; c2y = ey - s*k;
      d = `M${f(sx-a)},${f(sy)} C${f(sx-a)},${f(c1y)} ${f(ex-b)},${f(c2y)} ${f(ex-b)},${f(ey)}` +
          ` L${f(ex+b)},${f(ey)} C${f(ex+b)},${f(c2y)} ${f(sx+a)},${f(c1y)} ${f(sx+a)},${f(sy)} Z`;
    }
    hitD = `M${f(sx)},${f(sy)} C${f(c1x)},${f(c1y)} ${f(c2x)},${f(c2y)} ${f(ex)},${f(ey)}`;
    if (!edge.bidirectional && !edge.dash) fillMode = true;
    else d = hitD;
    strokeW = (w0 + w1) / 2;
    // Curve midpoint and its direction (cubic at t = 0.5).
    midX = (sx + 3*c1x + 3*c2x + ex) / 8; midY = (sy + 3*c1y + 3*c2y + ey) / 8;
    tx = 0.75*(c1x - sx) + 1.5*(c2x - c1x) + 0.75*(ex - c2x);
    ty = 0.75*(c1y - sy) + 1.5*(c2y - c1y) + 0.75*(ey - c2y);
  } else {
    // Cross-link: gentle curve, lighter, keeps arrowheads and label.
    const sxc = rx(src), syc = ry(src), txc = rx(tgt), tyc = ry(tgt);
    const mx = (sxc + txc) / 2, my = (syc + tyc) / 2;
    const dx = txc - sxc, dy = tyc - syc;
    const len = Math.hypot(dx, dy) || 1;
    // Normal is defined on the canonical (sorted) pair so parallel edges spread apart.
    const flip = edge.source < edge.target ? 1 : -1;
    const nxu = -dy / len * flip, nyu = dx / len * flip;
    const groupOff = total > 1 ? (idx - (total - 1) / 2) * EDGE_OFFSET : 0;
    const bulge = Math.min(70, len * 0.16) + groupOff;
    const cpx = edge.cp ? edge.cp.x : mx + nxu * bulge;
    const cpy = edge.cp ? edge.cp.y : my + nyu * bulge;
    const [sx, sy] = nodeEdgePoint(src, cpx, cpy);
    const [ex, ey] = nodeEdgePoint(tgt, cpx, cpy);
    d = `M${f(sx)},${f(sy)} Q${f(cpx)},${f(cpy)} ${f(ex)},${f(ey)}`;
    hitD = d;
    strokeW = 1.5 * thick;
    color = isSel ? '#ffffff' : (explicitColor || EDGE_COLORS.default);
    opacity = isSel ? 1 : 0.72;
    midX = (sx + 2 * cpx + ex) / 4; midY = (sy + 2 * cpy + ey) / 4;
    tx = ex - sx; ty = ey - sy;
    bulgeX = cpx - (sx + ex) / 2; bulgeY = cpy - (sy + ey) / 2;
  }

  // Label sits beside the line, not on it: pushed out along the curve's normal
  // just far enough that the label box clears the stroke. Branches put it
  // above (or right of a vertical one); cross-links on the outside of the bend.
  let labelX = midX, labelY = midY, tw = 0, th = 0;
  const label = edge.label || '';
  if (label) {
    ({ tw, th } = labelBox(label));
    const tl = Math.hypot(tx, ty) || 1;
    let nx = -ty / tl, ny = tx / tl;
    if (isTree) { if (ny > 0.05 || (Math.abs(ny) <= 0.05 && nx < 0)) { nx = -nx; ny = -ny; } }
    else if (nx * bulgeX + ny * bulgeY < 0) { nx = -nx; ny = -ny; }
    const off = Math.abs(nx) * tw / 2 + Math.abs(ny) * th / 2 + strokeW / 2 + 3;
    labelX = midX + nx * off; labelY = midY + ny * off;
  }

  return {
    isSel, isTree, d, hitD, fillMode, strokeW, color, opacity, label, labelX, labelY, tw, th,
    handleX: !isTree && edge.cp ? edge.cp.x : midX, handleY: !isTree && edge.cp ? edge.cp.y : midY,
    markerColor: isSel ? 'selected' : (edge.color || 'default'),
  };
}

function drawEdge(els, edge, src, tgt, idx, total, tree) {
  const { isSel, isTree, d, hitD, fillMode, strokeW, color, opacity, label, labelX, labelY, tw, th,
          handleX, handleY, markerColor } = edgeGeometry(edge, src, tgt, idx, total, tree);

  const { path, hit, bg, txt, lhit, handle, g } = els;
  setAttr(path, 'd', d);
  setAttr(hit, 'd', hitD);
  path.classList.toggle('selected', isSel);
  path.classList.toggle('tree-edge', isTree);
  path.style.stroke = color;
  path.style.fill = fillMode ? color : 'none';
  path.style.strokeWidth = fillMode ? '0.6' : String(strokeW);
  path.style.strokeOpacity = String(opacity);
  path.style.strokeDasharray = edge.dash ? '7 4' : '';
  // Arrowheads: cross-links always; tree branches only when explicitly bidirectional.
  if (!isTree || edge.bidirectional) setAttr(path, 'marker-end', `url(#arr-${markerColor})`);
  else if (path.hasAttribute('marker-end')) path.removeAttribute('marker-end');
  if (edge.bidirectional) setAttr(path, 'marker-start', `url(#arr-start-${markerColor})`);
  else if (path.hasAttribute('marker-start')) path.removeAttribute('marker-start');

  if (label) {
    for (const r of [bg, lhit]) {
      setAttr(r, 'x', f(labelX - tw / 2)); setAttr(r, 'y', f(labelY - th / 2));
      setAttr(r, 'width', tw); setAttr(r, 'height', th);
    }
    setAttr(txt, 'x', f(labelX)); setAttr(txt, 'y', f(labelY));
    if (els.label !== label) { txt.textContent = label; els.label = label; }
    txt.classList.toggle('selected', isSel);
    bg.style.display = txt.style.display = lhit.style.display = '';
  } else if (els.label !== '') {
    els.label = '';
    txt.textContent = '';
    bg.style.display = txt.style.display = lhit.style.display = 'none';
  }

  setAttr(handle, 'cx', f(handleX)); setAttr(handle, 'cy', f(handleY));
  handle.classList.toggle('active', !!edge.cp && !isTree);
  handle.classList.toggle('tree-handle', isTree);
  g.classList.toggle('cross-link', !isTree);
}

// Wholesale map replace (open / new / undo): drop every cached edge and
// minimap element and any node DOM left in #world, so nothing stale stays drawn.
export function resetRenderCaches() {
  for (const [, els] of edgeEls) els.g.remove();
  edgeEls.clear();
  edgesWorld.querySelectorAll('.edge-g').forEach(g => g.remove());
  $('world').querySelectorAll('.node, .fold-badge, .reparent-ghost-box').forEach(el => el.remove());
  if (minimapSvg) minimapSvg.innerHTML = '';
  mmEdges.clear(); mmNodes.clear();
  mmEdgeLayer = mmNodeLayer = mmView = null;
  clearSizes();
}

export function highlightSelected() {
  for (const n of state.nodes.values()) {
    if (!n.el) continue;
    const isSelected = n.id === state.selectedNodeId || state.selectedNodeIds.has(n.id);
    n.el.classList.toggle('selected', isSelected);
    if (state.mode === 'edge') {
      n.el.classList.toggle('edge-source', n.id === state.edgeSourceId);
      n.el.classList.toggle('edge-target',
        n.id === state.selectedNodeId && n.id !== state.edgeSourceId);
      n.el.classList.toggle('edge-candidate',
        n.id !== state.edgeSourceId && n.id !== state.selectedNodeId);
    } else {
      n.el.classList.remove('edge-source', 'edge-candidate', 'edge-target');
    }
  }
  edgesSvg.querySelectorAll('.edge-path').forEach(p => {
    p.classList.toggle('selected', p.dataset.id === state.selectedEdgeId);
  });
  edgesSvg.querySelectorAll('.edge-label-text').forEach(t => {
    t.classList.toggle('selected', t.dataset.id === state.selectedEdgeId);
  });
  markEdgesDirty();   // selected edge colour is set at draw time
}

// ─── Minimap ──────────────────────────────────────────────────────────────────
// Elements are kept per id and only their attributes change.
export const MM_W = 160, MM_H = 110;
export let minimapState = { scale: 1, offX: 0, offY: 0 };
const mmEdges = new Map(), mmNodes = new Map();
let mmEdgeLayer = null, mmNodeLayer = null, mmView = null;

function ensureMinimapLayers() {
  if (mmView && mmView.isConnected) return;
  minimapSvg.innerHTML = '';
  mmEdges.clear(); mmNodes.clear();
  mmEdgeLayer = document.createElementNS(SVGNS, 'g');
  mmNodeLayer = document.createElementNS(SVGNS, 'g');
  mmView = document.createElementNS(SVGNS, 'rect');
  mmView.setAttribute('fill', 'rgba(240,104,32,0.08)');
  mmView.setAttribute('stroke', '#f06820');
  mmView.setAttribute('stroke-width', '1');
  minimapSvg.append(mmEdgeLayer, mmNodeLayer, mmView);
}

export function updateMinimap() {
  if (!minimapSvg) return;
  ensureMinimapLayers();
  const tree = getTree();

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of state.nodes.values()) {
    if (tree.hidden.has(n.id)) continue;
    const x = rx(n), y = ry(n);
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  if (minX === Infinity) { minX = minY = 0; maxX = maxY = 0; }
  const pad = 40;
  minX -= pad; minY -= pad; maxX += pad; maxY += pad;
  const bw = maxX - minX || 1, bh = maxY - minY || 1;
  const scale = Math.min(MM_W / bw, MM_H / bh);
  const offX = (MM_W - bw * scale) / 2 - minX * scale;
  const offY = (MM_H - bh * scale) / 2 - minY * scale;
  minimapState = { scale, offX, offY };
  const wx = x => f(x * scale + offX);
  const wy = y => f(y * scale + offY);

  const seenE = new Set();
  for (const edge of state.edges.values()) {
    const src = state.nodes.get(edge.source), tgt = state.nodes.get(edge.target);
    if (!src || !tgt) continue;
    seenE.add(edge.id);
    let line = mmEdges.get(edge.id);
    if (!line) {
      line = document.createElementNS(SVGNS, 'line');
      line.setAttribute('stroke-width', '0.8');
      mmEdgeLayer.appendChild(line); mmEdges.set(edge.id, line);
    }
    setAttr(line, 'x1', wx(rx(src))); setAttr(line, 'y1', wy(ry(src)));
    setAttr(line, 'x2', wx(rx(tgt))); setAttr(line, 'y2', wy(ry(tgt)));
    const col = (edge.color && edge.color !== 'default' && EDGE_COLORS[edge.color])
      || tree.branch.get(tree.parent.get(edge.target) === edge.source ? edge.target : edge.source)
      || EDGE_COLORS.default;
    setAttr(line, 'stroke', col);
    const hide = tree.hidden.has(src.id) || tree.hidden.has(tgt.id);
    line.style.display = hide ? 'none' : '';
  }
  for (const [id, el] of mmEdges) if (!seenE.has(id)) { el.remove(); mmEdges.delete(id); }

  const seenN = new Set();
  for (const n of state.nodes.values()) {
    seenN.add(n.id);
    let c = mmNodes.get(n.id);
    if (!c) {
      c = document.createElementNS(SVGNS, 'circle');
      c.setAttribute('r', 3);
      mmNodeLayer.appendChild(c); mmNodes.set(n.id, c);
    }
    setAttr(c, 'cx', wx(rx(n))); setAttr(c, 'cy', wy(ry(n)));
    const isSel = n.id === state.selectedNodeId || state.selectedNodeIds.has(n.id);
    setAttr(c, 'fill', isSel ? '#f06820' : '#7b84a3');
    c.style.display = tree.hidden.has(n.id) ? 'none' : '';
  }
  for (const [id, el] of mmNodes) if (!seenN.has(id)) { el.remove(); mmNodes.delete(id); }

  updateMinimapViewport();
}

export function updateMinimapViewport() {
  if (!minimapSvg) return;
  ensureMinimapLayers();
  const { scale, offX, offY } = minimapState;
  const v1 = screenToWorld(0, 0);
  const v2 = screenToWorld(window.innerWidth, window.innerHeight);
  setAttr(mmView, 'x', f(v1.x * scale + offX)); setAttr(mmView, 'y', f(v1.y * scale + offY));
  setAttr(mmView, 'width', f(Math.max(0, (v2.x - v1.x) * scale)));
  setAttr(mmView, 'height', f(Math.max(0, (v2.y - v1.y) * scale)));
}

// Minimap click: glide the camera there.
minimapEl.addEventListener('click', e => {
  e.stopPropagation();
  const r = minimapEl.getBoundingClientRect();
  const mx = e.clientX - r.left, my = e.clientY - r.top;
  const { scale, offX, offY } = minimapState;
  const wx = (mx - offX) / scale;
  const wy = (my - offY) / scale;
  import('./camera.js').then(m => m.centerOn({ x: wx, y: wy }));
});
