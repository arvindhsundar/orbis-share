// ─── Utilities ───────────────────────────────────────────────────────────────
export function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function clamp(v, lo, hi) { return Math.min(Math.max(v, lo), hi); }

export function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
