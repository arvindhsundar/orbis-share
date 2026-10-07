import { state } from './state.js';

// ─── One rAF loop for everything that moves ──────────────────────────────────
// Node glides (FLIP-style tweens from the rendered position to the layout
// target), camera easing, pan inertia, and the edge redraw that follows them
// all run in the same frame, so edges never lag behind nodes.
//
// Every node has a logical position (x, y: what the layout / file says) and a
// rendered position (rx, ry: what is on screen right now).

let raf = null;
const dirty = { edges: false, layout: false };
const nodeAnims = new Map();      // id -> { fx, fy, t0, dur }
let camAnim = null;               // { from, to, t0, dur }
let camTarget = null;             // eased wheel target { x, y, zoom }
let inertia = null;               // { vx, vy } px per ms
let lastTick = 0;

const hooks = { layout: null, renderEdges: null, applyCam: null, afterSettle: [] };
export function setFrameHooks(h) { Object.assign(hooks, h); }

const easeInOut = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

function request() { if (!raf) raf = requestAnimationFrame(tick); }

export function isAnimating() {
  return !!(raf || nodeAnims.size || camAnim || camTarget || inertia);
}

// ─── Node placement ──────────────────────────────────────────────────────────
export function placeNode(n) {
  if (n.rx === undefined || n.rx === null) { n.rx = n.x; n.ry = n.y; }
  if (n.el) n.el.style.transform = `translate(${n.rx}px,${n.ry}px) translate(-50%,-50%)`;
  if (n.foldEl && n.foldPos) {
    n.foldEl.style.transform = `translate(${n.rx + n.foldPos.dx}px,${n.ry + n.foldPos.dy}px) translate(-50%,-50%)`;
  }
}

// Jump: logical and rendered position together, no animation.
export function setNodePos(n, x, y) {
  n.x = x; n.y = y; n.rx = x; n.ry = y;
  nodeAnims.delete(n.id);
  placeNode(n);
}

// Spring the rendered position to the logical one. A node already moving
// keeps its speed, so a new target mid-flight bends the path instead of
// restarting it. `kick` (px/s) gives a starting push, e.g. a pop on create.
// Tuned for a small overshoot and a settle in about half a second.
const OMEGA = 15, ZETA = 0.6;
export function tweenNode(n, _dur, kick = null) {
  if (n.rx === undefined || n.rx === null) { n.rx = n.x; n.ry = n.y; }
  const a = nodeAnims.get(n.id) || { vx: 0, vy: 0 };
  if (kick) { a.vx += kick.x; a.vy += kick.y; }
  if (Math.abs(n.rx - n.x) < 0.5 && Math.abs(n.ry - n.y) < 0.5 && Math.hypot(a.vx, a.vy) < 5) {
    nodeAnims.delete(n.id);
    n.rx = n.x; n.ry = n.y; placeNode(n);
    return;
  }
  nodeAnims.set(n.id, a);
  request();
}

export function stopNodeTween(n) { nodeAnims.delete(n.id); }
export function isTweening(n) { return nodeAnims.has(n.id); }

export function markEdgesDirty() { dirty.edges = true; request(); }
export function markLayoutDirty() { dirty.layout = true; request(); }

// ─── Camera motion ───────────────────────────────────────────────────────────
export function animateCamera(to, dur = 340) {
  camTarget = null; inertia = null;
  const from = { ...state.camera };
  camAnim = { from, to: { x: to.x, y: to.y, zoom: to.zoom ?? from.zoom }, t0: performance.now(), dur };
  request();
}

// Eased approach to a target (used for mouse-wheel steps).
export function easeCameraTo(to) {
  camAnim = null; inertia = null;
  camTarget = { x: to.x, y: to.y, zoom: to.zoom };
  request();
}
export function getCameraTarget() { return camTarget || (camAnim && camAnim.to) || state.camera; }

export function startInertia(vx, vy) {
  camAnim = null; camTarget = null;
  if (Math.hypot(vx, vy) < 0.05) { inertia = null; return; }
  inertia = { vx, vy };
  request();
}

