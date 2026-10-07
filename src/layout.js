import { state } from './state.js';
import { nodeSize } from './sizes.js';

// ─── Spanning tree over the concept graph ────────────────────────────────────
// The map is a GRAPH. For drawing and tidy layout we pick, per connected
// component, a root and a BFS spanning tree. Tree edges become curved
// branches; every other edge is a cross-link.
//
// Root choice (deterministic, sticky):
//   1. a node flagged `root: true` (optional field, saved in the file)
//   2. otherwise: a node with no incoming edges, then most connections,
//      then insertion order.
// Children follow outgoing edges first; nodes only reachable "backwards"
// are attached afterwards so every node in the component is in the tree.

export const BRANCH_PALETTE = ['#2a9db8', '#d09028', '#3d9c68', '#8a6cc0', '#d05050', '#3a72d0', '#c040b0', '#7a9a30'];

export const NODE_COLOR_HEX = {
  purple: '#7b5ea7', green: '#3d8c60', amber: '#c07818', coral: '#c04040',
  teal: '#2a8098', blue: '#3060c0', pink: '#b030a0',
};

let cache = { sig: null, tree: null };

function signature() {
  let s = '';
  for (const n of state.nodes.values()) s += n.id + (n.root ? '*' : '') + (n.collapsed ? '^' : '') + (n.color || '') + ',';
  s += '|';
  for (const e of state.edges.values()) s += e.id + ':' + e.source + '>' + e.target + ',';
  return s;
}

export function invalidateTree() { cache.sig = null; }

export function getTree() {
  const sig = signature();
  if (sig === cache.sig) return cache.tree;
  cache = { sig, tree: buildTree() };
  return cache.tree;
}

function buildTree() {
  const nodes = [...state.nodes.values()];
  const order = new Map(nodes.map((n, i) => [n.id, i]));
  const out = new Map(), inn = new Map();
  for (const n of nodes) { out.set(n.id, []); inn.set(n.id, []); }
  for (const e of state.edges.values()) {
    if (!out.has(e.source) || !out.has(e.target) || e.source === e.target) continue;
    out.get(e.source).push({ e, o: e.target });
    inn.get(e.target).push({ e, o: e.source });
  }

  const parent = new Map(), parentEdge = new Map(), children = new Map(), depth = new Map();
  const rootOf = new Map(), roots = [], treeEdges = new Set();
  for (const n of nodes) children.set(n.id, []);

  // Connected components (undirected), in node order.
  const seen = new Set();
  const comps = [];
  for (const n of nodes) {
    if (seen.has(n.id)) continue;
    const comp = [];
    const q = [n.id]; seen.add(n.id);
    while (q.length) {
      const id = q.shift(); comp.push(id);
      for (const { o } of out.get(id)) if (!seen.has(o)) { seen.add(o); q.push(o); }
      for (const { o } of inn.get(id)) if (!seen.has(o)) { seen.add(o); q.push(o); }
    }
    comp.sort((a, b) => order.get(a) - order.get(b));
    comps.push(comp);
  }

  for (const comp of comps) {
    let root = comp.find(id => state.nodes.get(id).root);
    if (!root) {
      let best = null, bestScore = -Infinity;
      for (const id of comp) {
        const score = (inn.get(id).length === 0 ? 1e6 : 0) + out.get(id).length + inn.get(id).length;
        if (score > bestScore) { bestScore = score; best = id; }
      }
      root = best;
    }
    roots.push(root);
    const visited = new Set([root]);
    const visitOrder = [root];
    depth.set(root, 0); rootOf.set(root, root);
    const attach = (child, par, e) => {
      visited.add(child); visitOrder.push(child);
      parent.set(child, par); parentEdge.set(child, e.id); treeEdges.add(e.id);
      children.get(par).push(child);
      depth.set(child, depth.get(par) + 1); rootOf.set(child, root);
    };
    let queue = [root];
    while (true) {
      while (queue.length) {
        const u = queue.shift();
        for (const { e, o } of out.get(u)) if (!visited.has(o)) { attach(o, u, e); queue.push(o); }
      }
      // Nodes reachable only against edge direction.
      let added = false;
      for (const u of visitOrder) {
        for (const { e, o } of inn.get(u)) {
          if (!visited.has(o)) { attach(o, u, e); queue.push(o); added = true; }
        }
        if (added) break;
      }
      if (!added) break;
    }
  }

  // Keep the root choice sticky: flag the roots, unflag everything else.
  // (Optional `root` field; written to the file only when true.)
  const rootSet = new Set(roots);
  for (const n of nodes) {
    if (rootSet.has(n.id)) { if (!n.root) n.root = true; }
    else if (n.root) delete n.root;
  }

  // Branch colours: each first-level branch gets its own colour. Below that,
  // siblings take neighbouring shades of their parent's colour and each level
  // out gets a little lighter. A node with an explicit colour starts afresh
  // from that colour.
  const branch = new Map();
  const hidden = new Set();
  for (const root of roots) {
    const rn = state.nodes.get(root);
    if (rn.color && rn.color !== 'default' && NODE_COLOR_HEX[rn.color]) branch.set(root, NODE_COLOR_HEX[rn.color]);
    children.get(root).forEach((c, i) => paint(c, hexToHsl(BRANCH_PALETTE[i % BRANCH_PALETTE.length]), rn.collapsed, true));
  }
  function paint(id, base, isHidden, isFirst) {
    const n = state.nodes.get(id);
    const own = n.color && n.color !== 'default' ? NODE_COLOR_HEX[n.color] : null;
    const hsl = own ? hexToHsl(own) : base;
    branch.set(id, hslToHex(hsl));
    if (isHidden) hidden.add(id);
    const kids = children.get(id);
    kids.forEach((c, i) => paint(c, shadeFor(hsl, i, kids.length), isHidden || !!n.collapsed, false));
  }

  return { parent, parentEdge, children, depth, roots, rootOf, treeEdges, branch, hidden };
}

