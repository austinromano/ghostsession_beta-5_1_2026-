import { useEffect, useMemo, useState } from 'react';
import { useAudioStore } from '../../stores/audioStore';
import { useProjectStore } from '../../stores/projectStore';
import Waveform from '../tracks/Waveform';
import { samplePreview } from '../../lib/samplePreview';

// Bottom sample editor / clip inspector. Mounts at the bottom of the
// arrangement view; shows when exactly one clip is selected. Big waveform,
// metadata pills (BPM, character, duration), and the per-clip controls
// the audio store already supports (volume, pitch, mute, fine-trim).

const PITCH_MIN = -12;
const PITCH_MAX = 12;

export default function SampleEditorPanel({ projectId }: { projectId: string }) {
  const selectedTrackIds = useAudioStore((s) => s.selectedTrackIds);
  const loadedTracks = useAudioStore((s) => s.loadedTracks);
  const setTrackVolume = useAudioStore((s) => s.setTrackVolume);
  const setTrackMuted = useAudioStore((s) => s.setTrackMuted);
  const setTrackPitch = useAudioStore((s) => s.setTrackPitch);
  const setTrackBpm = useAudioStore((s) => s.setTrackBpm);
  const setTrackWarp = useAudioStore((s) => s.setTrackWarp);
  const currentProject = useProjectStore((s) => s.currentProject);

  // The panel operates on the WHOLE selection. Single click = one clip;
  // multi-select = same controls apply to every selected clip at once.
  // First selected acts as the "anchor" for display values; values that
  // differ across the selection are flagged "Mixed".
  const ids = useMemo(() => Array.from(selectedTrackIds), [selectedTrackIds]);
  const trackId = ids[0] || null;
  const isMulti = ids.length > 1;

  const projectTrack = useMemo(() => {
    if (!trackId || !currentProject?.tracks) return null;
    return (currentProject.tracks as any[]).find((t) => t.id === trackId) || null;
  }, [trackId, currentProject?.tracks]);

  const loaded = trackId ? loadedTracks.get(trackId) : undefined;

  // Compute whether a getter returns the same value across every clip in
  // the selection. Used to render the "Mixed" hint on controls.
  const allSameNumber = (g: (t: any) => number | undefined): boolean => {
    if (!isMulti) return true;
    let first: number | undefined;
    let init = false;
    for (const id of ids) {
      const v = g(loadedTracks.get(id));
      if (!init) { first = v; init = true; }
      else if (v !== first) return false;
    }
    return true;
  };
  const allSameBool = (g: (t: any) => boolean): boolean => {
    if (!isMulti) return true;
    let first: boolean | undefined;
    let init = false;
    for (const id of ids) {
      const v = g(loadedTracks.get(id));
      if (!init) { first = v; init = true; }
      else if (v !== first) return false;
    }
    return true;
  };

  if (!trackId || !projectTrack) {
    return (
      <div className="shrink-0 h-[112px] mt-2 rounded-2xl glass flex items-center justify-center text-[11px] text-white/30 italic">
        Click a clip to inspect it
      </div>
    );
  }

  const fileName = projectTrack.name || projectTrack.fileName || 'Untitled';
  const detectedBpm: number | null = projectTrack.detectedBpm ?? null;
  const sampleCharacter: string | null = projectTrack.sampleCharacter ?? null;
  const durationSec = loaded?.buffer?.duration ?? 0;
  const volume = loaded?.volume ?? 1;
  const pitch = loaded?.pitch ?? 0;
  const muted = loaded?.muted ?? false;
  const warp = loaded?.warp !== false;
  // Manual BPM override (loaded.bpm). Falls back to the file's detected
  // BPM so the box always shows the value currently driving the stretch.
  const effectiveBpm = (loaded?.bpm && loaded.bpm > 0) ? loaded.bpm : (detectedBpm ?? 120);

  const fmtDuration = (s: number) => {
    if (!s || !Number.isFinite(s)) return '–';
    const m = Math.floor(s / 60);
    const r = Math.floor(s % 60).toString().padStart(2, '0');
    return `${m}:${r}`;
  };

  const handlePreview = () => samplePreview.toggle(`clip:${trackId}`);

  // "Mixed" detection per control. When true, the value display shows
  // a hint that not every selected clip shares the value — but a change
  // still applies the new value to every clip.
  const mixedVolume = !allSameNumber((t) => t?.volume);
  const mixedPitch = !allSameNumber((t) => t?.pitch);
  const mixedMuted = !allSameBool((t) => !!t?.muted);
  const mixedWarp = !allSameBool((t) => t?.warp !== false);
  const mixedBpm = !allSameNumber((t) => t?.bpm || 0);

  // Fan-out helpers — every action runs against every selected clip.
  const applyVolume = (v: number) => ids.forEach((id) => setTrackVolume(id, v));
  const applyPitch = (v: number) => ids.forEach((id) => setTrackPitch(id, v));
  const applyMute = (next: boolean) => ids.forEach((id) => setTrackMuted(id, next));
  const applyWarp = (next: boolean) => ids.forEach((id) => setTrackWarp(id, next));
  const applyBpm = (next: number) => ids.forEach((id) => setTrackBpm(id, next));

  return (
    <div className="shrink-0 h-[140px] mt-2 rounded-2xl glass flex overflow-hidden">
      {/* Left: file info + metadata pills */}
      <div className="shrink-0 w-[220px] flex flex-col gap-2 px-3 py-2 border-r border-white/[0.05]">
        <div className="flex items-center gap-2 min-w-0">
          <button
            onClick={handlePreview}
            className="shrink-0 w-6 h-6 flex items-center justify-center rounded-full bg-ghost-green/20 text-ghost-green hover:bg-ghost-green/30 transition-colors"
            title="Preview clip"
          >
            <svg width="9" height="9" viewBox="0 0 10 10" fill="currentColor"><polygon points="2,1 9,5 2,9" /></svg>
          </button>
          <span className="text-[12px] font-semibold text-white/90 truncate" title={fileName}>
            {isMulti ? `${ids.length} clips selected` : fileName}
          </span>
        </div>
        <div className="flex flex-wrap gap-1 items-center">
          <button
            onClick={() => applyWarp(!warp)}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider transition-colors"
            style={{
              background: warp ? 'rgba(0,255,200,0.18)' : 'rgba(255,255,255,0.04)',
              color: warp ? '#00FFC8' : 'rgba(255,255,255,0.55)',
              border: `1px solid ${warp ? 'rgba(0,255,200,0.5)' : 'rgba(255,255,255,0.06)'}`,
            }}
            title={
              mixedWarp ? 'Warp differs across selection — click to set all' :
              warp ? 'Warp on — sample stretches to project BPM' : 'Warp off — plays at native speed'
            }
          >
            Warp {mixedWarp ? '~' : warp ? 'On' : 'Off'}
          </button>
          <BpmEditor
            value={effectiveBpm}
            onChange={(v) => applyBpm(v)}
            isOverride={!!loaded?.bpm && loaded.bpm > 0}
            disabled={!warp}
            mixed={mixedBpm}
          />
          <Pill icon="time" label={fmtDuration(durationSec)} />
          {sampleCharacter && !isMulti && (
            <Pill icon="dot" label={sampleCharacter[0].toUpperCase() + sampleCharacter.slice(1)} />
          )}
        </div>
        <button
          onClick={() => applyMute(!muted)}
          className={`text-[10px] font-semibold uppercase tracking-wider px-2 py-1 rounded transition-colors mt-auto ${
            mixedMuted
              ? 'bg-white/[0.04] text-white/60 hover:bg-white/[0.08] hover:text-white'
              : muted
                ? 'bg-red-500/20 text-red-300 hover:bg-red-500/30'
                : 'bg-white/[0.04] text-white/60 hover:bg-white/[0.08] hover:text-white'
          }`}
        >
          {mixedMuted ? 'Mute (mixed)' : muted ? 'Muted' : 'Mute'}
        </button>
      </div>

      {/* Centre: big waveform with a bar-line overlay so the user can
          see where each bar lands inside the clip — same look as the
          arrangement's BarGridOverlay, but scaled to this single
          trimmed clip. */}
      <div className="flex-1 min-w-0 px-3 py-2 flex">
        <div className="flex-1 relative">
          <Waveform
            seed={`editor:${trackId}`}
            height={120}
            fileId={projectTrack.fileId}
            projectId={projectId}
            trackId={trackId}
            showPlayhead={true}
          />
          <SampleEditorBarGrid trackId={trackId} />
        </div>
      </div>

      {/* Right: knobs (volume + pitch). Plain range inputs for now —
           swap for proper rotary knobs in a follow-up. */}
      <div className="shrink-0 w-[180px] flex flex-col justify-center gap-3 px-3 py-2 border-l border-white/[0.05]">
        <Slider
          label="Vol"
          value={volume}
          mixed={mixedVolume}
          min={0}
          max={1.5}
          step={0.01}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={applyVolume}
        />
        <Slider
          label="Pitch"
          value={pitch}
          mixed={mixedPitch}
          min={PITCH_MIN}
          max={PITCH_MAX}
          step={1}
          format={(v) => `${v >= 0 ? '+' : ''}${v} st`}
          onChange={applyPitch}
        />
      </div>
    </div>
  );
}

