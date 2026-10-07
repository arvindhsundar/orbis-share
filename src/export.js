import { state, App } from './state.js';
import { showToast, getEdgeGroups, edgeGeometry } from './render.js';
import { getTree } from './layout.js';
import { nodeSize } from './sizes.js';
import { nodeText } from './nodes.js';

// ─── Export ───────────────────────────────────────────────────────────────────
// The picture is built from what is on screen: same curves, branch colours,
// label spots, node sizes and line breaks, in the current day/night theme.
// Folded-away nodes are left out.

const SVGNS = 'http://www.w3.org/2000/svg';
const rx = n => (n.rx ?? n.x);
const ry = n => (n.ry ?? n.y);
const FONT_PX = { sm: 13, md: 16, lg: 20 };

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// Mix two #rrggbb colours: `p` parts of a, the rest b (like CSS color-mix).
function mix(a, b, p) {
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
  const ch = sh => Math.round(((pa >> sh) & 255) * p + ((pb >> sh) & 255) * (1 - p));
  return '#' + [16, 8, 0].map(sh => ch(sh).toString(16).padStart(2, '0')).join('');
}

// The node's text split into the lines the browser actually drew.
function nodeLines(n) {
  const text = nodeText(n);
  const tn = n.el && [...n.el.childNodes].find(c => c.nodeType === 3);
  if (!tn) return [text];
  const lines = [];
  let top = null, cur = '';
  const re = /\S+\s*/g;
  let m;
  while ((m = re.exec(tn.data))) {
    const r = document.createRange();
    r.setStart(tn, m.index); r.setEnd(tn, m.index + m[0].trimEnd().length);
    const rect = r.getClientRects()[0];
    const t = rect ? Math.round(rect.top) : top;
    if (top !== null && t !== null && Math.abs(t - top) > 2) { lines.push(cur.trimEnd()); cur = ''; }
    if (t !== null) top = t;
    cur += m[0];
  }
  if (cur) lines.push(cur.trimEnd());
  return lines.length ? lines : [text];
}

function visibleNodes(tree) {
  return [...state.nodes.values()].filter(n => !tree.hidden.has(n.id));
}

export function getGraphBounds() {
  const tree = getTree();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of visibleNodes(tree)) {
    const { w, h } = nodeSize(n);
    minX = Math.min(minX, rx(n) - w/2); minY = Math.min(minY, ry(n) - h/2);
    maxX = Math.max(maxX, rx(n) + w/2); maxY = Math.max(maxY, ry(n) + h/2);
  }
  const pad = 60;
  return { x: minX - pad, y: minY - pad, w: maxX - minX + pad*2, h: maxY - minY + pad*2 };
}

