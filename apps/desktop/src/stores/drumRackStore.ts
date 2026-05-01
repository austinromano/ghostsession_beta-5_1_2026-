import { create } from 'zustand';
import { getCtx, getDrumBus, safeStop } from './audio/graph';
import { audioBufferCache, getAudioData } from '../lib/audio';
import { useAudioStore, getStartedAt } from './audioStore';
import { sendSessionAction } from '../lib/socket';

// Drum-rack / step-sequencer store.
//
// Architecture (Ableton-style, smarter than FL's pattern-playlist):
//   - The rack itself owns SHARED sample slots (rows). Same kick / snare /
//     hat across the whole song.
//   - The arrangement holds CLIPS on a single drum-rack lane. Each clip
//     carries its OWN step pattern + length. So bars 1-4 can fire a verse
//     beat, bars 5-8 a fill, bars 9-12 the chorus — every clip is
//     independently editable, no mode-switching like FL Studio.
//   - The rack panel always shows the ROWS (samples) at the top and the
//     SELECTED clip's step grid below — open the panel for a different
//     clip and the grid swaps in.
//   - The scheduler walks every clip on every tick and queues only steps
//     whose project-time falls inside that clip's [startSec, endSec].

export interface DrumRow {
  id: string;
  name: string;
  fileId: string | null;
  buffer?: AudioBuffer;
  volume: number;
  muted: boolean;
}

export interface DrumClip {
  id: string;
  startSec: number;
  lengthSec: number;
  patternSteps: number;
  // Steps are stored per-row. Outer index matches `rows[]`; inner array
  // is length `patternSteps`. Each value is the velocity (0 = off, 0–1 =
  // on with that gain multiplier). Toggling on uses 1.0 by default; the
  // user can drag a cell to dial in any value in (0, 1]. New rows added
  // later get auto-padded with zeros.
  steps: number[][];
  // Sparse map of cells that are TRIPLET cells. Key = `${rowIdx}:${stepIdx}`,
  // value = three sub-velocities (the three notes inside the cell's
  // duration, at offsets 0, stepDur/3, 2·stepDur/3). When a (r,s) is
  // present in this map, the cell is a triplet and `steps[r][s]` is
  // ignored — the three subs drive playback. Storing as a sparse map
  // (instead of a 3D array) keeps the data shape clean: only cells the
  // user explicitly converts to triplet take up space.
  tripletSubs?: Record<string, [number, number, number]>;
}

/** Build the sparse-map key used by `tripletSubs`. Centralised so
 * any future lookup / write goes through the same format. */
export function tripletKey(rowIdx: number, stepIdx: number): string {
  return `${rowIdx}:${stepIdx}`;
}

interface DrumRackState {
  open: boolean;
  // Expand the drum-rack lane in the arrangement so each row gets its
  // own sub-lane showing just that row's hits.
  expanded: boolean;
  // When `expanded`, render each per-row sub-lane at the SAME height as
  // a regular audio track lane instead of the compact 24 px sub-lane
  // height. Lets the user see drum hits at full visual scale alongside
  // the rest of the arrangement.
  tallRows: boolean;
  rows: DrumRow[];
  clips: DrumClip[];
  selectedClipId: string | null;

  setOpen: (v: boolean) => void;
  setExpanded: (v: boolean) => void;
  setTallRows: (v: boolean) => void;

  // Row-level (samples / mix)
  addEmptyRow: () => void;
  removeRow: (rowId: string) => void;
  setRowBuffer: (rowId: string, name: string, buffer: AudioBuffer, fileId?: string | null) => void;
  setRowVolume: (rowId: string, v: number) => void;
  toggleRowMuted: (rowId: string) => void;