// Child shade: hue nudged per sibling (0, +12, -12, +24, -24 ... degrees),
// a step lighter than the parent, capped so text on it stays readable.
const HUE_STEP = 12, LIGHT_STEP = 6, LIGHT_MAX = 68;
function shadeFor([h, s, l], i, count) {
  const k = count > 1 ? Math.ceil(i / 2) * (i % 2 ? 1 : -1) : 0;
  return [(h + k * HUE_STEP + 360) % 360, s, Math.min(LIGHT_MAX, l + LIGHT_STEP)];
}

export function hexToHsl(hex) {
  const v = parseInt(hex.slice(1), 16);
  const r = (v >> 16 & 255) / 255, g = (v >> 8 & 255) / 255, b = (v & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60;
  }
  return [h, s * 100, l * 100];
}

export function hslToHex([h, s, l]) {
  s /= 100; l /= 100;
  const a = s * Math.min(l, 1 - l);
  const ch = n => {
    const k = (n + h / 30) % 12;
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255).toString(16).padStart(2, '0');
  };
  return '#' + ch(0) + ch(8) + ch(4);
}

// ─── Where a new child goes (no tidy run) ────────────────────────────────────
// Beside its parent, below the parent's last visible child on that side.
// Nothing else moves. Side: away from the grandparent; for a root, the side
// with fewer children (right on a tie). `exclude` = ids to ignore (a branch
// being dragged).
export function childSlot(parentId, w, h, exclude = new Set(), tree = getTree()) {
  const p = state.nodes.get(parentId);
  const { w: pw } = nodeSize(p);
  const kids = p.collapsed ? [] : (tree.children.get(parentId) || []).filter(id => !exclude.has(id));
  const gp = tree.parent.get(parentId) && state.nodes.get(tree.parent.get(parentId));
  let s;
  if (gp) s = p.x >= gp.x ? 1 : -1;
  else {
    let right = 0, left = 0;
    for (const id of kids) { if (state.nodes.get(id).x >= p.x) right++; else left++; }
    s = left < right ? -1 : 1;
  }
  const sameSide = kids.map(id => state.nodes.get(id)).filter(c => (c.x - p.x) * s > 0);
  let slot;
  if (sameSide.length) {
    let last = sameSide[0];
    for (const c of sameSide) if (c.y + nodeSize(c).h / 2 > last.y + nodeSize(last).h / 2) last = c;
    const ls = nodeSize(last);
    slot = { x: last.x - s * ls.w / 2 + s * w / 2, y: last.y + ls.h / 2 + V_GAP + h / 2, side: s };
  } else {
    slot = { x: p.x + s * (pw / 2 + (gp ? H_GAP : H_GAP_ROOT) + w / 2), y: p.y, side: s };
  }
  // Something already there (another branch reaching across)? Step down below it.
  const others = [...state.nodes.values()].filter(n => !exclude.has(n.id) && !tree.hidden.has(n.id));
  for (let guard = 0; guard < 200; guard++) {
    const hit = others.find(n => {
      const ns = nodeSize(n);
      return Math.abs(n.x - slot.x) * 2 < ns.w + w + 8 && Math.abs(n.y - slot.y) * 2 < ns.h + h + 2 * V_GAP - 2;
    });
    if (!hit) break;
    slot.y = hit.y + nodeSize(hit).h / 2 + V_GAP + h / 2;
  }
  return slot;
}

