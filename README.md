# Orbis

Concept-map tool. Plain vanilla JS, entry `concept-map.html`, maps are JSON (`{nodes, edges, camera, physics}`; see `orbis-map-format.json`).

## Web version

- `npm run dev` - serve the repo at http://localhost:3001/concept-map.html
- `npm run build` - bundle to `dist/concept-map.html`; `npm start` serves it with the vault sync API

## Mac app (Tauri v2)

The same page wrapped as a native app, "Orbis" (`com.puttheplayerfirst.orbis`).
`fs-bridge.js` adds native file handling when the page runs inside the app; in a browser it does nothing.

- Save / Save As / Open / New use native Mac dialogs: Cmd+S, Cmd+Shift+S, Cmd+O, Cmd+N.
- Maps save as `.orbis.json` (plain JSON, so Claude and Git read them). Default folder: `~/Documents/Orbis Maps` (change it with `mapsDir`, below).
- Autosave: a few seconds after each change, if the map has a file.
- Window title shows the file name, with a dot when there are unsaved changes.
- `.orbis` files open in Orbis on double-click. `.orbis.json` files: `open -a Orbis file.orbis.json`, or Finder "Open With > Orbis" (macOS only sees the last extension, `.json`, so Orbis is not the default JSON app).
- On launch the app reopens the last file you had open.
- SVG / PNG export go through a save dialog. PDF export stays in the web version.

### One-time setup

- Xcode command line tools: `xcode-select --install`
- Rust: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`
- `npm install`

### Local config (Share + maps folder)

Server details are never in the code. Orbis reads them from a local file that is not in git:

```
~/Library/Application Support/com.puttheplayerfirst.orbis/orbis.config.json
```

- Copy `orbis.config.example.json` there and fill in your values, then restart Orbis.
- `siteRepo` (folder under your home with the site), `stagingScript` (deploy script in that folder, called as `script maps-<slug> <dir>`), `siteHost` (ssh target, used by Stop sharing), `stagingRoot` (absolute staging folder on the server), `shareBaseUrl` (public link prefix; the slug and `/` are added).
- `mapsDir` (optional): default folder for maps, relative to your home folder or absolute.
- Each value can also come from an env var: `ORBIS_SITE_REPO`, `ORBIS_STAGING_SCRIPT`, `ORBIS_SITE_HOST`, `ORBIS_STAGING_ROOT`, `ORBIS_SHARE_BASE_URL`, `ORBIS_MAPS_DIR` (apps opened from Finder do not see shell env vars, so the file is the normal way).
- No file: everything works except Share, which says "sharing not configured".

### Run in dev

```
npm run app:dev
```

Starts `npm run dev` (http-server on port 3001) and opens the app window on it. Edit JS, then reload the window (Cmd+R).

### Rebuild the app

```
npm run app:install
```

Builds a release `Orbis.app` (`src-tauri/target/release/bundle/macos/Orbis.app`), copies it to `/Applications` and clears the quarantine flag. `npm run app:build` builds without installing. Signing is ad-hoc (no paid certificate).

### Files

- `src-tauri/` - Tauri shell (Rust): window, dialog + fs plugins, file association, open-file events.
- `src-tauri/capabilities/default.json` - what the page may do (dialogs, read/write files under the home folder, set the window title).
- `fs-bridge.js` - the app-side save / open / autosave / title logic.
- `npm run build:app` - what the app ships: the bundled page + `fs-bridge.js` in `dist/`.
