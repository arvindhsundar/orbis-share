import { state, App, UI, $ } from './state.js';
import { applyCam } from './camera.js';
import { renderAllEdges, updateStatus, showToast } from './render.js';
import { createNodeEl, selectNode, addNode } from './nodes.js';
import { kickPhysics } from './physics.js';
import { snapshot } from './history.js';
import { resetRenderCaches } from './render.js';
import { unobserveNode } from './sizes.js';
import { stopCameraMotion } from './frame.js';

// Drift (force physics) is OFF by default. The last choice is remembered for
// new maps; a map saved with `physics.drift` reopens the way it was saved.
// Old files only carry `physics.enabled` (which defaulted to true), so that
// field alone is not trusted.
export function rememberedDrift() {
  try { return localStorage.getItem('orbis-drift') === 'on'; } catch { return false; }
}
export function rememberDrift(on) {
  try { localStorage.setItem('orbis-drift', on ? 'on' : 'off'); } catch {}
}

const physicsBtnEl = $('physics-btn');

// ─── Persistence ──────────────────────────────────────────────────────────────
export function serialize() {
  return {
    nodes: [...state.nodes.values()].map(n => {
      const o = {
        id: n.id, label: n.label, x: n.x, y: n.y,
        color: n.color, shape: n.shape, pinned: n.pinned,
        fontSize: n.fontSize, fontWeight: n.fontWeight, fontStyle: n.fontStyle,
      };
      // Optional fields, written only when set (old readers ignore them).
      if (n.root) o.root = true;
      if (n.collapsed) o.collapsed = true;
      if (n.icon) o.icon = n.icon;
      return o;
    }),
    edges: [...state.edges.values()].map(e => ({
      id: e.id, source: e.source, target: e.target, label: e.label,
      color: e.color, thickness: e.thickness, dash: e.dash, bidirectional: e.bidirectional, cp: e.cp || null,
    })),
    camera: { ...state.camera },
    physics: { ...state.physics, drift: !!state.physics.enabled },
    ...(state.share ? { share: { ...state.share } } : {}),
  };
}

export function deserialize(data) {
  stopCameraMotion();
  [...state.nodes.values()].forEach(n => { unobserveNode(n); n.el?.remove(); n.foldEl?.remove(); });
  state.nodes.clear();
  resetRenderCaches();
  state.edges.clear();
  state.selectedNodeId = null;
  state.selectedEdgeId = null;
  UI.closeEdgePanel();

  (data.nodes || []).forEach(nd => {
    const node = { ...nd, vx:0, vy:0, rx: nd.x, ry: nd.y };
    state.nodes.set(node.id, node);
    state.createdAt.set(node.id, Date.now());
    createNodeEl(node);
  });
  (data.edges || []).forEach(ed => {
    state.edges.set(ed.id, {
      color: 'default', thickness: 'normal', dash: false,
      ...ed,
    });
  });

  state.share = data.share && data.share.slug ? { slug: data.share.slug } : null;
  if (data.camera) Object.assign(state.camera, data.camera);
  if (data.physics) {
    const { drift, enabled, ...tuning } = data.physics;
    Object.assign(state.physics, tuning);
  }
  state.physics.enabled = (data.physics && typeof data.physics.drift === 'boolean')
    ? data.physics.drift
    : rememberedDrift();
  delete state.physics.drift;

  const first = [...state.nodes.values()].sort((a,b) => (state.createdAt.get(a.id)||0) - (state.createdAt.get(b.id)||0))[0];
  if (first) selectNode(first.id);
  else {
    const n = addNode('', 0, 0);
    selectNode(n.id);
  }

  applyCam();
  renderAllEdges();
  updateStatus();
  kickPhysics();
  syncPhysicsUI();
  import('./share.js').then(m => m.syncShare());
}

export function syncPhysicsUI() {
  const p = state.physics;
  $('sl-repulsion').value = p.repulsion; $('val-repulsion').textContent = p.repulsion;
  $('sl-linkDistance').value = p.linkDistance; $('val-linkDistance').textContent = p.linkDistance;
  $('sl-linkStrength').value = p.linkStrength; $('val-linkStrength').textContent = p.linkStrength;
  $('sl-damping').value = p.damping; $('val-damping').textContent = p.damping;
  physicsBtnEl.classList.toggle('active', p.enabled);
}

// ─── Auto-save ────────────────────────────────────────────────────────────────
let autoSaveTimer = null;
export function scheduleAutoSave() {
  if (state.viewOnly) return;          // a shared view never writes anything
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => {
    try {
      localStorage.setItem('orbis-autosave', JSON.stringify(serialize()));
      localStorage.setItem('orbis-autosave-ts', Date.now());
    } catch {}
  }, 1000);
}

// ─── Grid snapping ────────────────────────────────────────────────────────────
export function snapToGrid(val) {
  if (!state.gridSnap) return val;
  return Math.round(val / state.gridSize) * state.gridSize;
}

App.toggleGridSnap = function(on) {
  state.gridSnap = on;
  $('val-gridsnap').textContent = on ? 'On' : 'Off';
  $('gridsize-row').style.display = on ? '' : 'none';
  showToast('Grid snap ' + (on ? 'on (' + state.gridSize + 'px)' : 'off'));
};

App.updateGridSize = function(size) {
  state.gridSize = size;
  $('val-gridsize').textContent = size;
};

App.saveFile = async function() {
  const data = JSON.stringify(serialize(), null, 2);
  const filename = 'concept-map-' + new Date().toISOString().slice(0,19).replace(/[T:]/g,'-') + '.json';
  try {
    if (window.showSaveFilePicker) {
      const fh = await window.showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: 'Concept Map JSON', accept: {'application/json':['.json']} }],
      });
      const w = await fh.createWritable();
      await w.write(data); await w.close();
    } else throw new Error('fallback');
  } catch {
    const a = document.createElement('a');
    a.href = 'data:application/json,' + encodeURIComponent(data);
    a.download = filename; a.click();
  }
  showToast('Saved!');
};

App.openFile = async function() {
  try {
    if (window.showOpenFilePicker) {
      const [fh] = await window.showOpenFilePicker({
        types: [{ description: 'Concept Map JSON', accept: {'application/json':['.json']} }],
      });
      const text = await (await fh.getFile()).text();
      deserialize(JSON.parse(text));
    } else throw new Error('fallback');
  } catch {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.json';
    inp.addEventListener('change', async () => {
      const text = await inp.files[0].text();
      deserialize(JSON.parse(text));
    });
    inp.click();
  }
};

App.newMap = function() {
  if (state.nodes.size > 0 && !confirm('Start a new map? Unsaved changes will be lost.')) return;
  try { localStorage.removeItem('orbis-autosave'); localStorage.removeItem('orbis-autosave-ts'); } catch {}
  deserialize({ nodes: [], edges: [] });
};