export function stopCameraMotion() { camAnim = null; camTarget = null; inertia = null; }

export function onSettled(fn) { hooks.afterSettle.push(fn); request(); }

// ─── The loop ────────────────────────────────────────────────────────────────
function tick(now) {
  raf = null;
  const t = performance.now();
  const dt = lastTick ? Math.min(48, t - lastTick) : 16;
  lastTick = t;

  if (dirty.layout) { dirty.layout = false; hooks.layout && hooks.layout(); }

  let moved = false;
  const steps = Math.max(1, Math.ceil(dt / 8)), h = dt / 1000 / steps;
  for (const [id, a] of nodeAnims) {
    const n = state.nodes.get(id);
    if (!n || n.dragging) { nodeAnims.delete(id); continue; }
    for (let i = 0; i < steps; i++) {        // damped spring, small fixed steps
      a.vx += (OMEGA * OMEGA * (n.x - n.rx) - 2 * ZETA * OMEGA * a.vx) * h;
      a.vy += (OMEGA * OMEGA * (n.y - n.ry) - 2 * ZETA * OMEGA * a.vy) * h;
      n.rx += a.vx * h; n.ry += a.vy * h;
    }
    if (Math.abs(n.x - n.rx) < 0.3 && Math.abs(n.y - n.ry) < 0.3 && Math.hypot(a.vx, a.vy) < 4) {
      n.rx = n.x; n.ry = n.y; nodeAnims.delete(id);
    }
    placeNode(n);
    moved = true;
  }

  let camMoved = false;
  const cam = state.camera;
  if (camAnim) {
    const p = Math.max(0, Math.min(1, (t - camAnim.t0) / camAnim.dur));
    const e = easeInOut(p);
    const { from, to } = camAnim;
    // Interpolate zoom in log space so zoom-in and zoom-out feel symmetric.
    const z = Math.exp(Math.log(from.zoom) + (Math.log(to.zoom) - Math.log(from.zoom)) * e);
    // Keep the world point under the screen centre on a straight path.
    const W = window.innerWidth / 2, H = window.innerHeight / 2;
    const fc = { x: (W - from.x) / from.zoom, y: (H - from.y) / from.zoom };
    const tc = { x: (W - to.x) / to.zoom, y: (H - to.y) / to.zoom };
    const cx = fc.x + (tc.x - fc.x) * e, cy = fc.y + (tc.y - fc.y) * e;
    cam.zoom = z; cam.x = W - cx * z; cam.y = H - cy * z;
    camMoved = true;
    if (p >= 1) { Object.assign(cam, to); camAnim = null; }
  } else if (camTarget) {
    const k = 1 - Math.pow(1 - 0.28, dt / 16);
    cam.x += (camTarget.x - cam.x) * k;
    cam.y += (camTarget.y - cam.y) * k;
    cam.zoom += (camTarget.zoom - cam.zoom) * k;
    camMoved = true;
    if (Math.abs(camTarget.x - cam.x) < 0.3 && Math.abs(camTarget.y - cam.y) < 0.3 && Math.abs(camTarget.zoom - cam.zoom) < 0.0005) {
      Object.assign(cam, camTarget); camTarget = null;
    }
  } else if (inertia) {
    cam.x += inertia.vx * dt; cam.y += inertia.vy * dt;
    const decay = Math.pow(0.92, dt / 16);
    inertia.vx *= decay; inertia.vy *= decay;
    camMoved = true;
    if (Math.hypot(inertia.vx, inertia.vy) < 0.02) inertia = null;
  }

  if (moved || dirty.edges) { dirty.edges = false; hooks.renderEdges && hooks.renderEdges(); }
  if (camMoved && hooks.applyCam) hooks.applyCam();

  if (nodeAnims.size || camAnim || camTarget || inertia || dirty.layout || dirty.edges) {
    request();
  } else {
    lastTick = 0;
    if (hooks.afterSettle.length) {
      const fns = hooks.afterSettle.splice(0);
      fns.forEach(fn => fn());
    }
  }
}
