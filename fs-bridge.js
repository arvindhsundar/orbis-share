// ─── fs-bridge.js ─────────────────────────────────────────────────────────────
// Native file handling for the Orbis Mac app (Tauri v2).
//
// Inside Tauri:   Save / Save As / Open / New use native Mac dialogs and read and
//                 write .orbis files (JSON inside) on disk. Old .orbis.json maps
//                 still open and save in place. Cmd+S, Cmd+Shift+S, Cmd+O, Cmd+N.
//                 Also: Open Recent, the menu bar actions, the save prompt on
//                 Cmd+Q, Markdown import, and re-publishing shared maps on save.
//                 Window title = file name + a dot when there are unsaved changes.
//                 Autosaves to the open file a few seconds after changes.
// In a browser:   does nothing, so the web version keeps its old behaviour.
//
// Loaded after src/main.js (both are modules, so order is kept). Talks to the app
// only through window.App, window.serialize and window.deserialize.

(function () {
  const T = window.__TAURI__;
  if (!T || !T.fs || !T.dialog) return;

  const { fs, dialog, core, event } = T;
  const tauriPath = T.path;
  const appWindow = T.window.getCurrentWindow();

  // Default maps folder (under the home folder). "mapsDir" in the local
  // orbis.config.json (or ORBIS_MAPS_DIR) overrides it; see the README.
  const MAPS_SUBDIR = 'Documents/Orbis Maps';
  const DEFAULT_EXT = '.orbis';
  const OPEN_FILTERS = [{ name: 'Orbis Map', extensions: ['orbis', 'json'] }];
  const SAVE_FILTERS = [{ name: 'Orbis Map', extensions: ['orbis'] }];
  const LAST_FILE_KEY = 'orbis-last-file';
  const RECENT_KEY = 'orbis-recent';
  const RECENT_MAX = 12;
  const POLL_MS = 1000;        // how often we look for changes
  const QUIET_MS = 2500;       // autosave this long after the last change...
  const MAX_WAIT_MS = 10000;   // ...or at least this often while changes keep coming

  const doc = {
    path: null,          // file on disk, or null for an untitled map
    label: null,         // title override (e.g. a locked session opened read-only)
    savedSig: null,      // signature of the map as last saved / opened
    lastSig: null,       // signature at the previous poll
    firstDirtyAt: 0,
    lastChangeAt: 0,
    saving: false,
  };

  let mapsDir = null;

  // ─── helpers ────────────────────────────────────────────────────────────────
  function toast(msg, dur = 2200) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove('show'), dur);
  }

  function baseName(p) {
    return p ? p.split('/').pop() : null;
  }

  function dirName(p) {
    return p ? p.slice(0, p.lastIndexOf('/')) : null;
  }

  // What counts as "the map changed". Camera moves do not mark the file dirty,
  // and positions are rounded so sub-pixel physics drift does not either.
  function signature(data) {
    const nodes = (data.nodes || []).map(n => ({ ...n, x: Math.round(n.x || 0), y: Math.round(n.y || 0) }));
    return JSON.stringify({ nodes, edges: data.edges || [], physics: data.physics || null });
  }

  function currentSig() {
    try { return signature(window.serialize()); } catch { return doc.savedSig; }
  }

  function isDirty() {
    return doc.savedSig !== null && currentSig() !== doc.savedSig;
  }

  function hasContent() {
    try {
      const d = window.serialize();
      return d.nodes.length > 1 || d.edges.length > 0 || (d.nodes[0] && d.nodes[0].label);
    } catch { return false; }
  }

  function markClean() {
    doc.savedSig = currentSig();
    doc.lastSig = doc.savedSig;
    doc.firstDirtyAt = 0;
    updateTitle();
  }

  let lastTitle = '';
  function updateTitle() {
    const name = doc.label || baseName(doc.path) || 'Untitled';
    const dirty = doc.savedSig !== null && doc.lastSig !== doc.savedSig;
    const title = (dirty ? '● ' : '') + name + ' - Orbis';
    if (title === lastTitle) return;
    lastTitle = title;
    document.title = title;
    appWindow.setTitle(title).catch(() => {});
  }

  function recentList() {
    try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]').filter(x => typeof x === 'string'); }
    catch { return []; }
  }

  function remember(p) {
    try {
      if (p) {
        localStorage.setItem(LAST_FILE_KEY, p);
        const list = [p, ...recentList().filter(x => x !== p)].slice(0, RECENT_MAX);
        localStorage.setItem(RECENT_KEY, JSON.stringify(list));
      } else localStorage.removeItem(LAST_FILE_KEY);
    } catch {}
  }

  async function getMapsDir() {
    if (mapsDir) return mapsDir;
    const home = await tauriPath.homeDir();
    let sub = MAPS_SUBDIR;
    try { sub = (await core.invoke('app_settings')).mapsDir || MAPS_SUBDIR; } catch {}
    mapsDir = sub.startsWith('/') ? sub : await tauriPath.join(home, sub);
    try {
      if (!(await fs.exists(mapsDir))) await fs.mkdir(mapsDir, { recursive: true });
    } catch (e) { console.warn('[orbis] could not create Maps folder', e); }
    return mapsDir;
  }

  function withExt(p) {
    if (/\.(json|orbis)$/i.test(p)) return p;
    return p + DEFAULT_EXT;
  }

  const stemOf = p => baseName(p).replace(/\.orbis\.json$|\.json$|\.orbis$/i, '');

  function suggestedName() {
    if (doc.path) return stemOf(doc.path) + DEFAULT_EXT;
    let first = '';
    try { first = (window.serialize().nodes[0] || {}).label || ''; } catch {}
    const slug = first.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
    return (slug || 'untitled') + DEFAULT_EXT;
  }

  // ─── save ───────────────────────────────────────────────────────────────────
  async function writeTo(p, { quiet = false } = {}) {
    doc.saving = true;
    try {
      const data = window.serialize();
      await fs.writeTextFile(p, JSON.stringify(data, null, 2) + '\n');
      doc.path = p;
      doc.label = null;
      remember(p);
      doc.savedSig = signature(data);
      doc.lastSig = currentSig();
      doc.firstDirtyAt = 0;
      updateTitle();
      if (!quiet) toast('Saved ' + baseName(p));
      if (window.OrbisShare) window.OrbisShare.afterSave();
      return true;
    } catch (e) {
      console.error('[orbis] save failed', e);
      toast('Could not save: ' + (e && e.message ? e.message : e), 4000);
      return false;
    } finally {
      doc.saving = false;
    }
  }

  async function saveAs() {
    const dir = doc.path ? dirName(doc.path) : await getMapsDir();
    const chosen = await dialog.save({
      title: 'Save map',
      defaultPath: await tauriPath.join(dir, suggestedName()),
      filters: SAVE_FILTERS,
    });
    if (!chosen) return false;
    // The save panel adds ".orbis" and asks before replacing; a name typed
    // without any extension still gets one here.
    const target = withExt(chosen);
    if (target !== chosen && await fs.exists(target).catch(() => false)) {
      const replace = await dialog.ask(baseName(target) + ' already exists. Replace it?', {
        title: 'Orbis', kind: 'warning', okLabel: 'Replace', cancelLabel: 'Cancel',
      });
      if (!replace) return false;
    }
    return writeTo(target);
  }

  async function save() {
    if (doc.path) return writeTo(doc.path);
    return saveAs();
  }

  // Before replacing the current map: keep a filed map safe, ask about an untitled one.
  async function settleCurrent() {
    if (!isDirty()) return true;
    if (doc.path) return writeTo(doc.path, { quiet: true });
    if (!hasContent()) return true;
    const keep = await dialog.ask('This map has not been saved to a file yet. Save it first?', {
      title: 'Orbis', kind: 'warning', okLabel: 'Save', cancelLabel: 'Discard',
    });
    if (keep) return saveAs();
    return true;
  }

  // ─── open ───────────────────────────────────────────────────────────────────
  async function openPath(p) {
    let text;
    try { text = await fs.readTextFile(p); }
    catch (e) { toast('Could not open ' + baseName(p), 4000); console.error(e); return false; }

    let data;
    try { data = JSON.parse(text); }
    catch { toast(baseName(p) + ' is not valid JSON', 4000); return false; }

    if (data && data.v === 1 && data.salt && data.iv && data.data) {
      // Locked session (saved with Lock): unlock, then treat as an untitled copy
      // so we never overwrite the encrypted file with plain JSON.
      const map = await unlock(data);
      if (!map) return false;
      window.deserialize(map);
      doc.path = null;
      doc.label = baseName(p) + ' (unlocked copy)';
      remember(null);
      markClean();
      toast('Unlocked. Use Save As to keep a plain copy.', 3500);
      return true;
    }

    if (!data || !Array.isArray(data.nodes)) {
      toast(baseName(p) + ' is not an Orbis map', 4000);
      return false;
    }

    window.deserialize(data);
    doc.path = p;
    doc.label = null;
    remember(p);
    markClean();
    toast('Opened ' + baseName(p));
    return true;
  }

  async function openDialog() {
    if (!(await settleCurrent())) return;
    const dir = doc.path ? dirName(doc.path) : await getMapsDir();
    const chosen = await dialog.open({
      title: 'Open map',
      defaultPath: dir,
      multiple: false,
      directory: false,
      filters: OPEN_FILTERS,
    });
    if (!chosen) return;
    await openPath(typeof chosen === 'string' ? chosen : chosen.path);
  }

  async function newMap() {
    if (!(await settleCurrent())) return;
    try { localStorage.removeItem('orbis-autosave'); localStorage.removeItem('orbis-autosave-ts'); } catch {}
    window.deserialize({ nodes: [], edges: [] });
    doc.path = null;
    doc.label = null;
    remember(null);
    markClean();
  }

  // ─── Open Recent ─────────────────────────────────────────────────────────────
  // A small list of the last maps opened or saved; missing files are dropped.
  async function openRecent() {
    const items = [];
    for (const p of recentList()) {
      if (await fs.exists(p).catch(() => false)) items.push(p);
    }
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(items)); } catch {}
    let box = document.getElementById('recent-modal');
    if (!box) {
      box = document.createElement('div');
      box.id = 'recent-modal';
      box.innerHTML = '<div class="recent-box"><div class="recent-title">Open Recent</div><div class="recent-list"></div>' +
                      '<div class="recent-hint">Click a map · Esc to close</div></div>';
      box.addEventListener('mousedown', e => { if (e.target === box) close(); });
      document.body.appendChild(box);
    }
    const list = box.querySelector('.recent-list');
    list.innerHTML = '';
    if (!items.length) list.innerHTML = '<div class="recent-empty">No recent maps yet.</div>';
    let sel = 0;
    const rows = items.map((p, i) => {
      const row = document.createElement('div');
      row.className = 'recent-row' + (p === doc.path ? ' current' : '');
      const name = document.createElement('span'); name.textContent = stemOf(p);
      const where = document.createElement('small'); where.textContent = dirName(p).replace(/^\/Users\/[^/]+/, '~');
      row.append(name, where);
      row.addEventListener('click', () => pick(i));
      list.appendChild(row);
      return row;
    });
    const mark = () => rows.forEach((r, i) => r.classList.toggle('highlighted', i === sel));
    mark();
    function close() { box.classList.remove('visible'); window.removeEventListener('keydown', key, true); }
    async function pick(i) {
      close();
      const p = items[i];
      if (!p || p === doc.path) return;
      if (!(await settleCurrent())) return;
      await openPath(p);
    }
    function key(e) {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(rows.length - 1, sel + 1); mark(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); mark(); }
      else if (e.key === 'Enter') { e.preventDefault(); pick(sel); }
    }
    window.addEventListener('keydown', key, true);
    box.classList.add('visible');
  }

  // ─── Markdown outline import ────────────────────────────────────────────────
  async function importMarkdown() {
    if (!(await settleCurrent())) return;
    const chosen = await dialog.open({
      title: 'Import outline', defaultPath: doc.path ? dirName(doc.path) : await getMapsDir(),
      multiple: false, directory: false, filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'txt'] }],
    });
    if (!chosen) return;
    let text;
    try { text = await fs.readTextFile(typeof chosen === 'string' ? chosen : chosen.path); }
    catch (e) { toast('Could not read that file', 4000); return; }
    if (!window.App.loadMarkdown(text)) return;
    doc.path = null;
    doc.label = null;
    remember(null);
    doc.savedSig = '';          // an imported map is unsaved until Save
    doc.lastSig = currentSig();
    updateTitle();
  }

  // ─── Quit (Cmd+Q, Orbis > Quit, Dock) ───────────────────────────────────────
  // A filed map is saved quietly; an untitled one with content asks first.
  let quitting = false;
  async function quit() {
    if (quitting) return;
    quitting = true;
    try {
      if (isDirty()) {
        if (doc.path) await writeTo(doc.path, { quiet: true });
        else if (hasContent()) {
          const keep = await dialog.ask('Save this map before quitting?', {
            title: 'Orbis', kind: 'warning', okLabel: 'Save', cancelLabel: "Don't Save",
          });
          if (keep && !(await saveAs())) return;      // save panel cancelled: stay open
        }
      }
      await core.invoke('quit_app');
    } finally {
      quitting = false;
    }
  }

  // ─── Menu bar ───────────────────────────────────────────────────────────────
  function onMenu(id) {
    const App = window.App;
    const actions = {
      'new': newMap, 'open': openDialog, 'open-recent': openRecent, 'save': save, 'save-as': saveAs,
      'share': () => App.share(), 'import-md': importMarkdown,
      'export-png': () => App.exportPNG(), 'export-pdf': () => App.exportPDF(),
      'export-svg': () => App.exportSVG(), 'export-md': () => App.exportMarkdown(),
      'close': () => appWindow.close(), 'quit': quit,
      'find': () => window.UI.openFind(), 'arrange': () => App.autoArrange(), 'fit': () => App.fitMap(),
      'drift': () => App.togglePhysics(), 'minimap': () => App.toggleMinimap(), 'theme': () => App.toggleTheme(),
      'zoom-in': () => App.zoom(1.15), 'zoom-out': () => App.zoom(0.87), 'zoom-reset': () => App.zoom(0),
      'shortcuts': () => document.getElementById('help-overlay')?.classList.toggle('visible'),
    };
    const fn = actions[id];
    if (fn) fn();
  }

  // Files the OS handed us (Finder double-click / `open -a Orbis file`).
  async function openPending() {
    let files = [];
    try { files = await core.invoke('take_opened_files'); } catch {}
    if (!files || !files.length) return false;
    if (!(await settleCurrent())) return true;
    return openPath(files[files.length - 1]);
  }

  // ─── locked (.orbis encrypted) sessions ────────────────────────────────────
  const fromB64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

  async function decrypt(p, password) {
    const keyMat = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: fromB64(p.salt), iterations: 200000, hash: 'SHA-256' },
      keyMat, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    const buf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(p.iv) }, key, fromB64(p.data));
    return JSON.parse(new TextDecoder().decode(buf));
  }

  function askPassword() {
    return new Promise(resolve => {
      const $ = id => document.getElementById(id);
      const modal = $('pw-modal'), input = $('pw-input'), conf = $('pw-confirm');
      const err = $('pw-error'), ok = $('pw-ok'), cancel = $('pw-cancel');
      if (!modal) { resolve(null); return; }
      $('pw-title').textContent = 'Unlock Session';
      $('pw-desc').textContent = 'Enter the password for this locked map.';
      input.value = ''; conf.value = ''; err.textContent = '';
      conf.style.display = 'none';
      ok.textContent = 'Unlock';
      modal.classList.add('visible');
      requestAnimationFrame(() => input.focus());
      const done = v => {
        modal.classList.remove('visible');
        ok.removeEventListener('click', go); cancel.removeEventListener('click', stop);
        input.removeEventListener('keydown', key);
        resolve(v);
      };
      const go = () => { if (!input.value) { err.textContent = 'Password required.'; return; } done(input.value); };
      const stop = () => done(null);
      const key = e => {
        if (e.key === 'Enter') { e.preventDefault(); go(); }
        if (e.key === 'Escape') { e.preventDefault(); stop(); }
      };
      ok.addEventListener('click', go); cancel.addEventListener('click', stop);
      input.addEventListener('keydown', key);
    });
  }

  async function unlock(payload) {
    const pw = await askPassword();
    if (!pw) return null;
    try { return await decrypt(payload, pw); }
    catch { toast('Wrong password or corrupted file.', 3500); return null; }
  }

  // ─── exports (SVG / PNG) go through a native save dialog ──────────────────
  // export.js calls this when present; a browser download link does nothing in the app.
  async function saveExport(fileName, contents) {
    const dir = doc.path ? dirName(doc.path) : await getMapsDir();
    const stem = doc.path ? baseName(doc.path).replace(/\.orbis\.json$|\.json$|\.orbis$/i, '') : null;
    const ext = fileName.split('.').pop();
    const chosen = await dialog.save({
      title: 'Export',
      defaultPath: await tauriPath.join(dir, stem ? stem + '.' + ext : fileName),
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
    });
    if (!chosen) return false;
    const target = chosen.toLowerCase().endsWith('.' + ext) ? chosen : chosen + '.' + ext;
    if (typeof contents === 'string') await fs.writeTextFile(target, contents);
    else await fs.writeFile(target, contents);
    toast('Exported ' + baseName(target));
    return true;
  }

  // ─── autosave + title ───────────────────────────────────────────────────────
  function tick() {
    if (doc.savedSig === null) return;
    const sig = currentSig();
    const now = Date.now();
    if (sig !== doc.lastSig) {
      doc.lastSig = sig;
      doc.lastChangeAt = now;
      if (sig !== doc.savedSig && !doc.firstDirtyAt) doc.firstDirtyAt = now;
      if (sig === doc.savedSig) doc.firstDirtyAt = 0;
    }
    updateTitle();
    const dirty = sig !== doc.savedSig;
    if (dirty && doc.path && !doc.saving &&
        (now - doc.lastChangeAt >= QUIET_MS || now - doc.firstDirtyAt >= MAX_WAIT_MS)) {
      writeTo(doc.path, { quiet: true });
    }
  }

  // ─── wiring ─────────────────────────────────────────────────────────────────
  function onKey(e) {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    const k = e.key.toLowerCase();
    let fn = null;
    if (k === 's') fn = e.shiftKey ? saveAs : save;
    else if (k === 'o') fn = e.shiftKey ? openRecent : openDialog;
    else if (k === 'n' && !e.shiftKey) fn = newMap;
    else if (k === 'q' && !e.shiftKey) fn = quit;
    if (!fn) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    fn();
  }

  async function start() {
    const App = window.App;
    App.saveFile = save;
    App.saveFileAs = saveAs;
    App.openFile = openDialog;
    App.newMap = newMap;
    App.openRecent = openRecent;
    App.importMarkdown = importMarkdown;
    window.OrbisFS = { save, saveAs, open: openDialog, openPath, openRecent, newMap, saveExport, quit,
                       get path() { return doc.path; } };

    window.addEventListener('keydown', onKey, true);

    getMapsDir();

    // Start from: a file the OS asked us to open, else the last file, else
    // whatever main.js restored (an untitled map).
    let opened = await openPending();
    if (!opened) {
      let last = null;
      try { last = localStorage.getItem(LAST_FILE_KEY); } catch {}
      if (last) {
        try { if (await fs.exists(last)) opened = await openPath(last); } catch {}
        if (!opened) remember(null);
      }
    }
    if (!opened) markClean();

    event.listen('orbis://open-files', () => { openPending(); });
    event.listen('orbis://menu', e => onMenu(e.payload));

    appWindow.onCloseRequested(async e => {
      if (!isDirty()) return;
      if (doc.path) { await writeTo(doc.path, { quiet: true }); return; }
      if (!hasContent()) return;
      const keep = await dialog.ask('Save this map to a file before closing?', {
        title: 'Orbis', kind: 'warning', okLabel: 'Save', cancelLabel: "Don't Save",
      });
      if (keep && !(await saveAs())) e.preventDefault();
    });

    setInterval(tick, POLL_MS);
  }

  function whenReady() {
    if (window.App && window.serialize && window.deserialize) start();
    else setTimeout(whenReady, 50);
  }
  whenReady();
})();
