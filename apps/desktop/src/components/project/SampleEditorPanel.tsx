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

  // Show only when there's exactly one selected clip — the panel is for
  // single-clip detail. Multi-select keeps the inspector dormant.
  const trackId = selectedTrackIds.size === 1 ? Array.from(selectedTrackIds)[0] : null;

  const projectTrack = useMemo(() => {
    if (!trackId || !currentProject?.tracks) return null;
    return (currentProject.tracks as any[]).find((t) => t.id === trackId) || null;
  }, [trackId, currentProject?.tracks]);

  const loaded = trackId ? loadedTracks.get(trackId) : undefined;

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
          <span className="text-[12px] font-semibold text-white/90 truncate" title={fileName}>{fileName}</span>
        </div>
        <div className="flex flex-wrap gap-1 items-center">
          {/* Warp on/off. When off the clip plays native-speed and the
              drag-release snap reverts to the clip's leading edge — what
              you want for 808s, hits, FX, or anything where the auto
              beat-detection would otherwise mis-place the clip. */}
          <button
            onClick={() => setTrackWarp(trackId, !warp)}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider transition-colors"
            style={{
              background: warp ? 'rgba(0,255,200,0.18)' : 'rgba(255,255,255,0.04)',
              color: warp ? '#00FFC8' : 'rgba(255,255,255,0.55)',
              border: `1px solid ${warp ? 'rgba(0,255,200,0.5)' : 'rgba(255,255,255,0.06)'}`,
            }}
            title={warp ? 'Warp on — sample stretches to project BPM' : 'Warp off — plays at native speed'}
          >
            Warp {warp ? 'On' : 'Off'}
          </button>
          {/* Editable BPM box, /2 and ×2. Like Ableton's Warp BPM widget —
              changes the SOURCE tempo we stretch from, so when the project
              tempo and sample tempo agree the clip plays at native speed.
              Disabled when warp is off since the BPM has no effect there. */}
          <BpmEditor
            value={effectiveBpm}
            onChange={(v) => setTrackBpm(trackId, v)}
            isOverride={!!loaded?.bpm && loaded.bpm > 0}
            disabled={!warp}
          />
          <Pill icon="time" label={fmtDuration(durationSec)} />
          {sampleCharacter && (
            <Pill icon="dot" label={sampleCharacter[0].toUpperCase() + sampleCharacter.slice(1)} />
          )}
        </div>
        <button
          onClick={() => setTrackMuted(trackId, !muted)}
          className={`text-[10px] font-semibold uppercase tracking-wider px-2 py-1 rounded transition-colors mt-auto ${
            muted
              ? 'bg-red-500/20 text-red-300 hover:bg-red-500/30'
              : 'bg-white/[0.04] text-white/60 hover:bg-white/[0.08] hover:text-white'
          }`}
        >
          {muted ? 'Muted' : 'Mute'}
        </button>
      </div>

      {/* Centre: big waveform */}
      <div className="flex-1 min-w-0 px-3 py-2 flex">
        <Waveform
          seed={`editor:${trackId}`}
          height={120}
          fileId={projectTrack.fileId}
          projectId={projectId}
          trackId={trackId}
          showPlayhead={true}
        />
      </div>

      {/* Right: knobs (volume + pitch). Plain range inputs for now —
           swap for proper rotary knobs in a follow-up. */}
      <div className="shrink-0 w-[180px] flex flex-col justify-center gap-3 px-3 py-2 border-l border-white/[0.05]">
        <Slider
          label="Vol"
          value={volume}
          min={0}
          max={1.5}
          step={0.01}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => setTrackVolume(trackId, v)}
        />
        <Slider
          label="Pitch"
          value={pitch}
          min={PITCH_MIN}
          max={PITCH_MAX}
          step={1}
          format={(v) => `${v >= 0 ? '+' : ''}${v} st`}
          onChange={(v) => setTrackPitch(trackId, v)}
        />
      </div>
    </div>
  );
}

function BpmEditor({ value, onChange, isOverride, disabled }: { value: number; onChange: (v: number) => void; isOverride: boolean; disabled?: boolean }) {
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
        value={draft}
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

function Slider({ label, value, min, max, step, format, onChange }: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between text-[10px] font-semibold text-white/60">
        <span className="uppercase tracking-wider">{label}</span>
        <span className="tabular-nums text-white/80">{format(value)}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full accent-ghost-green"
      />
    </div>
  );
}
