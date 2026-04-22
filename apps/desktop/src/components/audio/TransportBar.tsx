import { useState, useRef, useEffect } from 'react';
import { useAudioStore } from '../../stores/audioStore';
import { useProjectStore } from '../../stores/projectStore';
import { audioBufferCache, cacheBuffer, detectBpmFromName, formatTime } from '../../lib/audio';
import { api } from '../../lib/api';
import { getSocket } from '../../lib/socket';
import { useCollabStore } from '../../stores/collabStore';
import FrequencyBar, { type VizMode } from './FrequencyBar';

export default function TransportBar({ tracks, projectId, projectTempo, onTempoChange, trackZoom, onZoomChange, vizMode }: { tracks?: any[]; projectId?: string; projectTempo?: number; onTempoChange?: (bpm: number) => void; trackZoom?: 'full' | 'half'; onZoomChange?: (zoom: 'full' | 'half') => void; vizMode?: VizMode }) {
  const isPlaying = useAudioStore((s) => s.isPlaying);
  const currentTime = useAudioStore((s) => s.currentTime);
  const duration = useAudioStore((s) => s.duration);
  const loadedTracks = useAudioStore((s) => s.loadedTracks);
  const projectBpm = useAudioStore((s) => s.projectBpm);
  const canUndo = useAudioStore((s) => s.canUndo);
  const canRedo = useAudioStore((s) => s.canRedo);
  const play = useAudioStore((s) => s.play);
  const pause = useAudioStore((s) => s.pause);
  const seekTo = useAudioStore((s) => s.seekTo);
  const loadTrackFromBuffer = useAudioStore((s) => s.loadTrackFromBuffer);
  const setProjectBpm = useAudioStore((s) => s.setProjectBpm);
  const currentProject = useProjectStore((s) => s.currentProject);
  const [loop, setLoop] = useState(false);
  const [metronome, setMetronome] = useState(false);
  const [dragging, setDragging] = useState(false);
  const seekBarRef = useRef<HTMLDivElement>(null);
  const loadedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (projectTempo && projectTempo > 0) {
      setProjectBpm(projectTempo);
    }
  }, [projectTempo, setProjectBpm]);

  useEffect(() => {
    if (!tracks || !projectId) return;
    const tryLoad = () => {
      for (const track of tracks) {
        if (!track.fileId || loadedRef.current.has(track.id)) continue;
        if (audioBufferCache.has(track.fileId)) {
          loadedRef.current.add(track.id);
          const trackName = track.name || track.fileName || '';
          const detectedBpm = detectBpmFromName(trackName);
          const buffer = audioBufferCache.get(track.fileId)!;
          loadTrackFromBuffer(track.id, buffer, detectedBpm);
          // Auto-set project tempo from first track with detected BPM
          if (detectedBpm > 0 && onTempoChange && (!projectTempo || projectTempo === 120)) {
            onTempoChange(detectedBpm);
          }
        }
      }
    };
    tryLoad();
    const interval = setInterval(tryLoad, 500);
    return () => clearInterval(interval);
  }, [tracks, projectId, loadTrackFromBuffer]);

  useEffect(() => {
    loadedRef.current.clear();
  }, [projectId]);

  // If the audio store gets cleaned up (e.g. the user re-clicked the same
  // project and selectProject called audioCleanup), loadedTracks drops to 0
  // while projectId stays the same. TransportBar never unmounts, so our
  // restore refs still point at the old session — the restore effect would
  // short-circuit with "already restored" and the saved state would never
  // re-apply. Reset the refs so the next load re-runs restore from scratch.
  const loadedSize = useAudioStore((s) => s.loadedTracks.size);
  const lastLoadedSizeRef = useRef(0);
  useEffect(() => {
    if (loadedSize === 0 && lastLoadedSizeRef.current > 0) {
      console.log('[arrangement] audio cleanup detected — resetting restore refs');
      restoredProjectIdRef.current = null;
      lastAppliedServerRef.current = null;
      lastSentServerRef.current = null;
    }
    lastLoadedSizeRef.current = loadedSize;
  }, [loadedSize]);

  // Track the last arrangement blob we've applied from the server so we can
  // (a) restore when the project first loads, and (b) re-apply when a
  // collaborator pushes an update mid-session — while skipping echoes of
  // our own just-saved blob so we don't fight our own optimistic updates.
  const lastAppliedServerRef = useRef<string | null>(null);
  const lastSentServerRef = useRef<string | null>(null);
  const restoredProjectIdRef = useRef<string | null>(null);
  const serverArrangementJson = useProjectStore((s) => s.currentProject?.arrangementJson ?? null);

  // Initial restore (server first, then localStorage fallback) once all tracks
  // have loaded into the audio store.
  useEffect(() => {
    if (!tracks || !projectId) return;
    if (restoredProjectIdRef.current === projectId) return;
    const allLoaded = tracks.every((t: any) => !t.fileId || loadedRef.current.has(t.id));
    if (!allLoaded) {
      console.log('[arrangement] restore waiting — not all tracks loaded', {
        total: tracks.length,
        loaded: loadedRef.current.size,
      });
      return;
    }
    restoredProjectIdRef.current = projectId;
    console.log('[arrangement] all tracks loaded — running restore', {
      projectId,
      serverArrangementJsonPresent: !!serverArrangementJson,
      serverArrangementJsonBytes: serverArrangementJson?.length ?? 0,
    });

    const fileIdMap = new Map<string, string>();
    for (const t of tracks) {
      if (t.fileId) fileIdMap.set(t.id, t.fileId);
    }

    if (serverArrangementJson) {
      try {
        const parsed = JSON.parse(serverArrangementJson);
        if (parsed && Array.isArray(parsed.clips)) {
          const loaded = useAudioStore.getState().loadedTracks;
          const matched = parsed.clips.filter((c: any) => loaded.has(c.trackId)).length;
          const trackIds = Array.from(loaded.keys()).map((k) => k.slice(0, 8));
          const clipIds = parsed.clips.map((c: any) => `${c.trackId.slice(0, 8)}@${c.startOffset.toFixed(2)}`);
          console.log('[arrangement] applying server blob', { clipsInBlob: parsed.clips.length, matchedInLoaded: matched, loadedTrackIds: trackIds, blobClips: clipIds });
          useAudioStore.getState().applyArrangementClips(parsed.clips);
          lastAppliedServerRef.current = serverArrangementJson;
          return;
        } else {
          console.warn('[arrangement] server blob malformed', parsed);
        }
      } catch (err) {
        console.warn('[arrangement] server blob JSON parse failed', err);
      }
    }
    console.log('[arrangement] falling back to localStorage restore');
    useAudioStore.getState().restoreArrangementState(projectId, fileIdMap);
  }, [tracks, projectId, serverArrangementJson, useAudioStore.getState().loadedTracks.size]);

  // Live sync: whenever the server's arrangementJson changes and it's not
  // our own echo, apply it to the local audio store.
  useEffect(() => {
    if (!serverArrangementJson) return;
    if (serverArrangementJson === lastAppliedServerRef.current) {
      console.log('[arrangement] live-sync skip — already applied');
      return;
    }
    if (serverArrangementJson === lastSentServerRef.current) {
      console.log('[arrangement] live-sync skip — echo of our own send');
      lastAppliedServerRef.current = serverArrangementJson;
      return;
    }
    try {
      const parsed = JSON.parse(serverArrangementJson);
      if (parsed && Array.isArray(parsed.clips)) {
        const preview = parsed.clips.map((c: any) => `${c.trackId.slice(0, 8)}@${c.startOffset.toFixed(2)}`);
        console.log('[arrangement] live-sync APPLYING remote blob', { clips: parsed.clips.length, preview });
        useAudioStore.getState().applyArrangementClips(parsed.clips);
        lastAppliedServerRef.current = serverArrangementJson;
      }
    } catch { /* ignore malformed blobs */ }
  }, [serverArrangementJson]);

  // Auto-save arrangement state on changes — writes localStorage (instant
  // cache) AND pushes to the server so collaborators receive it live.
  // GATE: never save until the initial restore has applied. Otherwise the
  // default-zero offsets from a fresh loadTrackFromBuffer would race the
  // restore and POST an empty state to the server before we read the saved
  // one back — which is how "my moves don't persist" happens.
  const bufferVersion = useAudioStore((s) => s.bufferVersion);
  const arrangeLoadedTracks = useAudioStore((s) => s.loadedTracks);
  useEffect(() => {
    if (!projectId || !tracks || arrangeLoadedTracks.size === 0) return;
    if (restoredProjectIdRef.current !== projectId) {
      console.log('[arrangement] save blocked — restore not yet run', { projectId });
      return;
    }
    const timer = setTimeout(async () => {
      const fileIdMap = new Map<string, string>();
      for (const t of tracks) {
        if (t.fileId) fileIdMap.set(t.id, t.fileId);
      }
      try {
        const state = useAudioStore.getState().buildArrangementState(fileIdMap);
        const payload = JSON.stringify(state);
        // Skip if nothing has changed since the last POST. Otherwise every
        // server-side project-updated would refetch → new tracks prop ref →
        // re-run this effect → POST same state back in a loop.
        if (payload === lastSentServerRef.current) return;
        useAudioStore.getState().saveArrangementState(projectId, fileIdMap);
        lastSentServerRef.current = payload;
        console.log('[arrangement] POSTing to server', { projectId, clips: state.clips.length });
        await api.saveArrangement(projectId, state);
        console.log('[arrangement] POST ok');
      } catch (err) {
        console.error('[arrangement] POST FAILED', err);
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [projectId, tracks, bufferVersion, arrangeLoadedTracks]);

  // Immediate save on explicit drops / other critical moments — bypasses the
  // 500 ms debounce so the arrangement survives if the plugin is closed
  // right after a drag. Hits the server synchronously too so collaborators
  // see the move without waiting for the debounce.
  useEffect(() => {
    if (!projectId || !tracks) return;
    const flush = () => {
      const size = useAudioStore.getState().loadedTracks.size;
      if (size === 0) {
        console.log('[arrangement] flush skipped — no tracks loaded', { projectId });
        return;
      }
      if (restoredProjectIdRef.current !== projectId) {
        console.log('[arrangement] flush skipped — restore not yet run', { projectId, ref: restoredProjectIdRef.current });
        return;
      }
      const fileIdMap = new Map<string, string>();
      for (const t of tracks) {
        if (t.fileId) fileIdMap.set(t.id, t.fileId);
      }
      try {
        const state = useAudioStore.getState().buildArrangementState(fileIdMap);
        const payload = JSON.stringify(state);
        if (payload === lastSentServerRef.current) {
          console.log('[arrangement] flush skip — state unchanged', { projectId });
          return;
        }
        useAudioStore.getState().saveArrangementState(projectId, fileIdMap);
        lastSentServerRef.current = payload;
        const offsets = state.clips.map((c: any) => `${c.trackId.slice(0, 6)}@${c.startOffset.toFixed(2)}`);
        console.log('[arrangement] flush POST', { projectId, clips: state.clips.length, offsets });
        api.saveArrangement(projectId, state).then(() => {
          console.log('[arrangement] flush POST ok', { projectId });
        }).catch((err) => {
          console.error('[arrangement] flush POST FAILED', err);
        });
      } catch (err) { console.error('[arrangement] flush build failed', err); }
    };
    window.addEventListener('ghost-save-arrangement', flush);
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);
    return () => {
      window.removeEventListener('ghost-save-arrangement', flush);
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('beforeunload', flush);
    };
  }, [projectId, tracks]);

  // Attach the collab store to the current project so remote transport
  // ticks and clip drags route into state. Detach on unmount / project switch.
  useEffect(() => {
    if (!projectId) return;
    useCollabStore.getState().attach(projectId);
    return () => useCollabStore.getState().detach();
  }, [projectId]);

  // Broadcast a transport tick at ~10 Hz while playing so collaborators
  // see a ghost playhead follow us. On pause we send one final tick with
  // isPlaying:false so their ghost snaps to the right spot and stops.
  useEffect(() => {
    if (!projectId) return;
    const socket = getSocket();
    if (!socket) return;
    // Always emit one tick per state change so paused/resumed state is current.
    socket.emit('transport:tick', {
      projectId,
      currentTime: useAudioStore.getState().currentTime,
      isPlaying,
    });
    if (!isPlaying) return;
    const id = setInterval(() => {
      socket.emit('transport:tick', {
        projectId,
        currentTime: useAudioStore.getState().currentTime,
        isPlaying: true,
      });
    }, 100);
    return () => clearInterval(id);
  }, [projectId, isPlaying]);

  const hasTracksLoaded = loadedTracks.size > 0;

  const handlePlayPause = () => {
    if (isPlaying) pause();
    else play();
  };

  const handleSeekClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (duration <= 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    seekTo(ratio * duration);
  };

  const handleSeekDrag = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!dragging || duration <= 0 || !seekBarRef.current) return;
    const rect = seekBarRef.current.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    seekTo(ratio * duration);
  };

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div className="shrink-0 flex flex-col w-full" style={{ background: 'rgba(10,4,18,0.97)', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
      <div className="h-4 w-full flex items-stretch overflow-hidden" style={{ background: 'rgba(255,255,255,0.02)', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
        {Array.from({ length: 16 }, (_, bar) => (
          <div key={bar} className="flex-1 flex items-start relative" style={{ borderLeft: '1px solid rgba(255,255,255,0.12)' }}>
            <div className="absolute bottom-0 left-1/4 w-px h-2" style={{ background: 'rgba(255,255,255,0.06)' }} />
            <div className="absolute bottom-0 left-1/2 w-px h-3" style={{ background: 'rgba(255,255,255,0.08)' }} />
            <div className="absolute bottom-0 left-3/4 w-px h-2" style={{ background: 'rgba(255,255,255,0.06)' }} />
          </div>
        ))}
      </div>
      <FrequencyBar
        seekBarRef={seekBarRef}
        progress={progress}
        isPlaying={isPlaying}
        onSeekClick={handleSeekClick}
        onSeekDrag={handleSeekDrag}
        onSeekEnd={() => setDragging(false)}
        vizMode={vizMode}
      >
        <div className="absolute inset-0 flex items-center z-10 pointer-events-none">
          <div className="absolute left-3 flex items-center gap-1 pointer-events-auto" style={{ filter: 'drop-shadow(0 0 3px rgba(0,0,0,0.8))' }}>
            <button onClick={() => {
              const state = useAudioStore.getState();
              if (!state.canUndo) return;
              state.undo();
              state.loadedTracks.forEach((t, id) => {
                const fileId = currentProject?.tracks?.find((tr: any) => tr.id === id)?.fileId;
                if (fileId) { cacheBuffer(fileId, t.buffer); }
              });
            }} className={`w-6 h-6 flex items-center justify-center rounded transition-colors ${canUndo ? 'text-white/60 hover:text-white' : 'text-white/15 cursor-not-allowed'}`} title="Undo">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="1 4 1 10 7 10" /><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" /></svg>
            </button>
            <button onClick={() => {
              const state = useAudioStore.getState();
              if (!state.canRedo) return;
              state.redo();
              state.loadedTracks.forEach((t, id) => {
                const fileId = currentProject?.tracks?.find((tr: any) => tr.id === id)?.fileId;
                if (fileId) { cacheBuffer(fileId, t.buffer); }
              });
            }} className={`w-6 h-6 flex items-center justify-center rounded transition-colors ${canRedo ? 'text-white/60 hover:text-white' : 'text-white/15 cursor-not-allowed'}`} title="Redo">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.13-9.36L23 10" /></svg>
            </button>
            <span className="text-[9px] font-mono text-white/60 ml-1">{formatTime(currentTime)}</span>
          </div>

          <div className="absolute flex items-center gap-3 pointer-events-auto" style={{ left: '50%', transform: 'translateX(-50%) translateY(-30%)', filter: 'drop-shadow(0 0 3px rgba(0,0,0,0.8))' }}>
            <button onClick={() => seekTo(0)} className="w-7 h-7 flex items-center justify-center rounded-full text-white/70 hover:text-white transition-colors" title="Skip Back">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="6" width="3" height="12" rx="1" /><polygon points="20,6 11,12 20,18" /></svg>
            </button>
            <button onClick={() => seekTo(Math.max(0, currentTime - 5))} className="w-7 h-7 flex items-center justify-center rounded-full text-white/70 hover:text-white transition-colors" title="Rewind">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><polygon points="11,6 2,12 11,18" /><polygon points="22,6 13,12 22,18" /></svg>
            </button>
            <button onClick={handlePlayPause} className={`w-10 h-10 rounded-full flex items-center justify-center transition-all relative z-[5] text-white`} style={{ background: 'linear-gradient(180deg, #9333EA 0%, #6B21A8 100%)', boxShadow: '0 0 20px rgba(147,51,234,0.5)', isolation: 'isolate' }} title={isPlaying ? 'Pause' : 'Play'}>
              {isPlaying ? (
                <svg width="12" height="12" viewBox="0 0 12 14" fill="white"><rect x="1" y="1" width="3.5" height="12" rx="1" /><rect x="7.5" y="1" width="3.5" height="12" rx="1" /></svg>
              ) : (
                <svg width="12" height="12" viewBox="0 0 10 12" fill="white" className="ml-0.5"><polygon points="0,0 10,6 0,12" /></svg>
              )}
            </button>
            <button onClick={() => seekTo(Math.min(duration, currentTime + 5))} className="w-7 h-7 flex items-center justify-center rounded-full text-white/70 hover:text-white transition-colors" title="Fast Forward">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><polygon points="13,6 22,12 13,18" /><polygon points="2,6 11,12 2,18" /></svg>
            </button>
          </div>

          <div className="absolute right-3 flex items-center gap-1.5 pointer-events-auto" style={{ filter: 'drop-shadow(0 0 3px rgba(0,0,0,0.8))' }}>
            <span className="text-[9px] font-mono text-white/60">{formatTime(currentTime)} / {formatTime(duration)}</span>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-white/50"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" /><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" /></svg>
          </div>
        </div>
      </FrequencyBar>
    </div>
  );
}
