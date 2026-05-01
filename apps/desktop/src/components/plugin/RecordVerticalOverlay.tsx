import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { getCtx, getMasterFader } from '../../stores/audio/graph';

// Vertical-cam recorder overlay. Captures the user's webcam in a
// portrait 9:16 frame AND taps the project's master output via a
// MediaStreamDestinationNode, then merges the two tracks into a
// single MediaStream that MediaRecorder writes to a WebM blob the
// user can download.
//
// Why this is wired off the master fader instead of grabbing the
// AudioContext.destination: there's no clean way to record the
// destination directly. Tapping the master node leaves audio
// playback to the speakers UNAFFECTED — the destination connection
// stays in place; we just add a parallel branch that feeds the
// MediaStreamDestinationNode for the duration of the recording.
//
// The 9:16 preview crops the camera feed to 1080x1920 inside an
// `object-cover` <video>, so any aspect ratio the camera reports
// fills the frame without letterboxing. Recording uses the camera's
// native track resolution; we don't re-encode to 1080x1920 inside
// the overlay since the preview is just a cosmetic crop.

interface Props {
  open: boolean;
  onClose: () => void;
}

type RecorderState = 'idle' | 'requesting' | 'previewing' | 'recording' | 'finalizing' | 'error';

export default function RecordVerticalOverlay({ open, onClose }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  // Hold every node we create here in refs so cleanup teardown can
  // reach them deterministically — important because both the camera
  // and the audio tap have side effects (tracks held open + extra
  // edges into the live AudioContext) that will leak across opens
  // if we let GC handle them.
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const audioDestRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recordTimerRef = useRef<number | null>(null);
  const recordStartRef = useRef<number>(0);

  const [state, setState] = useState<RecorderState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  // Resulting blob URL after stop — the user can preview + download
  // without leaving the overlay.
  const [resultUrl, setResultUrl] = useState<string | null>(null);

  // Acquire camera as soon as the overlay opens. Mic is intentionally
  // OFF here — the recorded audio comes from the project's master
  // output, not the user's mic (the user's mic already feeds the
  // collaborators via WebRTC; nobody wants their face-cam recording
  // to also pick up their own mic on top of the project audio).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setState('requesting');
    setError(null);
    setResultUrl(null);
    setElapsedMs(0);
    chunksRef.current = [];

    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: 1080 },
            height: { ideal: 1920 },
            aspectRatio: { ideal: 9 / 16 },
            facingMode: 'user',
          },
          audio: false,
        });
        if (cancelled) {
          for (const t of stream.getTracks()) try { t.stop(); } catch { /* ignore */ }
          return;
        }
        cameraStreamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          // Mirror the local preview so the user sees themselves the
          // way they expect (TikTok mirrors preview by default). The
          // recorded track is NOT mirrored — that's the standard
          // contract on the platforms.
          videoRef.current.play().catch(() => { /* autoplay blocked is fine; user clicks Record */ });
        }
        setState('previewing');
      } catch (err: unknown) {
        if (cancelled) return;
        const msg = (err as { message?: string })?.message || 'Camera access denied';
        setError(msg);
        setState('error');
      }
    })();

    return () => {
      cancelled = true;
      // Tear EVERYTHING down on overlay close — leaving streams open
      // keeps the camera light on and orphans the master-fader edge
      // we add for recording. Cleanup is best-effort; failures here
      // shouldn't block subsequent opens.
      stopRecording('cancelled');
      const cam = cameraStreamRef.current;
      if (cam) {
        for (const t of cam.getTracks()) try { t.stop(); } catch { /* ignore */ }
        cameraStreamRef.current = null;
      }
      if (audioDestRef.current) {
        try { getMasterFader().disconnect(audioDestRef.current); } catch { /* ignore */ }
        audioDestRef.current = null;
      }
      if (recordTimerRef.current) {
        clearInterval(recordTimerRef.current);
        recordTimerRef.current = null;
      }
      if (videoRef.current) {
        videoRef.current.srcObject = null;
      }
    };
  }, [open]);

  function tapMasterAudio(): MediaStreamTrack {
    // Pull a fresh MediaStreamDestinationNode and connect the master
    // fader to it as a parallel branch — the existing fader →
    // destination connection stays untouched so playback to the
    // speakers is unaffected. Returning the track lets the caller
    // splice it into the camera MediaStream.
    const ctx = getCtx();
    const dest = ctx.createMediaStreamDestination();
    audioDestRef.current = dest;
    getMasterFader().connect(dest);
    return dest.stream.getAudioTracks()[0];
  }

  function pickMimeType(): string | undefined {
    // Try mp4 first (some Chromium builds + Safari 14.1+ support it
    // and it uploads directly to TikTok / Reels). Fall back to webm
    // which is universal in browsers but needs conversion before
    // mobile upload.
    const candidates = [
      'video/mp4;codecs=avc1,mp4a',
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
    ];
    for (const t of candidates) {
      if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t)) return t;
    }
    return undefined;
  }

  function startRecording() {
    const cam = cameraStreamRef.current;
    if (!cam) return;
    chunksRef.current = [];
    setResultUrl(null);

    const audioTrack = tapMasterAudio();
    const tracks: MediaStreamTrack[] = [...cam.getVideoTracks()];
    if (audioTrack) tracks.push(audioTrack);
    const combined = new MediaStream(tracks);

    const mimeType = pickMimeType();
    let rec: MediaRecorder;
    try {
      rec = mimeType ? new MediaRecorder(combined, { mimeType }) : new MediaRecorder(combined);
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message || 'Recorder failed to start';
      setError(msg);
      setState('error');
      return;
    }
    recorderRef.current = rec;
    rec.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
    };
    rec.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: rec.mimeType || 'video/webm' });
      const url = URL.createObjectURL(blob);
      setResultUrl(url);
      setState('previewing');
    };
    // 250 ms time-slice keeps memory bounded for long takes — chunks
    // accumulate as small Blob fragments instead of one big buffer.
    rec.start(250);

    recordStartRef.current = performance.now();
    setElapsedMs(0);
    if (recordTimerRef.current) clearInterval(recordTimerRef.current);
    recordTimerRef.current = window.setInterval(() => {
      setElapsedMs(performance.now() - recordStartRef.current);
    }, 100);

    setState('recording');
  }

  function stopRecording(reason: 'user' | 'cancelled' = 'user') {
    const rec = recorderRef.current;
    if (rec && rec.state !== 'inactive') {
      try { rec.stop(); } catch { /* ignore */ }
    }
    recorderRef.current = null;
    if (recordTimerRef.current) {
      clearInterval(recordTimerRef.current);
      recordTimerRef.current = null;
    }
    if (audioDestRef.current) {
      try { getMasterFader().disconnect(audioDestRef.current); } catch { /* ignore */ }
      audioDestRef.current = null;
    }
    if (reason === 'cancelled') {
      // Drop any recorded data — the user closed the overlay before
      // hitting stop. We don't surprise-keep a half-take.
      chunksRef.current = [];
      if (resultUrl) {
        URL.revokeObjectURL(resultUrl);
        setResultUrl(null);
      }
      setState('idle');
    } else {
      setState('finalizing');
    }
  }

  function downloadResult() {
    if (!resultUrl) return;
    const ext = resultUrl.includes('mp4') || (recorderRef.current?.mimeType || '').includes('mp4') ? 'mp4' : 'webm';
    const a = document.createElement('a');
    a.href = resultUrl;
    a.download = `ghost-session-${Date.now()}.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function discardResult() {
    if (resultUrl) URL.revokeObjectURL(resultUrl);
    setResultUrl(null);
    setElapsedMs(0);
  }

  const formatTime = (ms: number): string => {
    const total = Math.floor(ms / 1000);
    const m = Math.floor(total / 60);
    const s = (total % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[100] flex items-center justify-center"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          style={{ background: 'rgba(0,0,0,0.78)', backdropFilter: 'blur(8px)' }}
        >
          {/* Click outside the frame to close — same affordance as
              every other overlay in the app. */}
          <div className="absolute inset-0" onClick={onClose} />

          <motion.div
            className="relative flex flex-col items-center"
            initial={{ scale: 0.96, y: 8 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.96, y: 8 }}
            transition={{ type: 'spring', stiffness: 260, damping: 26 }}
          >
            {/* 9:16 frame — fixed pixel size keeps the preview
                consistent across panel widths. Fits a 1080×1920
                portrait shape into ~360 px wide so a typical 1080p
                screen has plenty of margin. */}
            <div
              className="relative rounded-2xl overflow-hidden"
              style={{
                width: 360,
                height: 640,
                background: 'rgba(8,6,18,0.95)',
                border: '1px solid rgba(255,255,255,0.08)',
                boxShadow: '0 20px 60px rgba(0,0,0,0.6), 0 0 0 4px rgba(168,85,247,0.12)',
              }}
            >
              {/* Camera preview — mirrored so the user sees themselves
                  the way they expect. The RECORDED track is the raw
                  camera feed (TikTok handles preview-mirror itself). */}
              <video
                ref={videoRef}
                muted
                playsInline
                autoPlay
                className="absolute inset-0 w-full h-full object-cover"
                style={{ transform: 'scaleX(-1)', background: '#0a0a0f' }}
              />

              {/* If a take just finished, swap the live preview for
                  the recorded result so the user can review before
                  saving. URL.createObjectURL handles seek/scrub on
                  the local blob. */}
              {resultUrl && (
                <video
                  src={resultUrl}
                  controls
                  playsInline
                  className="absolute inset-0 w-full h-full object-cover bg-black"
                  style={{ background: '#0a0a0f' }}
                />
              )}

              {/* Top bar — rec dot + timer + close. Sits over the
                  preview with a gradient scrim for legibility. */}
              <div
                className="absolute top-0 left-0 right-0 px-3 pt-3 pb-6 flex items-center gap-2 pointer-events-none"
                style={{ background: 'linear-gradient(180deg, rgba(0,0,0,0.55), rgba(0,0,0,0))' }}
              >
                {state === 'recording' && (
                  <>
                    <motion.span
                      className="w-2 h-2 rounded-full bg-red-500"
                      animate={{ opacity: [1, 0.35, 1] }}
                      transition={{ duration: 1, repeat: Infinity, ease: 'easeInOut' }}
                    />
                    <span className="text-[12px] font-bold text-white tabular-nums">{formatTime(elapsedMs)}</span>
                  </>
                )}
                <span className="ml-auto" />
                <button
                  type="button"
                  onClick={onClose}
                  className="pointer-events-auto w-7 h-7 rounded-full flex items-center justify-center text-white/85 hover:text-white"
                  style={{ background: 'rgba(0,0,0,0.55)' }}
                  title="Close"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>

              {/* Error overlay — full-frame so the user can't miss it. */}
              {state === 'error' && error && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/85 px-6 text-center">
                  <div>
                    <div className="text-[14px] font-semibold text-red-300 mb-1">Camera unavailable</div>
                    <div className="text-[11.5px] text-white/70">{error}</div>
                  </div>
                </div>
              )}

              {/* Bottom controls — record / stop / download / discard.
                  Layout swaps based on state so only the relevant
                  affordance is visible at any moment. */}
              <div className="absolute bottom-0 left-0 right-0 flex items-center justify-center gap-4 pb-5">
                {state === 'previewing' && !resultUrl && (
                  <button
                    type="button"
                    onClick={startRecording}
                    className="w-16 h-16 rounded-full flex items-center justify-center transition-transform hover:scale-105 active:scale-95"
                    style={{
                      background: 'rgba(255,255,255,0.95)',
                      boxShadow: '0 6px 18px rgba(0,0,0,0.45), 0 0 0 4px rgba(255,255,255,0.18)',
                    }}
                    title="Start recording"
                  >
                    <span className="block w-12 h-12 rounded-full" style={{ background: '#ef4444' }} />
                  </button>
                )}
                {state === 'recording' && (
                  <button
                    type="button"
                    onClick={() => stopRecording('user')}
                    className="w-16 h-16 rounded-full flex items-center justify-center transition-transform hover:scale-105 active:scale-95"
                    style={{
                      background: 'rgba(255,255,255,0.95)',
                      boxShadow: '0 6px 18px rgba(0,0,0,0.45), 0 0 0 4px rgba(239,68,68,0.35)',
                    }}
                    title="Stop"
                  >
                    <span className="block w-7 h-7 rounded-md" style={{ background: '#ef4444' }} />
                  </button>
                )}
                {resultUrl && state !== 'recording' && (
                  <>
                    <button
                      type="button"
                      onClick={discardResult}
                      className="px-4 h-10 rounded-full text-[12.5px] font-semibold text-white/85 hover:text-white"
                      style={{ background: 'rgba(255,255,255,0.10)', border: '1px solid rgba(255,255,255,0.18)' }}
                    >
                      Retake
                    </button>
                    <button
                      type="button"
                      onClick={downloadResult}
                      className="px-5 h-10 rounded-full text-[12.5px] font-semibold text-white"
                      style={{ background: 'linear-gradient(180deg, #ef4444 0%, #991b1b 100%)' }}
                    >
                      Save
                    </button>
                  </>
                )}
                {(state === 'requesting' || state === 'finalizing') && (
                  <span className="text-[11.5px] text-white/70">
                    {state === 'requesting' ? 'Requesting camera…' : 'Finalising…'}
                  </span>
                )}
              </div>
            </div>

            {/* Helper line under the frame so the user knows the audio
                routing without me adding a giant tooltip. */}
            <div className="mt-3 text-[11px] text-white/55 max-w-[360px] text-center">
              Records your camera + the project's master output. Hit play in the transport before recording so the audio is captured.
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
