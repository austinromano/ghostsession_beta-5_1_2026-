import { create } from 'zustand';
import { setLaneEqBand, setLaneEqBypass } from './audio/trackEq';
import { getCtx } from './audio/graph';

// Resolve the live AudioContext for filter ramps. Wrapped in a
// try/catch because getCtx() will eagerly init() the audio graph if
// it hasn't been booted yet — and we shouldn't boot the audio engine
// just because the user dragged an EQ band before any source loaded.
function getCtxIfPresent(): AudioContext | undefined {
  try { return getCtx(); } catch { return undefined; }
}

// Fires whenever a chain mutates in a way that requires re-routing the
// audio graph (add or remove an effect). audioStore listens for this
// and, if playing, seeks to the current position so startAllSources
// rebuilds with the new chain shape. Sub-millisecond click is the
// trade-off for hot add/remove.
function fireRewire() {
  try {
    window.dispatchEvent(new CustomEvent('ghost-fx-rewire'));
  } catch { /* SSR */ }
}

// Per-track effect chains. Visual-only first pass — chips render in the
// sidebar, get dropped onto tracks, reorder / delete / bypass live in the
// SampleEditorPanel chain editor. DSP routing is a follow-up; the chain
// state lands here so the audio layer can later mirror it.
//
// Persisted to localStorage keyed by project id so chains survive reload
// without needing a server migration. When server-side persistence comes
// in, this store becomes the cache + the source of truth on the wire.

export type EffectKind = 'eq' | 'comp' | 'reverb';

// Per-band EQ point — frequency in Hz, gain in dB. Four bands per EQ
// instance, named Low / Low Mid / High Mid / High.
export interface EqBand {
  freq: number;
  gain: number;
}

export interface EqParams {
  bands: [EqBand, EqBand, EqBand, EqBand];
}

export interface CompParams {
  threshold: number;
  ratio: number;
  makeup: number;
}

export interface ReverbParams {
  wet: number;
  decay: number;
}

export type EffectParams = EqParams | CompParams | ReverbParams;

export interface Effect {
  id: string;
  kind: EffectKind;
  bypassed: boolean;
  // Kind-specific params. Populated with the kind's defaults when the
  // effect is created and migrated lazily for older persisted chains.
  params?: EffectParams;
}

export const EQ_BAND_LABELS = ['Low', 'Low Mid', 'High Mid', 'High'] as const;

export function defaultParams(kind: EffectKind): EffectParams {
  if (kind === 'eq') {
    return {
      bands: [
        { freq: 80, gain: 0 },
        { freq: 1200, gain: 0 },
        { freq: 3600, gain: 0 },
        { freq: 12000, gain: 0 },
      ],
    };
  }
  if (kind === 'comp') {
    return { threshold: -20, ratio: 4, makeup: 0 };
  }
  return { wet: 0.3, decay: 1.8 };
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

/**
 * The arrangement groups clips by `fileId` (same source = same lane).
 * Effects are a property of the LANE, not an individual clip — this
 * helper picks the right key from a track-shaped object so every reader
 * agrees: drop site, chip strip, editor panel, audio routing.
 *
 * Falls back to `id` for tracks without a fileId (drum-rack rows etc.)
 * so the key is always defined.
 */
export function laneKeyOf(track: { id?: string; fileId?: string | null } | null | undefined): string {
  if (!track) return '';
  return (track.fileId && track.fileId.length > 0) ? track.fileId : (track.id ?? '');
}

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
  // Generic params updater — caller passes a partial that gets shallow-
  // merged into the existing params blob. Kind-specific helpers can wrap
  // this with stronger typing when needed.
  setEffectParams: (trackId: string, effectId: string, partial: Partial<EffectParams>) => void;
  // EQ-only helper: update one band by index. Keeps the bands tuple
  // intact (length 4) so React selectors stay stable.
  setEqBand: (trackId: string, effectId: string, bandIndex: number, patch: Partial<EqBand>) => void;
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
    const updated: Effect[] = [
      ...existing,
      { id: newId(), kind, bypassed: false, params: defaultParams(kind) },
    ];
    proj.set(trackId, updated);
    next.set(pid, proj);
    set({ byProject: next });
    persistProject(pid, proj);
    fireRewire();
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
    fireRewire();
  },

  toggleBypass: (trackId, effectId) => {
    const pid = get().currentProjectId;
    if (!pid) return;
    const next = new Map(get().byProject);
    const proj = new Map(next.get(pid) ?? new Map<string, Effect[]>());
    const existing = proj.get(trackId) ?? [];
    let toggled: Effect | null = null;
    const updated = existing.map((e) => {
      if (e.id !== effectId) return e;
      const flipped = { ...e, bypassed: !e.bypassed };
      toggled = flipped;
      return flipped;
    });
    proj.set(trackId, updated);
    next.set(pid, proj);
    set({ byProject: next });
    persistProject(pid, proj);
    // Push bypass to live filter params for every clip in the lane —
    // smooth-ramps, no playback interruption.
    if (toggled && (toggled as Effect).kind === 'eq') {
      setLaneEqBypass(trackId, (toggled as Effect).bypassed, getCtxIfPresent());
    }
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

  setEffectParams: (trackId, effectId, partial) => {
    const pid = get().currentProjectId;
    if (!pid) return;
    const next = new Map(get().byProject);
    const proj = new Map(next.get(pid) ?? new Map<string, Effect[]>());
    const existing = proj.get(trackId) ?? [];
    const updated = existing.map((e) => {
      if (e.id !== effectId) return e;
      const base = e.params ?? defaultParams(e.kind);
      return { ...e, params: { ...base, ...partial } as EffectParams };
    });
    proj.set(trackId, updated);
    next.set(pid, proj);
    set({ byProject: next });
    persistProject(pid, proj);
  },

  setEqBand: (trackId, effectId, bandIndex, patch) => {
    const pid = get().currentProjectId;
    if (!pid) return;
    if (bandIndex < 0 || bandIndex > 3) return;
    const next = new Map(get().byProject);
    const proj = new Map(next.get(pid) ?? new Map<string, Effect[]>());
    const existing = proj.get(trackId) ?? [];
    let resolvedFreq = 0;
    let resolvedGain = 0;
    const updated = existing.map((e) => {
      if (e.id !== effectId || e.kind !== 'eq') return e;
      const base = (e.params as EqParams | undefined) ?? (defaultParams('eq') as EqParams);
      const newBands = [...base.bands] as [EqBand, EqBand, EqBand, EqBand];
      newBands[bandIndex] = { ...newBands[bandIndex], ...patch };
      resolvedFreq = newBands[bandIndex].freq;
      resolvedGain = newBands[bandIndex].gain;
      return { ...e, params: { bands: newBands } };
    });
    proj.set(trackId, updated);
    next.set(pid, proj);
    set({ byProject: next });
    persistProject(pid, proj);
    // Live-push the band update to every BiquadFilter clip in the
    // lane. trackId here IS the laneKey (drop site stores the chain
    // by laneKey), so trackEq registry entries match.
    if (resolvedFreq > 0 || resolvedGain !== 0) {
      setLaneEqBand(trackId, bandIndex, resolvedFreq, resolvedGain, getCtxIfPresent());
    }
  },
}));
