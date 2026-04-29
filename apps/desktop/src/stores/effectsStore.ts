import { create } from 'zustand';

// Per-track effect chains. Visual-only first pass — chips render in the
// sidebar, get dropped onto tracks, reorder / delete / bypass live in the
// SampleEditorPanel chain editor. DSP routing is a follow-up; the chain
// state lands here so the audio layer can later mirror it.
//
// Persisted to localStorage keyed by project id so chains survive reload
// without needing a server migration. When server-side persistence comes
// in, this store becomes the cache + the source of truth on the wire.

export type EffectKind = 'eq' | 'comp' | 'reverb';

export interface Effect {
  id: string;
  kind: EffectKind;
  bypassed: boolean;
}

export const EFFECT_LABEL: Record<EffectKind, string> = {
  eq: 'EQ',
  comp: 'Comp',
  reverb: 'Reverb',
};

// Hue per kind so chips colour-code at a glance. Aligned with the existing
// master-bus FX rack accent for Reverb (#a855f7) so the visual language
// stays consistent.
export const EFFECT_HUE: Record<EffectKind, number> = {
  eq: 195,        // teal/cyan
  comp: 35,       // amber
  reverb: 270,    // violet
};

// MIME the sidebar drag source writes and the track drop target reads.
// Distinct from clip / sample-library MIMEs so handlers don't cross.
export const EFFECT_DRAG_MIME = 'application/x-ghost-effect';

interface EffectsState {
  // projectId -> trackId -> Effect[]
  byProject: Map<string, Map<string, Effect[]>>;
  // The project we're currently scoped to. Set whenever the user opens a
  // project so reads in components can stay flat.
  currentProjectId: string | null;
  setProject: (projectId: string | null) => void;
  // Returns the chain for a given track in the current project.
  // Always returns a stable empty array for "no chain yet" so React
  // selectors don't churn.
  getChain: (trackId: string) => Effect[];
  add: (trackId: string, kind: EffectKind) => void;
  remove: (trackId: string, effectId: string) => void;
  toggleBypass: (trackId: string, effectId: string) => void;
  reorder: (trackId: string, fromIndex: number, toIndex: number) => void;
  setOrder: (trackId: string, effectIds: string[]) => void;
}

const EMPTY: Effect[] = [];

const storageKey = (projectId: string) => `ghost_track_effects::${projectId}`;

const hydrateProject = (projectId: string): Map<string, Effect[]> => {
  try {
    const raw = localStorage.getItem(storageKey(projectId));
    if (!raw) return new Map();
    const data = JSON.parse(raw) as Record<string, Effect[]>;
    return new Map(Object.entries(data));
  } catch {
    return new Map();
  }
};

const persistProject = (projectId: string, chains: Map<string, Effect[]>) => {
  try {
    const obj: Record<string, Effect[]> = {};
    chains.forEach((v, k) => { obj[k] = v; });
    localStorage.setItem(storageKey(projectId), JSON.stringify(obj));
  } catch {
    // quota / private mode — non-fatal
  }
};

const newId = () => 'fx_' + Math.random().toString(36).slice(2, 10);

export const useEffectsStore = create<EffectsState>((set, get) => ({
  byProject: new Map(),
  currentProjectId: null,

  setProject: (projectId) => {
    if (!projectId) {
      set({ currentProjectId: null });
      return;
    }
    const existing = get().byProject.get(projectId);
    if (existing) {
      set({ currentProjectId: projectId });
      return;
    }
    const hydrated = hydrateProject(projectId);
    const next = new Map(get().byProject);
    next.set(projectId, hydrated);
    set({ byProject: next, currentProjectId: projectId });
  },

  getChain: (trackId) => {
    const pid = get().currentProjectId;
    if (!pid) return EMPTY;
    return get().byProject.get(pid)?.get(trackId) ?? EMPTY;
  },

  add: (trackId, kind) => {
    const pid = get().currentProjectId;
    if (!pid) return;
    const next = new Map(get().byProject);
    const proj = new Map(next.get(pid) ?? new Map<string, Effect[]>());
    const existing = proj.get(trackId) ?? [];
    const updated = [...existing, { id: newId(), kind, bypassed: false }];
    proj.set(trackId, updated);
    next.set(pid, proj);
    set({ byProject: next });
    persistProject(pid, proj);
  },

  remove: (trackId, effectId) => {
    const pid = get().currentProjectId;
    if (!pid) return;
    const next = new Map(get().byProject);
    const proj = new Map(next.get(pid) ?? new Map<string, Effect[]>());
    const existing = proj.get(trackId) ?? [];
    const updated = existing.filter((e) => e.id !== effectId);
    if (updated.length === 0) proj.delete(trackId);
    else proj.set(trackId, updated);
    next.set(pid, proj);
    set({ byProject: next });
    persistProject(pid, proj);
  },

  toggleBypass: (trackId, effectId) => {
    const pid = get().currentProjectId;
    if (!pid) return;
    const next = new Map(get().byProject);
    const proj = new Map(next.get(pid) ?? new Map<string, Effect[]>());
    const existing = proj.get(trackId) ?? [];
    const updated = existing.map((e) => (e.id === effectId ? { ...e, bypassed: !e.bypassed } : e));
    proj.set(trackId, updated);
    next.set(pid, proj);
    set({ byProject: next });
    persistProject(pid, proj);
  },

  reorder: (trackId, fromIndex, toIndex) => {
    const pid = get().currentProjectId;
    if (!pid) return;
    const next = new Map(get().byProject);
    const proj = new Map(next.get(pid) ?? new Map<string, Effect[]>());
    const existing = proj.get(trackId) ?? [];
    if (fromIndex < 0 || fromIndex >= existing.length || toIndex < 0 || toIndex >= existing.length) return;
    const updated = [...existing];
    const [moved] = updated.splice(fromIndex, 1);
    updated.splice(toIndex, 0, moved);
    proj.set(trackId, updated);
    next.set(pid, proj);
    set({ byProject: next });
    persistProject(pid, proj);
  },

  setOrder: (trackId, effectIds) => {
    const pid = get().currentProjectId;
    if (!pid) return;
    const next = new Map(get().byProject);
    const proj = new Map(next.get(pid) ?? new Map<string, Effect[]>());
    const existing = proj.get(trackId) ?? [];
    const byId = new Map(existing.map((e) => [e.id, e] as const));
    const updated = effectIds.map((id) => byId.get(id)).filter((e): e is Effect => !!e);
    if (updated.length !== existing.length) return; // ignore partial reorder payloads
    proj.set(trackId, updated);
    next.set(pid, proj);
    set({ byProject: next });
    persistProject(pid, proj);
  },
}));
