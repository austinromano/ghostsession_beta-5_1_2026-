import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence, useDragControls } from 'framer-motion';
import { getCtx, getMasterFader } from '../../stores/audio/graph';

// Vertical (9:16) composite recorder for TikTok / Reels / Shorts.
//
// What the recorded video contains:
//   - Top ~28%: the user's webcam (object-cover crop).
//   - Bottom ~72%: a live screen capture of the app the user shared
//     (typically the Ghost Session tab in a narrow window so the
//     arrangement / mixer / plugins stack vertically the way the
//     reference TikToks do).
//   - Audio: the project's master output, tapped from the master
//     fader through a parallel MediaStreamDestinationNode so speaker
//     playback is unaffected. Mic is intentionally OFF — the audio
//     bed is the project, not the user's voice.
//
// How the composite is built:
//   - A hidden 1080×1920 <canvas> is updated each animation frame
//     with drawImage calls from two off-DOM <video> elements (camera
//     + screen). canvas.captureStream(30) gives us a single video
//     track that MediaRecorder can encode.
//   - The audio track and the canvas video track go into one
//     combined MediaStream that the recorder writes to a Blob.
//
// While recording, the entire overlay UI hides itself (display:
// none) so it doesn't end up captured by the screen-share track.
// The user controls stop via the browser's built-in "Stop sharing"
// bar — when the screen track ends we finalise the take and
// re-expand the overlay to show the preview + save/retake buttons.

interface Props {
  open: boolean;
  onClose: () => void;
}

type Phase =
  | 'requesting_camera'
  | 'previewing'
  | 'requesting_screen'
  | 'recording'
  | 'finalizing'
  | 'reviewing'
  | 'error';

const OUTPUT_W = 1080;
const OUTPUT_H = 1920;
const CAMERA_HEIGHT = Math.round(OUTPUT_H * 0.28);
const SCREEN_TOP = CAMERA_HEIGHT;
const SCREEN_HEIGHT = OUTPUT_H - CAMERA_HEIGHT;

// Frame-fit math: scale + crop so the source fills the destination
// rect like CSS object-fit: cover.
function drawCover(
  ctx: CanvasRenderingContext2D,
  src: HTMLVideoElement,
  dx: number, dy: number, dw: number, dh: number,
): void {
  const sw = src.videoWidth;
  const sh = src.videoHeight;
  if (!sw || !sh) return;
  const sourceAspect = sw / sh;
  const destAspect = dw / dh;
  let cropW = sw;
  let cropH = sh;
  let cropX = 0;
  let cropY = 0;
  if (sourceAspect > destAspect) {
    // Source is wider than dest — crop the sides.
    cropW = sh * destAspect;
    cropX = (sw - cropW) / 2;
  } else {
    // Source is taller than dest — crop the top/bottom.
    cropH = sw / destAspect;
    cropY = (sh - cropH) / 2;
  }
  try {
    ctx.drawImage(src, cropX, cropY, cropW, cropH, dx, dy, dw, dh);
  } catch { /* video may not be ready yet */ }
}

function pickMimeType(): string | undefined {
  // Try the most specific MP4 / H.264 codec strings first — modern
  // Chromium (116+) and Safari accept these and we want MP4 output
  // since TikTok / Reels / Shorts upload mp4 directly. Fall through
  // to webm only if no mp4 candidate is supported on this engine.
  const candidates = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',  // baseline 3.0 + AAC-LC (most universal)
    'video/mp4;codecs=avc1.42001E,mp4a.40.2',
    'video/mp4;codecs=avc1.4D401E,mp4a.40.2',  // main 3.0 + AAC-LC
    'video/mp4;codecs=avc1.640028,mp4a.40.2',  // high 4.0 + AAC-LC
    'video/mp4;codecs=h264,aac',
    'video/mp4;codecs=avc1,mp4a',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  if (typeof MediaRecorder === 'undefined') return undefined;
  for (const t of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(t)) return t;
    } catch { /* some browsers throw on unsupported strings instead of returning false */ }
  }
  return undefined;
}

