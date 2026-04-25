import { useState, useRef, useEffect } from 'react';
import { useAudioStore, pendingTrackOffsets } from '../../stores/audioStore';
import { useProjectStore } from '../../stores/projectStore';
import { audioBufferCache, cacheBuffer, detectBpmFromName, formatTime, snapToGrid } from '../../lib/audio';
import { api } from '../../lib/api';
import { getSocket } from '../../lib/socket';
import { useCollabStore } from '../../stores/collabStore';
import FrequencyBar, { type VizMode } from './FrequencyBar';

// Module-level clipboard for the project's clip copy/paste keyboard
// shortcuts. Stores a bundle of clips with their RELATIVE offsets so
// pasting a multi-selection preserves the time spacing between them.
//
// `baseOffset` is where the first paste batch starts. Subsequent pastes
// advance by the bundle's total duration so repeated Ctrl+V lays batches
// end-to-end instead of stacking.
interface ClipboardItem {
  fileId: string;
  name: string;
  type: string;
  relOffset: number;   // seconds from the bundle's earliest clip
  duration: number;
}
let clipClipboard: {
  items: ClipboardItem[];
  bundleDuration: number;  // earliestOffset..latestEnd span
  nextBaseOffset: number;  // where the NEXT Ctrl+V batch starts
} | null = null;

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
          // Prefer the server's analysed BPM (onset-autocorrelation) over the
          // filename parse — much more reliable and we already paid for it.
          const analysedBpm = typeof (track as any).detectedBpm === 'number' ? (track as any).detectedBpm : 0;
          const nameBpm = detectBpmFromName(trackName);
          const detectedBpm = analysedBpm > 0 ? analysedBpm : nameBpm;
          const firstBeatOffset = typeof (track as any).firstBeatOffset === 'number' ? (track as any).firstBeatOffset : undefined;
          const beats = Array.isArray((track as any).beats) ? (track as any).beats as number[] : undefined;
          const character = (track as any).sampleCharacter as ('percussive' | 'tonal' | 'mixed' | 'ambient' | undefined);
          const buffer = audioBufferCache.get(track.fileId)!;
          loadTrackFromBuffer(track.id, buffer, detectedBpm, detectedBpm, firstBeatOffset, beats, character);
          // Auto-set project tempo from first track with detected BPM.
          // Once the project has a BPM, later samples stretch to match instead.
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
      // Clear loadedRef too — otherwise tryLoad's "already loaded" dedup
      // guard skips every track forever when re-clicking the same project
      // (projectId unchanged, so the projectId-keyed clear effect never fires).
      // Without this the audio store never repopulates, seeder runs with
      // defaults, and the saved arrangement appears to vanish.
      loadedRef.current.clear();
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
    // Guard against the vacuous-truth trap: during project switches `tracks`
    // briefly flips to [] before the new project's tracks arrive. `every()`
    // on an empty array returns true, which used to fire restore with an
    // empty store, flip the save gate open, and let the next partial load
    // POST an incomplete arrangement back to the server — wiping saved work.
    if (tracks.length === 0) {
      console.log('[arrangement] restore waiting — tracks prop empty');
      return;
    }
    // Also require at least one audio track actually in the store when the
    // project has any file-backed tracks. Otherwise we'd open the save gate
    // before loadTrackFromBuffer has populated anything, and the first save
    // would be empty.
    const hasFileTracks = tracks.some((t: any) => t.fileId);
    const storeSize = useAudioStore.getState().loadedTracks.size;
    if (hasFileTracks && storeSize === 0) {
      console.log('[arrangement] restore waiting — audio store empty');
      return;
    }
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
    // Defense-in-depth: never POST a state that's missing base tracks the
    // server knows about. If any file-backed track from `tracks` hasn't made
    // it into the store yet, defer — otherwise buildArrangementState would
    // emit a partial blob and overwrite saved clips for the missing ones.
    const fileBackedTracks = tracks.filter((t: any) => t.fileId);
    const allBaseTracksLoaded = fileBackedTracks.every((t: any) => arrangeLoadedTracks.has(t.id));
    if (!allBaseTracksLoaded) {
      console.log('[arrangement] save blocked — base tracks not all in store', {
        expected: fileBackedTracks.length, have: arrangeLoadedTracks.size,
      });
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
      // Same guard as the debounced save — don't flush a partial blob if
      // any base track hasn't been loaded into the store yet.
      const loaded = useAudioStore.getState().loadedTracks;
      const fileBacked = tracks.filter((t: any) => t.fileId);
      if (!fileBacked.every((t: any) => loaded.has(t.id))) {
        console.log('[arrangement] flush skipped — base tracks not all in store');
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

  // Ctrl+C / Ctrl+V on a selected clip: copy its track data, then paste at
  // the playhead (snapped to the nearest bar). Escape clears selection.
  // Skip the listener while the user is typing in any text field.
  useEffect(() => {
    if (!projectId) return;
    const onKey = async (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement | null;
      const tag = tgt?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tgt?.isContentEditable) return;
      if (e.key === 'Escape') {
        useAudioStore.getState().clearSelection();
        return;
      }
      // Delete / Backspace: deletes the whole current selection. Works
      // without a modifier because that's how users expect it.
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const selIds = Array.from(useAudioStore.getState().selectedTrackIds);
        if (selIds.length === 0) return;
        e.preventDefault();
        for (const id of selIds) {
          useAudioStore.getState().removeTrack(id);
          try { await api.deleteTrack(projectId, id); } catch { /* ignore */ }
        }
        useAudioStore.getState().clearSelection();
        window.dispatchEvent(new CustomEvent('ghost-refresh-project'));
        return;
      }
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      const buildClipboardFromSelection = (selIds: string[]): boolean => {
        if (!tracks || selIds.length === 0) return false;
        const loadedTracks = useAudioStore.getState().loadedTracks;
        const items: ClipboardItem[] = [];
        let earliest = Infinity;
        let latestEnd = 0;
        for (const id of selIds) {
          const t = tracks.find((x: any) => x.id === id);
          if (!t || !t.fileId) continue;
          const loaded = loadedTracks.get(id);
          const duration = loaded?.buffer?.duration || 0;
          const offset = loaded?.startOffset ?? 0;
          if (offset < earliest) earliest = offset;
          if (offset + duration > latestEnd) latestEnd = offset + duration;
          items.push({ fileId: t.fileId, name: t.name || 'Clip', type: t.type || 'audio', relOffset: offset, duration });
        }
        if (items.length === 0) return false;
        // Normalise relOffset to the bundle's earliest clip.
        for (const it of items) it.relOffset = it.relOffset - earliest;
        const bundleDuration = latestEnd - earliest;
        clipClipboard = {
          items,
          bundleDuration,
          // First paste batch starts right after the last clip in the bundle.
          nextBaseOffset: latestEnd,
        };
        return true;
      };

      if (k === 'c') {
        const selIds = Array.from(useAudioStore.getState().selectedTrackIds);
        if (selIds.length === 0) return;
        if (!buildClipboardFromSelection(selIds)) return;
        e.preventDefault();
      } else if (k === 'x') {
        // Cut = copy + delete every selected clip.
        const selIds = Array.from(useAudioStore.getState().selectedTrackIds);
        if (selIds.length === 0) return;
        if (!buildClipboardFromSelection(selIds)) return;
        e.preventDefault();
        for (const id of selIds) {
          useAudioStore.getState().removeTrack(id);
          try { await api.deleteTrack(projectId, id); } catch { /* ignore */ }
        }
        useAudioStore.getState().clearSelection();
        window.dispatchEvent(new CustomEvent('ghost-refresh-project'));
      } else if (k === 'v') {
        if (!clipClipboard) return;
        e.preventDefault();
        const projectBpm = useAudioStore.getState().projectBpm || 120;
        const grid = useAudioStore.getState().gridDivision;
        const baseOffset = Math.max(0, snapToGrid(clipClipboard.nextBaseOffset, projectBpm, grid, 'nearest'));
        try {
          for (const item of clipClipboard.items) {
            const itemOffset = baseOffset + item.relOffset;
            const result = await api.addTrack(projectId, {
              name: item.name, type: item.type as any,
              fileId: item.fileId, fileName: item.name,
            } as any);
            if (result?.id) pendingTrackOffsets.set(result.id, itemOffset);
          }
          // Advance the base for the next Ctrl+V so batches lay end-to-end.
          clipClipboard.nextBaseOffset = baseOffset + clipClipboard.bundleDuration;
          window.dispatchEvent(new CustomEvent('ghost-refresh-project'));
          window.dispatchEvent(new CustomEvent('ghost-save-arrangement'));
        } catch { /* swallow — UI will surface via project refresh */ }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
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
