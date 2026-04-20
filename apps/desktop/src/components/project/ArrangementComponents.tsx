import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useAudioStore, pendingTrackOffsets } from '../../stores/audioStore';
import { api } from '../../lib/api';
import { snapToBar } from '../../lib/audio';
import Waveform from '../tracks/Waveform';
import Avatar from '../common/Avatar';

type Member = { userId: string; displayName: string; avatarUrl: string | null };

/* ── Drop zone for uploading audio files ── */
export function ArrangementDropZone({ projectId, onFilesAdded, children }: { projectId: string; onFilesAdded: () => void; children: React.ReactNode }) {
  const [dragOver, setDragOver] = useState(false);

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const droppedFiles = Array.from(e.dataTransfer.files).filter((f) =>
      f.type.startsWith('audio/') || f.name.match(/\.(wav|mp3|flac|aiff|ogg|m4a|aac)$/i)
    );
    if (droppedFiles.length === 0) return;
    for (const file of droppedFiles) {
      const { fileId } = await api.uploadFile(projectId, file);
      const trackName = file.name.replace(/\.[^.]+$/, '');
      await api.addTrack(projectId, { name: trackName, type: 'fullmix', fileId, fileName: file.name } as any);
    }
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
  const { numBars } = useArrangement();
  // Thin the label density as bar count grows so text doesn't crowd.
  const step = numBars <= 24 ? 2 : numBars <= 48 ? 4 : numBars <= 96 ? 8 : 16;

  return (
    <div className="relative h-[18px] w-full select-none" style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
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
  );
}
export function BarGridOverlay() { return null; }

/* ── Playhead across all lanes ── */
export function ArrangementPlayhead() {
  const currentTime = useAudioStore((s) => s.currentTime);
  const isPlaying = useAudioStore((s) => s.isPlaying);
  const soloPlayingTrackId = useAudioStore((s) => s.soloPlayingTrackId);
  const { arrangementDur } = useArrangement();

  if ((!isPlaying && currentTime === 0) || soloPlayingTrackId) return null;
  const pct = arrangementDur > 0 ? (currentTime / arrangementDur) * 100 : 0;

  return (
    <div
      className="absolute top-0 bottom-0 w-[2px] pointer-events-none z-20"
      style={{ left: `${Math.min(pct, 100)}%`, background: '#00FFC8', boxShadow: '0 0 6px rgba(0,255,200,0.5)' }}
    />
  );
}

