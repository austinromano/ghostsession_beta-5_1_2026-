import { useEffect, useRef, useState } from 'react';
import { useDrumRack, type DrumRow } from '../../stores/drumRackStore';
import { useAudioStore } from '../../stores/audioStore';
import { audioBufferCache, getAudioData } from '../../lib/audio';
import { api } from '../../lib/api';
import { getCtx } from '../../stores/audio/graph';
import { sendSessionAction } from '../../lib/socket';
import { SAMPLE_LIBRARY_DRAG_MIME } from '../layout/SampleLibrarySection';

// Drum-rack / step-sequencer panel. Lives at the bottom of the
// arrangement.
//
// Layout:
//   - Rows (shared sample slots) sit at the top — kick / snare / hat
//     are global to the whole rack.
//   - The step grid below shows the SELECTED clip's pattern. Click a
//     clip in the timeline to edit it; click "+ Clip" to add a new one
//     at the playhead. No clip selected = empty state.

export default function DrumRackPanel({ projectId }: { projectId: string }) {
  const open = useDrumRack((s) => s.open);
  const rows = useDrumRack((s) => s.rows);
  const clips = useDrumRack((s) => s.clips);
  const selectedClipId = useDrumRack((s) => s.selectedClipId);
  const setOpen = useDrumRack((s) => s.setOpen);
  const addEmptyRow = useDrumRack((s) => s.addEmptyRow);
  const removeRow = useDrumRack((s) => s.removeRow);
  const setRowBuffer = useDrumRack((s) => s.setRowBuffer);
  const setRowVolume = useDrumRack((s) => s.setRowVolume);
  const toggleRowMuted = useDrumRack((s) => s.toggleRowMuted);
  const toggleStep = useDrumRack((s) => s.toggleStep);
  const setStepVelocity = useDrumRack((s) => s.setStepVelocity);
  const setClipTriplet = useDrumRack((s) => s.setClipTriplet);
  const clearClip = useDrumRack((s) => s.clearClip);
  const setPatternSteps = useDrumRack((s) => s.setPatternSteps);
  const createClipAt = useDrumRack((s) => s.createClipAt);
  const duplicateClip = useDrumRack((s) => s.duplicateClip);
  const selectClip = useDrumRack((s) => s.selectClip);
  const startScheduler = useDrumRack((s) => s.startScheduler);
  const stopScheduler = useDrumRack((s) => s.stopScheduler);
  const loadForProject = useDrumRack((s) => s.loadForProject);

  // Hydrate per-project drum-rack state on mount (and whenever projectId
  // flips). Buffers stream in as they decode. After local hydrate, ask
  // the room for the current shared snapshot — peers reply only if they
  // have content, so a lone user keeps their localStorage intact.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await loadForProject(projectId);
      if (cancelled) return;
      try { sendSessionAction(projectId, { type: 'drum.request-state' }); } catch { /* socket may not be ready */ }
    })();
    return () => { cancelled = true; };
  }, [projectId, loadForProject]);

  // Start / stop the scheduler whenever the project transport flips.
  const isPlaying = useAudioStore((s) => s.isPlaying);
  useEffect(() => {
    if (isPlaying) startScheduler(projectId);
    else stopScheduler();
    return () => { stopScheduler(); };
  }, [isPlaying, projectId, startScheduler, stopScheduler]);

  const selectedClip = clips.find((c) => c.id === selectedClipId) ?? null;
  const patternSteps = selectedClip?.patternSteps ?? 16;

  // Live "current step" within the selected clip's pattern — drives the
  // column highlight + per-cell flash so the rack reads in lock-step with
  // the scheduler. -1 when the playhead is outside the clip or paused.
  const currentStepIdx = useAudioStore((s) => {
    if (!selectedClip || !s.isPlaying) return -1;
    const t = s.currentTime;
    if (t < selectedClip.startSec || t >= selectedClip.startSec + selectedClip.lengthSec) return -1;
    const projectBpmNow = s.projectBpm > 0 ? s.projectBpm : 120;
    const sub = selectedClip.triplet ? 6 : 4;
    const stepDur = 60 / projectBpmNow / sub;
    const absStep = Math.floor((t - selectedClip.startSec) / Math.max(stepDur, 1e-6));
    return absStep % selectedClip.patternSteps;
  });

  // Default clip length = 8 bars at the current project BPM. Long enough
  // to drop in as a section; pattern loops inside via the scheduler. Drag
  // the right edge to resize.
  const projectBpm = useAudioStore((s) => s.projectBpm);
  const bpm = projectBpm > 0 ? projectBpm : 120;
  const barSec = 240 / bpm;
  const defaultClipSec = 8 * barSec;

  const handleAddClip = () => {
    const playhead = useAudioStore.getState().currentTime || 0;
    const id = createClipAt(playhead, defaultClipSec);
    selectClip(id);
  };

  const handleDuplicate = () => {
    if (!selectedClipId) return;
    const playhead = useAudioStore.getState().currentTime || 0;
    duplicateClip(selectedClipId, playhead);
  };

  // Load any source (OS file / library / project file) into the row.
  // For multiplayer: every sample needs a project-scoped fileId so peers
  // can fetch the same audio. OS drops and library drops therefore get
  // uploaded to the project here; project-file drops already have one.
  const loadIntoRow = async (rowId: string, source: { kind: 'os'; file: File } | { kind: 'library'; id: string; name: string } | { kind: 'projectFile'; id: string; name: string }) => {
    try {
      let buffer: AudioBuffer | null = null;
      let name = '';
      let fileId: string | null = null;
      let fileToUpload: File | null = null;

      if (source.kind === 'os') {
        const arr = await source.file.arrayBuffer();
        buffer = await getCtx().decodeAudioData(arr.slice(0));
        name = source.file.name.replace(/\.[^.]+$/, '');
        fileToUpload = source.file;
      } else if (source.kind === 'library') {
        const arr = await api.downloadSampleLibraryAudio(source.id);
        buffer = await getCtx().decodeAudioData(arr.slice(0));
        name = source.name.replace(/\.[^.]+$/, '');
        // Re-wrap as a project file so collaborators can fetch by fileId.
        const ext = source.name.match(/\.[a-z0-9]+$/i)?.[0] || '.wav';
        const fileName = source.name.endsWith(ext) ? source.name : `${name}${ext}`;
        fileToUpload = new File([arr], fileName, { type: 'audio/wav' });
      } else {
        // project file — already shared via the project's audio storage.
        const cached = audioBufferCache.get(source.id);
        if (cached) buffer = cached;
        else {
          const data = await getAudioData(projectId, source.id);
          buffer = data.buffer;
        }
        name = source.name.replace(/\.[^.]+$/, '');
        fileId = source.id;
      }

      // Push OS / library samples into project storage so peers can fetch.
      if (fileToUpload && !fileId) {
        try {
          const result = await api.uploadFile(projectId, fileToUpload);
          fileId = result.fileId;
          if (buffer && fileId) audioBufferCache.set(fileId, buffer);
        } catch (err) {
          if (import.meta.env?.DEV) console.warn('[drumrack.uploadSample]', err);
          // Fall through with fileId=null — sample stays local-only.
        }
      }

      if (buffer) setRowBuffer(rowId, name || 'Sample', buffer, fileId);
    } catch (err) {
      if (import.meta.env?.DEV) console.warn('[drumrack.loadIntoRow]', err);
    }
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="absolute right-12 top-1 z-30 px-2 h-7 flex items-center gap-1 rounded text-[10px] font-semibold uppercase tracking-wider bg-black/40 text-white/60 hover:bg-white/[0.08] hover:text-white transition-colors"
        title="Open drum rack"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="6" height="6" rx="1" /><rect x="15" y="3" width="6" height="6" rx="1" />
          <rect x="3" y="15" width="6" height="6" rx="1" /><rect x="15" y="15" width="6" height="6" rx="1" />
        </svg>
        Drum Rack
      </button>
    );
  }

  return (
    <div className="shrink-0 mt-2 rounded-2xl glass overflow-hidden flex flex-col" style={{ maxHeight: 360 }}>
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-white/[0.06]">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-ghost-green">
          <rect x="3" y="3" width="6" height="6" rx="1" /><rect x="15" y="3" width="6" height="6" rx="1" />
          <rect x="3" y="15" width="6" height="6" rx="1" /><rect x="15" y="15" width="6" height="6" rx="1" />
        </svg>
        <span className="text-[12px] font-semibold text-white/85">Drum Rack</span>
        <span className="text-[10px] text-white/40">
          {selectedClip
            ? `— editing clip @ ${selectedClip.startSec.toFixed(2)}s · ${selectedClip.lengthSec.toFixed(2)}s long`
            : '— no clip selected'}
        </span>
        <div className="ml-auto flex items-center gap-1 text-[10px]">
          <button
            onClick={handleAddClip}
            className="px-2 py-0.5 rounded bg-ghost-green/15 text-ghost-green hover:bg-ghost-green/25"
            title="Add 8-bar clip at playhead"
          >
            + Clip
          </button>
          <button
            onClick={() => selectedClip && setClipTriplet(selectedClip.id, !selectedClip.triplet)}
            disabled={!selectedClip}
            className={`px-2 py-0.5 rounded ${selectedClip?.triplet ? 'bg-ghost-green/20 text-ghost-green' : 'text-white/40 hover:bg-white/[0.06] hover:text-white disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-white/40'}`}
            title={selectedClip?.triplet ? 'Switch to straight 16ths' : 'Switch to 16th triplets'}
          >
            3T
          </button>
          <button
            onClick={handleDuplicate}
            disabled={!selectedClip}
            className="px-2 py-0.5 rounded bg-ghost-green/10 text-ghost-green hover:bg-ghost-green/20 disabled:opacity-30 disabled:hover:bg-ghost-green/10"
            title="Duplicate selected clip at playhead"
          >
            Duplicate
          </button>
          <button
            onClick={() => selectedClip && setPatternSteps(selectedClip.id, 16)}
            disabled={!selectedClip}
            className={`px-2 py-0.5 rounded ${patternSteps === 16 && selectedClip ? 'bg-ghost-green/20 text-ghost-green' : 'text-white/40 hover:bg-white/[0.06] hover:text-white disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-white/40'}`}
          >
            16
          </button>
          <button
            onClick={() => selectedClip && setPatternSteps(selectedClip.id, 32)}
            disabled={!selectedClip}
            className={`px-2 py-0.5 rounded ${patternSteps === 32 && selectedClip ? 'bg-ghost-green/20 text-ghost-green' : 'text-white/40 hover:bg-white/[0.06] hover:text-white disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-white/40'}`}
          >
            32
          </button>
          {selectedClip && (
            <button
              onClick={() => clearClip(selectedClip.id)}
              className="px-2 py-0.5 rounded text-white/50 hover:bg-white/[0.06] hover:text-white"
              title="Clear clip pattern"
            >
              Clear
            </button>
          )}
          <button
            onClick={() => addEmptyRow()}
            className="px-2 py-0.5 rounded text-white/50 hover:bg-white/[0.06] hover:text-white"
            title="Add row"
          >
            + Row
          </button>
          <button
            onClick={() => setOpen(false)}
            className="px-2 py-0.5 rounded text-white/40 hover:bg-white/[0.06] hover:text-white"
            title="Close"
          >
            ×
          </button>
        </div>
      </div>

      {/* Rows + grid for selected clip */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {rows.map((row, rowIdx) => (
          <DrumRowItem
            key={row.id}
            row={row}
            rowIdx={rowIdx}
            patternSteps={patternSteps}
            steps={selectedClip?.steps[rowIdx] ?? null}
            clipSelected={!!selectedClip}
            currentStepIdx={currentStepIdx}
            triplet={!!selectedClip?.triplet}
            onDrop={(source) => loadIntoRow(row.id, source)}
            onToggleStep={(idx) => selectedClip && toggleStep(selectedClip.id, rowIdx, idx)}
            onSetStepVelocity={(idx, v) => selectedClip && setStepVelocity(selectedClip.id, rowIdx, idx, v)}
            onSetVolume={(v) => setRowVolume(row.id, v)}
            onToggleMuted={() => toggleRowMuted(row.id)}
            onRemove={() => removeRow(row.id)}
          />
        ))}
        {!selectedClip && (
          <div className="px-3 py-4 text-center text-[11px] text-white/35">
            No clip selected. Click <span className="text-ghost-green">+ Clip</span> to add one at the playhead, or click an existing clip in the drum lane.
          </div>
        )}
      </div>
    </div>
  );
}

