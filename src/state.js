// ─── State ───────────────────────────────────────────────────────────────────
export const state = {
  nodes: new Map(),
  edges: new Map(),
  selectedNodeId: null,
  selectedEdgeId: null,
  camera: { x: 0, y: 0, zoom: 1 },
  physics: { enabled: true, repulsion: 8000, linkDistance: 180, linkStrength: 0.4, damping: 0.75 },
  mode: 'normal',   // 'normal' | 'edge' | 'editing'
  edgeSourceId: null,
  edgeCandidateId: null,
  history: [],
  historyIndex: -1,
  historyPaused: false,
  ctxTargetId: null,
  physicsRunning: false,
  physicsRaf: null,
  createdAt: new Map(),
  selectedNodeIds: new Set(),   // I: multi-select set
  gridSnap: false,
  gridSize: 20,
};

// Edge colors palette
export const EDGE_COLORS = {
  default: '#7b84a3',
  accent:  '#f06820',
  green:   '#3d8c60',
  amber:   '#c08020',
  coral:   '#c04040',
  teal:    '#2a8098',
};

// ─── DOM refs ─────────────────────────────────────────────────────────────────
export const $ = id => document.getElementById(id);

// ─── Shared namespace objects ─────────────────────────────────────────────────
export const App = {};
export const UI = {};
export const Keyboard = {};