  // Clip-level (per-section patterns)
  selectClip: (clipId: string | null) => void;
  createClipAt: (startSec: number, lengthSec: number) => string;
  duplicateClip: (clipId: string, atSec: number) => string | null;
  deleteClip: (clipId: string) => void;
  moveClip: (clipId: string, newStartSec: number) => void;
  resizeClip: (clipId: string, newLengthSec: number) => void;
  setPatternSteps: (clipId: string, n: 16 | 32) => void;
  toggleStep: (clipId: string, rowIdx: number, stepIdx: number) => void;
  // Set the velocity of a single step. velocity in [0, 1]; 0 turns the
  // step off. Used by the click-and-drag interaction in the step grid.
  setStepVelocity: (clipId: string, rowIdx: number, stepIdx: number, velocity: number) => void;
  // Convert a cell to a triplet — splits the cell into three sub-hits
  // at velocity 1.0 each. The original `steps[r][s]` is zeroed; the
  // three sub-velocities drive playback. Idempotent: calling on a
  // cell that's already triplet leaves it alone.
  convertStepToTriplet: (clipId: string, rowIdx: number, stepIdx: number) => void;
  // Set the velocity of one of the three sub-positions inside a
  // triplet cell. If all three subs reach 0 the cell automatically
  // un-tripletizes (the entry is dropped from the sparse map) so the
  // grid reads as empty again — matching the toggle-off semantics of
  // a regular cell.
  setStepSubVelocity: (clipId: string, rowIdx: number, stepIdx: number, subIdx: 0 | 1 | 2, velocity: number) => void;
  clearClip: (clipId: string) => void;

  // Scheduler
  startScheduler: (projectId: string) => void;
  stopScheduler: () => void;

  // Persistence (rows + clips per project; buffers rehydrated from fileId)
  loadForProject: (projectId: string) => Promise<void>;

  // Multiplayer sync — apply a snapshot received over the socket.
  applyRemoteState: (payload: { rows: Array<{ id: string; name: string; fileId: string | null; volume: number; muted: boolean }>; clips: DrumClip[] }) => Promise<void>;
}

let schedulerTimer: ReturnType<typeof setInterval> | null = null;
const activeSources: Set<AudioBufferSourceNode> = new Set();
// Per-row AnalyserNode tap. Lives outside the store state because
// AnalyserNode isn't serialisable (would break network sync if added
// to DrumRow). Created lazily on first hit, persists for the lifetime
// of the AudioContext, gets exposed via getRowAnalyser() so the
// per-row meter can read levels off it.
const rowAnalysers = new Map<string, AnalyserNode>();
export function getRowAnalyser(rowId: string): AnalyserNode | null {
  return rowAnalysers.get(rowId) || null;
}

// Persistence — rows (without buffer) + clips, keyed by projectId in
// localStorage. Buffer rehydrated from fileId on load.
//
// Real-time multiplayer: same payload is also broadcast over the project
// socket room as a `drum.state` session-action so every collaborator
// sees rows/clips/steps live. _applyingRemote suppresses echoes.
let _currentProjectId: string | null = null;
let _hydrating = false;
let _applyingRemote = false;
let _lastBroadcastJson = '';
const persistKey = (projectId: string) => `drumrack::${projectId}`;

interface DrumSyncPayload {
  rows: Array<{ id: string; name: string; fileId: string | null; volume: number; muted: boolean }>;
  clips: DrumClip[];
}

function buildSyncPayload(rows: DrumRow[], clips: DrumClip[]): DrumSyncPayload {
  return {
    rows: rows.map((r) => ({
      id: r.id,
      name: r.name,
      fileId: r.fileId,
      volume: r.volume,
      muted: r.muted,
    })),
    clips,
  };
}

function payloadHasContent(p: DrumSyncPayload): boolean {
  if (p.clips.length > 0) return true;
  return p.rows.some((r) => !!r.fileId);
}

// Called by sessionStore when a peer sends `drum.request-state`. We only
// reply if our state has anything worth sharing — avoids clobbering a
// late joiner whose populated localStorage just loaded in.
export function getDrumSyncSnapshot(): DrumSyncPayload | null {
  const s = useDrumRack.getState();
  const payload = buildSyncPayload(s.rows, s.clips);
  return payloadHasContent(payload) ? payload : null;
}

function makeRow(): DrumRow {
  return { id: crypto.randomUUID(), name: 'Empty', fileId: null, volume: 1, muted: false };
}

function emptySteps(rowCount: number, patternSteps: number): number[][] {
  return Array.from({ length: rowCount }, () => new Array(patternSteps).fill(0));
}

// Drop any tripletSubs entries pointing at (rowIdx, stepIdx). Used
// when a step is toggled off or has its main velocity set — the cell
// can't be both a single hit and a triplet, so the triplet entry
// retires with the on-state. Returns the same map untouched if there
// was nothing to drop, so the caller can keep the reference stable.
function dropTripletAt(map: Record<string, [number, number, number]> | undefined, rowIdx: number, stepIdx: number): Record<string, [number, number, number]> | undefined {
  if (!map) return undefined;
  const k = tripletKey(rowIdx, stepIdx);
  if (!(k in map)) return map;
  const next = { ...map };
  delete next[k];
  return next;
}

