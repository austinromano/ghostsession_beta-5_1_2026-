import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { api } from '../../lib/api';
import { useAudioStore } from '../../stores/audioStore';
import { useDrumRack } from '../../stores/drumRackStore';
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
    })).then(async () => {
      if (cancelled) return;
      const arrJson = (project as any).arrangementJson;
      if (arrJson) {
        try {
          const parsed = JSON.parse(arrJson);
          if (parsed?.clips && Array.isArray(parsed.clips)) {
            audioStore.applyArrangementClips(parsed.clips);
          }
          // Drum rack state piggybacks on arrangementJson. Apply rows + clips
          // first (the row buffers come back blank because the editor strips
          // them before save), then fetch each row's sample via the public
          // download endpoint and inject the AudioBuffer back into the row.
          if (parsed?.drumRack && Array.isArray(parsed.drumRack.rows) && Array.isArray(parsed.drumRack.clips)) {
            await useDrumRack.getState().applyRemoteState(parsed.drumRack);
            const rows = useDrumRack.getState().rows;
            await Promise.all(rows.map(async (r) => {
              if (!r.fileId || r.buffer) return;
              try {
                const cached = audioBufferCache.get(r.fileId);
                if (cached) {
                  useDrumRack.setState((s) => ({ rows: s.rows.map((rr) => rr.id === r.id ? { ...rr, buffer: cached } : rr) }));
                  return;
                }
                const ab = await api.downloadPublicFile(token, r.fileId);
                const ctx = new AudioContext();
                const buf = await ctx.decodeAudioData(ab.slice(0));
                await ctx.close();
                audioBufferCache.set(r.fileId, buf);
                if (cancelled) return;
                useDrumRack.setState((s) => ({ rows: s.rows.map((rr) => rr.id === r.id ? { ...rr, buffer: buf } : rr) }));
              } catch (err) {
                console.warn('[PublicViewer] drum row buffer fetch failed', r.id, err);
              }
            }));
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
            <PublicDrumRackLanes />
            <BarGridOverlay />
            <ArrangementPlayhead />
          </div>
        </div>
      </div>
    </div>
  );
}

// Read-only drum rack lanes. Mirrors the editor's DrumRackLanes/DrumClipBlock
// /DrumRowLane visuals — green clip blocks on the rack lane, vertical hit
// sticks per row below. No drag handlers, no selection, no toggle to
// expand/collapse — viewer always shows everything.
function PublicDrumRackLanes() {
  const clips = useDrumRack((s) => s.clips);
  const rows = useDrumRack((s) => s.rows);
  const { bpm, arrangementDur } = useArrangement();
  const stepDur = 60 / Math.max(1, bpm) / 4; // 16th note in seconds

  if (arrangementDur <= 0 || (clips.length === 0 && rows.every((r) => !r.fileId))) return null;

  const hue = 165; // ghost-green family — same as the editor lane
  const laneHeight = 56;
  const subLaneHeight = 24;

  return (
    <>
      {/* Top rack lane — header + green clip blocks */}
      <div className="flex items-stretch border-b border-white/[0.04]" style={{ height: laneHeight }}>
        <div
          style={{ width: TRACK_HEADER_WIDTH }}
          className="shrink-0 px-2 py-1.5 border-r border-white/[0.04] flex items-center gap-2"
        >
          <span style={{ background: `hsl(${hue}, 70%, 55%)`, width: 6, height: 6, borderRadius: 999, flexShrink: 0, boxShadow: `0 0 6px hsl(${hue}, 70%, 55%, 0.5)` }} />
          <div className="min-w-0 flex-1">
            <div className="text-white text-[11px] font-semibold truncate leading-tight">Drum Rack</div>
            <div className="text-white/40 text-[9px] uppercase tracking-wider">{rows.filter((r) => r.fileId).length} pads</div>
          </div>
        </div>
        <div className="flex-1 relative">
          {clips.map((clip) => {
            const leftPct = (clip.startSec / arrangementDur) * 100;
            const widthPct = Math.max(0.5, (clip.lengthSec / arrangementDur) * 100);
            const totalSteps = Math.max(1, Math.round(clip.lengthSec / Math.max(stepDur, 1e-6)));
            return (
              <div
                key={clip.id}
                className="absolute top-1 bottom-1 rounded overflow-hidden select-none pointer-events-none"
                style={{
                  left: `${leftPct}%`,
                  width: `${widthPct}%`,
                  background: `linear-gradient(180deg, hsla(${hue},70%,40%,0.95), hsla(${hue},65%,28%,0.95))`,
                  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.18), 0 1px 4px rgba(0,0,0,0.4)',
                }}
              >
                {/* Length label — same as editor's clip block */}
                <div className="absolute top-1 left-1.5 text-[9px] font-mono text-white/85 leading-none" style={{ textShadow: '0 1px 2px rgba(0,0,0,0.6)' }}>
                  {clip.lengthSec.toFixed(2)}s
                </div>
                {/* Step pattern preview — repeats across the clip's full length */}
                <div className="absolute inset-1 mt-3.5 flex flex-col gap-[1px] pointer-events-none">
                  {clip.steps.slice(0, Math.max(1, rows.length)).map((rowSteps, rIdx) => (
                    <div key={rIdx} className="flex-1 relative min-h-0">
                      {Array.from({ length: totalSteps }).map((_, sIdx) => {
                        const on = !!rowSteps?.[sIdx % clip.patternSteps];
                        if (!on) return null;
                        const cellLeft = (sIdx / totalSteps) * 100;
                        return (
                          <div
                            key={sIdx}
                            className="absolute top-0 bottom-0 rounded-[1px]"
                            style={{
                              left: `${cellLeft}%`,
                              width: `${Math.max(0.3, 100 / totalSteps - 0.1)}%`,
                              background: 'rgba(255,255,255,0.85)',
                            }}
                          />
                        );
                      })}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Per-row sub-lanes — only render rows that have a sample loaded */}
      {rows.map((row, rowIdx) => {
        if (!row.fileId) return null;
        const rowHue = (210 + rowIdx * 47) % 360;
        return (
          <div key={row.id} className="flex items-stretch border-b border-white/[0.03]" style={{ height: subLaneHeight }}>
            <div
              style={{ width: TRACK_HEADER_WIDTH }}
              className="shrink-0 px-2 border-r border-white/[0.04] flex items-center gap-2"
            >
              <span style={{ background: `hsl(${rowHue}, 70%, 60%)`, width: 4, height: 4, borderRadius: 999, flexShrink: 0 }} />
              <div className="text-white/70 text-[10px] font-semibold truncate">{row.name && row.name !== 'Empty' ? row.name : `Row ${rowIdx + 1}`}</div>
            </div>
            <div
              className="relative flex-1"
              style={{ background: 'rgba(10,4,18,0.3)', opacity: row.muted ? 0.4 : 1 }}
            >
              {clips.map((clip) => {
                const totalSteps = Math.max(1, Math.round(clip.lengthSec / Math.max(stepDur, 1e-6)));
                const rowSteps = clip.steps[rowIdx] || [];
                return (
                  <div key={clip.id}>
                    {Array.from({ length: totalSteps }).map((_, sIdx) => {
                      if (!rowSteps[sIdx % clip.patternSteps]) return null;
                      const hitTime = clip.startSec + sIdx * stepDur;
                      if (hitTime >= arrangementDur) return null;
                      const leftPct = (hitTime / arrangementDur) * 100;
                      const widthPct = (stepDur / arrangementDur) * 100;
                      return (
                        <div
                          key={sIdx}
                          className="absolute top-1 bottom-1 rounded-sm pointer-events-none"
                          style={{
                            left: `${leftPct}%`,
                            width: `${Math.max(0.25, widthPct - 0.05)}%`,
                            background: `hsl(${rowHue}, 70%, 60%)`,
                            boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.25), 0 1px 2px rgba(0,0,0,0.4)',
                          }}
                        />
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </>
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