function BpmEditor({ value, onChange, isOverride, disabled, mixed }: { value: number; onChange: (v: number) => void; isOverride: boolean; disabled?: boolean; mixed?: boolean }) {
  // Local text state so the user can type freely (e.g. backspace through "1"
  // without the field snapping back). Commits on Enter or blur, clamped to
  // a sane musical range. Highlights when the user has overridden the
  // detected value so they can tell at a glance.
  const [draft, setDraft] = useState(String(Math.round(value * 100) / 100));
  useEffect(() => { setDraft(String(Math.round(value * 100) / 100)); }, [value]);

  const commit = (v: number) => {
    if (!Number.isFinite(v)) return;
    const clamped = Math.max(20, Math.min(400, v));
    onChange(Number(clamped.toFixed(2)));
  };

  return (
    <span
      className="inline-flex items-stretch rounded overflow-hidden text-[10px] font-medium"
      style={{
        background: 'rgba(255,255,255,0.04)',
        border: `1px solid ${isOverride ? 'rgba(0,255,200,0.45)' : 'rgba(255,255,255,0.06)'}`,
        opacity: disabled ? 0.4 : 1,
        pointerEvents: disabled ? 'none' : undefined,
      }}
    >
      <span className="px-1.5 self-center text-ghost-green/80 uppercase tracking-wider text-[9px] font-semibold">BPM</span>
      <input
        type="text"
        value={mixed ? '~' : draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { commit(parseFloat(draft)); (e.target as HTMLInputElement).blur(); }
          else if (e.key === 'Escape') { setDraft(String(Math.round(value * 100) / 100)); (e.target as HTMLInputElement).blur(); }
        }}
        onBlur={() => commit(parseFloat(draft))}
        className="w-12 bg-transparent text-white/90 text-center outline-none tabular-nums focus:bg-white/[0.06]"
      />
      <button
        onClick={() => commit(value / 2)}
        className="px-1.5 text-white/50 hover:bg-white/[0.06] hover:text-white border-l border-white/[0.06]"
        title="Half time"
      >
        /2
      </button>
      <button
        onClick={() => commit(value * 2)}
        className="px-1.5 text-white/50 hover:bg-white/[0.06] hover:text-white border-l border-white/[0.06]"
        title="Double time"
      >
        ×2
      </button>
    </span>
  );
}

