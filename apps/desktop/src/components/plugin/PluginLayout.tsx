import { useEffect, useState, useRef } from 'react';
import { motion } from 'framer-motion';
import { useAuthStore } from '../../stores/authStore';
import { useProjectStore } from '../../stores/projectStore';
import { api } from '../../lib/api';
import { onGlobalOnlineUsers, type OnlineUser } from '../../lib/socket';
import Avatar from '../common/Avatar';
import ChatPanel from '../session/ChatPanel';
import { useSessionStore } from '../../stores/sessionStore';
import { useAudioStore } from '../../stores/audioStore';
import { useEffectsStore } from '../../stores/effectsStore';
import { API_BASE } from '../../lib/constants';
import { devWarn } from '../../lib/log';

// Hooks
import { useNotifications } from '../../hooks/useNotifications';
import { useCursorTracking } from '../../hooks/useCursorTracking';
import { useSamplePacks } from '../../hooks/useSamplePacks';
import { useWebRTC } from '../../hooks/useWebRTC';
import { useVoiceMic } from '../../hooks/useVoiceMic';
import { useVoiceStore } from '../../stores/voiceStore';

// Extracted components
import ProjectListSidebar from '../layout/ProjectListSidebar';
import PresenceFriendsList from '../layout/PresenceFriendsList';
import SettingsPopup from '../common/SettingsPopup';
import NotificationPopup, { BellIcon } from '../common/NotificationPopup';
import InboxPopup from '../common/InboxPopup';
import InviteModal from '../common/InviteModal';
import ShareModal from './ShareModal';
import VideoGrid from '../video/VideoGrid';
import ScreenShareView from '../video/ScreenShareView';
import FullMixDropZone from '../tracks/FullMixDropZone';
import SocialFeed from '../social/SocialFeed';
import TransportBar from '../audio/TransportBar';
import { ArrangementDropZone, ArrangementScrollView, BarRuler, ArrangementPlayhead, DraggableTrackList } from '../project/ArrangementComponents';
import MasterTrackLane from '../project/MasterTrackLane';
import MasterBusLane from '../project/MasterBusLane';
import ArrangementComments from '../project/ArrangementComments';
import SampleEditorPanel from '../project/SampleEditorPanel';
import DrumRackPanel from '../project/DrumRackPanel';
import SamplePackContentView from './SamplePackContentView';
import AddFriendPopover from './AddFriendPopover';
import ProjectHeaderBar from './ProjectHeaderBar';
import CollaboratorsBar from './CollaboratorsBar';
import WelcomeHero from '../onboarding/WelcomeHero';
import FirstInviteNudge from '../onboarding/FirstInviteNudge';
import MessagesView from '../messages/MessagesView';
import CommunityRoomView from '../social/CommunityRoomView';
import { useCommunityStore } from '../../stores/communityStore';

const INVITE_NUDGE_FLAG = 'ghost_shown_invite_nudge';

const VIZ_MODES = ['bars', 'wave', 'radial', 'ghost'] as const;

