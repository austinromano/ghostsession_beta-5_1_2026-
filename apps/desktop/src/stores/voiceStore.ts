import { create } from 'zustand';

/**
 * Shared voice-mic state. useVoiceMic (the setup hook) writes the
 * live MediaStream + error here; UserVoiceBar reads from it for the
 * mic / deafen toggles; PluginLayout subscribes so it can attach the
 * stream to WebRTC peers when the user is in a session.
 *
 * Keeping this in zustand instead of context lets the sidebar UI and
 * the WebRTC pipe both read without prop drilling and without
 * mounting useVoiceMic twice (which would call getUserMedia twice).
 */

interface VoiceState {
  stream: MediaStream | null;
  muted: boolean;
  deafened: boolean;
  micError: string | null;
  setStream: (s: MediaStream | null) => void;
  setMuted: (m: boolean) => void;
  setDeafened: (d: boolean) => void;
  setMicError: (e: string | null) => void;
  toggleMuted: () => void;
  /**
   * Discord-style toggle: deafening also mutes the mic; un-deafening
   * leaves the mic at whatever it was before (no auto-unmute).
   */
  toggleDeafened: () => void;
}

export const useVoiceStore = create<VoiceState>((set, get) => ({
  stream: null,
  muted: false,
  deafened: false,
  micError: null,
  setStream: (stream) => set({ stream }),
  setMuted: (muted) => set({ muted }),
  setDeafened: (deafened) => set({ deafened }),
  setMicError: (micError) => set({ micError }),
  toggleMuted: () => set({ muted: !get().muted }),
  toggleDeafened: () => {
    const next = !get().deafened;
    if (next) {
      set({ deafened: true, muted: true });
    } else {
      set({ deafened: false });
    }
  },
}));
