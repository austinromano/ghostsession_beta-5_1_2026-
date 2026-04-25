import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Reorder, useDragControls } from 'framer-motion';
import { useAudioStore, pendingTrackOffsets } from '../../stores/audioStore';
import { useProjectStore } from '../../stores/projectStore';
import { useCollabStore } from '../../stores/collabStore';
import { api } from '../../lib/api';
import { snapToGrid } from '../../lib/audio';
import { getSocket } from '../../lib/socket';
import Waveform from '../tracks/Waveform';
import Avatar from '../common/Avatar';
import { SAMPLE_LIBRARY_DRAG_MIME } from '../layout/SampleLibrarySection';

type Member = { userId: string; displayName: string; avatarUrl: string | null };

// Width of the FL-Studio-style track header column on the left of every
// lane. BarRuler and ArrangementPlayhead both pad/offset by this so their
// time axis stays aligned with the clip area, NOT the headers.
export const TRACK_HEADER_WIDTH = 110;

// Same hue palette the Waveform uses, so the lane header's accent strip
// always matches the colour of the clips inside it.
const LANE_HUE_PALETTE = [270, 165, 300, 220, 190, 330];

function laneHueForKey(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = ((h << 5) - h + key.charCodeAt(i)) | 0;
  return LANE_HUE_PALETTE[Math.abs(h) % LANE_HUE_PALETTE.length];
}