/* ── Single clip in a lane ── */
function LaneClip({ track, selectedProjectId, deleteTrack, trackZoom, laneWidth, clipIndex, totalClips, members }: {
  track: any; selectedProjectId: string; deleteTrack: any; trackZoom: 'full' | 'half'; laneWidth: number; clipIndex: number; totalClips: number; members: Member[];
}) {
  const { arrangementDur, bpm } = useArrangement();
  const startOffset = useAudioStore((s) => s.loadedTracks.get(track.id)?.startOffset ?? 0);
  const clipDur = useAudioStore((s) => s.loadedTracks.get(track.id)?.buffer?.duration ?? 0);
  const setTrackOffset = useAudioStore((s) => s.setTrackOffset);
  const [dragOffset, setDragOffset] = useState<number | null>(null);

  // Prefer time-axis positioning once the buffer has loaded; fall back to the
  // legacy side-by-side layout so clips don't collapse to zero width while the
  // audio is still decoding.
  const haveTime = clipDur > 0 && arrangementDur > 0;
  const effectiveOffset = dragOffset !== null ? dragOffset : startOffset;
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

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // Don't start a drag if the user clicked on one of the hover controls.
    if ((e.target as HTMLElement).closest('button')) return;
    if (!haveTime) return;
    const clipEl = e.currentTarget;
    const laneEl = clipEl.parentElement;
    if (!laneEl) return;

    e.preventDefault();
    const startX = e.clientX;
    const laneWidthPx = laneEl.clientWidth;
    const initialOffset = startOffset;
    let liveOffset = initialOffset;

    const handleMove = (ev: PointerEvent) => {
      const deltaX = ev.clientX - startX;
      const deltaTime = (deltaX / laneWidthPx) * arrangementDur;
      liveOffset = Math.max(0, initialOffset + deltaTime);
      setDragOffset(liveOffset);
    };
    const handleUp = () => {
      // Commit: snap the final position to the nearest bar.
      const snapped = Math.max(0, snapToBar(liveOffset, bpm, 'nearest'));
      setDragOffset(null);
      if (Math.abs(snapped - initialOffset) > 0.001) {
        setTrackOffset(track.id, snapped);
        // Ask TransportBar to flush the arrangement to localStorage now so
        // the position survives even if the plugin is torn down before the
        // debounced save runs.
        window.dispatchEvent(new CustomEvent('ghost-save-arrangement'));
      }
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
    };
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
  };

  return (
    <div
      onPointerDown={handlePointerDown}
      className={`absolute top-1 bottom-1 group rounded-lg overflow-hidden ${haveTime ? 'cursor-grab active:cursor-grabbing' : ''}`}
      style={{
        left: `${leftPct}%`,
        width: `${clipWidth}%`,
        background: '#0A0412',
        border: '1px solid rgba(255,255,255,0.08)',
        boxShadow: dragOffset !== null ? '0 0 0 1px rgba(168,85,247,0.6), 0 4px 16px rgba(124,58,237,0.3)' : undefined,
        zIndex: dragOffset !== null ? 10 : undefined,
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
            <Avatar name={ownerName} src={owner?.avatarUrl || null} size="sm" />
          </div>
        </div>
      )}
      {/* Hover controls */}
      <div className="absolute top-1/2 -translate-y-1/2 right-1 z-20 flex items-center gap-0 opacity-0 group-hover:opacity-100 transition-opacity rounded overflow-hidden" style={{ background: 'rgba(0,0,0,0.7)' }}>
        <button
          onClick={async () => {
            if (!track.fileId) return;
            // Drop the copy immediately after *this* clip, snapped to the
            // nearest bar. Using track.startOffset + duration (instead of a
            // fixed clipIndex-based offset) means the duplicate lands next
            // to the clip the user actually clicked, even after the user
            // has dragged it elsewhere on the grid.
            const loaded = useAudioStore.getState().loadedTracks.get(track.id);
            const clipDuration = loaded?.buffer?.duration || 0;
            const currentOffset = loaded?.startOffset ?? 0;
            const rawOffset = currentOffset + clipDuration;
            const projectBpm = useAudioStore.getState().projectBpm || 120;
            const newOffset = Math.max(0, snapToBar(rawOffset, projectBpm, 'nearest'));

            const result = await api.addTrack(selectedProjectId, { name: (track.name || 'Track'), type: track.type || 'audio', fileId: track.fileId, fileName: track.name } as any);
            if (result?.id) {
              // Stash the intended offset so the audio store applies it the
              // moment the new track lands (it otherwise defaults to 0 and
              // overlaps the original before the async seeder catches up).
              pendingTrackOffsets.set(result.id, newOffset);
            }
            window.dispatchEvent(new CustomEvent('ghost-refresh-project'));
            // Ask TransportBar to flush the arrangement immediately so the
            // new clip's position survives a quick plugin close.
            window.dispatchEvent(new CustomEvent('ghost-save-arrangement'));
          }}
          title="Duplicate"
          className="w-7 h-7 flex items-center justify-center text-white/70 hover:text-white hover:bg-white/10 transition-colors"
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
        </button>
        <button
          onClick={() => { useAudioStore.getState().removeTrack(track.id); deleteTrack(selectedProjectId, track.id); }}
          title="Delete"
          className="w-7 h-7 flex items-center justify-center text-white/70 hover:text-red-400 hover:bg-white/10 transition-colors"
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
        </button>
      </div>
    </div>
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

  // Seed startOffsets for never-positioned duplicate clips so they land side
  // by side on first load. Runs on every loadedTracks change so late-arriving
  // tracks still get their offset seeded — once seededRef has the id, we
  // stop touching it so drags survive.
  useEffect(() => {
    lanes.forEach((laneTracks) => {
      if (laneTracks.length <= 1) return;
      const firstBuffer = loadedTracks.get(laneTracks[0].id)?.buffer;
      if (!firstBuffer) return;
      const clipDur = firstBuffer.duration;
      laneTracks.forEach((t: any, idx: number) => {
        if (idx === 0) return;
        if (seededRef.current.has(t.id)) return;
        const loaded = loadedTracks.get(t.id);
        if (!loaded) return; // wait for load — don't mark as seeded yet
        if (loaded.startOffset === 0) {
          setTrackOffset(t.id, idx * clipDur);
        }
        seededRef.current.add(t.id);
      });
    });
  }, [tracks.length, bufferVersion, loadedTracks]);

  // When the project changes, forget what we've seeded so the new project
  // starts clean.
  useEffect(() => {
    seededRef.current.clear();
  }, [selectedProjectId]);

  const laneHeight = trackZoom === 'half' ? 50 : 72;

  return (
    <div className="flex flex-col gap-1 mt-2">
      {Array.from(lanes.entries()).map(([fileId, laneTracks]) => (
        <div
          key={fileId}
          className="relative rounded-lg"
          style={{ height: laneHeight, background: 'rgba(10,4,18,0.4)', borderBottom: '1px solid rgba(255,255,255,0.04)' }}
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
      ))}
    </div>
  );
}

export function TrackWithWidth({ track, selectedProjectId, deleteTrack, updateTrack, trackZoom, fetchProject }: { track: any; selectedProjectId: string; deleteTrack: any; updateTrack: any; trackZoom: 'full' | 'half'; fetchProject: any }) {
  return null;
}
