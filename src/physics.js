import { state } from './state.js';
import { renderAllEdges, updateStatus } from './render.js';
import { nodeSize } from './sizes.js';
import { placeNode, stopNodeTween, markLayoutDirty } from './frame.js';
import { getTree } from './layout.js';

// ─── Physics ─────────────────────────────────────────────────────────────────
// Alpha cooling (à la d3-force): forces scale with alpha, which decays each
// tick from 1 → 0. This guarantees the simulation terminates rather than
// oscillating forever around equilibrium.
const ALPHA_DECAY = 0.03;   // reaches ~0.001 in ~225 ticks (~3.5s at 60fps)
const ALPHA_MIN   = 0.001;
let alpha = 0;

// "Something changed." With Drift off this re-runs the tidy layout (next
// frame, animated); with Drift on it reheats the force simulation.
export function kickPhysics() {
  if (!state.physics.enabled) { markLayoutDirty(); return; }
  alpha = 1;  // always reheat — forces start fresh
  if (state.physicsRunning) return;
  state.physicsRunning = true;
  physicsLoop();
}

export function physicsLoop() {
  if (!state.physics.enabled || alpha < ALPHA_MIN) {
    state.physicsRunning = false;
    return;
  }

  const hidden = getTree().hidden;
  const nodes = [...state.nodes.values()].filter(n => !hidden.has(n.id));
  const edges = [...state.edges.values()].filter(e => !hidden.has(e.source) && !hidden.has(e.target));
  const { repulsion, linkDistance, linkStrength, damping } = state.physics;

  for (const n of nodes) {
    const { w, h } = nodeSize(n);   // cached: no layout reads per frame
    n._r = Math.hypot(w / 2, h / 2);
  }

  // Repulsion — scaled by alpha
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      const dx = b.x - a.x, dy = b.y - a.y;
      const d   = Math.hypot(dx, dy) || 1;
      const gap = Math.max(d - a._r - b._r, 1);
      const force = repulsion / (gap * gap) * alpha;
      const fx = (dx/d) * force, fy = (dy/d) * force;
      if (!a.pinned && !a.dragging) { a.vx -= fx; a.vy -= fy; }
      if (!b.pinned && !b.dragging) { b.vx += fx; b.vy += fy; }
    }
  }

  for (const n of nodes) delete n._r;

  // Spring attraction — scaled by alpha
  for (const edge of edges) {
    const a = state.nodes.get(edge.source), b = state.nodes.get(edge.target);
    if (!a || !b) continue;
    const dx = b.x - a.x, dy = b.y - a.y;
    const d = Math.hypot(dx, dy) || 1;
    const diff = (d - linkDistance) / d * linkStrength * alpha;
    const fx = dx * diff, fy = dy * diff;
    if (!a.pinned && !a.dragging) { a.vx += fx; a.vy += fy; }
    if (!b.pinned && !b.dragging) { b.vx -= fx; b.vy -= fy; }
  }

  // Cancel net center-of-mass velocity to prevent the whole graph from drifting
  const free = nodes.filter(n => !n.pinned && !n.dragging);
  if (free.length > 0) {
    const cmvx = free.reduce((s,n) => s+n.vx, 0) / free.length;
    const cmvy = free.reduce((s,n) => s+n.vy, 0) / free.length;
    for (const n of free) { n.vx -= cmvx; n.vy -= cmvy; }
  }

  const MAX_V = 50;
  for (const n of nodes) {
    if (n.pinned || n.dragging) { n.vx = 0; n.vy = 0; continue; }
    n.vx *= damping; n.vy *= damping;
    const speed = Math.hypot(n.vx, n.vy);
    if (speed > MAX_V) { n.vx = n.vx / speed * MAX_V; n.vy = n.vy / speed * MAX_V; }
    n.x += n.vx; n.y += n.vy;
    stopNodeTween(n);
    n.rx = n.x; n.ry = n.y;
    placeNode(n);
  }

  alpha *= (1 - ALPHA_DECAY);

  renderAllEdges();
  updateStatus();

  state.physicsRaf = requestAnimationFrame(physicsLoop);
}