export function buildExportSVG() {
  const tree = getTree();
  const el = (tag, attrs = {}, parent) => {
    const e = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (parent) parent.appendChild(e);
    return e;
  };
  const font = "'Barlow Semi Condensed', 'Arial Narrow', sans-serif";
  const bgCol = cssVar('--bg') || '#0c0a1c';
  const textCol = cssVar('--text') || '#ede8ff';
  const mutedCol = cssVar('--text-muted') || '#8878c0';
  const defBorder = cssVar('--node-default-border') || '#4c4480';

  // Edges first, collecting label boxes so the bounds include them.
  const edgeParts = [];
  let bounds = getGraphBounds();
  let x1 = bounds.x, y1 = bounds.y, x2 = bounds.x + bounds.w, y2 = bounds.y + bounds.h;
  for (const [, edges] of getEdgeGroups()) {
    edges.forEach((edge, idx) => {
      const src = state.nodes.get(edge.source), tgt = state.nodes.get(edge.target);
      if (!src || !tgt || tree.hidden.has(src.id) || tree.hidden.has(tgt.id)) return;
      const g = edgeGeometry(edge, src, tgt, idx, edges.length, tree, null);
      edgeParts.push({ edge, g });
      if (g.label) {
        x1 = Math.min(x1, g.labelX - g.tw/2 - 20); x2 = Math.max(x2, g.labelX + g.tw/2 + 20);
        y1 = Math.min(y1, g.labelY - g.th/2 - 20); y2 = Math.max(y2, g.labelY + g.th/2 + 20);
      }
    });
  }
  bounds = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };

  const svg = el('svg', { xmlns: SVGNS, width: Math.ceil(bounds.w), height: Math.ceil(bounds.h),
    viewBox: `${bounds.x} ${bounds.y} ${bounds.w} ${bounds.h}` });
  el('rect', { x: bounds.x, y: bounds.y, width: bounds.w, height: bounds.h, fill: bgCol }, svg);
  // Arrowhead markers: the same ones the screen uses.
  const defs = document.querySelector('#edges-svg defs');
  if (defs) svg.appendChild(defs.cloneNode(true));

  for (const { edge, g } of edgeParts) {
    const p = el('path', { d: g.d }, svg);
    if (g.fillMode) { p.setAttribute('fill', g.color); p.setAttribute('stroke', g.color); p.setAttribute('stroke-width', '0.6'); }
    else { p.setAttribute('fill', 'none'); p.setAttribute('stroke', g.color); p.setAttribute('stroke-width', g.strokeW); }
    if (g.opacity !== 1) p.setAttribute('stroke-opacity', g.opacity);
    if (edge.dash) p.setAttribute('stroke-dasharray', '7 4');
    if (!g.isTree || edge.bidirectional) p.setAttribute('marker-end', `url(#arr-${g.markerColor})`);
    if (edge.bidirectional) p.setAttribute('marker-start', `url(#arr-start-${g.markerColor})`);
    if (g.label) {
      el('rect', { x: g.labelX - g.tw/2, y: g.labelY - g.th/2, width: g.tw, height: g.th, rx: 4, fill: bgCol }, svg);
      const t = el('text', { x: g.labelX, y: g.labelY, fill: mutedCol, 'font-size': 13, 'font-family': font,
        'text-anchor': 'middle', 'dominant-baseline': 'middle' }, svg);
      t.textContent = g.label;
    }
  }

  for (const n of visibleNodes(tree)) {
    const { w, h } = nodeSize(n);
    const cs = n.el ? getComputedStyle(n.el) : null;
    const color = n.color || 'default';
    const fill = cssVar(`--node-${color}-bg`) || cssVar('--node-default-bg');
    const branch = tree.branch.get(n.id);
    const stroke = color === 'default'
      ? (branch ? mix(branch, defBorder, 0.75) : defBorder)
      : (cssVar(`--node-${color}-border`) || defBorder);
    const radius = n.shape === 'circle' ? Math.min(w, h) / 2 : n.shape === 'pill' ? h / 2 : n.shape === 'rounded' ? 24 : 8;
    el('rect', { x: rx(n) - w/2, y: ry(n) - h/2, width: w, height: h, rx: radius,
      fill, stroke, 'stroke-width': 1.5 }, svg);
    const size = cs ? parseFloat(cs.fontSize) : FONT_PX[n.fontSize] || 16;
    const lines = nodeLines(n);
    const lh = size * 1.3;
    const t = el('text', { x: rx(n), y: ry(n) - (lines.length - 1) * lh / 2, fill: textCol,
      'font-size': size, 'font-weight': n.fontWeight === 'bold' ? 700 : 500,
      'font-style': n.fontStyle === 'italic' ? 'italic' : 'normal', 'font-family': font,
      'text-anchor': 'middle', 'dominant-baseline': 'middle' }, svg);
    lines.forEach((line, i) => {
      const ts = el('tspan', { x: rx(n), dy: i ? lh : 0 }, t);
      ts.textContent = line;
    });
  }

  return { svg, bounds };
}

// The app's own Barlow font files, embedded in the exported SVG so the
// picture uses the same letters as the screen (no internet needed).
let fontCss = null;
async function embeddedFontCss() {
  if (fontCss !== null) return fontCss;
  const rules = [];
  for (const sheet of document.styleSheets) {
    let list;
    try { list = sheet.cssRules; } catch { continue; }
    for (const r of list) {
      if (!(r instanceof CSSFontFaceRule) || !/Barlow/.test(r.style.getPropertyValue('font-family'))) continue;
      const m = r.style.getPropertyValue('src').match(/url\("?([^")]+)"?\)/);
      if (!m) continue;
      try {
        let url = m[1];
        if (!url.startsWith('data:')) {
          const buf = new Uint8Array(await (await fetch(new URL(url, sheet.href || location.href))).arrayBuffer());
          let bin = '';
          for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
          url = 'data:font/woff2;base64,' + btoa(bin);
        }
        rules.push(`@font-face{font-family:'Barlow Semi Condensed';font-style:${r.style.getPropertyValue('font-style') || 'normal'};` +
                   `font-weight:${r.style.getPropertyValue('font-weight') || 400};src:url(${url}) format('woff2');}`);
      } catch {}
    }
  }
  fontCss = rules.join('\n');
  return fontCss;
}

