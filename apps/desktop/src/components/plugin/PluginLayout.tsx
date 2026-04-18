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
import { API_BASE } from '../../lib/constants';
import { devWarn } from '../../lib/log';

// Hooks
import { useNotifications } from '../../hooks/useNotifications';
import { useCursorTracking } from '../../hooks/useCursorTracking';
import { useSamplePacks } from '../../hooks/useSamplePacks';

// Extracted components
import ProjectListSidebar from '../layout/ProjectListSidebar';
import PresenceFriendsList from '../layout/PresenceFriendsList';
import SettingsPopup from '../common/SettingsPopup';
import NotificationPopup, { BellIcon } from '../common/NotificationPopup';
import InboxPopup from '../common/InboxPopup';
import InviteModal from '../common/InviteModal';
import VideoGrid from '../video/VideoGrid';
import FullMixDropZone from '../tracks/FullMixDropZone';
import SocialFeed from '../social/SocialFeed';
import TransportBar from '../audio/TransportBar';
import { ArrangementDropZone, ArrangementScrollView, BarRuler, ArrangementPlayhead, DraggableTrackList } from '../project/ArrangementComponents';
import SamplePackContentView from './SamplePackContentView';
import AddFriendPopover from './AddFriendPopover';
import ProjectHeaderBar from './ProjectHeaderBar';
import CollaboratorsBar from './CollaboratorsBar';
import WelcomeHero from '../onboarding/WelcomeHero';
import FirstInviteNudge from '../onboarding/FirstInviteNudge';

const INVITE_NUDGE_FLAG = 'ghost_shown_invite_nudge';

const VIZ_MODES = ['bars', 'wave', 'radial', 'ghost'] as const;

