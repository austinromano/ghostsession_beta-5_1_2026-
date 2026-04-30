import { useCallback, useEffect, useRef } from 'react';
import { useSessionStore } from '../stores/sessionStore';
import { useVoiceStore } from '../stores/voiceStore';

/**
 * Discord-style always-on voice mic. Acquires a mic-only MediaStream
 * the moment the user joins a project session (currentProjectId set
 * in sessionStore) and releases it when they leave.
 *
 * Setup hook — call once at the top of PluginLayout. State + toggles
 * live in useVoiceStore so the sidebar UI (UserVoiceBar) and the
 * WebRTC publisher (PluginLayout) can share without prop drilling.
 */
export function useVoiceMic(): void {
  const currentProjectId = useSessionStore((s) => s.currentProjectId);
  const muted = useVoiceStore((s) => s.muted);
  const deafened = useVoiceStore((s) => s.deafened);
  const setStream = useVoiceStore((s) => s.setStream);
  const setMicError = useVoiceStore((s) => s.setMicError);
  const streamRef = useRef<MediaStream | null>(null);

  const releaseStream = useCallback(() => {
    const s = streamRef.current;
    if (!s) return;
    for (const track of s.getTracks()) {
      try { track.stop(); } catch { /* already stopped */ }
    }
    streamRef.current = null;
    setStream(null);
  }, [setStream]);

  const acquireStream = useCallback(async () => {
    if (streamRef.current && streamRef.current.getAudioTracks().some((t) => t.readyState === 'live')) return;
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
      // Apply the current mute / deafen state to the freshly-acquired
      // track so peers don't get a half-second of audio between
      // capture and the next mute-state push.
      for (const track of s.getAudioTracks()) {
        track.enabled = !useVoiceStore.getState().muted && !useVoiceStore.getState().deafened;
      }
      streamRef.current = s;
      setStream(s);
      setMicError(null);
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message || 'Mic permission denied';
      setMicError(msg);
      streamRef.current = null;
      setStream(null);
    }
  }, [setStream, setMicError]);

  // Auto-acquire on session join, release on leave.
  useEffect(() => {
    if (currentProjectId) {
      acquireStream();
    } else {
      releaseStream();
    }
  }, [currentProjectId, acquireStream, releaseStream]);

  // Final cleanup on hook unmount.
  useEffect(() => () => { releaseStream(); }, [releaseStream]);

  // Push mute / deafen state into the live track.
  useEffect(() => {
    const s = streamRef.current;
    if (!s) return;
    const enabled = !muted && !deafened;
    for (const track of s.getAudioTracks()) {
      track.enabled = enabled;
    }
  }, [muted, deafened]);

  // Deafen also silences incoming audio. Mute every <audio> + <video>
  // element in the document and stash their prior muted state so we
  // restore exactly on un-deafen.
  useEffect(() => {
    const els = Array.from(document.querySelectorAll<HTMLMediaElement>('audio, video'));
    if (deafened) {
      els.forEach((el) => {
        if (!el.dataset.preDeafenMuted) {
          el.dataset.preDeafenMuted = el.muted ? '1' : '0';
        }
        el.muted = true;
      });
    } else {
      els.forEach((el) => {
        const prior = el.dataset.preDeafenMuted;
        if (prior !== undefined) {
          el.muted = prior === '1';
          delete el.dataset.preDeafenMuted;
        }
      });
    }
  }, [deafened]);
}
