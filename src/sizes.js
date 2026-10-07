// ─── Node size cache ─────────────────────────────────────────────────────────
// Reading offsetWidth per node per frame forces layout (thrash). Sizes are
// cached by node id and kept fresh by a ResizeObserver; a size change asks the
// app to re-run the tidy layout (label edits grow the node, siblings shift).

const sizes = new Map();          // nodeId -> { w, h }
let onResize = null;

export function setResizeHandler(fn) { onResize = fn; }

const ro = typeof ResizeObserver !== 'undefined'
  ? new ResizeObserver(entries => {
      let changed = false;
      const grown = [];   // { id, dw, dh } for nodes that were already measured
      for (const entry of entries) {
        const el = entry.target;
        const id = el.dataset.id;
        if (!id) continue;
        const box = entry.borderBoxSize && entry.borderBoxSize[0];
        const w = box ? box.inlineSize : el.offsetWidth;
        const h = box ? box.blockSize : el.offsetHeight;
        if (!w || !h) continue;                 // hidden (collapsed) or tearing down
        const prev = sizes.get(id);
        if (!prev || Math.abs(prev.w - w) > 0.5 || Math.abs(prev.h - h) > 0.5) {
          // Only a change of the node's own text counts as "grew" (a font
          // finishing loading or a style change resizes it without new text).
          const t = el.textContent;
          if (prev && prev.t !== undefined && prev.t !== t) grown.push({ id, dw: w - prev.w, dh: h - prev.h });
          sizes.set(id, { w, h, t });
          changed = true;
        }
      }
      if (changed && onResize) onResize(grown);
    })
  : null;

export function observeNode(node) {
  if (!node.el) return;
  if (ro) ro.observe(node.el);
}

export function unobserveNode(node) {
  if (node.el && ro) ro.unobserve(node.el);
}

export function forgetNode(id) { sizes.delete(id); }

// Whole map replaced (open / new / undo): old sizes would read as "grew".
export function clearSizes() { sizes.clear(); }


// Size of a node; measures once (and caches) if the observer has not reported yet.
export function nodeSize(node) {
  let s = sizes.get(node.id);
  if (s) return s;
  const el = node.el;
  if (el && el.isConnected) {
    const w = el.offsetWidth, h = el.offsetHeight;
    if (w && h) { s = { w, h, t: el.textContent }; sizes.set(node.id, s); return s; }
  }
  return { w: 100, h: 37 };
}