// Migration helper — old projects stored steps as boolean[][]; new
// schema uses number[][] with velocity 0..1. Coerce on load so the
// rest of the code can assume the new shape regardless of save age.
function coerceStepsToNumber(steps: unknown): number[][] {
  if (!Array.isArray(steps)) return [];
  return steps.map((row) => {
    if (!Array.isArray(row)) return [];
    return row.map((v) => {
      if (typeof v === 'number') return Math.max(0, Math.min(1, v));
      return v ? 1 : 0;
    });
  });
}

export const useDrumRack = create<DrumRackState>((set, get) => ({
  open: false,
  expanded: false,
  tallRows: false,
  rows: [makeRow(), makeRow(), makeRow(), makeRow()],
  clips: [],
  selectedClipId: null,

  setOpen: (v) => set({ open: v }),
  setExpanded: (v) => set({ expanded: v }),
  setTallRows: (v) => set({ tallRows: v }),

  addEmptyRow: () => set((s) => ({
    rows: [...s.rows, makeRow()],
    // Pad each clip's pattern with a new empty row so indices stay aligned.
    clips: s.clips.map((c) => ({ ...c, steps: [...c.steps, new Array(c.patternSteps).fill(0)] })),
  })),

  removeRow: (rowId) => set((s) => {
    const idx = s.rows.findIndex((r) => r.id === rowId);
    if (idx < 0) return s;
    return {
      rows: s.rows.filter((r) => r.id !== rowId),
      clips: s.clips.map((c) => ({ ...c, steps: c.steps.filter((_, i) => i !== idx) })),
    };
  }),

  setRowBuffer: (rowId, name, buffer, fileId) =>
    set((s) => ({ rows: s.rows.map((r) => (r.id === rowId ? { ...r, name, buffer, fileId: fileId ?? null } : r)) })),

  setRowVolume: (rowId, v) =>
    set((s) => ({ rows: s.rows.map((r) => (r.id === rowId ? { ...r, volume: Math.max(0, Math.min(1.5, v)) } : r)) })),

  toggleRowMuted: (rowId) =>
    set((s) => ({ rows: s.rows.map((r) => (r.id === rowId ? { ...r, muted: !r.muted } : r)) })),

  selectClip: (clipId) => set({ selectedClipId: clipId }),

  createClipAt: (startSec, lengthSec) => {
    const id = crypto.randomUUID();
    set((s) => ({
      clips: [...s.clips, {
        id,
        startSec: Math.max(0, startSec),
        lengthSec: Math.max(0.05, lengthSec),
        patternSteps: 16,
        steps: emptySteps(s.rows.length, 16),
      }],
      selectedClipId: id,
    }));
    return id;
  },

  duplicateClip: (clipId, atSec) => {
    const src = get().clips.find((c) => c.id === clipId);
    if (!src) return null;
    const id = crypto.randomUUID();
    set((s) => ({
      clips: [...s.clips, {
        id,
        startSec: Math.max(0, atSec),
        lengthSec: src.lengthSec,
        patternSteps: src.patternSteps,
        steps: src.steps.map((row) => row.slice()),
      }],
      selectedClipId: id,
    }));
    return id;
  },

  deleteClip: (clipId) => set((s) => ({
    clips: s.clips.filter((c) => c.id !== clipId),
    selectedClipId: s.selectedClipId === clipId ? null : s.selectedClipId,
  })),

  moveClip: (clipId, newStartSec) => set((s) => ({
    clips: s.clips.map((c) => (c.id === clipId ? { ...c, startSec: Math.max(0, newStartSec) } : c)),
  })),

  resizeClip: (clipId, newLengthSec) => set((s) => ({
    clips: s.clips.map((c) => (c.id === clipId ? { ...c, lengthSec: Math.max(0.05, newLengthSec) } : c)),
  })),

  setPatternSteps: (clipId, n) => set((s) => ({
    clips: s.clips.map((c) => {
      if (c.id !== clipId) return c;
      const steps = c.steps.map((row) => {
        const next: number[] = new Array(n).fill(0);
        for (let i = 0; i < Math.min(n, row.length); i++) next[i] = row[i];
        return next;
      });
      // Auto-extend the clip so one full cycle of the new pattern fits.
      // Matches FL Studio: pattern block defaults to pattern length.
      // Shrinking the pattern (32 → 16) leaves the clip alone — user
      // may have a longer clip that loops the pattern.
      const bpm = useAudioStore.getState().projectBpm || 120;
      const stepDur = 60 / bpm / 4;
      const fullCycle = n * stepDur;
      const lengthSec = Math.max(c.lengthSec, fullCycle);
      // Drop any triplet entries that point past the new pattern
      // length (e.g. shrinking 32 → 16 nukes triplets at steps 16+).
      let tripletSubs = c.tripletSubs;
      if (tripletSubs) {
        const next: Record<string, [number, number, number]> = {};
        for (const k of Object.keys(tripletSubs)) {
          const [, sStr] = k.split(':');
          if (parseInt(sStr, 10) < n) next[k] = tripletSubs[k];
        }
        tripletSubs = next;
      }
      return { ...c, patternSteps: n, steps, lengthSec, tripletSubs };
    }),
  })),

  toggleStep: (clipId, rowIdx, stepIdx) => set((s) => ({
    clips: s.clips.map((c) => {
      if (c.id !== clipId) return c;
      // If the cell is currently a triplet, a regular toggle empties
      // the whole triplet at once.
      const k = tripletKey(rowIdx, stepIdx);
      if (c.tripletSubs && k in c.tripletSubs) {
        return { ...c, tripletSubs: dropTripletAt(c.tripletSubs, rowIdx, stepIdx) };
      }
      const steps = c.steps.map((r) => r.slice());
      if (!steps[rowIdx]) steps[rowIdx] = new Array(c.patternSteps).fill(0);
      const wasOn = steps[rowIdx][stepIdx] > 0;
      steps[rowIdx][stepIdx] = wasOn ? 0 : 1;
      return { ...c, steps };
    }),
  })),

  setStepVelocity: (clipId, rowIdx, stepIdx, velocity) => set((s) => ({
    clips: s.clips.map((c) => {
      if (c.id !== clipId) return c;
      const steps = c.steps.map((r) => r.slice());
      if (!steps[rowIdx]) steps[rowIdx] = new Array(c.patternSteps).fill(0);
      steps[rowIdx][stepIdx] = Math.max(0, Math.min(1, velocity));
      // Setting a main velocity on a cell that was a triplet
      // collapses it back to a single hit — the two states are
      // mutually exclusive.
      const tripletSubs = dropTripletAt(c.tripletSubs, rowIdx, stepIdx);
      return { ...c, steps, tripletSubs };
    }),
  })),

  convertStepToTriplet: (clipId, rowIdx, stepIdx) => set((s) => ({
    clips: s.clips.map((c) => {
      if (c.id !== clipId) return c;
      const k = tripletKey(rowIdx, stepIdx);
      if (c.tripletSubs?.[k]) return c; // already triplet
      const tripletSubs = { ...(c.tripletSubs || {}) };
      tripletSubs[k] = [1, 1, 1];
      // Zero the straight slot for this cell — playback now reads
      // from the three subs and the main velocity must not double-fire.
      const steps = c.steps.map((r, i) => (i === rowIdx ? r.slice() : r));
      if (!steps[rowIdx]) steps[rowIdx] = new Array(c.patternSteps).fill(0);
      steps[rowIdx][stepIdx] = 0;
      return { ...c, steps, tripletSubs };
    }),
  })),

  setStepSubVelocity: (clipId, rowIdx, stepIdx, subIdx, velocity) => set((s) => ({
    clips: s.clips.map((c) => {
      if (c.id !== clipId) return c;
      const k = tripletKey(rowIdx, stepIdx);
      const cur = c.tripletSubs?.[k];
      if (!cur) return c; // can't sub-edit a non-triplet cell
      const next: [number, number, number] = [cur[0], cur[1], cur[2]];
      next[subIdx] = Math.max(0, Math.min(1, velocity));
      const tripletSubs = { ...(c.tripletSubs || {}) };
      // All-zero sub triple drops the entry — the cell goes back to
      // empty. Matches the "toggle off" feel of a regular cell.
      if (next[0] <= 0 && next[1] <= 0 && next[2] <= 0) {
        delete tripletSubs[k];
      } else {
        tripletSubs[k] = next;
      }
      return { ...c, tripletSubs };
    }),
  })),

  clearClip: (clipId) => set((s) => ({
    clips: s.clips.map((c) => (c.id === clipId ? { ...c, steps: emptySteps(s.rows.length, c.patternSteps) } : c)),
  })),

  startScheduler: () => {
    if (schedulerTimer) return;
    const ctx = getCtx();
    // Track which (clipId, absoluteStepIdx) pairs we've already queued so
    // we never double-fire across overlapping scheduler ticks.
    const queued = new Set<string>();
    // Last seen project time — used to detect a backward jump (loop or
    // user seek). When projectNow regresses we wipe `queued` so steps
    // can fire again on the second pass; otherwise the stale keys from
    // the first loop iteration would block every hit on the second.
    let lastProjectNow = -1;
    let wasPlaying = false;

    const tick = () => {
      const audio = useAudioStore.getState();
      if (!audio.isPlaying) {
        // Reset the dedupe set so the NEXT play-from-start (or any new
        // playback range) gets a clean slate. Otherwise rewind+play
        // suffers the same stale-key problem as a loop.
        if (wasPlaying) { queued.clear(); lastProjectNow = -1; wasPlaying = false; }
        return;
      }
      wasPlaying = true;
      const projectBpm = audio.projectBpm > 0 ? audio.projectBpm : 120;
      const stepDur = 60 / projectBpm / 4; // 16th note
      const lookahead = 0.12;

      // Use the sample-accurate ctx → project anchor instead of the
      // RAF-driven audio.currentTime, which can be up to ~16ms stale.
      // The stale gap was being baked into every scheduled hit's `when`,
      // pushing them late — most audible on hi-hats (16ths) where any
      // delay reads as drag. projectTime = ctxNow - startedAt.
      const ctxNow = ctx.currentTime;
      const startedAt = getStartedAt();
      const projectNow = ctxNow - startedAt;
      const horizonProjectTime = projectNow + lookahead;

      // Backward jump detection — > 50 ms regression flags a loop /
      // seek / rewind. Wipe the dedupe set so previously-queued steps
      // are eligible to fire again at their new (looped) project times.
      if (lastProjectNow >= 0 && projectNow < lastProjectNow - 0.05) {
        queued.clear();
      }
      lastProjectNow = projectNow;

      for (const clip of get().clips) {
        const clipEnd = clip.startSec + clip.lengthSec;
        if (clipEnd <= projectNow) continue;
        if (clip.startSec >= horizonProjectTime) continue;
        // Walk the clip's step indices that intersect the lookahead window.
        const clipDur = clip.lengthSec;
        const stepsPerClip = Math.floor(clipDur / stepDur);
        if (stepsPerClip <= 0) continue;
        // Iterate every absolute step in this clip and schedule any whose
        // project-time hits in the [now, horizon] window.
        const startStep = Math.max(0, Math.floor((projectNow - clip.startSec) / stepDur));
        const endStep = Math.min(stepsPerClip, Math.ceil((horizonProjectTime - clip.startSec) / stepDur) + 1);
        for (let absStep = startStep; absStep < endStep; absStep++) {
          const stepProjectTime = clip.startSec + absStep * stepDur;
          if (stepProjectTime < projectNow - 0.005) continue;
          if (stepProjectTime > horizonProjectTime) continue;
          const queueKey = `${clip.id}:${absStep}`;
          if (queued.has(queueKey)) continue;
          queued.add(queueKey);
          const stepIdx = absStep % clip.patternSteps;
          const rows = get().rows;
          for (let r = 0; r < rows.length; r++) {
            const row = rows[r];
            if (row.muted || !row.buffer) continue;
            // Triplet cell takes precedence over the straight slot.
            // The three sub-velocities drive playback at offsets 0,
            // stepDur/3, 2·stepDur/3 — three notes in one cell's slot.
            const subs = clip.tripletSubs?.[tripletKey(r, stepIdx)];
            const hits: Array<{ off: number; vel: number }> = subs
              ? [
                  { off: 0, vel: subs[0] },
                  { off: stepDur / 3, vel: subs[1] },
                  { off: (2 * stepDur) / 3, vel: subs[2] },
                ]
              : (() => {
                  const v = clip.steps[r]?.[stepIdx] ?? 0;
                  return v > 0 ? [{ off: 0, vel: v }] : [];
                })();
            if (hits.length === 0) continue;
            // Lazily create a persistent per-row analyser → drum bus
            // connection. Every hit on this row routes through that
            // analyser so the row meter sees its own level, and the
            // drum bus sees the sum of every row.
            let rowAnalyser = rowAnalysers.get(row.id);
            if (!rowAnalyser) {
              rowAnalyser = ctx.createAnalyser();
              rowAnalyser.fftSize = 256;
              rowAnalyser.smoothingTimeConstant = 0.6;
              rowAnalyser.connect(getDrumBus());
              rowAnalysers.set(row.id, rowAnalyser);
            }
            for (const { off, vel } of hits) {
              if (vel <= 0) continue;
              const src = ctx.createBufferSource();
              src.buffer = row.buffer;
              const g = ctx.createGain();
              g.gain.value = row.volume * vel;
              src.connect(g);
              g.connect(rowAnalyser);
              const when = stepProjectTime + off + startedAt;
              src.start(Math.max(ctxNow, when));
              activeSources.add(src);
              src.onended = () => {
                activeSources.delete(src);
                try { src.disconnect(); g.disconnect(); } catch { /* ignore */ }
              };
            }
          }
        }
      }
      // Drop stale queued entries far behind the playhead so the set
      // doesn't grow unbounded over a long session.
      if (queued.size > 4096) {
        const cutoff = projectNow - 5;
        queued.forEach((k) => {
          const [, stepStr] = k.split(':');
          const t = parseInt(stepStr, 10) * stepDur;
          if (t < cutoff) queued.delete(k);
        });
      }
    };

    schedulerTimer = setInterval(tick, 25);
    tick();
  },

  stopScheduler: () => {
    if (schedulerTimer) { clearInterval(schedulerTimer); schedulerTimer = null; }
    for (const src of activeSources) { safeStop(src); }
    activeSources.clear();
  },

  loadForProject: async (projectId: string) => {
    _currentProjectId = projectId;
    _hydrating = true;
    try {
      const raw = (typeof localStorage !== 'undefined') ? localStorage.getItem(persistKey(projectId)) : null;
      if (raw) {
        const data = JSON.parse(raw) as {
          rows: DrumRow[]; clips: DrumClip[]; selectedClipId: string | null;
          // UI state — open + expanded + tallRows restore the panel
          // exactly as the user left it on their last visit so the editor
          // stays "warm".
          open?: boolean; expanded?: boolean; tallRows?: boolean;
        };
        const rows = (data.rows || []).map((r) => ({ ...r, buffer: undefined }));
        // Coerce step values to numbers — saves before the velocity
        // refactor stored boolean[][]; new code expects number[][].
        const clips = (data.clips || []).map((c) => ({ ...c, steps: coerceStepsToNumber(c.steps) }));
        const selectedClipId = data.selectedClipId ?? null;
        set({
          rows, clips, selectedClipId,
          open: data.open ?? false,
          expanded: data.expanded ?? false,
          tallRows: data.tallRows ?? false,
        });
      } else {
        // Fresh project — start with 4 empty slots and the panel closed.
        set({
          rows: [makeRow(), makeRow(), makeRow(), makeRow()],
          clips: [],
          selectedClipId: null,
          open: false,
          expanded: false,
          tallRows: false,
        });
      }
    } catch {
      set({
        rows: [makeRow(), makeRow(), makeRow(), makeRow()],
        clips: [],
        selectedClipId: null,
        open: false,
        expanded: false,
        tallRows: false,
      });
    } finally {
      _hydrating = false;
    }

    // Rehydrate AudioBuffers from each row's fileId. Done after the
    // initial set so the panel can render immediately and buffers
    // stream in as they decode.
    const rows = get().rows;
    for (const r of rows) {
      if (!r.fileId || r.buffer) continue;
      try {
        const cached = audioBufferCache.get(r.fileId);
        const buffer = cached ?? (await getAudioData(projectId, r.fileId)).buffer;
        set((s) => ({
          rows: s.rows.map((rr) => (rr.id === r.id ? { ...rr, buffer } : rr)),
        }));
      } catch {
        // file deleted or unavailable — leave row without buffer
      }
    }
  },

  applyRemoteState: async (payload) => {
    if (!payload || !Array.isArray(payload.rows) || !Array.isArray(payload.clips)) return;
    const projectId = _currentProjectId;
    _applyingRemote = true;
    try {
      // Reuse cached AudioBuffers from any existing row with the same
      // fileId so we don't re-decode every time a peer broadcasts.
      const prevRows = get().rows;
      const fileIdToBuffer = new Map<string, AudioBuffer>();
      for (const r of prevRows) {
        if (r.fileId && r.buffer) fileIdToBuffer.set(r.fileId, r.buffer);
      }
      const rows: DrumRow[] = payload.rows.map((r) => ({
        id: r.id,
        name: r.name,
        fileId: r.fileId,
        volume: r.volume,
        muted: r.muted,
        buffer: r.fileId ? fileIdToBuffer.get(r.fileId) : undefined,
      }));
      set((s) => ({
        rows,
        // Same boolean→number coercion on the wire — peers on older
        // builds may still broadcast boolean[][].
        clips: payload.clips.map((c) => ({ ...c, steps: coerceStepsToNumber(c.steps) })),
        // Keep selection local — collaborators have their own panel focus.
        selectedClipId: s.selectedClipId,
      }));
      // Quantize incoming clips to the local project's bar grid. If the
      // payload was saved at a slightly different BPM (or accumulated
      // sub-bar drift over many tempo changes), this brings every clip
      // back onto a clean bar boundary so the visuals line up with the
      // ruler exactly.
      if (useAudioStore.getState().projectBpm > 0) {
        snapClipsToProjectGrid(1);
      }
    } finally {
      _applyingRemote = false;
    }

    // Fetch any buffers we don't already have for this project.
    if (!projectId) return;
    const rows = get().rows;
    for (const r of rows) {
      if (!r.fileId || r.buffer) continue;
      try {
        const cached = audioBufferCache.get(r.fileId);
        const buffer = cached ?? (await getAudioData(projectId, r.fileId)).buffer;
        _applyingRemote = true;
        try {
          set((s) => ({
            rows: s.rows.map((rr) => (rr.id === r.id ? { ...rr, buffer } : rr)),
          }));
        } finally {
          _applyingRemote = false;
        }
      } catch {
        // file unavailable
      }
    }
  },
}));