export default function PluginLayout() {
  const { user, logout } = useAuthStore();
  const { projects, currentProject, fetchProjects, fetchProject, createProject, updateProject, updateTrack, deleteTrack, versions, fetchVersions } = useProjectStore();
  const { join, leave, onlineUsers } = useSessionStore();

  // Domain hooks
  const notifs = useNotifications();
  const samplePackState = useSamplePacks();

  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [showSocial, setShowSocial] = useState(false);
  const [showMarketplace, setShowMarketplace] = useState(false);
  const [chatCollapsed, setChatCollapsed] = useState(false);
  const [videoGridHidden, setVideoGridHidden] = useState(true);
  const [shareStatus, setShareStatus] = useState('');
  const [showAllBars] = useState(false);
  const [vizModeIdx, setVizModeIdx] = useState(0);
  const vizMode = VIZ_MODES[vizModeIdx];
  const [isBeatView, setIsBeatView] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [trackZoom, setTrackZoom] = useState<'full' | 'half'>('full');
  const [onlineActivity, setOnlineActivity] = useState<Map<string, OnlineUser>>(new Map());
  const [showNotifs, setShowNotifs] = useState(false);
  const [showInbox, setShowInbox] = useState(false);
  const [showInvite, setShowInvite] = useState(false);
  const [friends, setFriends] = useState<{ id: string; displayName: string; avatarUrl: string | null }[]>([]);
  const [showVersionHistory, setShowVersionHistory] = useState(false);
  const [reverting, setReverting] = useState(false);
  const [inviteNudgeProject, setInviteNudgeProject] = useState<{ id: string; name: string } | null>(null);
  const cursorContainerRef = useRef<HTMLDivElement>(null);
  const currentProjectId = useSessionStore((s) => s.currentProjectId);
  useCursorTracking(cursorContainerRef, currentProjectId);

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
  useEffect(() => {
    if (!selectedProjectId) return;
    const pollTimer = setInterval(() => { fetchProject(selectedProjectId); }, 5000);
    const handleRefresh = () => { fetchProject(selectedProjectId); fetchProjects(); };
    window.addEventListener('ghost-refresh-project', handleRefresh);
    return () => { clearInterval(pollTimer); window.removeEventListener('ghost-refresh-project', handleRefresh); };
  }, [selectedProjectId]);

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
    if (selectedProjectId) { leave(); audioCleanup(); }
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
    if (selectedProjectId) { leave(); audioCleanup(); }
  };

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
          <div className={`relative flex flex-col self-stretch ${sidebarCollapsed ? 'w-4 shrink-0' : 'w-[210px] shrink-0 glass glass-glow rounded-2xl pt-2 px-2'}`}>
            <button
              onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
              className="absolute right-0 top-1/2 -translate-y-1/2 z-10 w-5 h-10 flex items-center justify-center rounded-full glass hover:bg-white/[0.08] transition-colors"
              title={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
            >
              <svg width="8" height="12" viewBox="0 0 8 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-ghost-text-muted">
                {sidebarCollapsed ? <polyline points="2,1 6,6 2,11" /> : <polyline points="6,1 2,6 6,11" />}
              </svg>
            </button>
            {!sidebarCollapsed && (
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
                />
              </div>
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

            <div className="flex-1 flex min-h-0 gap-2">
              {selectedProjectId && currentProject ? (
                <>
                  <div className="flex-1 flex flex-col min-w-0">
                    <ProjectHeaderBar
                      project={currentProject}
                      canDelete={currentProject.ownerId === user?.id}
                      onNameChange={(name) => updateProject(currentProject.id, { name })}
                      onTempoChange={(tempo) => updateProject(currentProject.id, { tempo })}
                      onKeyChange={(key) => updateProject(currentProject.id, { key })}
                      onTimeSignatureChange={(ts) => updateProject(currentProject.id, { timeSignature: ts } as any)}
                      onShowVersionHistory={() => { setShowVersionHistory((v) => !v); if (!showVersionHistory) fetchVersions(selectedProjectId); }}
                      onShareToFeed={handleShareProject}
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

                          <CollaboratorsBar
                            members={members}
                            onlineUsers={onlineUsers}
                            onInvite={() => setShowInvite(!showInvite)}
                          />

                          <div className="flex items-center gap-1 mb-3">
                            <button
                              onClick={handleDownloadStems}
                              className="flex items-center gap-2 px-5 py-2 rounded-lg text-[14px] font-bold tracking-wide transition-all hover:brightness-110 active:scale-[0.98]"
                              style={{ background: '#7C3AED', color: '#fff' }}
                            >
                              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                                <polyline points="7 10 12 15 17 10" />
                                <line x1="12" y1="15" x2="12" y2="3" />
                              </svg>
                              Download Stems
                            </button>
                            <div className="flex-1" />
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
                          </div>

                          <ArrangementDropZone projectId={selectedProjectId!} onFilesAdded={() => fetchProject(selectedProjectId!)}>
                            <ArrangementScrollView showAll={showAllBars}>
                              <BarRuler />
                              <FullMixDropZone projectId={selectedProjectId!} onFilesAdded={() => fetchProject(selectedProjectId!)} isBeat={isBeatView} compact={trackZoom === 'half'} />
                              <DraggableTrackList
                                tracks={currentProject.tracks}
                                selectedProjectId={selectedProjectId!}
                                deleteTrack={deleteTrack}
                                updateTrack={updateTrack}
                                trackZoom={trackZoom}
                                fetchProject={fetchProject}
                                members={members}
                              />
                              <ArrangementPlayhead />
                            </ArrangementScrollView>
                          </ArrangementDropZone>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Right panel (video + chat) */}
                  <div className={`relative flex flex-col min-h-0 h-full gap-1 shrink-0 ${chatCollapsed ? 'w-0 overflow-hidden' : 'w-[280px] overflow-hidden'}`}>
                    <button
                      onClick={() => setChatCollapsed(!chatCollapsed)}
                      className="absolute -left-5 top-1/2 -translate-y-1/2 z-10 w-5 h-10 flex items-center justify-center rounded-full glass hover:bg-white/[0.08] transition-colors"
                      title={chatCollapsed ? 'Show chat' : 'Hide chat'}
                    >
                      <svg width="8" height="12" viewBox="0 0 8 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-ghost-text-muted">
                        {chatCollapsed ? <polyline points="2,1 6,6 2,11" /> : <polyline points="6,1 2,6 6,11" />}
                      </svg>
                    </button>
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
                            <VideoGrid members={members} userId={user?.id} />
                          </div>
                        )}
                        <div className="w-full flex flex-col min-h-0 flex-1 overflow-hidden glass glass-glow rounded-2xl">
                          <ChatPanel />
                        </div>
                      </>
                    )}
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
                  <div className={`relative flex flex-col min-h-0 h-full gap-2 shrink-0 ${chatCollapsed ? 'w-0 overflow-hidden' : 'w-[280px] overflow-hidden'}`}>
                    <button
                      onClick={() => setChatCollapsed(!chatCollapsed)}
                      className="absolute -left-5 top-1/2 -translate-y-1/2 z-10 w-5 h-10 flex items-center justify-center rounded-full glass hover:bg-white/[0.08] transition-colors"
                      title={chatCollapsed ? 'Show chat' : 'Hide chat'}
                    >
                      <svg width="8" height="12" viewBox="0 0 8 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-ghost-text-muted">
                        {chatCollapsed ? <polyline points="2,1 6,6 2,11" /> : <polyline points="6,1 2,6 6,11" />}
                      </svg>
                    </button>
                    {!chatCollapsed && (
                      <>
                        <div className="w-full shrink-0">
                          <VideoGrid members={members} userId={user?.id} />
                        </div>
                        <div className="w-full flex flex-col min-h-0 flex-1 overflow-hidden glass glass-glow rounded-2xl">
                          <ChatPanel />
                        </div>
                      </>
                    )}
                  </div>
                </>
              ) : showSocial ? (
                <SocialFeed user={user} friends={friends} />
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
