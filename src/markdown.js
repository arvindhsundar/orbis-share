import { state, App } from './state.js';
import { showToast } from './render.js';
import { getTree } from './layout.js';
import { uuid } from './utils.js';
import { deliver } from './export.js';

// ─── Markdown outline ────────────────────────────────────────────────────────
// Export: each map (root) is a "# heading", its branches an indented list.
// A labelled branch reads "- *label:* Child". Links that are not part of the
// tree (cross-links) go in a "## Links" list at the end, so nothing is lost:
//   - Budget → Hiring: needs        (one way)
//   - Budget ↔ Hiring               (both ways)
// Import reads the same shape back (any indented "-", "*" or "+" list works).

const one = s => (s || '').replace(/\s*\n\s*/g, ' ').trim();
const labelOf = n => one((n.icon ? n.icon + ' ' : '') + n.label) || '(blank)';

export function mapToMarkdown() {
  const tree = getTree();
  const out = [];
  const branchLine = (id, depth) => {
    const n = state.nodes.get(id);
    const e = state.edges.get(tree.parentEdge.get(id));
    const tag = e && e.label ? `*${one(e.label)}:* ` : '';
    out.push('  '.repeat(depth) + '- ' + tag + labelOf(n));
    for (const c of tree.children.get(id) || []) branchLine(c, depth + 1);
  };
  for (const root of tree.roots) {
    if (out.length) out.push('');
    out.push('# ' + labelOf(state.nodes.get(root)));
    out.push('');
    for (const c of tree.children.get(root) || []) branchLine(c, 0);
  }
  const links = [...state.edges.values()].filter(e => !tree.treeEdges.has(e.id));
  if (links.length) {
    out.push('', '## Links', '');
    for (const e of links) {
      const a = state.nodes.get(e.source), b = state.nodes.get(e.target);
      if (!a || !b) continue;
      out.push(`- ${labelOf(a)} ${e.bidirectional ? '↔' : '→'} ${labelOf(b)}${e.label ? ': ' + one(e.label) : ''}`);
    }
  }
  return out.join('\n') + '\n';
}

// Parse an outline into an Orbis map ({ nodes, edges }). Positions are left at
// 0,0; the caller runs Arrange.
export function markdownToMap(text) {
  const nodes = [], edges = [];
  const byLabel = new Map();
  const node = (label, root) => {
    let icon;
    const m = label.match(/^(\p{Extended_Pictographic}️?)\s+(.*)$/u);
    if (m) { icon = m[1]; label = m[2]; }
    const n = { id: uuid(), label, x: 0, y: 0, color: 'default', shape: 'rect',
                fontSize: 'md', fontWeight: 'normal', fontStyle: 'normal', pinned: false };
    if (icon) n.icon = icon;
    if (root) n.root = true;
    nodes.push(n);
    if (!byLabel.has(label.toLowerCase())) byLabel.set(label.toLowerCase(), n.id);
    return n;
  };
  const edge = (source, target, label = '', extra = {}) =>
    edges.push({ id: uuid(), source, target, label, color: 'default', thickness: 'normal', dash: false, bidirectional: false, cp: null, ...extra });

  let root = null, inLinks = false;
  const stack = [];          // [{ indent, id }]
  const pendingLinks = [];
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    if (!raw.trim()) continue;
    const h = raw.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const title = one(h[2]);
      if (/^links$/i.test(title) && h[1].length > 1) { inLinks = true; continue; }
      inLinks = false;
      root = node(title, true);
      stack.length = 0;
      continue;
    }
    const li = raw.match(/^(\s*)[-*+]\s+(.*)$/);
    if (!li) continue;
    const body = one(li[2]);
    if (inLinks) { pendingLinks.push(body); continue; }
    if (!root) root = node('Map', true);
    const indent = li[1].replace(/\t/g, '  ').length;
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const parentId = stack.length ? stack[stack.length - 1].id : root.id;
    const tagged = body.match(/^\*([^*]+):\*\s+(.*)$/);
    const n = node(tagged ? tagged[2] : body);
    edge(parentId, n.id, tagged ? one(tagged[1]) : '');
    stack.push({ indent, id: n.id });
  }

  const find = s => byLabel.get(s.replace(/^(\p{Extended_Pictographic}️?)\s+/u, '').trim().toLowerCase());
  for (const line of pendingLinks) {
    const m = line.match(/^(.*?)\s+(→|↔|->|<->)\s+(.*?)(?::\s+(.*))?$/);
    if (!m) continue;
    const a = find(m[1]), b = find(m[3]);
    if (a && b) edge(a, b, m[4] ? one(m[4]) : '', { bidirectional: m[2] === '↔' || m[2] === '<->' });
  }
  return { nodes, edges };
}

App.exportMarkdown = async function() {
  if (!state.nodes.size) { showToast('Nothing to export — add some nodes first'); return; }
  try { await deliver('md', mapToMarkdown(), 'text/markdown'); }
  catch (e) { showToast('Export failed: ' + (e.message || e)); }
};

// Load an outline as a fresh map (the caller has already dealt with unsaved work).
App.loadMarkdown = function(text) {
  const data = markdownToMap(text);
  if (!data.nodes.length) { showToast('No outline found in that file', 3000); return false; }
  window.deserialize({ ...data, physics: { drift: false } });
  App.autoArrange();
  showToast(`Imported ${data.nodes.length} nodes`);
  return true;
};

// Web version: pick a .md file. (The Mac app replaces this in fs-bridge.js.)
App.importMarkdown = function() {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = '.md,.markdown,.txt';
  inp.addEventListener('change', async () => {
    const f = inp.files[0];
    if (!f) return;
    if (state.nodes.size > 1 && !confirm('Replace the current map with this outline?')) return;
    App.loadMarkdown(await f.text());
  });
  inp.click();
};