function Pill({ icon, label }: { icon: 'bpm' | 'time' | 'dot'; label: string }) {
  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium text-white/70"
      style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)' }}
    >
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-ghost-green/80">
        {icon === 'bpm' && (<><circle cx="12" cy="12" r="9" /><polyline points="12 6 12 12 16 14" /></>)}
        {icon === 'time' && (<><circle cx="12" cy="12" r="9" /><polyline points="12 7 12 13 17 13" /></>)}
        {icon === 'dot' && (<circle cx="12" cy="12" r="3" fill="currentColor" />)}
      </svg>
      {label}
    </span>
  );
}

function Slider({ label, value, min, max, step, format, onChange, mixed }: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
  mixed?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between text-[10px] font-semibold text-white/60">
        <span className="uppercase tracking-wider">{label}</span>
        <span className="tabular-nums text-white/80">{mixed ? 'Mixed' : format(value)}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full accent-ghost-green"
        style={{ opacity: mixed ? 0.6 : 1 }}
      />
    </div>
  );
}

/**
 * Bar-line overlay for the sample editor's big waveform. Computes how
 * many bars the trimmed clip spans at the current project tempo and
 * draws a faint vertical line at each bar boundary. Same look as the
 * arrangement's BarGridOverlay, scoped to one clip.
 */
function SampleEditorBarGrid({ trackId }: { trackId: string }) {
  const projectBpm = useAudioStore((s) => s.projectBpm);
  const trimStart = useAudioStore((s) => s.loadedTracks.get(trackId)?.trimStart ?? 0);
  const trimEnd = useAudioStore((s) => s.loadedTracks.get(trackId)?.trimEnd ?? 0);
  const bufferDuration = useAudioStore((s) => s.loadedTracks.get(trackId)?.buffer?.duration ?? 0);
  const pitch = useAudioStore((s) => s.loadedTracks.get(trackId)?.pitch ?? 0);

  if (bufferDuration <= 0 || projectBpm <= 0) return null;

  const playbackRate = Math.pow(2, pitch / 12);
  const effectiveTrimEnd = trimEnd > 0 ? trimEnd : bufferDuration;
  const clipDurTimeline = (effectiveTrimEnd - trimStart) / Math.max(0.0001, playbackRate);
  const barSec = 240 / projectBpm;
  const numBars = Math.max(1, Math.round(clipDurTimeline / barSec));

  // Bright line every `labeledStep` bars (matches the arrangement's
  // overlay density), dim line on every bar in between.
  const labeledStep = numBars <= 8 ? 1 : numBars <= 16 ? 2 : numBars <= 32 ? 4 : 8;

  return (
    <div className="absolute inset-0 pointer-events-none">
      {Array.from({ length: numBars + 1 }).map((_, i) => {
        const isLabeled = i % labeledStep === 0;
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
