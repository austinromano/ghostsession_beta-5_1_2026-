import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { api } from '../../lib/api';
import { useAudioStore } from '../../stores/audioStore';
import { audioBufferCache } from '../../lib/audio';
import Waveform from '../tracks/Waveform';
import {
  BarRuler,
  BarGridOverlay,
  ArrangementPlayhead,
  TRACK_HEADER_WIDTH,
  useArrangement,
} from '../project/ArrangementComponents';
import type { ProjectDetail } from '@ghost/types';

/**
 * Read-only project viewer at /p/<token>. Mirrors the editor's arrangement
 * layout (bar ruler, lane grid, playhead) so the recipient sees what the
 * owner actually built — not a stripped-down summary. Editing affordances
 * (drag, trim, mute, context menus, drum-rack editor) are absent.
 *
 * Reuses BarRuler / BarGridOverlay / ArrangementPlayhead from the editor.
 * Each are pure store-read components — they work fine without auth or
 * sockets, and any seek-to-click in BarRuler just scrubs local playback.
 */
export default function PublicProjectViewer({ token }: { token: string }) {
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tracksReady, setTracksReady] = useState(false);

  const isPlaying = useAudioStore((s) => s.isPlaying);
  const currentTime = useAudioStore((s) => s.currentTime);
  const duration = useAudioStore((s) => s.duration);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.getPublicProject(token)
      .then((p) => {
        if (cancelled) return;
        setProject(p);
        setLoading(false);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setError(err.message || 'Failed to load shared project');
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [token]);

  // Once project + track list arrive: set BPM, fetch every audio file via
  // the public token endpoint, decode each, and hand to the audio store
  // via loadTrackFromBuffer. Then apply the saved arrangementJson so each
  // clip sits at its right startOffset / trimStart / trimEnd / volume.
  useEffect(() => {
    if (!project) return;
    let cancelled = false;
    const audioStore = useAudioStore.getState();

    const tempo = project.tempo || 120;
    audioStore.setProjectBpm(tempo);

    const audioTracks = (project.tracks || []).filter((t: any) => t.fileId);

    Promise.all(audioTracks.map(async (t: any) => {
      try {
        const arrayBuffer = await api.downloadPublicFile(token, t.fileId);
        const tempCtx = new AudioContext();
        const buffer = await tempCtx.decodeAudioData(arrayBuffer.slice(0));
        await tempCtx.close();
        // Cache so re-renders don't re-decode. fileId is omitted on the
        // <Waveform> below so the auth'd peaks/decode endpoints are never
        // hit; the waveform derives raw samples from loadedTracks.buffer.
        audioBufferCache.set(t.fileId, buffer);
        if (cancelled) return;
        audioStore.loadTrackFromBuffer(
          t.id, buffer, t.bpm || 0,
          t.detectedBpm ?? undefined,
          t.firstBeatOffset ?? undefined,
          t.beats ?? undefined,
          t.sampleCharacter ?? undefined,
        );
      } catch (err) {
        console.warn('[PublicViewer] failed to load track', t.id, err);
      }
    })).then(() => {
      if (cancelled) return;
      const arrJson = (project as any).arrangementJson;
      if (arrJson) {
        try {
          const parsed = JSON.parse(arrJson);
          if (parsed?.clips && Array.isArray(parsed.clips)) {
            audioStore.applyArrangementClips(parsed.clips);
          }
        } catch { /* no-op on bad JSON */ }
      }
      setTracksReady(true);
    });

    return () => {
      cancelled = true;
      try { audioStore.stop(); } catch { /* ignore */ }
    };
  }, [project, token]);

  const togglePlay = () => {
    const audioStore = useAudioStore.getState();
    if (audioStore.isPlaying) audioStore.pause();
    else audioStore.play();
  };

  const fmtTime = (s: number) => {
    if (!isFinite(s)) return '0:00';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  const audioTracks = (project?.tracks || []).filter((t: any) => t.fileId);

  if (loading) {
    return (
      <div className="min-h-screen w-full flex items-center justify-center" style={{ background: '#0A0412' }}>
        <div className="text-white/50 text-sm">Loading shared project…</div>
      </div>
    );
  }

  if (error || !project) {
    return (
      <div className="min-h-screen w-full flex items-center justify-center px-6" style={{ background: '#0A0412' }}>
        <div className="max-w-md text-center">
          <div className="text-white text-xl font-bold mb-2">Link unavailable</div>
          <p className="text-white/60 text-sm">{error || 'This project may have been unshared.'}</p>
          <a href="/" className="inline-block mt-6 px-5 py-2.5 rounded-lg text-white text-sm font-semibold"
             style={{ background: 'linear-gradient(180deg, #7C3AED 0%, #581C87 100%)' }}>
            Open Ghost Session
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen w-full" style={{ background: '#0A0412' }}>
      {/* Top bar — project name + Made-with-Ghost wordmark linking back. */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-white/[0.06]">
        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-wider text-white/40">Shared project</div>
          <div className="text-white text-lg font-bold truncate">{project.name}</div>
        </div>
        <a
          href="/"
          className="shrink-0 text-[12px] font-semibold text-white/70 hover:text-white px-3 py-1.5 rounded-lg border border-white/10 hover:border-white/30 transition-colors"
        >
          Made with <span style={{ background: 'linear-gradient(90deg, #00FFC8, #7C3AED)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>Ghost</span>
        </a>
      </div>

      {/* Transport — one big play button + time + meta */}
      <div className="px-6 pt-5 pb-3 flex items-center gap-4">
        <motion.button
          onClick={togglePlay}
          disabled={!tracksReady}
          className="w-12 h-12 rounded-full flex items-center justify-center text-black disabled:opacity-40 disabled:cursor-not-allowed"
          style={{ background: 'linear-gradient(180deg, #00FFC8 0%, #00B894 100%)', boxShadow: '0 4px 16px rgba(0,255,200,0.35)' }}
          whileTap={{ scale: 0.94 }}
        >
          {isPlaying ? (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
          )}
        </motion.button>
        <div className="flex flex-col">
          <div className="text-white font-mono text-[15px] tabular-nums">{fmtTime(currentTime)} / {fmtTime(duration)}</div>
          <div className="text-white/40 text-[11px]">
            {project.tempo ? `${project.tempo} BPM` : ''}
            {project.key ? ` · ${project.key}` : ''}
            {' · '}{audioTracks.length} track{audioTracks.length === 1 ? '' : 's'}
          </div>
        </div>
        {!tracksReady && (
          <div className="text-white/40 text-[11px] ml-auto">Decoding audio…</div>
        )}
      </div>

      {/* Arrangement — bar ruler + lanes + grid overlay + playhead. The
          ruler / overlay / playhead are pulled straight from the editor so
          the time axis renders identically (same bar numbers, same tick
          density, same playhead colour/glow). */}
      <div className="px-6 pb-12">
        <div className="rounded-xl border border-white/[0.06] overflow-hidden" style={{ background: 'rgba(0,0,0,0.25)' }}>
          <BarRuler />
          <div className="relative">
            {audioTracks.length === 0 && (
              <div className="px-4 py-10 text-center text-white/40 text-sm">No audio tracks in this project yet.</div>
            )}
            {audioTracks.map((t: any, idx: number) => (
              <ViewerLane key={t.id} track={t} colourIdx={idx} />
            ))}
            <BarGridOverlay />
            <ArrangementPlayhead />
          </div>
        </div>
      </div>
    </div>
  );
}

// Per-track lane. Mirrors the editor's LaneRow layout: a fixed-width
// header column with name + colour dot, then the relative clip area where
// a single Waveform clip is positioned absolutely by startOffset.
function ViewerLane({ track, colourIdx }: { track: any; colourIdx: number }) {
  const { arrangementDur } = useArrangement();
  const loaded = useAudioStore((s) => s.loadedTracks.get(track.id));

  const playbackRate = loaded ? Math.pow(2, (loaded.pitch || 0) / 12) : 1;
  const bufferDuration = loaded?.buffer?.duration ?? 0;
  const trimStart = loaded?.trimStart ?? 0;
  const trimEnd = (loaded?.trimEnd ?? 0) > 0 ? loaded!.trimEnd : bufferDuration;
  const startOffset = loaded?.startOffset ?? 0;
  const clipDur = bufferDuration > 0 ? Math.max(0, (trimEnd - trimStart) / Math.max(0.0001, playbackRate)) : 0;

  const haveTime = clipDur > 0 && arrangementDur > 0;
  const leftPct = haveTime ? (startOffset / arrangementDur) * 100 : 0;
  const widthPct = haveTime ? (clipDur / arrangementDur) * 100 : 0;

  // Same colour-dot palette the editor uses to give each lane an identity
  // even when names are truncated. Looped so any track count works.
  const dotPalette = ['#A855F7', '#00FFC8', '#3B82F6', '#EC4899', '#F59E0B', '#10B981', '#8B5CF6'];
  const dot = dotPalette[colourIdx % dotPalette.length];

  const displayName = (track.name || 'Track')
    .replace(/\.(wav|mp3|flac|aiff|ogg|m4a)$/i, '')
    .replace(/_/g, ' ');

  return (
    <div className="flex items-stretch border-b border-white/[0.04] last:border-b-0" style={{ height: 56 }}>
      <div
        style={{ width: TRACK_HEADER_WIDTH }}
        className="shrink-0 px-2 py-1.5 border-r border-white/[0.04] flex items-center gap-2"
      >
        <span style={{ background: dot, width: 6, height: 6, borderRadius: 999, flexShrink: 0, boxShadow: `0 0 6px ${dot}80` }} />
        <div className="min-w-0 flex-1">
          <div className="text-white text-[11px] font-semibold truncate leading-tight">{displayName}</div>
          <div className="text-white/40 text-[9px] uppercase tracking-wider truncate">{track.type || 'audio'}</div>
        </div>
      </div>
      <div className="flex-1 relative">
        {haveTime && (
          <div
            className="absolute top-1 bottom-1 rounded-md overflow-hidden"
            style={{
              left: `${leftPct}%`,
              width: `${widthPct}%`,
              background: '#0A0412',
              border: '1px solid rgba(255,255,255,0.08)',
            }}
          >
            <Waveform
              seed={track.name + (track.type || 'audio')}
              height={52}
              trackId={track.id}
              showPlayhead={true}
              viewStart={trimStart}
              viewEnd={trimEnd}
            />
          </div>
        )}
      </div>
    </div>
  );
}
