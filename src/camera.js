import { state, $ } from './state.js';
import { clamp } from './utils.js';
import { updateMinimapViewport, updateStatus } from './render.js';
import { animateCamera, easeCameraTo, getCameraTarget } from './frame.js';

const world = $('world');
const edgesWorld = $('edges-world');

export const MIN_ZOOM = 0.1, MAX_ZOOM = 4;

// ─── Camera ──────────────────────────────────────────────────────────────────
export function applyCam() {
  const { x, y, zoom } = state.camera;
  world.style.transform = `translate(${x}px,${y}px) scale(${zoom})`;
  edgesWorld.setAttribute('transform', `translate(${x},${y}) scale(${zoom})`);
  updateMinimapViewport();   // only the viewport rect; the map itself is untouched
}

export function worldToScreen(wx, wy) {
  return {
    x: wx * state.camera.zoom + state.camera.x,
    y: wy * state.camera.zoom + state.camera.y,
  };
}

export function screenToWorld(sx, sy) {
  return {
    x: (sx - state.camera.x) / state.camera.zoom,
    y: (sy - state.camera.y) / state.camera.zoom,
  };
}

// Animated centre on a node (pass { animate: false } to jump).
export function centerOn(node, opts = {}) {
  const W = window.innerWidth, H = window.innerHeight;
  const zoom = state.camera.zoom;
  const to = { x: W / 2 - node.x * zoom, y: H / 2 - node.y * zoom, zoom };
  if (opts.animate === false) { Object.assign(state.camera, to); applyCam(); return; }
  animateCamera(to);
}

// Zoom about a screen point. Animated by default (keyboard / buttons).
export function zoomBy(factor, cx, cy, opts = {}) {
  cx = cx ?? window.innerWidth / 2;
  cy = cy ?? window.innerHeight / 2;
  const base = getCameraTarget();
  const newZoom = clamp(base.zoom * factor, MIN_ZOOM, MAX_ZOOM);
  const scale = newZoom / base.zoom;
  const to = { x: cx - (cx - base.x) * scale, y: cy - (cy - base.y) * scale, zoom: newZoom };
  if (opts.animate === false) { Object.assign(state.camera, to); applyCam(); }
  else if (opts.smooth) easeCameraTo(to);
  else animateCamera(to, 220);
  updateStatus();
}

export function setZoom(z) {
  const W = window.innerWidth / 2, H = window.innerHeight / 2;
  zoomBy(z / getCameraTarget().zoom, W, H);
}