// Real-time level meter for a lane. Reads each track's AnalyserNode
// (created in startAllSources) once per frame, takes the peak deviation
// from the silent centre, and renders a vertical fill on the lane header.
// Decays smoothly when audio drops (smoothingTimeConstant on the analyser
// handles the actual audio envelope; we mostly just clamp + map to UI).
function LaneLevelMeter({ trackIds }: { trackIds: string[] }) {
  const isPlaying = useAudioStore((s) => s.isPlaying);
  const fillRef = useRef<HTMLDivElement | null>(null);
  const idsKey = trackIds.join(',');

  useEffect(() => {
    let raf = 0;
    const buf = new Uint8Array(128);
    let lastDisplayed = 0;
    const tick = () => {
      let peak = 0;
      const tracks = useAudioStore.getState().loadedTracks;
      for (const id of trackIds) {
        const t = tracks.get(id);
        if (t?.analyser) {
          t.analyser.getByteTimeDomainData(buf);
          let p = 0;
          for (let i = 0; i < buf.length; i++) {
            const dev = Math.abs(buf[i] - 128);
            if (dev > p) p = dev;
          }
          if (p > peak) peak = p;
        }
      }
      // Map 0..128 → 0..1 and apply a mild attack/release so the meter
      // tracks audio without flickering on every frame.
      const target = peak / 128;
      const next = target > lastDisplayed ? target : lastDisplayed * 0.85 + target * 0.15;
      lastDisplayed = next;
      const el = fillRef.current;
      if (el) el.style.height = `${Math.min(100, next * 100)}%`;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [idsKey, isPlaying]);

  return (
    <div
      className="relative shrink-0 rounded-sm overflow-hidden"
      style={{
        width: 4,
        height: '70%',
        background: 'rgba(0,0,0,0.45)',
        boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.06)',
      }}
    >
      <div
        ref={fillRef}
        className="absolute bottom-0 left-0 right-0"
        style={{
          height: '0%',
          // Classic VU gradient — green at the bottom for safe levels,
          // amber in the middle, red near clipping.
          background: 'linear-gradient(180deg, #ff4d4d 0%, #ffd24d 25%, #4dff8c 60%, #2bd16f 100%)',
          transition: 'height 0.05s linear',
        }}
      />
    </div>
  );
}

function TrackHeader({ name, hue, isSelected, trackIds }: { name: string; hue: number; isSelected?: boolean; trackIds: string[] }) {
  // Solid block fill (FL Studio playlist style) — saturated colour, full
  // lane height, name across the top, accent dot on the right.
  const fill = `hsl(${hue}, 38%, 30%)`;
  const accent = `hsl(${hue}, 80%, 60%)`;
  const cleanName = name.replace(/\.(wav|mp3|flac|aiff|ogg|m4a|aac)$/i, '').replace(/_/g, ' ');
  return (
    <div
      className="relative shrink-0 select-none flex items-center gap-1.5 px-2 rounded-l-md overflow-hidden"
      style={{
        width: TRACK_HEADER_WIDTH,
        height: '100%',
        background: fill,
        borderRight: `2px solid ${accent}`,
        boxShadow: isSelected ? `inset 0 0 0 1px ${accent}` : 'inset 0 1px 0 rgba(255,255,255,0.08), inset 0 -1px 0 rgba(0,0,0,0.25)',
      }}
      title={cleanName}
    >
      <span className="text-[11px] font-semibold text-white/95 truncate flex-1" style={{ textShadow: '0 1px 2px rgba(0,0,0,0.5)' }}>
        {cleanName}
      </span>
      <span
        className="shrink-0 w-1.5 h-1.5 rounded-full"
        style={{ background: accent, boxShadow: `0 0 4px ${accent}` }}
      />
      <LaneLevelMeter trackIds={trackIds} />
    </div>
  );
}

/* ── Drop zone for uploading audio files ── */
export function ArrangementDropZone({ projectId, onFilesAdded, children }: { projectId: string; onFilesAdded: () => void; children: React.ReactNode }) {
  const [dragOver, setDragOver] = useState(false);

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    // First: a Sample Library drag — no upload needed, server copies storage.
    const libPayload = e.dataTransfer.getData(SAMPLE_LIBRARY_DRAG_MIME);
    if (libPayload) {
      try {
        const { id } = JSON.parse(libPayload);
        if (id) {
          await api.copySampleLibraryFileToProject(id, projectId);
          window.dispatchEvent(new CustomEvent('ghost-storage-changed'));
          onFilesAdded();
          return;
        }
      } catch { /* fall through to file drop */ }
    }
    const droppedFiles = Array.from(e.dataTransfer.files).filter((f) =>
      f.type.startsWith('audio/') || f.name.match(/\.(wav|mp3|flac|aiff|ogg|m4a|aac)$/i)
    );
    if (droppedFiles.length === 0) return;
    for (const file of droppedFiles) {
      const { fileId } = await api.uploadFile(projectId, file);
      const trackName = file.name.replace(/\.[^.]+$/, '');
      await api.addTrack(projectId, { name: trackName, type: 'fullmix', fileId, fileName: file.name } as any);
    }
    window.dispatchEvent(new CustomEvent('ghost-storage-changed'));
    onFilesAdded();
  };

  return (
    <div
      className={`relative transition-all ${dragOver ? 'ring-2 ring-ghost-green/50 ring-inset' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
    >
      {children}
      {dragOver && (
        <div className="absolute inset-0 bg-ghost-green/5 pointer-events-none z-30 rounded-xl" />
      )}
    </div>
  );
}

const BARS_PER_VIEW = 8;

export function ArrangementScrollView({ children, showAll }: { children: React.ReactNode; showAll?: boolean }) {
  const { numBars, arrangementDur } = useArrangement();
  const currentTime = useAudioStore((s) => s.currentTime);
  const isPlaying = useAudioStore((s) => s.isPlaying);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Inner wrapper is wider than the viewport so only BARS_PER_VIEW bars show
  // at a time. When showAll is on, the whole arrangement is fit to the
  // viewport. When numBars ≤ BARS_PER_VIEW, we already fit without scrolling.
  const innerWidthPct = showAll ? 100 : Math.max(100, (numBars / BARS_PER_VIEW) * 100);

  // Auto-follow: once the playhead leaves the visible range, page forward (or
  // back, if the user seeked) so the playhead stays on screen. Skipped when
  // showAll is on — the whole arrangement is already in view.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !isPlaying || arrangementDur <= 0 || showAll) return;
    const inner = el.firstElementChild as HTMLElement | null;
    if (!inner) return;
    const playheadX = (currentTime / arrangementDur) * inner.clientWidth;
    const viewStart = el.scrollLeft;
    const viewEnd = viewStart + el.clientWidth;
    if (playheadX > viewEnd) {
      const maxScroll = Math.max(0, inner.clientWidth - el.clientWidth);
      el.scrollTo({ left: Math.min(maxScroll, viewStart + el.clientWidth), behavior: 'smooth' });
    } else if (playheadX < viewStart) {
      el.scrollTo({ left: Math.max(0, playheadX - 20), behavior: 'smooth' });
    }
  }, [currentTime, isPlaying, arrangementDur, showAll]);

  // When toggling back to 8-bar view, reset scroll so the playhead is visible.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || showAll) return;
    el.scrollTo({ left: 0, behavior: 'auto' });
  }, [showAll]);

  return (
    <div
      ref={scrollRef}
      className="relative overflow-x-auto"
      style={{ scrollbarWidth: 'thin', scrollbarColor: 'rgba(124,58,237,0.3) transparent' }}
    >
      <div className="relative" style={{ width: `${innerWidthPct}%` }}>
        {children}
      </div>
    </div>
  );
}

// Shared time axis for the arrangement: at least 16 bars wide, stretches to
// cover the longest clip. Ruler, clips, and playhead all position against this
// so they stay aligned regardless of BPM or project length.
function useArrangement() {
  const projectBpm = useAudioStore((s) => s.projectBpm);
  const duration = useAudioStore((s) => s.duration);
  const bpm = projectBpm > 0 ? projectBpm : 120;
  const barSec = 240 / bpm;
  // Round bar count up to cover the longest clip, then derive arrangementDur
  // from exact bars. This keeps ruler tick positions (i / numBars) and clip
  // positions (startOffset / arrangementDur) on the same denominator so
  // clips land exactly on bar lines.
  const numBars = Math.max(16, Math.ceil((duration || 0) / barSec));
  const arrangementDur = numBars * barSec;
  return { bpm, barSec, arrangementDur, numBars };
}

export function BarRuler() {
  const { numBars, arrangementDur } = useArrangement();
  const seekTo = useAudioStore((s) => s.seekTo);
  // Thin the label density as bar count grows so text doesn't crowd.
  const step = numBars <= 24 ? 2 : numBars <= 48 ? 4 : numBars <= 96 ? 8 : 16;

  const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    if (arrangementDur <= 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    seekTo(ratio * arrangementDur);
  };

  return (
    <div className="flex h-[18px] w-full select-none" style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
      {/* Header-column spacer keeps the time grid aligned with the clip
          area below — bar 1 sits at the same x as the leftmost clip. */}
      <div style={{ width: TRACK_HEADER_WIDTH }} className="shrink-0" />
      <div
        className="relative flex-1 cursor-pointer"
        onClick={handleSeek}
        title="Click to seek"
      >
        {Array.from({ length: numBars }).map((_, i) => {
          const leftPct = (i / numBars) * 100;
          const labeled = i % step === 0;
          return (
            <div key={i} className="absolute top-0 bottom-0 pointer-events-none" style={{ left: `${leftPct}%` }}>
              <div className="absolute top-0 left-0" style={{ width: 1, height: labeled ? 7 : 4, background: 'rgba(255,255,255,0.22)' }} />
              {labeled && (
                <span className="absolute left-[3px] top-[7px] text-[9px] leading-none font-medium tracking-wider text-white/35">
                  {i + 1}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
// Full-height vertical bar lines — same density as the BarRuler, drawn as
// an overlay over the lane area so the time grid runs continuously top to
// bottom (FL Studio playlist look). Renders ON TOP of clips with low
// opacity + pointer-events:none so it reads through them without blocking
// any interaction. Lines on labeled bars are brighter; in-between bars
// are dimmer for context.
export function BarGridOverlay() {
  const { numBars } = useArrangement();
  // Two-tier density. `labeledStep` = bright lines that align with the
  // labeled BarRuler ticks. `minorStep` = how often a dim line is drawn
  // in between. Past ~64 bars the dim in-between lines start crowding,
  // so we drop them and the grid stays readable in fit-all-bars view.
  const labeledStep = numBars <= 24 ? 2 : numBars <= 48 ? 4 : numBars <= 96 ? 8 : 16;
  const minorStep = numBars <= 16 ? 1 : numBars <= 32 ? 1 : numBars <= 64 ? 2 : numBars <= 128 ? 4 : 8;
  return (
    <div
      className="absolute pointer-events-none"
      style={{ left: TRACK_HEADER_WIDTH, top: 0, bottom: 0, right: 0, zIndex: 15 }}
    >
      {Array.from({ length: numBars }).map((_, i) => {
        // Skip the line entirely if it isn't on the labeled step or the
        // minor step — keeps the grid clean at high bar counts.
        const isLabeled = i % labeledStep === 0;
        if (!isLabeled && i % minorStep !== 0) return null;
        const leftPct = (i / numBars) * 100;
        return (
          <div
            key={i}
            className="absolute top-0 bottom-0"
            style={{
              left: `${leftPct}%`,
              width: 1,
              background: isLabeled ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.07)',
            }}
          />
        );
      })}
    </div>
  );
}

/* ── Playhead across all lanes ── */
export function ArrangementPlayhead() {
  const currentTime = useAudioStore((s) => s.currentTime);
  const isPlaying = useAudioStore((s) => s.isPlaying);
  const soloPlayingTrackId = useAudioStore((s) => s.soloPlayingTrackId);
  const { arrangementDur } = useArrangement();

  if (soloPlayingTrackId) return null;
  const showLocal = isPlaying || currentTime > 0;
  const localPct = arrangementDur > 0 ? (currentTime / arrangementDur) * 100 : 0;

  // Collaborator ghost playheads removed by design — playback is per-user
  // and showing other people's positions on your timeline was confusing
  // when multiple people scrub different sections.
  const remotes: Array<{ userId: string; pct: number; colour: string; displayName: string; isPlaying: boolean }> = [];

  return (
    // Wrapper offset by the track-header column so percentages map to the
    // CLIP area only — playhead at 0% sits at the leftmost clip edge, not
    // the leftmost header.
    <div className="absolute top-0 bottom-0 pointer-events-none" style={{ left: TRACK_HEADER_WIDTH, right: 0 }}>
      {remotes.map((r) => (
        <div
          key={r.userId}
          className="absolute top-0 bottom-0 w-[2px] pointer-events-none z-[18]"
          style={{
            left: `${Math.min(r.pct, 100)}%`,
            background: r.colour,
            opacity: r.isPlaying ? 0.75 : 0.35,
            boxShadow: `0 0 5px ${r.colour}`,
          }}
          title={`${r.displayName}${r.isPlaying ? ' (playing)' : ''}`}
        />
      ))}
      {showLocal && (
        <div
          className="absolute top-0 bottom-0 w-[2px] pointer-events-none z-20"
          style={{ left: `${Math.min(localPct, 100)}%`, background: '#00FFC8', boxShadow: '0 0 6px rgba(0,255,200,0.5)' }}
        />
      )}
    </div>
  );
}

/* ── Single clip in a lane ── */
function LaneClip({ track, selectedProjectId, deleteTrack, trackZoom, laneWidth, clipIndex, totalClips, members }: {
  track: any; selectedProjectId: string; deleteTrack: any; trackZoom: 'full' | 'half'; laneWidth: number; clipIndex: number; totalClips: number; members: Member[];
}) {
  const { arrangementDur, bpm } = useArrangement();
  const startOffset = useAudioStore((s) => s.loadedTracks.get(track.id)?.startOffset ?? 0);
  const clipDur = useAudioStore((s) => s.loadedTracks.get(track.id)?.buffer?.duration ?? 0);
  // Beat-aligned snap: firstBeatOffset tells us where inside the sample the
  // first detected beat lives. We snap that position (not the sample's
  // leading edge) to bar lines so kicks-with-lead-in hit the downbeat.
  // Convert from the original buffer's timeline to the currently-playing
  // (possibly stretched) timeline via the loaded track's stretch factor.
  const beatAlignOffset = useAudioStore((s) => {
    const t = s.loadedTracks.get(track.id);
    if (!t?.firstBeatOffset || !t.originalBuffer) return 0;
    const factor = t.originalBuffer.duration > 0 ? t.buffer.duration / t.originalBuffer.duration : 1;
    return t.firstBeatOffset * factor;
  });
  const setTrackOffset = useAudioStore((s) => s.setTrackOffset);
  // Selection — drives the green ring + what Ctrl+C/Ctrl+V operate on.
  const isSelected = useAudioStore((s) => s.selectedTrackIds.has(track.id));
  const setSelectedTrackIds = useAudioStore((s) => s.setSelectedTrackIds);
  const toggleTrackSelection = useAudioStore((s) => s.toggleTrackSelection);
  const addTrackToSelection = useAudioStore((s) => s.addTrackToSelection);
  // Group drag — any selected clip renders its position shifted by the
  // global groupDragDelta while a group drag is in progress.
  const inGroupDrag = useAudioStore((s) => s.groupDragIds.has(track.id));
  const groupDragDelta = useAudioStore((s) => s.groupDragDelta);
  const [dragOffset, setDragOffset] = useState<number | null>(null);
  // If a collaborator is currently dragging this clip, lock our own drag
  // and paint a coloured ghost at their live position.
  const remoteDrag = useCollabStore((s) => s.remoteDrags.get(track.id) || null);

  // Prefer time-axis positioning once the buffer has loaded; fall back to the
  // legacy side-by-side layout so clips don't collapse to zero width while the
  // audio is still decoding.
  const haveTime = clipDur > 0 && arrangementDur > 0;
  const effectiveOffset = dragOffset !== null
    ? dragOffset
    : inGroupDrag
      ? Math.max(0, startOffset + groupDragDelta)
      : startOffset;
  const leftPct = haveTime
    ? (effectiveOffset / arrangementDur) * 100
    : clipIndex * (100 / Math.max(1, totalClips));
  const clipWidth = haveTime
    ? (clipDur / arrangementDur) * 100
    : 100 / Math.max(1, totalClips);
  const height = trackZoom === 'half' ? 48 : 70;
  const owner = members.find((m) => m.userId === track.ownerId);
  const ownerName = owner?.displayName || track.ownerName || 'Unknown';
  const displayName = (track.name || 'Track').replace(/\.(wav|mp3|flac|aiff|ogg|m4a)$/i, '').replace(/_/g, ' ');

  // Context-menu state (replaces the old hover-controls overlay). Opens at
  // the cursor position on right-click; closes on any outside click or Esc.
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!menu) return;
    const onDown = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  // Build the list of clips these actions apply to: the whole selection if
  // this clip is part of a multi-selection, otherwise just this clip.
  const targetsForAction = (): string[] => {
    const sel = useAudioStore.getState().selectedTrackIds;
    if (sel.has(track.id) && sel.size > 1) return Array.from(sel);
    return [track.id];
  };

  const duplicateClip = async () => {
    const ids = targetsForAction();
    const projectBpm = useAudioStore.getState().projectBpm || 120;
    const grid = useAudioStore.getState().gridDivision;
    const loadedTracks = useAudioStore.getState().loadedTracks;
    const projectTracks = (useProjectStore.getState().currentProject?.tracks || []) as any[];
    for (const id of ids) {
      const srcTrack = projectTracks.find((t: any) => t.id === id);
      if (!srcTrack?.fileId) continue;
      const loaded = loadedTracks.get(id);
      const clipDuration = loaded?.buffer?.duration || 0;
      const rawOffset = (loaded?.startOffset ?? 0) + clipDuration;
      const newOffset = Math.max(0, snapToGrid(rawOffset, projectBpm, grid, 'nearest'));
      const result = await api.addTrack(selectedProjectId, {
        name: srcTrack.name || 'Track', type: srcTrack.type || 'audio',
        fileId: srcTrack.fileId, fileName: srcTrack.name,
      } as any);
      if (result?.id) pendingTrackOffsets.set(result.id, newOffset);
    }
    window.dispatchEvent(new CustomEvent('ghost-refresh-project'));
    window.dispatchEvent(new CustomEvent('ghost-save-arrangement'));
  };

  const deleteClip = async () => {
    const ids = targetsForAction();
    for (const id of ids) {
      useAudioStore.getState().removeTrack(id);
      try { await deleteTrack(selectedProjectId, id); } catch { /* continue remaining */ }
    }
    useAudioStore.getState().clearSelection();
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    if (remoteDrag) return;
    e.preventDefault();
    e.stopPropagation();
    // Right-click on a clip that isn't already in the selection replaces
    // selection with just this clip (so menu actions apply to what the
    // user visibly right-clicked). Right-click on a clip that IS in the
    // selection keeps the multi-selection intact.
    if (!isSelected) setSelectedTrackIds([track.id]);
    setMenu({ x: e.clientX, y: e.clientY });
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button')) return;
    if (!haveTime) return;
    // Conflict guard: someone else is already dragging this clip.
    if (remoteDrag) return;
    // Selection semantics: shift or ctrl/cmd extends; plain click replaces.
    if (e.shiftKey) addTrackToSelection(track.id);
    else if (e.ctrlKey || e.metaKey) toggleTrackSelection(track.id);
    else if (!isSelected) setSelectedTrackIds([track.id]);
    // If the clip is already in a multi-selection and user just clicks,
    // leave the selection as-is (so they can then drag the whole group).
    const clipEl = e.currentTarget;
    const laneEl = clipEl.parentElement;
    if (!laneEl) return;

    e.preventDefault();
    const startX = e.clientX;
    const laneWidthPx = laneEl.clientWidth;
    const initialOffset = startOffset;
    let liveOffset = initialOffset;
    const socket = getSocket();
    let lastEmit = 0;

    // Group drag setup: if this clip is part of a multi-selection, capture
    // every selected clip's initial offset so we can shift them together.
    // Leftmost clip caps the negative delta so the group can't slide past 0.
    const initialSel = useAudioStore.getState().selectedTrackIds;
    const isGroupDrag = initialSel.has(track.id) && initialSel.size > 1;
    const loadedTracksMap = useAudioStore.getState().loadedTracks;
    const groupIds: string[] = isGroupDrag ? Array.from(initialSel) : [];
    const initialGroupOffsets = new Map<string, number>();
    let groupLeftmost = Infinity;
    if (isGroupDrag) {
      for (const id of groupIds) {
        const l = loadedTracksMap.get(id);
        const off = l?.startOffset ?? 0;
        initialGroupOffsets.set(id, off);
        if (off < groupLeftmost) groupLeftmost = off;
      }
    }

    const handleMove = (ev: PointerEvent) => {
      const deltaX = ev.clientX - startX;
      const deltaTime = (deltaX / laneWidthPx) * arrangementDur;
      if (isGroupDrag) {
        // Clamp so the leftmost clip stays at ≥ 0.
        const clamped = Math.max(-groupLeftmost, deltaTime);
        useAudioStore.getState().setGroupDrag(groupIds, clamped);
        liveOffset = initialOffset + clamped;
      } else {
        liveOffset = Math.max(0, initialOffset + deltaTime);
        setDragOffset(liveOffset);
      }
      // Throttle live drag broadcast to ~30 Hz so collaborators see a smooth
      // ghost move without flooding the socket. Broadcast only for the
      // initiator clip during group drags — multi-clip ghosts would flood.
      const now = performance.now();
      if (socket && now - lastEmit > 33) {
        lastEmit = now;
        socket.emit('clip:drag', { projectId: selectedProjectId, trackId: track.id, liveOffset });
      }
    };
    const handleUp = () => {
      const grid = useAudioStore.getState().gridDivision;
      // Snap based on the initiator clip's first detected beat → bar line.
      // The same delta is then applied to every clip in the group so their
      // relative spacing is preserved.
      const beatPos = liveOffset + beatAlignOffset;
      const snappedBeatPos = snapToGrid(beatPos, bpm, grid, 'nearest');
      const snappedInitiator = Math.max(0, snappedBeatPos - beatAlignOffset);
      if (isGroupDrag) {
        const finalDelta = snappedInitiator - initialOffset;
        for (const id of groupIds) {
          const init = initialGroupOffsets.get(id) ?? 0;
          const next = Math.max(0, init + finalDelta);
          if (Math.abs(next - init) > 0.001) setTrackOffset(id, next);
        }
        useAudioStore.getState().endGroupDrag();
      } else {
        setDragOffset(null);
        if (Math.abs(snappedInitiator - initialOffset) > 0.001) {
          setTrackOffset(track.id, snappedInitiator);
        }
      }
      window.dispatchEvent(new CustomEvent('ghost-save-arrangement'));
      // Clear the remote ghost for every collaborator.
      if (socket) socket.emit('clip:drag', { projectId: selectedProjectId, trackId: track.id, liveOffset: null });
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
    };
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
  };

  // Remote ghost: someone else is dragging this clip — render a coloured
  // outline at their live position + a small caption with their name.
  const remoteGhostLeftPct = remoteDrag && haveTime
    ? (remoteDrag.liveOffset / arrangementDur) * 100
    : 0;

  return (
    <>
    {remoteDrag && haveTime && (
      <div
        className="absolute top-1 bottom-1 rounded-lg pointer-events-none"
        style={{
          left: `${remoteGhostLeftPct}%`,
          width: `${clipWidth}%`,
          border: `2px dashed ${remoteDrag.colour}`,
          background: `${remoteDrag.colour}14`,
          boxShadow: `0 0 10px ${remoteDrag.colour}55`,
          zIndex: 9,
        }}
      >
        <span
          className="absolute -top-4 left-0 px-1.5 py-0.5 rounded text-[9px] font-bold whitespace-nowrap"
          style={{ background: remoteDrag.colour, color: '#000' }}
        >
          {remoteDrag.displayName}
        </span>
      </div>
    )}
    <div
      data-clip-id={track.id}
      onPointerDown={handlePointerDown}
      onContextMenu={handleContextMenu}
      className={`absolute top-1 bottom-1 group rounded-lg overflow-hidden ${haveTime && !remoteDrag ? 'cursor-grab active:cursor-grabbing' : ''} ${remoteDrag ? 'cursor-not-allowed' : ''}`}
      style={{
        left: `${leftPct}%`,
        width: `${clipWidth}%`,
        background: '#0A0412',
        border: isSelected ? '1px solid rgba(0,255,200,0.7)' : '1px solid rgba(255,255,255,0.08)',
        boxShadow:
          dragOffset !== null ? '0 0 0 1px rgba(168,85,247,0.6), 0 4px 16px rgba(124,58,237,0.3)'
          : isSelected ? '0 0 0 1px rgba(0,255,200,0.45), 0 0 12px rgba(0,255,200,0.25)'
          : undefined,
        zIndex: dragOffset !== null ? 10 : isSelected ? 5 : undefined,
        opacity: remoteDrag ? 0.5 : 1,
        userSelect: 'none',
      }}
    >
      <Waveform
        seed={track.name + (track.type || 'audio')}
        height={height - 2}
        fileId={track.fileId}
        projectId={selectedProjectId}
        trackId={track.id}
        showPlayhead={true}
      />
      {/* Track name + uploader avatar — only on the first clip in a lane */}
      {clipIndex === 0 && (
        <div className="absolute left-2 top-1 z-10 pointer-events-none flex flex-col gap-1 items-start" style={{ filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.8))' }}>
          <p className="text-[10px] font-bold text-white/80 truncate max-w-[120px]">{displayName}</p>
          <div
            title={`Added by ${ownerName}`}
            className="shrink-0 rounded-[10px] overflow-hidden ring-1 ring-black/60"
            style={{
              boxShadow: '0 2px 6px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.08) inset',
            }}
          >
            <Avatar name={ownerName} src={owner?.avatarUrl || null} size="sm" userId={track.ownerId || null} />
          </div>
        </div>
      )}
    </div>
    {menu && (
      <div
        onMouseDown={(e) => e.stopPropagation()}
        className="fixed z-50 min-w-[140px] rounded-md py-1 shadow-[0_8px_24px_rgba(0,0,0,0.5)] backdrop-blur-md"
        style={{
          left: menu.x, top: menu.y,
          background: 'rgba(20, 12, 30, 0.96)',
          border: '1px solid rgba(255,255,255,0.08)',
        }}
      >
        <button
          onClick={() => { setMenu(null); duplicateClip(); }}
          className="w-full px-3 py-1.5 text-[13px] text-left text-ghost-text-secondary hover:bg-white/[0.06] hover:text-white transition-colors flex items-center gap-2"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
          Duplicate
        </button>
        <button
          onClick={() => { setMenu(null); deleteClip(); }}
          className="w-full px-3 py-1.5 text-[13px] text-left text-ghost-error-red hover:bg-ghost-error-red/10 transition-colors flex items-center gap-2"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
          Delete
        </button>
      </div>
    )}
    </>
  );
}

/* ── Single lane row ── */
// One reorderable lane. Drag is gated to the track header on the left so
// pointer-down on a clip / empty clip space behaves exactly like before
// (clip drag, marquee, etc.). useDragControls + dragListener=false is the
// framer-motion idiom for "drag only when I tell you to."
function LaneRow({ laneKey, laneTracks, laneHeight, selectedProjectId, deleteTrack, trackZoom, members }: {
  laneKey: string;
  laneTracks: any[];
  laneHeight: number;
  selectedProjectId: string;
  deleteTrack: any;
  trackZoom: 'full' | 'half';
  members: Member[];
}) {
  const dragControls = useDragControls();
  const hue = laneHueForKey(laneKey);
  const laneName = laneTracks[0]?.name || 'Track';
  const setTrackMuted = useAudioStore((s) => s.setTrackMuted);
  // True if every clip in this lane is currently muted — drives the
  // menu toggle's checkmark + label.
  const laneIsMuted = useAudioStore((s) => {
    const ids = laneTracks.map((t: any) => t.id);
    if (ids.length === 0) return false;
    return ids.every((id: string) => s.loadedTracks.get(id)?.muted === true);
  });
  // Right-click menu on the header (anchor in screen coords).
  const [headerMenu, setHeaderMenu] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!headerMenu) return;
    const onDown = () => setHeaderMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setHeaderMenu(null); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [headerMenu]);

  const toggleLaneMute = () => {
    const target = !laneIsMuted;
    for (const t of laneTracks) setTrackMuted(t.id, target);
    window.dispatchEvent(new CustomEvent('ghost-save-arrangement'));
  };

  const deleteLane = async () => {
    const count = laneTracks.length;
    const cleanName = laneName.replace(/\.(wav|mp3|flac|aiff|ogg|m4a|aac)$/i, '');
    if (!window.confirm(`Delete the entire "${cleanName}" track? This removes ${count} clip${count === 1 ? '' : 's'} from the arrangement.`)) return;
    for (const t of laneTracks) {
      useAudioStore.getState().removeTrack(t.id);
      try { await deleteTrack(selectedProjectId, t.id); } catch { /* keep going */ }
    }
    window.dispatchEvent(new CustomEvent('ghost-refresh-project'));
  };

  return (
    <Reorder.Item
      value={laneKey}
      dragListener={false}
      dragControls={dragControls}
      className="flex"
      style={{ height: laneHeight }}
      whileDrag={{ scale: 1.005, zIndex: 50, boxShadow: '0 8px 24px rgba(0,0,0,0.5)' }}
      transition={{ duration: 0.15 }}
      as="div"
    >
      {/* Track header is the drag handle. data-track-header lets the
          marquee handler bail out without starting a rubber-band. */}
      <div
        data-track-header
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          dragControls.start(e);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setHeaderMenu({ x: e.clientX, y: e.clientY });
        }}
        className="h-full flex"
        style={{ cursor: 'grab' }}
      >
        <TrackHeader name={laneName} hue={hue} trackIds={laneTracks.map((t: any) => t.id)} isSelected={laneIsMuted} />
      </div>
      <div
        className="relative rounded-r-lg flex-1"
        style={{
          background: 'rgba(10,4,18,0.4)',
          borderBottom: '1px solid rgba(255,255,255,0.04)',
          opacity: laneIsMuted ? 0.45 : 1,
          transition: 'opacity 0.15s linear',
        }}
      >
        {laneTracks.map((track: any, idx: number) => (
          <LaneClip
            key={track.id}
            track={track}
            selectedProjectId={selectedProjectId}
            deleteTrack={deleteTrack}
            trackZoom={trackZoom}
            laneWidth={100}
            clipIndex={idx}
            totalClips={laneTracks.length}
            members={members}
          />
        ))}
      </div>
      {headerMenu && (
        <div
          onMouseDown={(e) => e.stopPropagation()}
          className="fixed z-[60] min-w-[160px] rounded-md py-1 shadow-[0_8px_24px_rgba(0,0,0,0.5)] backdrop-blur-md"
          style={{
            left: headerMenu.x, top: headerMenu.y,
            background: 'rgba(20, 12, 30, 0.96)',
            border: '1px solid rgba(255,255,255,0.08)',
          }}
        >
          <button
            onClick={() => { setHeaderMenu(null); toggleLaneMute(); }}
            className="w-full px-3 py-1.5 text-[13px] text-left text-ghost-text-secondary hover:bg-white/[0.06] hover:text-white transition-colors flex items-center gap-2"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              {laneIsMuted ? (
                <>
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                  <line x1="23" y1="9" x2="17" y2="15" />
                  <line x1="17" y1="9" x2="23" y2="15" />
                </>
              ) : (
                <>
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                  <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" />
                </>
              )}
            </svg>
            {laneIsMuted ? 'Unmute track' : 'Mute track'}
          </button>
          <button
            onClick={() => { setHeaderMenu(null); deleteLane(); }}
            className="w-full px-3 py-1.5 text-[13px] text-left text-ghost-error-red hover:bg-ghost-error-red/10 transition-colors flex items-center gap-2"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
            Delete entire track
          </button>
        </div>
      )}
    </Reorder.Item>
  );
}

/* ── Track lanes with horizontal clips ── */
export function DraggableTrackList({ tracks, selectedProjectId, deleteTrack, updateTrack, trackZoom, fetchProject, members = [] }: {
  tracks: any[];
  selectedProjectId: string;
  deleteTrack: any;
  updateTrack: any;
  trackZoom: 'full' | 'half';
  fetchProject: any;
  members?: Member[];
}) {
  const bufferVersion = useAudioStore((s) => s.bufferVersion);

  const loadedTracks = useAudioStore((s) => s.loadedTracks);
  const setTrackOffset = useAudioStore((s) => s.setTrackOffset);
  // Tracks we've already seeded an initial offset for. Prevents re-seeding
  // after the user drags a clip, and also prevents double-seeding if the
  // effect fires repeatedly while a newly-duplicated track is decoding.
  const seededRef = useRef<Set<string>>(new Set());

  // Group tracks by fileId — same file = same lane, clips side by side
  const lanes = tracks.reduce((acc: Map<string, any[]>, track: any) => {
    const key = track.fileId || track.id;
    if (!acc.has(key)) acc.set(key, []);
    acc.get(key)!.push(track);
    return acc;
  }, new Map<string, any[]>());

  // If the server has a non-empty persisted arrangement, trust it and skip
  // the seeder — otherwise default idx*clipDur positions would stomp on the
  // user's saved drags after the restore applies. An empty clips array is
  // treated as "no arrangement yet" so fresh projects still get seeded.
  const hasServerArrangement = useProjectStore((s) => {
    const raw = s.currentProject?.arrangementJson;
    if (!raw) return false;
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed?.clips) && parsed.clips.length > 0;
    } catch {
      return false;
    }
  });

  // Seed startOffsets for never-positioned duplicate clips so they land side
  // by side on FIRST load (before anything is saved). Once the server owns
  // an arrangement, this effect no-ops.
  useEffect(() => {
    if (hasServerArrangement) return;
    lanes.forEach((laneTracks) => {
      if (laneTracks.length <= 1) return;
      const firstBuffer = loadedTracks.get(laneTracks[0].id)?.buffer;
      if (!firstBuffer) return;
      const clipDur = firstBuffer.duration;
      laneTracks.forEach((t: any, idx: number) => {
        if (idx === 0) return;
        if (seededRef.current.has(t.id)) return;
        const loaded = loadedTracks.get(t.id);
        if (!loaded) return;
        if (loaded.startOffset === 0) {
          setTrackOffset(t.id, idx * clipDur);
        }
        seededRef.current.add(t.id);
      });
    });
  }, [tracks.length, bufferVersion, loadedTracks, hasServerArrangement]);

  // When the project changes, forget what we've seeded so the new project
  // starts clean.
  useEffect(() => {
    seededRef.current.clear();
  }, [selectedProjectId]);

  const laneHeight = trackZoom === 'half' ? 50 : 72;

  // Marquee (rubber-band) multi-select. Pointer down on empty lane space
  // starts it; on release every clip whose bounding rect intersects the
  // marquee is dumped into the selection. Hit-testing via the data-clip-id
  // attribute on LaneClip — cheaper than maintaining a rect cache, and
  // accurate regardless of how the arrangement was scrolled/zoomed.
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [marquee, setMarquee] = useState<null | { x1: number; y1: number; x2: number; y2: number }>(null);
  const setSelectedTrackIds = useAudioStore((s) => s.setSelectedTrackIds);
  const clearSelection = useAudioStore((s) => s.clearSelection);

  // Lane order lives in the audio store and is round-tripped through the
  // server's arrangement blob — every collaborator sees the same vertical
  // layout. Reordering dispatches a flush so the change syncs instantly.
  const laneOrder = useAudioStore((s) => s.laneOrder);
  const setLaneOrderStore = useAudioStore((s) => s.setLaneOrder);
  const handleReorder = useCallback((next: string[]) => {
    setLaneOrderStore(next);
    window.dispatchEvent(new CustomEvent('ghost-save-arrangement'));
  }, [setLaneOrderStore]);

  const orderedLaneKeys = useMemo(() => {
    const keys = Array.from(lanes.keys());
    const indexOf = new Map(laneOrder.map((k, i) => [k, i]));
    // Stable sort: lanes the user has already arranged keep their slot;
    // brand-new lanes land at the bottom in tracks-prop order.
    return keys.sort((a, b) => {
      const ia = indexOf.get(a) ?? Infinity;
      const ib = indexOf.get(b) ?? Infinity;
      return ia - ib;
    });
  }, [lanes, laneOrder]);

  const handleMarqueeStart = (e: React.PointerEvent<HTMLDivElement>) => {
    // Don't start a marquee if the user actually grabbed a clip OR a track
    // header (which now drags the whole lane up/down).
    const target = e.target as HTMLElement;
    if (target.closest('[data-clip-id]')) return;
    if (target.closest('[data-track-header]')) return;
    if (e.button !== 0) return;
    const root = containerRef.current;
    if (!root) return;
    const rect = root.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    // Plain click on empty space clears the selection immediately. If this
    // turns into a drag, the marquee will replace it with its own set.
    if (!e.shiftKey && !e.ctrlKey && !e.metaKey) clearSelection();
    let dragged = false;
    const onMove = (ev: PointerEvent) => {
      if (!dragged && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return;
      dragged = true;
      setMarquee({ x1: startX, y1: startY, x2: ev.clientX, y2: ev.clientY });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (!dragged) { setMarquee(null); return; }
      // Read final marquee rect and hit-test every clip.
      const minX = Math.min(startX, (window as any).__lastMoveX ?? startX);
      setMarquee((m) => {
        if (!m) return null;
        const nx1 = Math.min(m.x1, m.x2), ny1 = Math.min(m.y1, m.y2);
        const nx2 = Math.max(m.x1, m.x2), ny2 = Math.max(m.y1, m.y2);
        const hits = new Set<string>();
        const extant = useAudioStore.getState().selectedTrackIds;
        // Preserve existing selection when Shift/Ctrl is held.
        if (e.shiftKey || e.ctrlKey || e.metaKey) for (const id of extant) hits.add(id);
        root.querySelectorAll<HTMLElement>('[data-clip-id]').forEach((el) => {
          const cr = el.getBoundingClientRect();
          const intersects = !(cr.right < nx1 || cr.left > nx2 || cr.bottom < ny1 || cr.top > ny2);
          if (intersects) {
            const id = el.getAttribute('data-clip-id');
            if (id) hits.add(id);
          }
        });
        setSelectedTrackIds(hits);
        return null;
      });
      void minX;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    void rect;
  };

  return (
    <div
      ref={containerRef}
      className="relative flex flex-col gap-1 mt-2"
      onPointerDown={handleMarqueeStart}
    >
      <Reorder.Group
        axis="y"
        values={orderedLaneKeys}
        onReorder={handleReorder}
        className="flex flex-col gap-1"
        as="div"
      >
        {orderedLaneKeys.map((laneKey) => {
          const laneTracks = lanes.get(laneKey);
          if (!laneTracks) return null;
          return (
            <LaneRow
              key={laneKey}
              laneKey={laneKey}
              laneTracks={laneTracks}
              laneHeight={laneHeight}
              selectedProjectId={selectedProjectId}
              deleteTrack={deleteTrack}
              trackZoom={trackZoom}
              members={members}
            />
          );
        })}
      </Reorder.Group>
      {/* Bar grid lines drawn ON TOP of all lanes (FL-Studio playlist
          style). pointer-events:none so the lines never block clip
          interactions. Opacity is low enough that clip waveforms read
          through cleanly. */}
      <BarGridOverlay />
      {marquee && (
        <div
          className="pointer-events-none"
          style={{
            position: 'fixed',
            left: Math.min(marquee.x1, marquee.x2),
            top: Math.min(marquee.y1, marquee.y2),
            width: Math.abs(marquee.x2 - marquee.x1),
            height: Math.abs(marquee.y2 - marquee.y1),
            background: 'rgba(0, 255, 200, 0.08)',
            border: '1px solid rgba(0, 255, 200, 0.6)',
            borderRadius: 4,
            zIndex: 40,
          }}
        />
      )}
    </div>
  );
}

export function TrackWithWidth({ track, selectedProjectId, deleteTrack, updateTrack, trackZoom, fetchProject }: { track: any; selectedProjectId: string; deleteTrack: any; updateTrack: any; trackZoom: 'full' | 'half'; fetchProject: any }) {
  return null;
}