export default function RecordVerticalOverlay({ open, onClose }: Props) {
  const [phase, setPhase] = useState<Phase>('requesting_camera');
  const [error, setError] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [resultMime, setResultMime] = useState<string>('video/webm');
  // Brief "Saved to Downloads" toast so the user can see the action
  // landed (browsers don't always show a download bar by default,
  // and a webview embed doesn't show one at all).
  const [savedToast, setSavedToast] = useState<string | null>(null);

  // Holds every track / node we create here so cleanup is deterministic.
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const audioDestRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const rafIdRef = useRef<number | null>(null);
  const recordTimerRef = useRef<number | null>(null);
  const startTimeRef = useRef<number>(0);

  // <video> elements feed the canvas compositor. The "preview" video
  // is what the user sees in the overlay before recording starts —
  // mirrored locally so the framing reads correctly.
  const cameraVideoRef = useRef<HTMLVideoElement | null>(null);
  const screenVideoRef = useRef<HTMLVideoElement | null>(null);
  const previewVideoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Acquire camera on open. Mic stays off intentionally.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setPhase('requesting_camera');
    setError(null);
    setResultUrl((url) => {
      if (url) URL.revokeObjectURL(url);
      return null;
    });
    setElapsedMs(0);
    chunksRef.current = [];

    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: 1280 },
            height: { ideal: 720 },
            facingMode: 'user',
          },
          audio: false,
        });
        if (cancelled) {
          for (const t of stream.getTracks()) try { t.stop(); } catch { /* ignore */ }
          return;
        }
        cameraStreamRef.current = stream;
        if (cameraVideoRef.current) {
          cameraVideoRef.current.srcObject = stream;
          cameraVideoRef.current.play().catch(() => { /* autoplay-blocked is fine */ });
        }
        if (previewVideoRef.current) {
          previewVideoRef.current.srcObject = stream;
          previewVideoRef.current.play().catch(() => { /* autoplay-blocked is fine */ });
        }
        setPhase('previewing');
      } catch (err: unknown) {
        if (cancelled) return;
        const msg = (err as { message?: string })?.message || 'Camera access denied';
        setError(msg);
        setPhase('error');
      }
    })();

    return () => {
      cancelled = true;
      cleanupAll();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function cleanupAll() {
    // Stop recorder if running.
    const rec = recorderRef.current;
    if (rec && rec.state !== 'inactive') {
      try { rec.stop(); } catch { /* ignore */ }
    }
    recorderRef.current = null;
    // Cancel compositor.
    if (rafIdRef.current != null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    if (recordTimerRef.current != null) {
      clearInterval(recordTimerRef.current);
      recordTimerRef.current = null;
    }
    // Stop camera + screen tracks.
    if (cameraStreamRef.current) {
      for (const t of cameraStreamRef.current.getTracks()) try { t.stop(); } catch { /* ignore */ }
      cameraStreamRef.current = null;
    }
    if (screenStreamRef.current) {
      for (const t of screenStreamRef.current.getTracks()) try { t.stop(); } catch { /* ignore */ }
      screenStreamRef.current = null;
    }
    // Detach the parallel master-fader edge.
    if (audioDestRef.current) {
      try { getMasterFader().disconnect(audioDestRef.current); } catch { /* ignore */ }
      audioDestRef.current = null;
    }
    if (cameraVideoRef.current) cameraVideoRef.current.srcObject = null;
    if (screenVideoRef.current) screenVideoRef.current.srcObject = null;
    if (previewVideoRef.current) previewVideoRef.current.srcObject = null;
  }

  function tapMasterAudio(): MediaStreamTrack | null {
    const ctx = getCtx();
    const dest = ctx.createMediaStreamDestination();
    audioDestRef.current = dest;
    getMasterFader().connect(dest);
    const tracks = dest.stream.getAudioTracks();
    return tracks[0] || null;
  }

  async function startRecording() {
    const cam = cameraStreamRef.current;
    if (!cam) return;
    setPhase('requesting_screen');
    setError(null);
    chunksRef.current = [];

    let screenStream: MediaStream;
    try {
      // preferCurrentTab is a Chromium hint — the picker pre-selects
      // the current tab so the user can confirm with one click. Other
      // browsers ignore it and still show the regular picker.
      screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30 } },
        audio: false,
        // Non-standard hints — Chromium pre-selects the current tab,
        // selfBrowserSurface tells the picker to allow this tab as
        // a target. Other browsers ignore both fields.
        preferCurrentTab: true,
        selfBrowserSurface: 'include',
      } as MediaStreamConstraints);
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message || 'Screen share cancelled';
      setError(msg);
      setPhase('previewing');
      return;
    }
    screenStreamRef.current = screenStream;
    if (screenVideoRef.current) {
      screenVideoRef.current.srcObject = screenStream;
      try { await screenVideoRef.current.play(); } catch { /* ignore */ }
    }

    // The browser owns the "stop sharing" UI — when the user clicks
    // it, the screen track ends and we finalise the recording. This
    // is the primary stop affordance during a take.
    const screenTrack = screenStream.getVideoTracks()[0];
    if (screenTrack) {
      screenTrack.addEventListener('ended', () => {
        if (recorderRef.current && recorderRef.current.state === 'recording') {
          stopRecording();
        }
      });
    }

    // Build the composite canvas + RAF compositor.
    const canvas = canvasRef.current;
    if (!canvas) {
      setError('Canvas missing');
      setPhase('error');
      return;
    }
    canvas.width = OUTPUT_W;
    canvas.height = OUTPUT_H;
    const ctx2d = canvas.getContext('2d');
    if (!ctx2d) {
      setError('2D context missing');
      setPhase('error');
      return;
    }
    const drawFrame = () => {
      // Black backdrop so any source frame that hasn't loaded yet
      // doesn't leave previous-frame artefacts.
      ctx2d.fillStyle = '#000';
      ctx2d.fillRect(0, 0, OUTPUT_W, OUTPUT_H);
      const camV = cameraVideoRef.current;
      const scrV = screenVideoRef.current;
      if (camV && camV.videoWidth > 0) {
        drawCover(ctx2d, camV, 0, 0, OUTPUT_W, CAMERA_HEIGHT);
      }
      if (scrV && scrV.videoWidth > 0) {
        drawCover(ctx2d, scrV, 0, SCREEN_TOP, OUTPUT_W, SCREEN_HEIGHT);
      }
      rafIdRef.current = requestAnimationFrame(drawFrame);
    };
    rafIdRef.current = requestAnimationFrame(drawFrame);

    const canvasStream = canvas.captureStream(30);
    const audioTrack = tapMasterAudio();
    const tracks: MediaStreamTrack[] = [...canvasStream.getVideoTracks()];
    if (audioTrack) tracks.push(audioTrack);
    const combined = new MediaStream(tracks);

    const mimeType = pickMimeType();
    let rec: MediaRecorder;
    try {
      rec = mimeType ? new MediaRecorder(combined, { mimeType }) : new MediaRecorder(combined);
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message || 'Recorder failed to start';
      setError(msg);
      setPhase('error');
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
      setResultMime(rec.mimeType || 'video/webm');
      // Tear down compositor + tracks now that the take is final.
      if (rafIdRef.current != null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
      if (screenStreamRef.current) {
        for (const t of screenStreamRef.current.getTracks()) try { t.stop(); } catch { /* ignore */ }
        screenStreamRef.current = null;
      }
      if (audioDestRef.current) {
        try { getMasterFader().disconnect(audioDestRef.current); } catch { /* ignore */ }
        audioDestRef.current = null;
      }
      if (recordTimerRef.current != null) {
        clearInterval(recordTimerRef.current);
        recordTimerRef.current = null;
      }
      setPhase('reviewing');
    };
    rec.start(250);

    startTimeRef.current = performance.now();
    setElapsedMs(0);
    if (recordTimerRef.current != null) clearInterval(recordTimerRef.current);
    recordTimerRef.current = window.setInterval(() => {
      setElapsedMs(performance.now() - startTimeRef.current);
    }, 100);
    setPhase('recording');
  }

  function stopRecording() {
    const rec = recorderRef.current;
    if (rec && rec.state !== 'inactive') {
      setPhase('finalizing');
      try { rec.stop(); } catch { /* onstop will still fire and re-set phase */ }
    }
  }

  async function downloadResult() {
    if (!resultUrl) return;
    const ext = resultMime.includes('mp4') ? 'mp4' : 'webm';
    // ISO-style date so multiple takes don't collide and the file
    // sorts chronologically in Downloads.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const fileName = `ghost-session-${stamp}.${ext}`;

    // Inside the JUCE plugin's WebView2 host the browser's anchor-
    // click download is silently swallowed; the C++ side has its
    // own ghost:// download protocol. To use it we need a fetchable
    // URL — the original blob: URL is scoped to the page, so we
    // fetch the blob, base64-encode it, and hand the data: URL to
    // ghost://download-stem (which already accepts an arbitrary
    // URL + fileName). For regular browsers the anchor path is
    // taken and the file lands in the user's Downloads folder.
    const isPlugin = !!(window as { chrome?: { webview?: unknown } }).chrome?.webview;

    if (isPlugin) {
      try {
        const res = await fetch(resultUrl);
        const buf = await res.arrayBuffer();
        // Build base64 from Uint8Array — chunked so we don't hit
        // the call-stack ceiling on long takes.
        const bytes = new Uint8Array(buf);
        let binary = '';
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
          binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
        }
        const b64 = btoa(binary);
        const dataUrl = `data:${resultMime};base64,${b64}`;
        const ghostUrl = `ghost://download-stem?url=${encodeURIComponent(dataUrl)}&fileName=${encodeURIComponent(fileName)}`;
        const iframe = document.createElement('iframe');
        iframe.style.display = 'none';
        iframe.src = ghostUrl;
        document.body.appendChild(iframe);
        setTimeout(() => { try { iframe.remove(); } catch { /* ignore */ } }, 1500);
        flashSaved(fileName);
        return;
      } catch (err) {
        // Fall through to the anchor path on encode/fetch failure.
        if (typeof console !== 'undefined') console.warn('[record] plugin download failed, falling back', err);
      }
    }

    const a = document.createElement('a');
    a.href = resultUrl;
    a.download = fileName;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    // Give the browser a tick to start streaming the blob before
    // we yank the anchor — instant remove + revoke can race the
    // download in some Chromium builds.
    setTimeout(() => { try { a.remove(); } catch { /* ignore */ } }, 200);
    flashSaved(fileName);
  }

  function flashSaved(fileName: string) {
    setSavedToast(`Saved ${fileName} to Downloads`);
    window.setTimeout(() => setSavedToast(null), 2400);
  }

  function discardResult() {
    if (resultUrl) URL.revokeObjectURL(resultUrl);
    setResultUrl(null);
    setElapsedMs(0);
    setPhase('previewing');
  }

  const formatTime = (ms: number): string => {
    const total = Math.floor(ms / 1000);
    const m = Math.floor(total / 60);
    const s = (total % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  };

  // Drag handling — the panel floats over the project and can be
  // moved freely so the user can keep working underneath it. Drag
  // is gated to a dedicated header bar via dragControls so clicks on
  // the record/save buttons don't accidentally start a drag gesture.
  const dragControls = useDragControls();

  // Hidden video elements + canvas live OUTSIDE the overlay so the
  // screen capture (which records the visible page) doesn't see
  // them, and so they keep playing when phase === 'recording'
  // collapses the visible overlay UI.
  const offscreenScaffold = (
    <div
      aria-hidden
      style={{
        position: 'fixed',
        left: -99999,
        top: -99999,
        width: 1,
        height: 1,
        overflow: 'hidden',
        pointerEvents: 'none',
      }}
    >
      <video ref={cameraVideoRef} muted playsInline autoPlay />
      <video ref={screenVideoRef} muted playsInline autoPlay />
      <canvas ref={canvasRef} width={OUTPUT_W} height={OUTPUT_H} />
    </div>
  );

  // While recording the OVERLAY DOM stays mounted (so React doesn't
  // tear down our streams) but renders nothing visible, so screen
  // capture sees the underlying app instead of our chrome.
  const visibleHidden = phase === 'recording' || phase === 'requesting_screen';

  return (
    <>
      {offscreenScaffold}
      <AnimatePresence>
        {open && !visibleHidden && (
          <motion.div
            // Floating, draggable panel — no full-screen backdrop so
            // the user can keep using the project underneath. dragMomentum
            // is off because momentum on a panel feels janky. constraints
            // pin to the document body so the panel can't be flung
            // off-screen.
            drag
            dragMomentum={false}
            dragElastic={0.04}
            dragControls={dragControls}
            dragListener={false}
            dragConstraints={{ left: -2000, right: 2000, top: -2000, bottom: 2000 }}
            initial={{ opacity: 0, scale: 0.96, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 8 }}
            transition={{ type: 'spring', stiffness: 260, damping: 26 }}
            className="fixed z-[100]"
            // Default-position the panel near the top-right so it
            // doesn't cover the arrangement view. The user can drag
            // it anywhere from there.
            style={{ top: 96, right: 24 }}
          >
            <div className="relative flex flex-col items-center">
              {/* Drag-handle bar — the only place that initiates a
                  drag gesture. Click-targets inside the frame stay
                  free of drag interference. */}
              <div
                onPointerDown={(e) => {
                  if (e.button !== 0) return;
                  dragControls.start(e);
                }}
                className="w-full h-7 flex items-center justify-between px-2 rounded-t-2xl"
                style={{
                  width: 360,
                  background: 'rgba(15,12,32,0.96)',
                  borderBottom: '1px solid rgba(255,255,255,0.06)',
                  cursor: 'grab',
                  touchAction: 'none',
                  userSelect: 'none',
                }}
                title="Drag to move"
              >
                <div className="flex items-center gap-1.5 text-white/55">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
                    <circle cx="9" cy="5" r="1.6" /><circle cx="9" cy="12" r="1.6" /><circle cx="9" cy="19" r="1.6" />
                    <circle cx="15" cy="5" r="1.6" /><circle cx="15" cy="12" r="1.6" /><circle cx="15" cy="19" r="1.6" />
                  </svg>
                  <span className="text-[10.5px] font-semibold tracking-wide uppercase">Vertical Recorder</span>
                </div>
                <button
                  type="button"
                  onClick={onClose}
                  onPointerDown={(e) => e.stopPropagation()}
                  className="w-5 h-5 flex items-center justify-center rounded text-white/55 hover:text-white hover:bg-white/[0.06]"
                  title="Close"
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>

              {/* 9:16 preview frame — shows what the recording will
                  look like. Camera fills the top region; bottom
                  region is a placeholder until the user clicks
                  record (which prompts for the screen share). */}
              <div
                className="relative overflow-hidden flex flex-col"
                style={{
                  width: 360,
                  height: 640,
                  background: '#0a0a0f',
                  border: '1px solid rgba(255,255,255,0.08)',
                  borderTop: 'none',
                  borderBottomLeftRadius: 16,
                  borderBottomRightRadius: 16,
                  boxShadow: '0 20px 60px rgba(0,0,0,0.6), 0 0 0 4px rgba(168,85,247,0.12)',
                }}
              >
                {/* Camera region — top 28%. Mirrored so the user
                    sees themselves the way they expect. */}
                <div className="relative" style={{ height: `${(CAMERA_HEIGHT / OUTPUT_H) * 100}%`, flex: 'none' }}>
                  {!resultUrl && (
                    <video
                      ref={previewVideoRef}
                      muted
                      playsInline
                      autoPlay
                      className="absolute inset-0 w-full h-full object-cover"
                      style={{ transform: 'scaleX(-1)', background: '#0a0a0f' }}
                    />
                  )}
                </div>

                {/* Screen-share region — bottom 72%. Before record
                    starts this is a hint; during review it's part
                    of the playback element below. */}
                {!resultUrl && (
                  <div
                    className="relative flex-1 flex items-center justify-center text-center px-6"
                    style={{
                      background: 'linear-gradient(180deg, rgba(20,12,44,0.6) 0%, rgba(8,6,18,0.95) 100%)',
                    }}
                  >
                    <div>
                      <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="rgba(168,134,255,0.65)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="mx-auto mb-2">
                        <rect x="2" y="3" width="20" height="14" rx="2" />
                        <line x1="8" y1="21" x2="16" y2="21" />
                        <line x1="12" y1="17" x2="12" y2="21" />
                      </svg>
                      <div className="text-[12px] text-white/80 font-semibold mb-1">App goes here</div>
                      <div className="text-[10.5px] text-white/50 leading-snug">
                        Hit record, then choose the Ghost Session window when your browser asks. The bar at the bottom of your browser stops the take.
                      </div>
                    </div>
                  </div>
                )}

                {/* Reviewing — single full-frame video with the
                    composited result so the user sees exactly what
                    the saved file looks like. */}
                {resultUrl && (
                  <video
                    src={resultUrl}
                    controls
                    playsInline
                    className="absolute inset-0 w-full h-full object-cover bg-black"
                  />
                )}

                {phase === 'error' && error && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/85 px-6 text-center">
                    <div>
                      <div className="text-[14px] font-semibold text-red-300 mb-1">Camera unavailable</div>
                      <div className="text-[11.5px] text-white/70">{error}</div>
                    </div>
                  </div>
                )}

                {/* Bottom controls — record / save / retake. Hidden
                    during requesting/finalising states so the user
                    doesn't double-click. */}
                <div className="absolute bottom-0 left-0 right-0 flex items-center justify-center gap-4 pb-5">
                  {phase === 'previewing' && !resultUrl && (
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
                  {resultUrl && phase === 'reviewing' && (
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
                  {(phase === 'requesting_camera' || phase === 'finalizing') && (
                    <span className="text-[11.5px] text-white/70">
                      {phase === 'requesting_camera' ? 'Requesting camera…' : 'Finalising…'}
                    </span>
                  )}
                </div>
              </div>

              <div className="mt-3 text-[11px] text-white/55 max-w-[360px] text-center">
                Top: your camera. Bottom: a screen capture of the app you pick. Audio is the project's master output — start playback before recording.
              </div>

              {/* Saved-to-Downloads confirmation. AnimatePresence so
                  the toast slides in/out instead of popping. */}
              <AnimatePresence>
                {savedToast && (
                  <motion.div
                    key="saved-toast"
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 10 }}
                    transition={{ type: 'spring', stiffness: 280, damping: 24 }}
                    className="mt-2 px-3.5 py-1.5 rounded-full text-[11.5px] font-semibold text-white flex items-center gap-1.5"
                    style={{ background: 'rgba(34,197,94,0.20)', border: '1px solid rgba(34,197,94,0.45)' }}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                    {savedToast}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Recording HUD — shown OUTSIDE the modal scaffold so it
          floats over the live app while recording. Tiny so the
          screen capture barely notices it; the user clicks the
          browser's own "Stop sharing" bar to end the take. */}
      {open && phase === 'recording' && (
        <div
          className="fixed top-3 right-3 z-[100] flex items-center gap-1.5 px-2.5 py-1 rounded-full pointer-events-none"
          style={{ background: 'rgba(239,68,68,0.92)', boxShadow: '0 4px 12px rgba(0,0,0,0.4)' }}
        >
          <motion.span
            className="w-1.5 h-1.5 rounded-full bg-white"
            animate={{ opacity: [1, 0.35, 1] }}
            transition={{ duration: 1, repeat: Infinity, ease: 'easeInOut' }}
          />
          <span className="text-[10px] font-bold text-white tabular-nums">REC {formatTime(elapsedMs)}</span>
        </div>
      )}
    </>
  );
}
