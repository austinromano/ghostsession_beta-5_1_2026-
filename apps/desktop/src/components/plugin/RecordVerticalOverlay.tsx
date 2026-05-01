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

// Recorder lifecycle:
//   requesting_camera → previewing → requesting_screen
//   → ready_to_record → recording → finalizing → reviewing
// Screen capture is acquired BEFORE the user presses record so they
// can confirm the composite (camera + screen) reads correctly. The
// big record button only appears once both streams are live.
type Phase =
  | 'requesting_camera'
  | 'previewing'
  | 'requesting_screen'
  | 'ready_to_record'
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
// rect like CSS object-fit: cover. Used for the camera region — we
// preserve the user's face cam aspect and crop excess.
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

// Stretch-fit: scale the entire source to exactly fill dest. Used for
// the screen-share region so the bottom 72% is ALWAYS filled edge-to-
// edge, regardless of whether the captured window's content actually
// reaches its edges. Cover-fit was leaving black space whenever the
// user's shared window had empty area below the app (browser chrome,
// taskbar, etc) — drawCover would dutifully scale that empty area
// into the dest. Stretch-fit accepts a small aspect distortion in
// exchange for never showing dead space.
function drawStretch(
  ctx: CanvasRenderingContext2D,
  src: HTMLVideoElement,
  dx: number, dy: number, dw: number, dh: number,
): void {
  const sw = src.videoWidth;
  const sh = src.videoHeight;
  if (!sw || !sh) return;
  try {
    ctx.drawImage(src, 0, 0, sw, sh, dx, dy, dw, dh);
  } catch { /* video may not be ready yet */ }
}

