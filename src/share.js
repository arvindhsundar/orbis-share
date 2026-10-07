import { state, App, $ } from './state.js';
import { showToast } from './render.js';

// ─── Share: a view-only copy of the map on the website ───────────────────────
// Share is turned on per map (Mac app only). The map then carries
// `share: { slug }` in its file, and every save re-publishes a view-only page
// to  <shareBaseUrl><slug>/  (hidden from search engines). Publishing runs the
// site's staging deploy script, whose privacy scans can block it. Stop sharing
// takes the page down.
//
// Where it publishes comes from the local orbis.config.json (see
// orbis.config.example.json and the README). Without it, Share is switched off.
//
// The published page is this same app with the map built in and every edit
// path switched off (view mode, below).

const PUBLISH_QUIET_MS = 10000;      // publish this long after the last save

const tauri = () => window.__TAURI__;
let settings = { shareConfigured: false, shareBaseUrl: null };
const settingsReady = (async () => {
  try { if (tauri()) settings = { ...settings, ...(await tauri().core.invoke('app_settings')) }; } catch {}
})();
export const shareUrl = slug => (settings.shareBaseUrl || '') + slug + '/';

function slugify(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

function mapName() {
  const p = window.OrbisFS && window.OrbisFS.path;
  if (p) return p.split('/').pop().replace(/\.orbis\.json$|\.json$|\.orbis$/i, '');
  const first = [...state.nodes.values()][0];
  return (first && first.label) || 'map';
}

function newSlug() {
  const rand = Math.random().toString(36).slice(2, 6);
  return (slugify(mapName()) || 'map') + '-' + rand;
}

function updateShareBtn() {
  const btn = $('share-btn');
  if (!btn) return;
  btn.classList.toggle('shared', !!state.share);
  btn.title = state.share ? 'Shared at ' + shareUrl(state.share.slug) + ' (click for options)' : 'Share a view-only link to this map';
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

// The page itself with the map built in, in view mode.
async function buildViewPage() {
  const res = await fetch(location.href.split('#')[0]);
  let html = await res.text();
  const data = window.serialize();
  delete data.share;
  const json = JSON.stringify({ map: data, title: mapName() }).replace(/</g, '\\u003c');
  html = html.replace(/<script[^>]*src="fs-bridge\.js"[^>]*><\/script>/g, '');
  html = html.replace(/<title>[^<]*<\/title>/, '<title>' + mapName().replace(/[<&]/g, '') + ' - Orbis</title>');
  html = html.replace('</head>', `<script>window.ORBIS_VIEW=${json};</script>\n</head>`);
  return html;
}

let publishTimer = null, publishing = false, again = false;

async function publishNow() {
  if (!state.share || !tauri()) return;
  if (publishing) { again = true; return; }
  publishing = true;
  const btn = $('share-btn');
  btn?.classList.add('busy');
  try {
    await tauri().core.invoke('publish_share', { slug: state.share.slug, html: await buildViewPage() });
    showToast('Share link updated');
  } catch (e) {
    const msg = String(e || 'unknown error');
    console.error('[orbis] share publish failed:', msg);
    const blocked = /BLOCKED|LEAK/.test(msg);
    await tauri().dialog.message(
      (blocked ? 'The privacy scan stopped this upload: the map mentions a private name or link.\n\n'
               : 'Could not update the share link.\n\n') + msg.slice(-600),
      { title: 'Orbis Share', kind: 'warning' }).catch(() => {});
  } finally {
    btn?.classList.remove('busy');
    publishing = false;
    if (again) { again = false; publishNow(); }
  }
}

// Called by fs-bridge.js after every save.
export function afterSave() {
  if (!state.share) return;
  clearTimeout(publishTimer);
  publishTimer = setTimeout(publishNow, PUBLISH_QUIET_MS);
}

// ─── Share button ────────────────────────────────────────────────────────────
const menu = $('share-menu');

App.share = async function(e) {
  e?.stopPropagation?.();
  const T = tauri();
  if (!T || !window.OrbisFS) { showToast('Sharing works in the Orbis Mac app', 3000); return; }
  await settingsReady;
  if (state.share) { toggleMenu(); return; }
  if (!settings.shareConfigured) {
    await T.dialog.message('Sharing is not set up on this Mac.\n\nAdd orbis.config.json (see the README) and restart Orbis.',
      { title: 'Orbis Share', kind: 'info' }).catch(() => {});
    return;
  }

  const slug = newSlug();
  const ok = await T.dialog.ask(
    'Put a view-only copy of this map online?\n\n' + shareUrl(slug) +
    '\n\nAnyone with the link can view it (not edit). It is hidden from Google. ' +
    'It updates by itself about 10 seconds after each save.',
    { title: 'Share map', kind: 'info', okLabel: 'Share', cancelLabel: 'Cancel' });
  if (!ok) return;
  state.share = { slug };
  updateShareBtn();
  // The share setting lives in the map file, so save first (asks for a name if untitled).
  const saved = await window.OrbisFS.save();
  if (!saved) { state.share = null; updateShareBtn(); return; }
  clearTimeout(publishTimer);
  showToast('Publishing…', 4000);
  await publishNow();
  if (await copy(shareUrl(slug))) showToast('Link copied: ' + shareUrl(slug), 4000);
};

function toggleMenu() {
  if (!menu.classList.toggle('visible')) return;
  $('share-menu-url').textContent = shareUrl(state.share.slug);
  const r = $('share-btn').getBoundingClientRect();
  menu.style.left = (r.right + 8) + 'px';
  menu.style.top = r.top + 'px';
}

App.shareAction = async function(kind) {
  menu.classList.remove('visible');
  if (!state.share) return;
  const url = shareUrl(state.share.slug);
  if (kind === 'copy') {
    showToast((await copy(url)) ? 'Link copied' : url, 4000);
  } else if (kind === 'update') {
    clearTimeout(publishTimer);
    showToast('Publishing…', 4000);
    await publishNow();
  } else if (kind === 'stop') {
    const T = tauri();
    const ok = await T.dialog.ask('Stop sharing this map? The link will stop working.',
      { title: 'Orbis Share', kind: 'warning', okLabel: 'Stop sharing', cancelLabel: 'Cancel' });
    if (!ok) return;
    const slug = state.share.slug;
    try { await T.core.invoke('unpublish_share', { slug }); }
    catch (err) {
      await T.dialog.message('Could not take the page down:\n\n' + err, { title: 'Orbis Share', kind: 'warning' }).catch(() => {});
      return;
    }
    clearTimeout(publishTimer);
    state.share = null;
    updateShareBtn();
    await window.OrbisFS.save();
    showToast('Sharing stopped');
  }
};

document.addEventListener('click', ev => {
  if (menu && !menu.contains(ev.target) && ev.target !== $('share-btn')) menu.classList.remove('visible');
});

// Keep the button in step when a map is opened / created.
export function syncShare() { updateShareBtn(); }
settingsReady.then(updateShareBtn);

window.OrbisShare = { afterSave };

// ─── View mode (the published page) ──────────────────────────────────────────
export const VIEW = window.ORBIS_VIEW || null;

if (VIEW) {
  document.body.classList.add('view-only');
  state.viewOnly = true;
  const container = $('canvas-container');

  // Only looking around is allowed: arrows, fit, minimap, find, fold, help.
  const allowed = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'f', 'F', 'm', 'M', '.', '?', 'Home', 'Escape']);
  document.addEventListener('keydown', e => {
    if (e.target.matches?.('#find-input')) return;
    if ((e.metaKey || e.ctrlKey) && ['f', '=', '-', '0'].includes(e.key)) return;
    if (!allowed.has(e.key) || e.metaKey || e.ctrlKey) { e.stopImmediatePropagation(); e.preventDefault(); }
  }, true);
  for (const type of ['dblclick', 'contextmenu']) {
    document.addEventListener(type, e => {
      if (e.target.closest?.('.fold-badge')) return;
      e.stopImmediatePropagation(); e.preventDefault();
    }, true);
  }
  // Left-drag anywhere pans the map (no node dragging, no edge drawing).
  container.addEventListener('mousedown', e => {
    if (e.button !== 0 || e.target.closest?.('.fold-badge, #minimap')) return;
    e.stopImmediatePropagation(); e.preventDefault();
    const nodeEl = e.target.closest?.('.node');
    const sx = e.clientX, sy = e.clientY, cx = state.camera.x, cy = state.camera.y;
    let moved = false;
    const onMove = ev => {
      if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) > 3) moved = true;
      state.camera.x = cx + ev.clientX - sx; state.camera.y = cy + ev.clientY - sy;
      import('./camera.js').then(m => m.applyCam());
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp);
      if (!moved && nodeEl) import('./nodes.js').then(m => m.selectNode(nodeEl.dataset.id));
    };
    window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp);
  }, true);
}
