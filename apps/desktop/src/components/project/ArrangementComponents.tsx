import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useAudioStore } from '../../stores/audioStore';
import { api } from '../../lib/api';
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

export function ArrangementScrollView({ children }: { children: React.ReactNode; showAll?: boolean }) {
  return <div className="relative overflow-x-auto" style={{ scrollbarWidth: 'thin', scrollbarColor: 'rgba(124,58,237,0.3) transparent' }}>{children}</div>;
}

export function BarRuler() { return null; }
export function BarGridOverlay() { return null; }

/* ── Playhead across all lanes ── */
export function ArrangementPlayhead() {
  const currentTime = useAudioStore((s) => s.currentTime);
  const duration = useAudioStore((s) => s.duration);
  const isPlaying = useAudioStore((s) => s.isPlaying);
  const soloPlayingTrackId = useAudioStore((s) => s.soloPlayingTrackId);

  if ((!isPlaying && currentTime === 0) || soloPlayingTrackId) return null;
  const pct = duration > 0 ? (currentTime / duration) * 100 : 0;

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
  const clipWidth = totalClips > 0 ? 100 / totalClips : 100;
  const leftPct = clipIndex * clipWidth;
  const height = trackZoom === 'half' ? 48 : 70;
  const owner = members.find((m) => m.userId === track.ownerId);
  const ownerName = owner?.displayName || track.ownerName || 'Unknown';
  const displayName = (track.name || 'Track').replace(/\.(wav|mp3|flac|aiff|ogg|m4a)$/i, '').replace(/_/g, ' ');

  return (
    <div
      className="absolute top-1 bottom-1 group rounded-lg overflow-hidden"
      style={{ left: `${leftPct}%`, width: `${clipWidth}%`, background: '#0A0412', border: '1px solid rgba(255,255,255,0.08)' }}
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
            <Avatar name={ownerName} src={owner?.avatarUrl || null} size="md" />
          </div>
        </div>
      )}
      {/* Hover controls */}
      <div className="absolute top-1/2 -translate-y-1/2 right-1 z-20 flex items-center gap-0 opacity-0 group-hover:opacity-100 transition-opacity rounded overflow-hidden" style={{ background: 'rgba(0,0,0,0.7)' }}>
        <button
          onClick={async () => {
            if (!track.fileId) return;
            // Calculate where the new clip should start — after the last clip in this lane
            const buffer = useAudioStore.getState().loadedTracks.get(track.id)?.buffer;
            const clipDuration = buffer?.duration || 0;
            const newOffset = (clipIndex + 1) * clipDuration;

            const result = await api.addTrack(selectedProjectId, { name: (track.name || 'Track'), type: track.type || 'audio', fileId: track.fileId, fileName: track.name } as any);
            // Set the startOffset for the new track so it plays after the original
            if (result?.id) {
              useAudioStore.getState().setTrackOffset(result.id, newOffset);
            }
            window.dispatchEvent(new CustomEvent('ghost-refresh-project'));
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

  // Group tracks by fileId — same file = same lane, clips side by side
  const lanes = tracks.reduce((acc: Map<string, any[]>, track: any) => {
    const key = track.fileId || track.id;
    if (!acc.has(key)) acc.set(key, []);
    acc.get(key)!.push(track);
    return acc;
  }, new Map<string, any[]>());

  // Set startOffsets for clips in each lane so they play sequentially
  useEffect(() => {
    lanes.forEach((laneTracks) => {
      if (laneTracks.length <= 1) return;
      const firstBuffer = loadedTracks.get(laneTracks[0].id)?.buffer;
      if (!firstBuffer) return;
      const clipDur = firstBuffer.duration;
      laneTracks.forEach((t: any, idx: number) => {
        const current = loadedTracks.get(t.id)?.startOffset ?? 0;
        const expected = idx * clipDur;
        if (Math.abs(current - expected) > 0.01) {
          setTrackOffset(t.id, expected);
        }
      });
    });
  }, [tracks.length, bufferVersion]);

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
      <ArrangementPlayhead />
    </div>
  );
}

export function TrackWithWidth({ track, selectedProjectId, deleteTrack, updateTrack, trackZoom, fetchProject }: { track: any; selectedProjectId: string; deleteTrack: any; updateTrack: any; trackZoom: 'full' | 'half'; fetchProject: any }) {
  return null;
}