// Grid snap subdivision picker. Sits next to the zoom buttons in the
// arrangement toolbar; reads/writes audioStore.gridDivision so every snap
// site (clip drag, paste, duplicate, trim) follows the same setting.
function GridSnapPicker() {
  const grid = useAudioStore((s) => s.gridDivision);
  const setGrid = useAudioStore((s) => s.setGridDivision);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const options: Array<{ label: string; value: number }> = [
    { label: 'Bar', value: 1 },
    { label: '1/2', value: 0.5 },
    { label: '1/4', value: 0.25 },
    { label: '1/8', value: 0.125 },
    { label: '1/16', value: 0.0625 },
  ];
  const current = options.find((o) => Math.abs(o.value - grid) < 1e-6) || options[0];

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className={`px-2 h-6 flex items-center justify-center gap-1 rounded text-[11px] font-semibold transition-colors ${grid !== 1 ? 'text-ghost-green' : 'text-white/40 hover:text-white/70'}`}
        title={`Grid snap: ${current.label}`}
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" />
          <rect x="3" y="14" width="7" height="7" /><rect x="14" y="14" width="7" height="7" />
        </svg>
        <span className="tabular-nums">{current.label}</span>
      </button>
      {open && (
        <div
          className="absolute right-0 mt-1 z-50 min-w-[80px] rounded-md py-1 shadow-[0_8px_24px_rgba(0,0,0,0.5)] backdrop-blur-md"
          style={{ background: 'rgba(20, 12, 30, 0.96)', border: '1px solid rgba(255,255,255,0.08)' }}
        >
          {options.map((o) => {
            const active = Math.abs(o.value - grid) < 1e-6;
            return (
              <button
                key={o.value}
                onClick={() => { setGrid(o.value); setOpen(false); }}
                className={`w-full px-3 py-1 text-[12px] text-left transition-colors flex items-center justify-between ${active ? 'text-ghost-green bg-white/[0.06]' : 'text-ghost-text-secondary hover:bg-white/[0.06] hover:text-white'}`}
              >
                <span>{o.label}</span>
                {active && <span className="text-[9px]">✓</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Undo / redo pair that lives next to the zoom buttons in the arrangement
// toolbar. Wired straight to audioStore.undo / .redo and greyed out when
// their stack is empty.
function UndoRedoButtons() {
  const undo = useAudioStore((s) => s.undo);
  const redo = useAudioStore((s) => s.redo);
  const canUndo = useAudioStore((s) => s.canUndo);
  const canRedo = useAudioStore((s) => s.canRedo);
  return (
    <>
      <button
        onClick={() => { if (canUndo) undo(); }}
        disabled={!canUndo}
        className={`w-6 h-6 flex items-center justify-center rounded transition-colors ${canUndo ? 'text-white/40 hover:text-white' : 'text-white/15 cursor-not-allowed'}`}
        title="Undo"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="1 4 1 10 7 10" />
          <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
        </svg>
      </button>
      <button
        onClick={() => { if (canRedo) redo(); }}
        disabled={!canRedo}
        className={`w-6 h-6 flex items-center justify-center rounded transition-colors ${canRedo ? 'text-white/40 hover:text-white' : 'text-white/15 cursor-not-allowed'}`}
        title="Redo"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="23 4 23 10 17 10" />
          <path d="M20.49 15a9 9 0 1 1-2.13-9.36L23 10" />
        </svg>
      </button>
    </>
  );
}

// Tiny hidden <audio> that plays a remote MediaStream. Mounted at
// the PluginLayout root level so voice keeps playing even when the
// VideoGrid panel is collapsed. The element's autoplay survives a
// stream swap because the effect re-attaches srcObject whenever the
// stream prop changes.
function RemoteVoicePlayer({ stream }: { stream: MediaStream }) {
  const ref = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.srcObject !== stream) el.srcObject = stream;
    // Some browsers won't autoplay audio without a user gesture.
    // Treat the play() promise as best-effort; failure just means
    // audio waits for the next user interaction.
    el.play().catch(() => { /* user gesture pending */ });
  }, [stream]);
  return <audio ref={ref} autoPlay playsInline />;
}

function DockButton({ title, active, onClick, children }: { title: string; active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <motion.button
      onClick={onClick}
      whileHover={{ scale: 1.06 }}
      whileTap={{ scale: 0.94 }}
      title={title}
      className={`w-11 h-11 flex items-center justify-center rounded-2xl transition-all shadow-[0_2px_8px_rgba(0,0,0,0.3)] hover:rounded-xl ${
        active ? 'text-white' : 'text-white/60 hover:text-white'
      }`}
      style={{
        background: active ? 'linear-gradient(135deg, #00FFC8 0%, #7C3AED 100%)' : 'rgba(255,255,255,0.05)',
        border: active ? '1px solid rgba(255,255,255,0.15)' : '1px solid rgba(255,255,255,0.08)',
        boxShadow: active
          ? '0 0 16px rgba(0,255,200,0.3), 0 2px 8px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.2)'
          : '0 2px 8px rgba(0,0,0,0.3)',
      }}
    >
      {children}
    </motion.button>
  );
}

export default function PluginLayout() {
  const { user, logout } = useAuthStore();
  const { projects, currentProject, fetchProjects, fetchProject, createProject, updateProject, updateTrack, deleteTrack, versions, fetchVersions } = useProjectStore();
  const { join, leave, onlineUsers } = useSessionStore();

  // Domain hooks
  const notifs = useNotifications();
  const samplePackState = useSamplePacks();

  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [pendingProfileUserId, setPendingProfileUserId] = useState<string | null>(null);
  const activeCommunityRoomId = useCommunityStore((s) => s.activeRoomId);
  const closeCommunityRoom = useCommunityStore((s) => s.closeRoom);

  // If the currently-selected project disappears from the list (e.g. host
  // canceled the shared session while the invitee was inside it), step back
  // to the home screen so we're not staring at a dead project.
  useEffect(() => {
    if (!selectedProjectId) return;
    if (projects.length === 0) return; // still loading
    if (!projects.some((p) => p.id === selectedProjectId)) {
      setSelectedProjectId(null);
    }
  }, [projects, selectedProjectId]);

  // Mirror selectedProjectId into the effects store so per-track effect
  // chains hydrate from localStorage scoped to the active project.
  useEffect(() => {
    useEffectsStore.getState().setProject(selectedProjectId);
  }, [selectedProjectId]);

  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem('ghost_sidebar_collapsed') !== '0');
  useEffect(() => {
    localStorage.setItem('ghost_sidebar_collapsed', sidebarCollapsed ? '1' : '0');
  }, [sidebarCollapsed]);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const raw = localStorage.getItem('ghost_sidebar_width');
    const n = raw ? parseInt(raw, 10) : NaN;
    return !isNaN(n) && n >= 180 && n <= 520 ? n : 210;
  });
  useEffect(() => {
    localStorage.setItem('ghost_sidebar_width', String(sidebarWidth));
  }, [sidebarWidth]);
  const [showSocial, setShowSocial] = useState(false);
  const [showMarketplace, setShowMarketplace] = useState(false);
  const [showMessages, setShowMessages] = useState(false);
  const [chatCollapsed, setChatCollapsed] = useState(() => localStorage.getItem('ghost_chat_collapsed') !== '0');
  useEffect(() => {
    localStorage.setItem('ghost_chat_collapsed', chatCollapsed ? '1' : '0');
  }, [chatCollapsed]);
  const [videoGridHidden, setVideoGridHidden] = useState(true);
  const [shareStatus, setShareStatus] = useState('');
  const [showAllBars, setShowAllBars] = useState(() => localStorage.getItem('ghost_show_all_bars') !== '0');
  useEffect(() => {
    localStorage.setItem('ghost_show_all_bars', showAllBars ? '1' : '0');
  }, [showAllBars]);
  const [vizModeIdx, setVizModeIdx] = useState(0);
  const vizMode = VIZ_MODES[vizModeIdx];
  const [isBeatView, setIsBeatView] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [trackZoom, setTrackZoom] = useState<'full' | 'half'>('full');
  // Per-project editor UI state (track zoom, future panel preferences).
  // Restores on project load so the user re-enters the project with the
  // same lane height they left it at — no settling time, no surprise.
  useEffect(() => {
    if (!selectedProjectId) return;
    try {
      const raw = localStorage.getItem(`editor-ui::${selectedProjectId}`);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (data.trackZoom === 'half' || data.trackZoom === 'full') {
        setTrackZoom(data.trackZoom);
      }
    } catch { /* ignore corrupt blob */ }
  }, [selectedProjectId]);
  useEffect(() => {
    if (!selectedProjectId) return;
    try {
      const raw = localStorage.getItem(`editor-ui::${selectedProjectId}`);
      const existing = raw ? JSON.parse(raw) : {};
      localStorage.setItem(`editor-ui::${selectedProjectId}`, JSON.stringify({ ...existing, trackZoom }));
    } catch { /* ignore quota errors */ }
  }, [selectedProjectId, trackZoom]);

  // Per-project clip selection persistence. Drives the green selection
  // ring AND what populates the SampleEditorPanel below — without this,
  // every project re-open lands on "click a clip to inspect it" and the
  // user has to reselect to see warp markers / pitch / volume etc. for
  // the clip they were working on.
  const selectedTrackIds = useAudioStore((s) => s.selectedTrackIds);
  const setSelectedTrackIds = useAudioStore((s) => s.setSelectedTrackIds);
  const loadedTracks = useAudioStore((s) => s.loadedTracks);
  const selectionRestoredFor = useRef<string | null>(null);

  // Save: every time the user changes the selection, write it back to
  // the per-project blob.
  useEffect(() => {
    if (!selectedProjectId) return;
    if (selectionRestoredFor.current !== selectedProjectId) return;
    try {
      const raw = localStorage.getItem(`editor-ui::${selectedProjectId}`);
      const existing = raw ? JSON.parse(raw) : {};
      localStorage.setItem(
        `editor-ui::${selectedProjectId}`,
        JSON.stringify({ ...existing, selectedTrackIds: Array.from(selectedTrackIds) }),
      );
    } catch { /* ignore quota errors */ }
  }, [selectedProjectId, selectedTrackIds]);

  // Restore: replay the saved selection as soon as the matching track
  // is in the audio store. Tracks load asynchronously, so the saved
  // selection might point to a track that hasn't decoded yet — keep
  // re-attempting on every loadedTracks change until one of:
  //   1. We find a match and restore it
  //   2. There's no saved blob / the saved selection is empty
  //   3. Every track the project knows about is already loaded and
  //      none match (saved id was for a deleted track)
  // Once any of those bail conditions hits, the restore-guard ref is
  // set and the save effect can start writing future changes.
  const expectedTrackCount = (currentProject?.tracks as any[] || [])
    .filter((t) => t && t.fileId).length;
  useEffect(() => {
    if (!selectedProjectId) return;
    if (selectionRestoredFor.current === selectedProjectId) return;
    if (loadedTracks.size === 0) return;
    let done = false;
    try {
      const raw = localStorage.getItem(`editor-ui::${selectedProjectId}`);
      if (!raw) {
        done = true;
      } else {
        const data = JSON.parse(raw);
        const savedIds = Array.isArray(data.selectedTrackIds) ? (data.selectedTrackIds as string[]) : [];
        if (savedIds.length === 0) {
          done = true;
        } else {
          const valid = savedIds.filter((id) => loadedTracks.has(id));
          if (valid.length > 0) {
            setSelectedTrackIds(valid);
            done = true;
          } else if (expectedTrackCount > 0 && loadedTracks.size >= expectedTrackCount) {
            // All expected tracks are loaded but none matched — saved
            // selection points at deleted tracks. Give up so saves
            // can begin from the user's next click.
            done = true;
          }
        }
      }
    } catch {
      done = true;
    }
    if (done) selectionRestoredFor.current = selectedProjectId;
  }, [selectedProjectId, loadedTracks, setSelectedTrackIds, expectedTrackCount]);

  // Reset the restore guard whenever the user switches projects so the
  // next project gets its own one-shot restore pass.
  useEffect(() => {
    if (selectionRestoredFor.current && selectionRestoredFor.current !== selectedProjectId) {
      selectionRestoredFor.current = null;
    }
  }, [selectedProjectId]);
  const [onlineActivity, setOnlineActivity] = useState<Map<string, OnlineUser>>(new Map());
  const [showNotifs, setShowNotifs] = useState(false);
  const [showInbox, setShowInbox] = useState(false);
  const [showInvite, setShowInvite] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const [friends, setFriends] = useState<{ id: string; displayName: string; avatarUrl: string | null }[]>([]);
  const [showVersionHistory, setShowVersionHistory] = useState(false);
  const [reverting, setReverting] = useState(false);
  const [inviteNudgeProject, setInviteNudgeProject] = useState<{ id: string; name: string } | null>(null);
  const cursorContainerRef = useRef<HTMLDivElement>(null);
  const currentProjectId = useSessionStore((s) => s.currentProjectId);
  useCursorTracking(cursorContainerRef, currentProjectId);

  // WebRTC is owned here so it keeps running even when the floating video
  // panel is hidden — otherwise we'd miss inbound offers while collapsed.
  const webrtc = useWebRTC(currentProjectId, user?.id ?? null);
  const remoteActivityCount = webrtc.remoteStreams.size + webrtc.remoteScreenStreams.size;

  // Auto-open the floating panel when a remote camera OR screen stream arrives.
  useEffect(() => {
    if (remoteActivityCount > 0 && videoGridHidden) setVideoGridHidden(false);
  }, [remoteActivityCount]);

  // Voice mic — auto-acquires on session join via sessionStore. Hook
  // writes its state into useVoiceStore; publish the mic stream to
  // every other online user's peer via the existing useWebRTC pipe
  // when it becomes available, so audio is heard the moment the user
  // enters the project.
  useVoiceMic();
  const voiceStream = useVoiceStore((s) => s.stream);
  useEffect(() => {
    if (!voiceStream || !currentProjectId || !user?.id) return;
    // No active camera publishing? Use publishStream to send the
    // mic-only stream as a "camera" track. If a camera stream is
    // already active, the existing replaceStream path keeps audio
    // routed via the camera mic.
    const otherUserIds = onlineUsers.filter((u) => u.userId !== user.id).map((u) => u.userId);
    if (otherUserIds.length === 0) return;
    webrtc.publishStream(voiceStream, otherUserIds).catch((err) => devWarn('PluginLayout.publishVoice', err));
    return () => {
      webrtc.stopStream();
    };
  }, [voiceStream, currentProjectId, user?.id, onlineUsers, webrtc]);

  const audioCleanup = useAudioStore((s) => s.cleanup);
  const members = currentProject?.members || [];

  // ── Effects ──

  useEffect(() => {
    onGlobalOnlineUsers((users) => {
      const map = new Map<string, OnlineUser>();
      users.forEach((u) => map.set(u.userId, u));
      setOnlineActivity(map);
    });
  }, []);

  useEffect(() => {
    fetchProjects();
    api.listUsers().then(setFriends).catch((err) => devWarn('PluginLayout.listUsers', err));
  }, []);

  // Polling fallback: refresh project data periodically in case socket.io
  // project-updated events are missed (e.g. plugin WebView).
  // Bumped 5 s → 120 s. The old interval was ~17k refetches per client per
  // day at ~300-500 KB each, which amplifies into huge Railway egress when
  // multiple collaborators are online. Sockets cover the live-sync case;
  // this is purely a safety net for dropped events.
  useEffect(() => {
    if (!selectedProjectId) return;
    const pollTimer = setInterval(() => { fetchProject(selectedProjectId); }, 120000);
    const handleRefresh = () => { fetchProject(selectedProjectId); fetchProjects(); };
    window.addEventListener('ghost-refresh-project', handleRefresh);
    return () => { clearInterval(pollTimer); window.removeEventListener('ghost-refresh-project', handleRefresh); };
  }, [selectedProjectId]);

  // Open a project by id from elsewhere in the app (e.g. the Join button on
  // a scheduled session). Fire: window.dispatchEvent(new CustomEvent('ghost-open-project', { detail: { projectId } }))
  // Refetches the projects list first so a newly-added project (e.g. auto-
  // created from a session acceptance) shows up in the sidebar.
  useEffect(() => {
    const openHandler = async (e: Event) => {
      const projectId = (e as CustomEvent<{ projectId: string }>).detail?.projectId;
      if (!projectId) return;
      await fetchProjects();
      selectProject(projectId);
    };
    window.addEventListener('ghost-open-project', openHandler);
    return () => window.removeEventListener('ghost-open-project', openHandler);
  }, []);

  // Open a user's profile page from anywhere in the app. Clicking an Avatar
  // with a userId fires 'ghost-open-profile' — we navigate to the Social
  // section (where the profile view lives) and pass the id down so SocialFeed
  // loads it on mount. Community room close fires too to avoid overlap.
  useEffect(() => {
    const openProfile = (e: Event) => {
      const userId = (e as CustomEvent<{ userId: string }>).detail?.userId;
      if (!userId) return;
      closeCommunityRoom();
      setPendingProfileUserId(userId);
      goTo('explore');
    };
    window.addEventListener('ghost-open-profile', openProfile);
    return () => window.removeEventListener('ghost-open-profile', openProfile);
  }, []);

  // Settings gear in the sidebar's UserVoiceBar dispatches this event
  // to mirror the dock avatar's behaviour.
  useEffect(() => {
    const openSettings = () => { setShowSettings(true); setShowNotifs(false); };
    window.addEventListener('ghost-open-settings', openSettings);
    return () => window.removeEventListener('ghost-open-settings', openSettings);
  }, []);

  // Always land on WelcomeHero when the plugin opens — user picks a project
  // from the sidebar or a CTA. No auto-select.

  // ── Handlers ──

  const acceptInvite = async (id: string) => {
    const projectId = await notifs.acceptInvite(id);
    await fetchProjects();
    if (projectId) selectProject(projectId);
    setShowNotifs(false);
  };

  const selectProject = async (id: string) => {
    // No-op when the same project is already open. Re-running the cleanup +
    // refetch cycle here is what used to flash the arrangement back to its
    // default layout, because the audio store gets wiped and repopulated
    // asynchronously. If the user wants to refresh, the dedicated refresh
    // button handles it without touching the audio store.
    if (id === selectedProjectId) return;
    if (selectedProjectId) {
      // Flush any pending arrangement save *before* audioCleanup wipes
      // the audio store. The debounced save in TransportBar runs 500 ms
      // after the last move, so a quick project switch would otherwise
      // drop the user's latest drag and lose it on return.
      window.dispatchEvent(new CustomEvent('ghost-save-arrangement'));
      leave();
      audioCleanup();
    }
    closeCommunityRoom();
    if (id === '__beats__') {
      const p = await createProject({ name: 'Untitled', projectType: 'beat' } as any);
      await fetchProjects();
      setSelectedProjectId(p.id);
      samplePackState.setSelectedPackId(null);
      setShowSocial(false);
      setIsBeatView(true);
      fetchProject(p.id);
      return;
    }
    setSelectedProjectId(id);
    samplePackState.setSelectedPackId(null);
    setShowSocial(false);
    setShowMarketplace(false);
    const proj = projects.find((p: any) => p.id === id);
    setIsBeatView((proj as any)?.projectType === 'beat');
    fetchProject(id);
    fetchVersions(id);
    join(id);
  };

  const maybeShowInviteNudge = (id: string, name: string) => {
    if (projects.length === 0 && !localStorage.getItem(INVITE_NUDGE_FLAG)) {
      setInviteNudgeProject({ id, name });
    }
  };

  const handleCreateBeat = async () => {
    try {
      const p = await createProject({ name: 'Untitled', projectType: 'beat' } as any);
      await fetchProjects();
      maybeShowInviteNudge(p.id, p.name);
      selectProject(p.id);
    } catch (err) { devWarn('PluginLayout.createBeat', err); }
  };

  const handleCreate = async () => {
    const p = await createProject({ name: 'Untitled' });
    await fetchProjects();
    maybeShowInviteNudge(p.id, p.name);
    selectProject(p.id);
  };

  const dismissInviteNudge = () => {
    localStorage.setItem(INVITE_NUDGE_FLAG, '1');
    setInviteNudgeProject(null);
  };

  const acceptInviteNudge = () => {
    localStorage.setItem(INVITE_NUDGE_FLAG, '1');
    setInviteNudgeProject(null);
    setShowInvite(true);
  };

  const handleRevert = async (versionId: string) => {
    if (!selectedProjectId || reverting) return;
    setReverting(true);
    try {
      await api.revertToVersion(selectedProjectId, versionId);
      await fetchProject(selectedProjectId);
      await fetchVersions(selectedProjectId);
    } catch (err: any) {
      console.error('Revert failed:', err);
    } finally {
      setReverting(false);
    }
  };

  const handleDeleteProject = async () => {
    if (!selectedProjectId) return;
    if (!confirm('Are you sure you want to delete this project? This cannot be undone.')) return;
    try {
      await api.deleteProject(selectedProjectId);
      leave(); audioCleanup();
      setSelectedProjectId(null);
      fetchProjects();
    } catch (err: any) {
      alert(err.message || 'Failed to delete project');
    }
  };

  const handleLeaveProject = async () => {
    if (!selectedProjectId) return;
    if (!confirm('Leave this project? You will need a new invite to rejoin.')) return;
    try {
      await api.leaveProject(selectedProjectId);
      leave(); audioCleanup();
      setSelectedProjectId(null);
      fetchProjects();
    } catch (err: any) {
      alert(err.message || 'Failed to leave project');
    }
  };

  const handleShareProject = async () => {
    if (!selectedProjectId || !currentProject) return;
    try {
      await fetch(`${API_BASE}/social/posts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('ghost_token')}` },
        body: JSON.stringify({ text: `Check out my project "${currentProject.name}" 🎵`, projectId: selectedProjectId }),
      });
      setShareStatus('Shared to feed!');
    } catch {
      setShareStatus('Failed to share');
    } finally {
      setTimeout(() => setShareStatus(''), 3000);
    }
  };

  const handleDownloadStems = () => {
    if (!currentProject?.tracks) return;
    const seen = new Set<string>();
    const items = currentProject.tracks
      .filter((t: any) => {
        if (!t.fileId || seen.has(t.fileId)) return false;
        seen.add(t.fileId);
        return true;
      })
      .map((t: any) => ({
        url: api.getDirectDownloadUrl(selectedProjectId!, t.fileId),
        name: (t.name || 'stem').replace(/ \(copy\)$/i, '') + '.wav',
      }));
    if (items.length === 0) return;
    (window as any).__ghostPendingExport = JSON.stringify(items);
    console.log('[DownloadStems] Set pending export:', items.length, 'items');
  };

  const handleCreatePack = async () => {
    const pack = await samplePackState.createPack();
    if (pack) setSelectedProjectId(null);
  };
  const handleSelectPack = (id: string) => {
    samplePackState.selectPack(id);
    setSelectedProjectId(null);
    if (selectedProjectId) {
      window.dispatchEvent(new CustomEvent('ghost-save-arrangement'));
      leave();
      audioCleanup();
    }
  };

  type DockMode = 'home' | 'explore' | 'messages' | 'marketplace';
  const goTo = (mode: DockMode) => {
    if (selectedProjectId) {
      window.dispatchEvent(new CustomEvent('ghost-save-arrangement'));
      leave();
      audioCleanup();
    }
    closeCommunityRoom();
    setSelectedProjectId(null);
    samplePackState.setSelectedPackId(null);
    setShowSocial(mode === 'explore');
    setShowMessages(mode === 'messages');
    setShowMarketplace(mode === 'marketplace');
  };
  const atHome = !selectedProjectId && !samplePackState.selectedPackId && !showSocial && !showMessages && !showMarketplace && !activeCommunityRoomId;

  // ── Render ──

  return (
    <div className="flex h-screen w-screen overflow-hidden relative">
      {/* Presence dock */}
      <div className="flex flex-col items-center justify-start shrink-0 w-[60px] pt-4 pb-2 z-20 gap-4">
        <motion.svg
          onClick={() => setVizModeIdx((i) => (i + 1) % VIZ_MODES.length)}
          width="44" height="44" viewBox="0 0 20 22" fill="none"
          className="shrink-0 cursor-pointer"
          style={{ filter: 'drop-shadow(0 0 4px rgba(0,255,200,0.3))' }}
          animate={{ y: [0, -8, 0] }}
          transition={{ duration: 2.5, repeat: Infinity, ease: 'easeInOut' }}
        >
          <defs>
            <linearGradient id="ghostGradNav" x1="0" y1="0" x2="20" y2="22" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stopColor="#00FFC8" /><stop offset="100%" stopColor="#7C3AED" />
            </linearGradient>
          </defs>
          <path d="M10 1C5.5 1 2 4.5 2 9v8l2-2 2 2 2-2 2 2 2-2 2 2 2-2 2 2V9c0-4.5-3.5-8-8-8z" fill="rgba(0,255,200,0.08)" stroke="url(#ghostGradNav)" strokeWidth="1.5" strokeLinejoin="round" />
          <ellipse cx="7.5" cy="9.5" rx="1.6" ry="1.8" fill="url(#ghostGradNav)" opacity="0.9" />
          <ellipse cx="12.5" cy="9.5" rx="1.6" ry="1.8" fill="url(#ghostGradNav)" opacity="0.9" />
          <ellipse cx="7.5" cy="9.2" rx="0.6" ry="0.7" fill="#0A0412" />
          <ellipse cx="12.5" cy="9.2" rx="0.6" ry="0.7" fill="#0A0412" />
        </motion.svg>

        <DockButton title="Home" active={atHome} onClick={() => goTo('home')}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 12L12 3l9 9" />
            <path d="M5 10v10a1 1 0 0 0 1 1h3v-6h6v6h3a1 1 0 0 0 1-1V10" />
          </svg>
        </DockButton>

        <DockButton title="Explore feed" active={showSocial} onClick={() => goTo('explore')}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" />
          </svg>
        </DockButton>

        <DockButton title="Messages" active={showMessages} onClick={() => goTo('messages')}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
          </svg>
        </DockButton>

        <DockButton title="Marketplace" active={showMarketplace} onClick={() => goTo('marketplace')}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 9h18l-1.5 10a2 2 0 0 1-2 1.8H6.5a2 2 0 0 1-2-1.8L3 9z" />
            <path d="M8 9V6a4 4 0 0 1 8 0v3" />
          </svg>
        </DockButton>

        <div className="w-8 h-px bg-white/10 my-1" />

        <div
          className="relative cursor-pointer"
          onClick={() => { setShowSettings(!showSettings); setShowNotifs(false); }}
          title={user?.displayName || 'Profile'}
        >
          <div className="rounded-[16px] overflow-hidden transition-all duration-200 shadow-[0_2px_8px_rgba(0,0,0,0.3)] hover:rounded-full">
            <Avatar name={user?.displayName || '?'} src={user?.avatarUrl} size="lg" />
          </div>
          <span
            className="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full"
            style={{ background: '#23A559', border: '2.5px solid #0A0412', boxShadow: '0 0 6px rgba(35,165,89,0.5)' }}
          />
        </div>

        <PresenceFriendsList friends={friends} onlineActivity={onlineActivity} selectProject={selectProject} />

        <AddFriendPopover friends={friends} onFriendsUpdated={setFriends} />
      </div>

      {/* Main column */}
      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        <div
          className="flex flex-1 min-h-0 p-2 gap-2"
          style={{ paddingBottom: selectedProjectId && currentProject ? '48px' : '8px' }}
        >
          {/* Sidebar */}
          <div
            className={`relative flex flex-col self-stretch ${sidebarCollapsed ? 'w-4 shrink-0' : 'shrink-0 glass glass-glow rounded-2xl pt-2 px-2'}`}
            style={sidebarCollapsed ? undefined : { width: sidebarWidth }}
          >
            <button
              onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
              className="absolute right-0 top-1/2 -translate-y-1/2 z-20 w-5 h-10 flex items-center justify-center rounded-full glass hover:bg-white/[0.08] transition-colors"
              title={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
            >
              <svg width="8" height="12" viewBox="0 0 8 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-ghost-text-muted">
                {sidebarCollapsed ? <polyline points="2,1 6,6 2,11" /> : <polyline points="6,1 2,6 6,11" />}
              </svg>
            </button>
            {!sidebarCollapsed && (
              <>
                {/* Resize handle — thin strip on the right edge. Sits under
                    the collapse button so that button wins hit-testing at
                    its hotspot. Drag horizontally to resize; width clamped
                    to [180, 520] and persisted to localStorage. */}
                <div
                  onPointerDown={(e) => {
                    e.preventDefault();
                    const startX = e.clientX;
                    const startW = sidebarWidth;
                    const onMove = (ev: PointerEvent) => {
                      const next = Math.max(180, Math.min(520, startW + (ev.clientX - startX)));
                      setSidebarWidth(next);
                    };
                    const onUp = () => {
                      window.removeEventListener('pointermove', onMove);
                      window.removeEventListener('pointerup', onUp);
                    };
                    window.addEventListener('pointermove', onMove);
                    window.addEventListener('pointerup', onUp);
                  }}
                  className="absolute right-0 top-0 bottom-0 w-1.5 z-10 cursor-ew-resize hover:bg-ghost-green/30 transition-colors"
                  title="Drag to resize"
                />
                <div className="flex-1 min-h-0 flex flex-col">
                  <ProjectListSidebar
                    projects={projects.filter((p: any) => p.projectType !== 'beat')}
                    allProjects={projects}
                    selectedId={selectedProjectId}
                    onSelect={selectProject}
                    onCreate={handleCreate}
                    onCreateBeat={handleCreateBeat}
                    samplePacks={samplePackState.packs}
                    selectedPackId={samplePackState.selectedPackId}
                    onSelectPack={handleSelectPack}
                    onCreatePack={handleCreatePack}
                    friends={friends}
                    onlineActivity={onlineActivity}
                  />
                </div>
              </>
            )}
          </div>

          {/* Main content */}
          <div ref={cursorContainerRef} className="relative flex-1 flex flex-col min-w-0 overflow-hidden">
            {showSettings && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowSettings(false)} />
                <SettingsPopup
                  user={user}
                  onSignOut={() => { setShowSettings(false); logout(); }}
                  onDeleteAccount={async () => { setShowSettings(false); await useAuthStore.getState().deleteAccount(); }}
                  onClose={() => setShowSettings(false)}
                  onProfile={() => { setShowSocial(true); setSelectedProjectId(null); samplePackState.setSelectedPackId(null); }}
                />
              </>
            )}
            {showNotifs && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowNotifs(false)} />
                <NotificationPopup
                  invitations={notifs.invitations}
                  onAccept={acceptInvite}
                  onDecline={notifs.declineInvite}
                  notifications={notifs.notifications.filter((n: any) => n.type !== 'loop' && !n.message.includes('🎵'))}
                  onMarkRead={notifs.markAllRead}
                  loopMessages={notifs.loopMessages}
                  onRemoveLoop={notifs.removeLoopMessage}
                />
              </>
            )}
            {showInbox && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowInbox(false)} />
                <InboxPopup
                  loopNotifications={notifs.notifications.filter((n: any) => n.type === 'loop' || n.message.includes('🎵'))}
                  onMarkRead={notifs.markAllRead}
                  onRefresh={notifs.fetchNotifications}
                />
              </>
            )}
            {showInvite && selectedProjectId && (
              <InviteModal open={showInvite} onClose={() => setShowInvite(false)} projectId={selectedProjectId} />
            )}
            {showInvite && samplePackState.selectedPackId && !selectedProjectId && (
              <InviteModal open={showInvite} onClose={() => setShowInvite(false)} projectId={samplePackState.selectedPackId} />
            )}
            {showShare && selectedProjectId && currentProject && (
              <ShareModal
                open={showShare}
                onClose={() => setShowShare(false)}
                projectId={selectedProjectId}
                projectName={currentProject.name}
                initialShareToken={(currentProject as any).shareToken ?? null}
              />
            )}

            <div className="flex-1 flex min-h-0 gap-2">
              {activeCommunityRoomId ? (
                <CommunityRoomView />
              ) : selectedProjectId && currentProject ? (
                <>
                  <div className="flex-1 flex flex-col min-w-0">
                    <ProjectHeaderBar
                      project={currentProject}
                      canDelete={currentProject.ownerId === user?.id}
                      canRename={currentProject.ownerId === user?.id}
                      onNameChange={(name) => updateProject(currentProject.id, { name })}
                      onTempoChange={(tempo) => updateProject(currentProject.id, { tempo })}
                      onKeyChange={(key) => updateProject(currentProject.id, { key })}
                      onTimeSignatureChange={(ts) => updateProject(currentProject.id, { timeSignature: ts } as any)}
                      onShowVersionHistory={() => { setShowVersionHistory((v) => !v); if (!showVersionHistory) fetchVersions(selectedProjectId); }}
                      onShareToFeed={handleShareProject}
                      onShareLink={() => setShowShare(true)}
                      onInvite={() => setShowInvite(true)}
                      onDelete={handleDeleteProject}
                      onLeave={handleLeaveProject}
                    />

                    <div className="flex-1 flex flex-col min-w-0 glass glass-glow rounded-2xl overflow-hidden">
                      <div className="flex-1 flex flex-col min-h-0">
                        <div className="flex-1 overflow-y-auto p-4">
                          {shareStatus && (
                            <div className="mb-3 px-4 py-2 rounded-lg bg-purple-500/20 border border-purple-500/30 text-[13px] text-purple-300 font-medium text-center">
                              {shareStatus}
                            </div>
                          )}

                          {showVersionHistory && (
                            <div className="mb-4 glass-subtle overflow-hidden">
                              <div className="px-4 py-2 border-b border-ghost-border/30 flex items-center justify-between">
                                <span className="text-[13px] font-bold text-ghost-text-secondary uppercase tracking-wider">Version History</span>
                                <span className="text-[11px] text-ghost-text-muted">{versions.length} snapshot{versions.length !== 1 ? 's' : ''}</span>
                              </div>
                              <div className="max-h-48 overflow-y-auto">
                                {versions.length === 0 ? (
                                  <div className="px-4 py-4 text-center text-[12px] text-ghost-text-muted italic">
                                    No snapshots yet — changes will be saved automatically
                                  </div>
                                ) : versions.map((v: any) => (
                                  <div key={v.id} className="flex items-center gap-3 px-4 py-2 border-b border-ghost-border/20 hover:bg-ghost-surface-light/30 transition-colors group">
                                    <div className="shrink-0">
                                      <Avatar
                                        name={v.createdByName || 'Unknown'}
                                        src={members.find((m: any) => m.userId === v.createdBy)?.avatarUrl || (v.createdBy === user?.id ? user?.avatarUrl : null)}
                                        size="sm"
                                      />
                                    </div>
                                    <div className="flex-1 min-w-0">
                                      <p className="text-[13px] text-ghost-text-primary font-medium truncate">{v.name}</p>
                                      <div className="flex items-center gap-2 mt-0.5">
                                        <span className="text-[11px] text-ghost-text-muted">{v.createdByName || 'Unknown'}</span>
                                        <span className="text-[11px] text-ghost-green font-medium">
                                          {new Date(v.createdAt).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })}
                                        </span>
                                      </div>
                                    </div>
                                    <span className="text-[11px] font-mono text-ghost-purple bg-ghost-purple/10 px-2 py-0.5 rounded shrink-0">V{v.versionNumber}</span>
                                    {(v.snapshotJson || v.snapshot) && (
                                      <button
                                        onClick={() => handleRevert(v.id)}
                                        disabled={reverting}
                                        className="opacity-0 group-hover:opacity-100 text-[11px] font-semibold px-2 py-1 bg-ghost-surface-light border border-ghost-border rounded text-ghost-text-secondary hover:text-white hover:border-ghost-purple transition-all shrink-0"
                                      >
                                        {reverting ? '...' : 'Revert'}
                                      </button>
                                    )}
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}

                          {(() => {
                            const local = webrtc.localScreenStream;
                            const remoteFirst = Array.from(webrtc.remoteScreenStreams.entries())[0];
                            if (local) {
                              return (
                                <ScreenShareView
                                  stream={local}
                                  sharerName="You"
                                  isLocal
                                  onStop={() => webrtc.stopScreen()}
                                />
                              );
                            }
                            if (remoteFirst) {
                              const [sharerId, stream] = remoteFirst;
                              const m = members.find((mm: any) => mm.userId === sharerId);
                              return (
                                <ScreenShareView
                                  stream={stream}
                                  sharerName={m?.displayName || 'A collaborator'}
                                  isLocal={false}
                                />
                              );
                            }
                            return null;
                          })()}

                          <CollaboratorsBar
                            members={members}
                            onlineUsers={onlineUsers}
                            onInvite={() => setShowInvite(!showInvite)}
                          />

                          <ArrangementDropZone projectId={selectedProjectId!} onFilesAdded={() => fetchProject(selectedProjectId!)}>
                            <FullMixDropZone
                              projectId={selectedProjectId!}
                              onFilesAdded={() => fetchProject(selectedProjectId!)}
                              isBeat={isBeatView}
                              compact={trackZoom === 'half'}
                              rightSlot={(
                                <motion.button
                                  onClick={handleDownloadStems}
                                  className="w-[120px] h-11 rounded-full text-white text-[14px] font-semibold flex items-center justify-center gap-2 transition-all shadow-[0_2px_8px_rgba(0,0,0,0.3),inset_0_1px_0_rgba(255,255,255,0.15)] hover:shadow-[0_0_20px_rgba(124,58,237,0.4),0_2px_8px_rgba(0,0,0,0.3),inset_0_1px_0_rgba(255,255,255,0.2)] shrink-0"
                                  style={{ background: 'linear-gradient(180deg, #7C3AED 0%, #581C87 100%)' }}
                                  whileHover={{ scale: 1.05 }}
                                  whileTap={{ scale: 0.95 }}
                                >
                                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                                    <polyline points="7 10 12 15 17 10" />
                                    <line x1="12" y1="15" x2="12" y2="3" />
                                  </svg>
                                  Download
                                </motion.button>
                              )}
                            />
                            <div className="flex items-center gap-1 py-1 justify-end">
                              {/* Undo / Redo — wired to audioStore. canUndo /
                                  canRedo come from the same store so the
                                  buttons grey out when their stack is empty. */}
                              <UndoRedoButtons />
                              <span className="w-px h-4 bg-white/[0.08] mx-0.5" />
                              <button
                                onClick={() => setTrackZoom('half')}
                                className={`w-6 h-6 flex items-center justify-center rounded transition-colors ${trackZoom === 'half' ? 'text-ghost-green' : 'text-white/30 hover:text-white/60'}`}
                                title="Compact"
                              >
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                  <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                                  <line x1="8" y1="11" x2="14" y2="11" />
                                </svg>
                              </button>
                              <button
                                onClick={() => setTrackZoom('full')}
                                className={`w-6 h-6 flex items-center justify-center rounded transition-colors ${trackZoom === 'full' ? 'text-ghost-green' : 'text-white/30 hover:text-white/60'}`}
                                title="Full Height"
                              >
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                  <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                                  <line x1="11" y1="8" x2="11" y2="14" /><line x1="8" y1="11" x2="14" y2="11" />
                                </svg>
                              </button>
                              <GridSnapPicker />
                              <button
                                onClick={() => setShowAllBars((v) => !v)}
                                className={`w-6 h-6 flex items-center justify-center rounded transition-colors ${showAllBars ? 'text-ghost-green' : 'text-white/30 hover:text-white/60'}`}
                                title={showAllBars ? 'Back to 8-bar view' : 'Fit whole arrangement'}
                              >
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                  <polyline points="4 8 2 12 4 16" />
                                  <polyline points="20 8 22 12 20 16" />
                                  <line x1="2" y1="12" x2="22" y2="12" />
                                </svg>
                              </button>
                            </div>
                            <ArrangementScrollView showAll={showAllBars}>
                              <BarRuler />
                              <DraggableTrackList
                                tracks={currentProject.tracks}
                                selectedProjectId={selectedProjectId!}
                                deleteTrack={deleteTrack}
                                updateTrack={updateTrack}
                                trackZoom={trackZoom}
                                fetchProject={fetchProject}
                                members={members}
                              />
                              <MasterBusLane trackZoom={trackZoom} />
                              <MasterTrackLane trackZoom={trackZoom} />
                              <ArrangementPlayhead />
                              <ArrangementComments projectId={selectedProjectId!} />
                            </ArrangementScrollView>
                          </ArrangementDropZone>
                          <SampleEditorPanel projectId={selectedProjectId!} />
                          <DrumRackPanel projectId={selectedProjectId!} />
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Right panel (video + chat) */}
                  <div className={`relative flex flex-col self-stretch ${chatCollapsed ? 'w-5 shrink-0' : 'w-[280px] shrink-0'}`}>
                    <button
                      onClick={() => setChatCollapsed(!chatCollapsed)}
                      className="absolute left-0 top-1/2 -translate-y-1/2 z-10 w-5 h-10 flex items-center justify-center rounded-full glass hover:bg-white/[0.08] transition-colors"
                      title={chatCollapsed ? 'Show chat' : 'Hide chat'}
                    >
                      <svg width="8" height="12" viewBox="0 0 8 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-ghost-text-muted">
                        {chatCollapsed ? <polyline points="6,1 2,6 6,11" /> : <polyline points="2,1 6,6 2,11" />}
                      </svg>
                    </button>
                    <div className="flex flex-col min-h-0 h-full gap-1 flex-1">
                    {!chatCollapsed && (
                      <>
                        <div className="w-full shrink-0 flex items-center justify-evenly glass glass-glow rounded-2xl h-[50px]">
                          <button
                            onClick={() => setVideoGridHidden(!videoGridHidden)}
                            className={`transition-colors ${!videoGridHidden ? 'text-ghost-green' : 'text-white/40 hover:text-ghost-green'}`}
                            title={videoGridHidden ? 'Show Video Grid' : 'Hide Video Grid'}
                          >
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                              <circle cx="8.5" cy="7" r="4" /><line x1="20" y1="8" x2="20" y2="14" />
                              <line x1="23" y1="11" x2="17" y2="11" />
                            </svg>
                          </button>
                          <button
                            onClick={() => {
                              const opening = !showNotifs;
                              setShowNotifs(opening);
                              setShowSettings(false);
                              if (opening) notifs.markBellSeen();
                            }}
                            className="text-white/40 hover:text-ghost-green transition-colors"
                          >
                            <BellIcon count={notifs.bellUnreadCount} />
                          </button>
                          <button
                            onClick={() => {
                              const opening = !showInbox;
                              setShowInbox(opening);
                              setShowNotifs(false);
                              setShowSettings(false);
                              if (opening) notifs.markInboxSeen();
                            }}
                            className="text-white/40 hover:text-ghost-green transition-colors relative"
                            title="Inbox"
                          >
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
                              <path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
                            </svg>
                            {notifs.inboxUnreadCount > 0 && (
                              <span className="absolute -top-1.5 -right-1.5 w-4 h-4 bg-ghost-green text-black text-[9px] font-bold rounded-full flex items-center justify-center">
                                {notifs.inboxUnreadCount}
                              </span>
                            )}
                          </button>
                          <button
                            onClick={() => { setShowSettings(!showSettings); setShowNotifs(false); }}
                            className="shrink-0 rounded-full outline-none focus:outline-none"
                          >
                            <Avatar name={user?.displayName || '?'} src={user?.avatarUrl} size="sm" />
                          </button>
                        </div>
                        {!videoGridHidden && (
                          <div className="w-full shrink-0">
                            <VideoGrid members={members} userId={user?.id} webrtc={webrtc} />
                          </div>
                        )}
                        <div className="w-full flex flex-col min-h-0 flex-1 overflow-hidden glass glass-glow rounded-2xl">
                          <ChatPanel />
                        </div>
                      </>
                    )}
                    </div>
                  </div>
                </>
              ) : samplePackState.selectedPackId && samplePackState.selectedPack ? (
                <>
                  <SamplePackContentView
                    pack={samplePackState.selectedPack}
                    onRenamePack={samplePackState.renamePack}
                    onDeletePack={samplePackState.deletePack}
                    onRemoveSample={samplePackState.removeSample}
                    onRefresh={samplePackState.fetchDetail}
                    members={[]}
                    onInvite={() => setShowInvite(true)}
                  />
                  <div className={`relative flex flex-col self-stretch ${chatCollapsed ? 'w-5 shrink-0' : 'w-[280px] shrink-0'}`}>
                    <button
                      onClick={() => setChatCollapsed(!chatCollapsed)}
                      className="absolute left-0 top-1/2 -translate-y-1/2 z-10 w-5 h-10 flex items-center justify-center rounded-full glass hover:bg-white/[0.08] transition-colors"
                      title={chatCollapsed ? 'Show chat' : 'Hide chat'}
                    >
                      <svg width="8" height="12" viewBox="0 0 8 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-ghost-text-muted">
                        {chatCollapsed ? <polyline points="6,1 2,6 6,11" /> : <polyline points="2,1 6,6 2,11" />}
                      </svg>
                    </button>
                    <div className="flex flex-col min-h-0 h-full gap-2 flex-1">
                    {!chatCollapsed && (
                      <>
                        <div className="w-full shrink-0">
                          <VideoGrid members={members} userId={user?.id} webrtc={webrtc} />
                        </div>
                        <div className="w-full flex flex-col min-h-0 flex-1 overflow-hidden glass glass-glow rounded-2xl">
                          <ChatPanel />
                        </div>
                      </>
                    )}
                    </div>
                  </div>
                </>
              ) : showSocial ? (
                <SocialFeed
                  user={user}
                  friends={friends}
                  initialProfileUserId={pendingProfileUserId}
                  onProfileShown={() => setPendingProfileUserId(null)}
                />
              ) : showMessages ? (
                <MessagesView friends={friends} />
              ) : showMarketplace ? (
                <div className="flex-1 flex items-center justify-center">
                  <div className="text-center">
                    <div className="w-20 h-20 rounded-full bg-emerald-500/10 flex items-center justify-center mx-auto mb-5">
                      <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#10B981" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="9" cy="21" r="1" /><circle cx="20" cy="21" r="1" />
                        <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6" />
                      </svg>
                    </div>
                    <h2 className="text-2xl font-bold text-white mb-2">Marketplace</h2>
                    <p className="text-[15px] text-white/40">Coming Soon</p>
                    <p className="text-[13px] text-white/25 mt-2 max-w-xs mx-auto">
                      Buy and sell beats, samples, and presets with producers around the world.
                    </p>
                  </div>
                </div>
              ) : (
                <WelcomeHero
                  userName={user?.displayName}
                  hasProjects={projects.length > 0}
                  onCreateProject={handleCreate}
                  onCreateBeat={handleCreateBeat}
                  onExploreFeed={() => { setShowSocial(true); setSelectedProjectId(null); samplePackState.setSelectedPackId(null); }}
                />
              )}
            </div>
          </div>
        </div>
      </div>

      <FirstInviteNudge
        open={!!inviteNudgeProject}
        projectName={inviteNudgeProject?.name || ''}
        onInviteClick={acceptInviteNudge}
        onDismiss={dismissInviteNudge}
      />

      {/* Remote voice players. Hidden <audio> elements that always
          play remote camera/voice streams regardless of whether the
          floating VideoGrid panel is open — Discord-style: voice is
          always audible while you're in the session. */}
      <div style={{ position: 'absolute', width: 0, height: 0, overflow: 'hidden' }}>
        {Array.from(webrtc.remoteStreams.entries()).map(([uid, stream]) => (
          <RemoteVoicePlayer key={uid} stream={stream} />
        ))}
      </div>

      {/* Transport bar */}
      {selectedProjectId && currentProject && (
        <div className="absolute bottom-0 left-0 right-0 z-30">
          <TransportBar
            tracks={currentProject.tracks}
            projectId={selectedProjectId}
            projectTempo={currentProject.tempo}
            onTempoChange={(bpm) => updateProject(selectedProjectId, { tempo: bpm })}
            trackZoom={trackZoom}
            onZoomChange={setTrackZoom}
            vizMode={vizMode}
          />
        </div>
      )}
    </div>
  );
}