// Draw the cartoon Ghost Session mascot (a Pac-Man-style ghost, mint
// green) centered at (cx, cy) with given outer width. Pure paths so
// it's resolution-independent and no image load is needed.
function drawGhostMascot(ctx: CanvasRenderingContext2D, cx: number, cy: number, w: number): void {
  const h = w * 1.05;
  const x = cx - w / 2;
  const y = cy - h / 2;
  const radius = w / 2;
  const bumpHeight = w * 0.10;
  ctx.save();
  // Body — dome on top, three rounded bumps on the bottom.
  ctx.fillStyle = '#23E5A8';
  ctx.beginPath();
  ctx.arc(cx, y + radius, radius, Math.PI, 0, false);     // top semicircle
  ctx.lineTo(x + w, y + h - bumpHeight);                  // right side down
  // 3 wavy bumps along the bottom (right → left).
  ctx.quadraticCurveTo(x + w * 0.83, y + h, x + w * 0.66, y + h - bumpHeight);
  ctx.quadraticCurveTo(x + w * 0.50, y + h, x + w * 0.33, y + h - bumpHeight);
  ctx.quadraticCurveTo(x + w * 0.16, y + h, x,            y + h - bumpHeight);
  ctx.closePath();
  ctx.fill();
  // Eyes — black ovals, slightly offset so the ghost reads as
  // glancing forward rather than dead-on staring.
  const eyeRx = w * 0.085;
  const eyeRy = w * 0.115;
  const eyeY = y + h * 0.46;
  ctx.fillStyle = '#0a0a0f';
  ctx.beginPath();
  ctx.ellipse(cx - w * 0.20, eyeY, eyeRx, eyeRy, 0, 0, Math.PI * 2);
  ctx.ellipse(cx + w * 0.20, eyeY, eyeRx, eyeRy, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// Round-rect path. Canvas's roundRect is not yet universal so we
// pave a manual one with arcTo for portability.
function pathRoundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Brand watermark — dark rounded pill in the bottom-right corner
// containing the ghost mascot + the wordmark "ghost session". Sized
// relative to the canvas so it reads at the same proportional weight
// regardless of output resolution.
function drawWatermark(ctx: CanvasRenderingContext2D): void {
  const canvasW = ctx.canvas.width;
  const canvasH = ctx.canvas.height;
  const iconSize = Math.round(canvasW * 0.06);          // ghost icon size
  const fontSize = Math.round(canvasW * 0.038);          // wordmark text
  const padX = Math.round(canvasW * 0.018);
  const padY = Math.round(canvasW * 0.014);
  const gap = Math.round(canvasW * 0.012);
  const margin = Math.round(canvasW * 0.025);
  const radius = Math.round(canvasW * 0.018);

  const text = 'ghost session';
  ctx.save();
  ctx.font = `700 ${fontSize}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`;
  const textWidth = ctx.measureText(text).width;

  const pillW = padX * 2 + iconSize + gap + textWidth;
  const pillH = padY * 2 + iconSize;
  const pillX = canvasW - pillW - margin;
  const pillY = canvasH - pillH - margin;

  // Drop shadow on the pill itself so it lifts off the screen capture
  // even when the captured area is dark.
  ctx.shadowColor = 'rgba(0,0,0,0.55)';
  ctx.shadowBlur = 16;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 6;
  pathRoundRect(ctx, pillX, pillY, pillW, pillH, radius);
  ctx.fillStyle = 'rgba(15, 12, 32, 0.92)';
  ctx.fill();
  // Subtle hairline border — kills the shadow that would otherwise
  // bleed through the pill content.
  ctx.shadowColor = 'transparent';
  pathRoundRect(ctx, pillX, pillY, pillW, pillH, radius);
  ctx.lineWidth = 1.4;
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.stroke();

  // Ghost mascot — left side of the pill.
  drawGhostMascot(ctx, pillX + padX + iconSize / 2, pillY + pillH / 2, iconSize);

  // Wordmark — right side, vertically centered against the icon.
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText(text, pillX + padX + iconSize + gap, pillY + pillH / 2 + 1);
  ctx.restore();
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
  // Share menu visibility. Opened from the review-state Share
  // button. Hides when the user picks a destination or closes it.
  const [showShareMenu, setShowShareMenu] = useState(false);

  // Holds every track / node we create here so cleanup is deterministic.
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const audioDestRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const rafIdRef = useRef<number | null>(null);
  const recordTimerRef = useRef<number | null>(null);
  const startTimeRef = useRef<number>(0);
  // Canvas captureStream — created once when the compositor starts
  // (after both camera + screen are live) and reused for both the
  // preview panel and the MediaRecorder feed. Stored in a ref so
  // beginRecording() can find it after chooseWindow() finished.
  const canvasStreamRef = useRef<MediaStream | null>(null);

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
    canvasStreamRef.current = null;
  }

  function tapMasterAudio(): MediaStreamTrack | null {
    const ctx = getCtx();
    const dest = ctx.createMediaStreamDestination();
    audioDestRef.current = dest;
    getMasterFader().connect(dest);
    const tracks = dest.stream.getAudioTracks();
    return tracks[0] || null;
  }

  // Step 1 — get the screen-share stream + start the canvas
  // compositor. Doesn't touch MediaRecorder yet; the user reviews
  // the composite preview first and triggers the take with the big
  // record button (beginRecording).
  async function chooseWindow() {
    const cam = cameraStreamRef.current;
    if (!cam) return;
    setPhase('requesting_screen');
    setError(null);

    let screenStream: MediaStream;
    try {
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

    // If the user hits Stop sharing in the browser at any point,
    // tear the compositor down + drop back to camera-only preview.
    const screenTrack = screenStream.getVideoTracks()[0];
    if (screenTrack) {
      screenTrack.addEventListener('ended', () => {
        if (recorderRef.current && recorderRef.current.state === 'recording') {
          stopRecording();
        } else {
          // User cancelled the share before recording started.
          stopCompositor();
          screenStreamRef.current = null;
          setPhase('previewing');
        }
      });
    }

    // Wire the canvas + RAF compositor — this populates the live
    // canvas captureStream that both the panel preview and the
    // recorder consume.
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
      ctx2d.fillStyle = '#000';
      ctx2d.fillRect(0, 0, OUTPUT_W, OUTPUT_H);
      const camV = cameraVideoRef.current;
      const scrV = screenVideoRef.current;
      if (camV && camV.videoWidth > 0) {
        drawCover(ctx2d, camV, 0, 0, OUTPUT_W, CAMERA_HEIGHT);
      }
      if (scrV && scrV.videoWidth > 0) {
        // Cover-fit preserves the captured window's aspect — content
        // crops in from the sides if the window is wider than the
        // 9:16 region, but never gets squished. Stretch-fit was
        // tried and rejected: filling the region edge-to-edge isn't
        // worth distorting the app UI.
        drawCover(ctx2d, scrV, 0, SCREEN_TOP, OUTPUT_W, SCREEN_HEIGHT);
      }
      // Watermark — drawn programmatically each frame as a dark pill
      // containing the ghost mascot + "ghost session" wordmark, so the
      // saved video always ships with the brand mark baked in. No
      // image-load step, no async race; just pure canvas paths so the
      // mark is always crisp at 1080×1920.
      drawWatermark(ctx2d);
      rafIdRef.current = requestAnimationFrame(drawFrame);
    };
    rafIdRef.current = requestAnimationFrame(drawFrame);

    canvasStreamRef.current = canvas.captureStream(30);
    setPhase('ready_to_record');
  }

  function stopCompositor() {
    if (rafIdRef.current != null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    canvasStreamRef.current = null;
  }

  // Step 2 — actually start the recording. Compositor must already
  // be running (chooseWindow has set phase = ready_to_record).
  function beginRecording() {
    const canvasStream = canvasStreamRef.current;
    if (!canvasStream) return;
    chunksRef.current = [];

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
      stopCompositor();
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
    setShowShareMenu(false);
    setPhase('previewing');
  }

  // Try the native Web Share API first — on mobile this opens the
  // OS share sheet with Instagram / TikTok / X / etc. as one-tap
  // targets. On desktop browsers the API rarely accepts video
  // files, so we fall back to a popover with launchers that open
  // the platform's web upload page in a new tab. Truly *automatic*
  // posting to Instagram personal accounts isn't possible — Meta's
  // Graph API only supports Business/Creator accounts via a Meta
  // OAuth flow + app review, which would be a separate server-side
  // integration phase.
  async function shareResult() {
    if (!resultUrl) return;
    try {
      const res = await fetch(resultUrl);
      const blob = await res.blob();
      const ext = resultMime.includes('mp4') ? 'mp4' : 'webm';
      const fileName = `ghost-session-${Date.now()}.${ext}`;
      const file = new File([blob], fileName, { type: blob.type });
      const nav = navigator as Navigator & { canShare?: (data: { files: File[] }) => boolean; share?: (data: { files: File[]; title?: string; text?: string }) => Promise<void> };
      if (nav.canShare && nav.share && nav.canShare({ files: [file] })) {
        try {
          await nav.share({
            files: [file],
            title: 'Ghost Session take',
            text: 'Made with Ghost Session',
          });
          flashSaved('Shared');
          return;
        } catch {
          // User cancelled the share sheet — fall through to the
          // platform-launcher popover below.
        }
      }
    } catch {
      // fetch / File construction failed — still show the popover.
    }
    setShowShareMenu(true);
  }

  // Save-then-launch: the platform doesn't give us an API to upload
  // a file from a web link, so we kick off a download (the user
  // already has the file in Downloads) and open the platform's
  // upload page in a new tab. The user manually picks the freshly-
  // downloaded file in the platform's uploader.
  function saveAndOpen(url: string) {
    downloadResult().catch(() => { /* ignore — open the platform anyway */ });
    window.open(url, '_blank', 'noopener,noreferrer');
    setShowShareMenu(false);
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

  return (
    <>
      {offscreenScaffold}
      <AnimatePresence>
        {open && (
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

                {/* Screen-share region — bottom 72%. Once chooseWindow
                    has succeeded, the live screen-capture <video>
                    fills this region so the user sees both their
                    camera (top) and the shared window (bottom)
                    inside one panel. Note: when the panel is over
                    the captured surface, this preview will recurse
                    visually — the user can drag the panel out of
                    the captured region to avoid that. */}
                {!resultUrl && (
                  <div
                    className="relative flex-1 overflow-hidden"
                    style={{
                      background: 'linear-gradient(180deg, rgba(20,12,44,0.6) 0%, rgba(8,6,18,0.95) 100%)',
                    }}
                  >
                    {/* Live screen-capture preview — visible from the
                        moment chooseWindow finishes through end of
                        recording. */}
                    {(phase === 'ready_to_record' || phase === 'recording' || phase === 'finalizing') && screenStreamRef.current && (
                      <video
                        autoPlay
                        muted
                        playsInline
                        ref={(el) => {
                          if (el && !el.srcObject && screenStreamRef.current) {
                            el.srcObject = screenStreamRef.current;
                          }
                        }}
                        className="absolute inset-0 w-full h-full object-cover bg-black"
                      />
                    )}

                    {phase === 'recording' && (
                      <div className="absolute top-2 left-1/2 -translate-x-1/2 flex items-center gap-1.5 px-2.5 py-1 rounded-full pointer-events-none"
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

                    {phase === 'requesting_screen' && (
                      <div className="absolute inset-0 flex items-center justify-center text-center px-6">
                        <div>
                          <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="rgba(168,134,255,0.85)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="mx-auto mb-2">
                            <rect x="2" y="3" width="20" height="14" rx="2" />
                            <line x1="8" y1="21" x2="16" y2="21" />
                            <line x1="12" y1="17" x2="12" y2="21" />
                          </svg>
                          <div className="text-[12px] text-white/85 font-semibold mb-1">Pick the window to share</div>
                          <div className="text-[10.5px] text-white/55 leading-snug">
                            Choose the Ghost Session window in your browser's screen-share dialog.
                          </div>
                        </div>
                      </div>
                    )}

                    {(phase === 'requesting_camera' || phase === 'previewing') && (
                      <div className="absolute inset-0 flex items-center justify-center text-center px-6">
                        <div>
                          <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="rgba(168,134,255,0.65)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="mx-auto mb-2">
                            <rect x="2" y="3" width="20" height="14" rx="2" />
                            <line x1="8" y1="21" x2="16" y2="21" />
                            <line x1="12" y1="17" x2="12" y2="21" />
                          </svg>
                          <div className="text-[12px] text-white/80 font-semibold mb-1">Choose a window to share</div>
                          <div className="text-[10.5px] text-white/50 leading-snug max-w-[240px] mx-auto">
                            Click the button below and pick the Ghost Session window so it appears here under your camera.
                          </div>
                        </div>
                      </div>
                    )}
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
                      onClick={chooseWindow}
                      className="px-5 h-11 rounded-full text-[12.5px] font-bold text-white flex items-center gap-2"
                      style={{
                        background: 'linear-gradient(180deg, #7C3AED 0%, #581C87 100%)',
                        boxShadow: '0 6px 18px rgba(124,58,237,0.35)',
                      }}
                      title="Choose window to share"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="2" y="3" width="20" height="14" rx="2" />
                        <line x1="8" y1="21" x2="16" y2="21" />
                        <line x1="12" y1="17" x2="12" y2="21" />
                      </svg>
                      Choose Window
                    </button>
                  )}
                  {phase === 'ready_to_record' && (
                    <button
                      type="button"
                      onClick={beginRecording}
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
                  {phase === 'recording' && (
                    <button
                      type="button"
                      onClick={stopRecording}
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
                  {resultUrl && phase === 'reviewing' && (
                    <>
                      <button
                        type="button"
                        onClick={discardResult}
                        className="px-3 h-10 rounded-full text-[12px] font-semibold text-white/85 hover:text-white"
                        style={{ background: 'rgba(255,255,255,0.10)', border: '1px solid rgba(255,255,255,0.18)' }}
                      >
                        Retake
                      </button>
                      <button
                        type="button"
                        onClick={downloadResult}
                        className="px-3.5 h-10 rounded-full text-[12px] font-semibold text-white"
                        style={{ background: 'linear-gradient(180deg, #ef4444 0%, #991b1b 100%)' }}
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        onClick={shareResult}
                        className="px-3.5 h-10 rounded-full text-[12px] font-semibold text-white flex items-center gap-1.5"
                        style={{ background: 'linear-gradient(180deg, #7C3AED 0%, #581C87 100%)' }}
                        title="Share to socials"
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                          <circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" />
                          <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
                          <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
                        </svg>
                        Share
                      </button>
                    </>
                  )}
                  {(phase === 'requesting_camera' || phase === 'finalizing') && (
                    <span className="text-[11.5px] text-white/70">
                      {phase === 'requesting_camera' ? 'Requesting camera…' : 'Finalising…'}
                    </span>
                  )}
                </div>

                {/* Share popover — opens over the preview when the
                    user clicks Share and Web Share API can't take the
                    file directly (true on most desktop browsers).
                    Each row downloads the file and opens the
                    platform's upload page so the user can pick the
                    just-saved file from their Downloads folder. */}
                <AnimatePresence>
                  {showShareMenu && (
                    <motion.div
                      key="share-menu"
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: 8 }}
                      transition={{ type: 'spring', stiffness: 280, damping: 26 }}
                      className="absolute inset-0 flex items-center justify-center"
                      style={{ background: 'rgba(8,6,18,0.92)', backdropFilter: 'blur(6px)' }}
                    >
                      <div className="w-[88%] rounded-xl p-3" style={{ background: 'rgba(20,14,40,0.95)', border: '1px solid rgba(168,134,255,0.22)' }}>
                        <div className="flex items-center gap-2 mb-2">
                          <span className="text-[12px] font-bold text-white">Share to…</span>
                          <button
                            type="button"
                            onClick={() => setShowShareMenu(false)}
                            className="ml-auto w-5 h-5 flex items-center justify-center rounded text-white/55 hover:text-white hover:bg-white/[0.08]"
                            title="Close"
                          >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                              <line x1="18" y1="6" x2="6" y2="18" />
                              <line x1="6" y1="6" x2="18" y2="18" />
                            </svg>
                          </button>
                        </div>
                        <div className="flex flex-col gap-1.5">
                          <SharePlatformRow
                            label="Instagram"
                            color="linear-gradient(135deg, #f09433 0%, #e6683c 25%, #dc2743 50%, #cc2366 75%, #bc1888 100%)"
                            onClick={() => saveAndOpen('https://www.instagram.com/')}
                          />
                          <SharePlatformRow
                            label="TikTok"
                            color="#000"
                            onClick={() => saveAndOpen('https://www.tiktok.com/upload?lang=en')}
                          />
                          <SharePlatformRow
                            label="YouTube Shorts"
                            color="#ff0000"
                            onClick={() => saveAndOpen('https://www.youtube.com/upload')}
                          />
                          <SharePlatformRow
                            label="X (Twitter)"
                            color="#000"
                            onClick={() => saveAndOpen('https://twitter.com/compose/tweet')}
                          />
                        </div>
                        <div className="mt-2.5 text-[10px] text-white/45 leading-snug">
                          The file downloads to your Downloads folder, then the platform opens — pick the just-saved video in their uploader. Direct posting from the desktop browser isn't supported by the platforms.
                        </div>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
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

    </>
  );
}

// One row in the Share-to popover — coloured chip + platform name
// + chevron. The platform's brand colour is set by the parent so
// future additions don't need a new component.
function SharePlatformRow({ label, color, onClick }: {
  label: string;
  color: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left transition-colors hover:bg-white/[0.06]"
    >
      <span
        aria-hidden
        className="shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-white"
        style={{ background: color }}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 12h14M13 5l7 7-7 7" />
        </svg>
      </span>
      <span className="text-[12.5px] font-semibold text-white/95">{label}</span>
      <svg className="ml-auto text-white/35" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="9 18 15 12 9 6" />
      </svg>
    </button>
  );
}