// ── Single row ───────────────────────────────────────────────────────────

function DrumRowItem({ row, patternSteps, steps, clipSelected, currentStepIdx, triplet, onDrop, onToggleStep, onSetStepVelocity, onSetVolume, onToggleMuted, onRemove }: {
  row: DrumRow;
  rowIdx: number;
  patternSteps: number;
  steps: number[] | null;
  clipSelected: boolean;
  currentStepIdx: number;
  triplet: boolean;
  onDrop: (source: { kind: 'os'; file: File } | { kind: 'library'; id: string; name: string } | { kind: 'projectFile'; id: string; name: string }) => void;
  onToggleStep: (idx: number) => void;
  onSetStepVelocity: (idx: number, velocity: number) => void;
  onSetVolume: (v: number) => void;
  onToggleMuted: () => void;
  onRemove: () => void;
}) {
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    const lib = e.dataTransfer.getData(SAMPLE_LIBRARY_DRAG_MIME);
    if (lib) {
      try {
        const { id, name } = JSON.parse(lib);
        if (id) { onDrop({ kind: 'library', id, name: name || 'Sample' }); return; }
      } catch { /* fall through */ }
    }
    const file = e.dataTransfer.files?.[0];
    if (file) {
      const isAudio = file.type.startsWith('audio/') || /\.(wav|mp3|flac|aiff|ogg|m4a|aac)$/i.test(file.name);
      if (isAudio) onDrop({ kind: 'os', file });
    }
  };

  const handlePickFile = (file: File | null) => {
    if (!file) return;
    onDrop({ kind: 'os', file });
  };

  const hasSample = !!row.buffer;

  return (
    <div className="flex items-center gap-2 px-2 py-1 border-b border-white/[0.04]">
      {/* Sample slot */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
        className={`shrink-0 w-[160px] h-7 flex items-center gap-1 px-2 rounded text-[11px] truncate cursor-pointer transition-colors ${
          dragOver
            ? 'bg-ghost-green/10 text-ghost-green ring-1 ring-ghost-green/40'
            : hasSample
              ? 'bg-white/[0.05] text-white/85 hover:bg-white/[0.08]'
              : 'bg-black/20 text-white/35 italic hover:text-white/60 border border-dashed border-white/[0.08]'
        }`}
        title={hasSample ? row.name : 'Drop a sample here, or click to browse'}
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-ghost-green/70">
          <path d="M9 18V5l12-2v13" />
          <circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />
        </svg>
        <span className="truncate flex-1">{row.name || 'Empty'}</span>
        <input
          ref={fileInputRef}
          type="file"
          accept="audio/*,.wav,.mp3,.flac,.aiff,.ogg,.m4a,.aac"
          style={{ display: 'none' }}
          onChange={(e) => { handlePickFile(e.target.files?.[0] ?? null); e.target.value = ''; }}
        />
      </div>

      {/* Mute */}
      <button
        onClick={onToggleMuted}
        className={`shrink-0 w-5 h-5 flex items-center justify-center rounded text-[9px] font-bold transition-colors ${
          row.muted ? 'bg-red-500/20 text-red-300' : 'text-white/35 hover:text-white hover:bg-white/[0.06]'
        }`}
        title={row.muted ? 'Unmute' : 'Mute'}
      >
        M
      </button>

      {/* Volume */}
      <input
        type="range"
        min={0}
        max={1.5}
        step={0.01}
        value={row.volume}
        onChange={(e) => onSetVolume(parseFloat(e.target.value))}
        className="shrink-0 w-[60px] accent-ghost-green"
        title={`Volume ${Math.round(row.volume * 100)}%`}
      />

      {/* Step grid (selected clip only). Each cell is a click-to-toggle
          + drag-up-or-down-to-set-velocity affordance with a vertical
          fill that reflects the velocity from the bottom up. */}
      <div className="flex-1 flex items-center gap-[2px]">
        {Array.from({ length: patternSteps }).map((_, i) => (
          <StepCell
            key={i}
            // In triplet mode every 3 cells = an 8th-note triplet
            // group; in straight mode every 4 cells = a beat. Group
            // start gets the slightly brighter base background so the
            // user can read the rhythmic structure at a glance.
            beatStart={triplet ? i % 3 === 0 : i % 4 === 0}
            playing={i === currentStepIdx}
            velocity={steps?.[i] ?? 0}
            disabled={!clipSelected}
            onToggle={() => onToggleStep(i)}
            onSetVelocity={(v) => onSetStepVelocity(i, v)}
            label={`Step ${i + 1}`}
          />
        ))}
      </div>

      {/* Row controls */}
      <button
        onClick={onRemove}
        className="shrink-0 w-5 h-5 flex items-center justify-center rounded text-white/30 hover:text-red-400 hover:bg-red-500/10"
        title="Delete row"
      >
        ×
      </button>
    </div>
  );
}