async function buildExportSVGWithFonts() {
  const out = buildExportSVG();
  const css = await embeddedFontCss();
  if (css) {
    const st = document.createElementNS(SVGNS, 'style');
    st.textContent = css;
    out.svg.insertBefore(st, out.svg.firstChild);
  }
  return out;
}

function stem() {
  const p = window.OrbisFS && window.OrbisFS.path;
  return p ? p.split('/').pop().replace(/\.orbis\.json$|\.json$|\.orbis$/i, '') : 'concept-map';
}

// Hand a finished file to the Mac app (native save dialog) or the browser.
async function deliver(ext, contents, mime) {
  const name = stem() + '.' + ext;
  if (window.OrbisFS) { await window.OrbisFS.saveExport(name, contents); return; }
  const blob = contents instanceof Blob ? contents : new Blob([contents], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  showToast(ext.toUpperCase() + ' exported');
}

function nothingToExport() {
  if (state.nodes.size) return false;
  showToast('Nothing to export — add some nodes first');
  return true;
}

// The map drawn onto a canvas at `scale`x (shared by PNG and PDF).
async function renderCanvas(want) {
  const { svg, bounds } = await buildExportSVGWithFonts();
  // Browsers refuse very large canvases; big maps get a smaller scale.
  const scale = Math.max(0.5, Math.min(want, 12000 / Math.max(bounds.w, bounds.h), Math.sqrt(120e6 / (bounds.w * bounds.h))));
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml' }));
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(bounds.w * scale); canvas.height = Math.ceil(bounds.h * scale);
      const ctx = canvas.getContext('2d');
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0, bounds.w, bounds.h);
      URL.revokeObjectURL(url);
      resolve({ canvas, bounds });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('could not draw the map')); };
    img.src = url;
  });
}

const canvasBytes = (canvas, type, q) => new Promise(res =>
  canvas.toBlob(async b => res(new Uint8Array(await b.arrayBuffer())), type, q));

App.exportSVG = async function() {
  if (nothingToExport()) return;
  try { await deliver('svg', new XMLSerializer().serializeToString((await buildExportSVGWithFonts()).svg), 'image/svg+xml'); }
  catch (e) { showToast('Export failed: ' + (e.message || e)); }
};

App.exportPNG = async function() {
  if (nothingToExport()) return;
  showToast('Preparing PNG…');
  try {
    const { canvas } = await renderCanvas(2);
    await deliver('png', await canvasBytes(canvas, 'image/png'), 'image/png');
  } catch (e) { showToast('Export failed: ' + (e.message || e)); }
};

// ─── PDF ─────────────────────────────────────────────────────────────────────
// A one-page PDF holding the map as a sharp JPEG, written by hand (no library,
// no print dialog), so it works the same in the browser and in the Mac app.
export function jpegToPdf(jpeg, imgW, imgH, pageW, pageH) {
  const enc = new TextEncoder();
  const parts = [], offsets = [];
  let len = 0;
  const push = b => { const u = typeof b === 'string' ? enc.encode(b) : b; parts.push(u); len += u.length; };
  const obj = (n, body) => { offsets[n] = len; push(`${n} 0 obj\n`); body(); push('\nendobj\n'); };
  const content = `q ${pageW} 0 0 ${pageH} 0 0 cm /Im0 Do Q`;

  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  obj(1, () => push('<< /Type /Catalog /Pages 2 0 R >>'));
  obj(2, () => push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'));
  obj(3, () => push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] ` +
                    `/Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`));
  obj(4, () => {
    push(`<< /Type /XObject /Subtype /Image /Width ${imgW} /Height ${imgH} /ColorSpace /DeviceRGB ` +
         `/BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`);
    push(jpeg); push('\nendstream');
  });
  obj(5, () => push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`));
  const xref = len;
  push(`xref\n0 6\n0000000000 65535 f \n`);
  for (let i = 1; i <= 5; i++) push(String(offsets[i]).padStart(10, '0') + ' 00000 n \n');
  push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  const out = new Uint8Array(len);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

App.exportPDF = async function() {
  if (nothingToExport()) return;
  showToast('Preparing PDF…');
  try {
    const { canvas, bounds } = await renderCanvas(3);
    const jpeg = await canvasBytes(canvas, 'image/jpeg', 0.92);
    const pdf = jpegToPdf(jpeg, canvas.width, canvas.height, Math.ceil(bounds.w), Math.ceil(bounds.h));
    await deliver('pdf', pdf, 'application/pdf');
  } catch (e) { showToast('Export failed: ' + (e.message || e)); }
};

export { deliver };