// Bar-lock drum clip positions when the project tempo changes. The
// audioStore's setProjectBpm dispatches `ghost-bpm-rescale` with the
// ratio (oldBpm / newBpm); we scale every clip's startSec + lengthSec
// by it AND re-snap to the new bar grid. Without the snap, multiple
// tempo changes accumulate floating-point drift and clips end up
// fractions of a beat off the bar lines they should sit on.
function snapClipsToProjectGrid(scale = 1) {
  const newBpm = useAudioStore.getState().projectBpm || 120;
  const newBarSec = 240 / newBpm;
  useDrumRack.setState((s) => ({
    clips: s.clips.map((c) => {
      const scaledStart = c.startSec * scale;
      const scaledLen = c.lengthSec * scale;
      return {
        ...c,
        startSec: Math.max(0, Math.round(scaledStart / newBarSec) * newBarSec),
        lengthSec: Math.max(newBarSec, Math.round(scaledLen / newBarSec) * newBarSec),
      };
    }),
  }));
}

if (typeof window !== 'undefined') {
  window.addEventListener('ghost-bpm-rescale', ((e: CustomEvent) => {
    const ratio = e.detail?.ratio;
    if (!ratio || Math.abs(ratio - 1) < 1e-6) return;
    snapClipsToProjectGrid(ratio);
  }) as EventListener);
}

// On every state change: persist locally AND broadcast to the room.
// Skipped during initial hydration so we don't overwrite saved state
// with empty defaults; skipped while applying a remote snapshot so we
// don't echo it straight back at the sender.
useDrumRack.subscribe((state) => {
  if (_hydrating || !_currentProjectId) return;

  const payload = buildSyncPayload(state.rows, state.clips);
  const json = JSON.stringify(payload);

  // localStorage save — payload (rows + clips) is the same blob peers
  // receive over the socket; selectedClipId / open / expanded are
  // local-only UI state so the editor restores its panel position on
  // re-open instead of resetting every time the user comes back.
  try {
    const persisted = {
      ...payload,
      selectedClipId: state.selectedClipId,
      open: state.open,
      expanded: state.expanded,
      tallRows: state.tallRows,
    };
    localStorage.setItem(persistKey(_currentProjectId), JSON.stringify(persisted));
  } catch { /* quota / serialization — ignore */ }

  // Real-time broadcast — skip echoes and identical snapshots.
  if (_applyingRemote) return;
  if (json === _lastBroadcastJson) return;
  _lastBroadcastJson = json;
  try {
    sendSessionAction(_currentProjectId, { type: 'drum.state', payload });
  } catch { /* socket may not be connected */ }
});