// Single step cell. Behavior:
//
//   - Plain click (no movement) toggles the step on/off. Toggling on
//     uses velocity 1.0 unless the cell already had a stored velocity
//     (the store retains it so re-toggling restores prior value).
//   - Pointer down + vertical drag (>3 px) enters drag mode and sets
//     velocity to the dragged-to position (1.0 at the top of the cell,
//     0 at the bottom). Drag commits with the pointer-up release; a
//     drag never produces an additional toggle.
//   - Visual: an inner vertical fill rises from the bottom of the cell
//     to (velocity × cellHeight). When the playhead is on the cell the
//     fill brightens; off-cells get a soft column glow so the playhead
//     is still visible on empty rows.
function StepCell({ beatStart, playing, velocity, disabled, onToggle, onSetVelocity, label }: {
  beatStart: boolean;
  playing: boolean;
  velocity: number;
  disabled: boolean;
  onToggle: () => void;
  onSetVelocity: (v: number) => void;
  label: string;
}) {
  const elRef = useRef<HTMLDivElement>(null);
  const dragStateRef = useRef<{
    startY: number;
    startV: number;
    height: number;
    moved: boolean;
  } | null>(null);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    if (e.button !== 0) return;
    const rect = elRef.current?.getBoundingClientRect();
    if (!rect) return;
    e.preventDefault();
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    dragStateRef.current = {
      startY: e.clientY,
      startV: velocity,
      height: rect.height,
      moved: false,
    };
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const st = dragStateRef.current;
    if (!st) return;
    const dy = st.startY - e.clientY; // up = positive
    if (!st.moved && Math.abs(dy) < 3) return;
    st.moved = true;
    // 1 cell of vertical drag = full 0..1 range. Start velocity is the
    // current cell value; if the cell was off we treat it as starting
    // from 0 so dragging up immediately turns it on at the dragged
    // velocity. Sensitivity tuned so a single cell-height drag covers
    // the full range — natural one-flick interaction.
    const base = st.startV > 0 ? st.startV : 0;
    const next = Math.max(0, Math.min(1, base + dy / st.height));
    onSetVelocity(next);
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const st = dragStateRef.current;
    dragStateRef.current = null;
    if (!st) return;
    (e.target as Element).releasePointerCapture?.(e.pointerId);
    if (!st.moved) {
      // Pure click — toggle. Drag-with-no-movement still counts as a
      // click so the user can tap a cell on without entering drag mode.
      onToggle();
    }
  };

  const on = velocity > 0;
  const fillColor = on
    ? (playing ? 'hsl(165, 95%, 70%)' : 'hsl(165, 70%, 45%)')
    : (playing ? 'rgba(0, 255, 200, 0.18)' : 'transparent');
  const cellBg = beatStart ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.025)';
  const fillPct = Math.max(0, Math.min(1, velocity)) * 100;
  const glow = on && playing
    ? '0 0 14px hsla(165, 95%, 70%, 0.85), inset 0 1px 0 rgba(255,255,255,0.5)'
    : on
      ? 'inset 0 1px 0 rgba(255,255,255,0.25), inset 0 -1px 0 rgba(0,0,0,0.25)'
      : undefined;

  return (
    <div
      ref={elRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      className="relative flex-1 h-6 rounded-sm overflow-hidden select-none"
      style={{
        background: cellBg,
        cursor: disabled ? 'not-allowed' : on ? 'ns-resize' : 'pointer',
        opacity: disabled ? 0.4 : 1,
        touchAction: 'none',
      }}
      title={disabled ? 'Select a clip first' : `${label} — drag up/down to set velocity (${Math.round(velocity * 100)}%)`}
    >
      {/* Velocity fill — vertical bar rising from the bottom of the
          cell to the current velocity. Height interpolates so a drag
          reads as the bar following the pointer. */}
      <div
        className="absolute left-0 right-0 bottom-0 transition-[height] duration-75"
        style={{
          height: `${fillPct}%`,
          background: fillColor,
          boxShadow: glow,
        }}
      />
      {/* Top edge highlight — small horizontal line at the top of the
          fill so the velocity level reads cleanly even at very low
          values where the fill body would otherwise be invisible. */}
      {on && (
        <div
          className="absolute left-0 right-0 transition-[bottom] duration-75 pointer-events-none"
          style={{
            bottom: `${fillPct}%`,
            height: 1.5,
            background: playing ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.55)',
            boxShadow: '0 0 4px rgba(0,255,200,0.6)',
          }}
        />
      )}
    </div>
  );
}