export function subtreeIds(id, tree = getTree()) {
  const outIds = [id];
  for (let i = 0; i < outIds.length; i++) outIds.push(...(tree.children.get(outIds[i]) || []));
  return outIds;
}

// ─── Tidy layout (MindNode style) ────────────────────────────────────────────
// Root stays where it is. First-level branches are split left/right to
// balance height; each subtree is stacked vertically, children's inner edges
// aligned. Returns Map id -> {x, y} (centre positions, world units).
const H_GAP = 46, H_GAP_ROOT = 64, V_GAP = 12, MAP_GAP = 60;

// Same estimate render.js uses for the label background.
export function labelWidth(label) { return Math.max(label.length * 7 + 12, 30); }

export function computeTidyLayout() {
  const tree = getTree();
  const target = new Map();
  const subH = new Map();

  const visibleKids = id => {
    const n = state.nodes.get(id);
    return n.collapsed ? [] : tree.children.get(id);
  };
  const measure = id => {
    const h = nodeSize(state.nodes.get(id)).h;
    const kids = visibleKids(id);
    let sum = 0;
    for (const k of kids) sum += measure(k);
    sum += Math.max(0, kids.length - 1) * V_GAP;
    const v = Math.max(h, sum);
    subH.set(id, v);
    return v;
  };
  const placeKids = (kids, pid, side) => {
    if (!kids.length) return;
    const p = target.get(pid);
    const pw = nodeSize(state.nodes.get(pid)).w;
    const baseGap = tree.parent.has(pid) ? H_GAP : H_GAP_ROOT;
    let total = kids.reduce((s, k) => s + subH.get(k), 0) + (kids.length - 1) * V_GAP;
    let cy = p.y - total / 2;
    for (const k of kids) {
      const kw = nodeSize(state.nodes.get(k)).w;
      const sh = subH.get(k);
      // A labelled branch needs room for its label between the two nodes.
      const label = state.edges.get(tree.parentEdge.get(k))?.label || '';
      const gap = label ? Math.max(baseGap, labelWidth(label) + 36) : baseGap;
      const kx = p.x + side * (pw / 2 + gap + kw / 2);
      target.set(k, { x: kx, y: cy + sh / 2, side });
      placeKids(visibleKids(k), k, side);
      cy += sh + V_GAP;
    }
  };

  for (const root of tree.roots) {
    const rn = state.nodes.get(root);
    target.set(root, { x: rn.x, y: rn.y, side: 0 });
    const kids = visibleKids(root);
    for (const k of kids) measure(k);
    const right = [], left = [];
    let R = 0, L = 0;
    for (const k of kids) {
      if (R <= L) { right.push(k); R += subH.get(k) + V_GAP; }
      else { left.push(k); L += subH.get(k) + V_GAP; }
    }
    placeKids(right, root, 1);
    placeKids(left, root, -1);
  }

  // Separate maps (one per root) must not overlap: walk them in order and
  // push each one down below any earlier map its box would hit.
  const boxes = [];
  for (const root of tree.roots) {
    const ids = subtreeIds(root, tree).filter(id => !tree.hidden.has(id) && target.has(id));
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const id of ids) {
      const t = target.get(id), { w, h } = nodeSize(state.nodes.get(id));
      x1 = Math.min(x1, t.x - w / 2); x2 = Math.max(x2, t.x + w / 2);
      y1 = Math.min(y1, t.y - h / 2); y2 = Math.max(y2, t.y + h / 2);
    }
    let shift = 0;
    for (let moved = true; moved;) {
      moved = false;
      for (const b of boxes) {
        if (x1 < b.x2 + MAP_GAP && x2 > b.x1 - MAP_GAP && y1 + shift < b.y2 + MAP_GAP && y2 + shift > b.y1 - MAP_GAP) {
          shift = b.y2 + MAP_GAP - y1; moved = true;
        }
      }
    }
    if (shift) for (const id of ids) target.get(id).y += shift;
    boxes.push({ x1, x2, y1: y1 + shift, y2: y2 + shift });
  }

  // Hidden (folded) nodes travel with their nearest visible ancestor, keeping
  // their offset, so unfolding shows the branch as it was.
  for (const id of tree.hidden) {
    let a = tree.parent.get(id);
    while (a && tree.hidden.has(a)) a = tree.parent.get(a);
    const t = target.get(a), an = state.nodes.get(a), n = state.nodes.get(id);
    if (t && an) target.set(id, { x: t.x + n.x - an.x, y: t.y + n.y - an.y, side: t.side });
  }
  return target;
}
