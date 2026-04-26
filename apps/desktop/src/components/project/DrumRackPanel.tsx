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
  const loadIntoRow = async (rowId: string, source: { kind: 'os'; file: File } | { kind: 'library'; id: string; name: string } | { kind: 'projectFile'; id: string; name: string }) => {
    try {
      let buffer: AudioBuffer | null = null;
      let name = '';
      let fileId: string | null = null;
      if (source.kind === 'os') {
        const arr = await source.file.arrayBuffer();
        buffer = await getCtx().decodeAudioData(arr.slice(0));
        name = source.file.name.replace(/\.[^.]+$/, '');
      } else if (source.kind === 'library') {
        const arr = await api.downloadSampleLibraryAudio(source.id);
        buffer = await getCtx().decodeAudioData(arr.slice(0));
        name = source.name.replace(/\.[^.]+$/, '');
      } else {
        const cached = audioBufferCache.get(source.id);
        if (cached) buffer = cached;
        else {
          const data = await getAudioData(projectId, source.id);
          buffer = data.buffer;
        }
        name = source.name.replace(/\.[^.]+$/, '');
        fileId = source.id;
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
            onDrop={(source) => loadIntoRow(row.id, source)}
            onToggleStep={(idx) => selectedClip && toggleStep(selectedClip.id, rowIdx, idx)}
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

function DrumRowItem({ row, patternSteps, steps, clipSelected, onDrop, onToggleStep, onSetVolume, onToggleMuted, onRemove }: {
  row: DrumRow;
  rowIdx: number;
  patternSteps: number;
  steps: boolean[] | null;
  clipSelected: boolean;
  onDrop: (source: { kind: 'os'; file: File } | { kind: 'library'; id: string; name: string } | { kind: 'projectFile'; id: string; name: string }) => void;
  onToggleStep: (idx: number) => void;
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

      {/* Step grid (selected clip only) */}
      <div className="flex-1 flex items-center gap-[2px]">
        {Array.from({ length: patternSteps }).map((_, i) => {
          const on = !!steps?.[i];
          const beatStart = i % 4 === 0;
          return (
            <button
              key={i}
              onClick={() => clipSelected && onToggleStep(i)}
              disabled={!clipSelected}
              className="flex-1 h-6 rounded-sm transition-colors disabled:cursor-not-allowed"
              style={{
                background: on
                  ? `hsl(165, 70%, 45%)`
                  : beatStart ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.04)',
                boxShadow: on ? 'inset 0 1px 0 rgba(255,255,255,0.25), inset 0 -1px 0 rgba(0,0,0,0.25)' : undefined,
                opacity: clipSelected ? 1 : 0.4,
              }}
              title={clipSelected ? `Step ${i + 1}` : 'Select a clip first'}
            />
          );
        })}
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
