import { useState, useEffect, useRef } from 'react';
import { Reorder } from 'framer-motion';
import type { SamplePack } from '@ghost/types';
import { api } from '../../lib/api';
import { useAudioStore } from '../../stores/audioStore';

export type { SamplePack };

function MiniWaveform({ name }: { name: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    let seed = 0;
    for (let i = 0; i < name.length; i++) seed = ((seed << 5) - seed + name.charCodeAt(i)) | 0;
    for (let x = 0; x < w; x++) {
      seed = (seed * 16807 + 12345) & 0x7fffffff;
      const amp = (seed % 100) / 100;
      const barH = amp * h * 0.8;
      ctx.fillStyle = `rgba(124, 58, 237, ${0.3 + amp * 0.4})`;
      ctx.fillRect(x, (h - barH) / 2, 1, barH);
    }
  }, [name]);
  return <canvas ref={canvasRef} width={36} height={18} className="shrink-0 rounded-sm" style={{ background: 'rgba(10,4,18,0.8)' }} />;
}

function LoopDropBox() {
  const [dragOver, setDragOver] = useState(false);
  const [loops, setLoops] = useState<{ name: string; fileId?: string; data: Float32Array | null }[]>([]);
  const [packId, setPackId] = useState<string | null>(null);

  // Load loops from server on mount
  useEffect(() => {
    (async () => {
      try {
        const packs = await api.listSamplePacks();
        let pack = packs.find((p: any) => p.name === 'My Loops');
        if (pack) {
          setPackId(pack.id);
          const detail = await api.getSamplePack(pack.id);
          if (detail.items) {
            setLoops(detail.items.map((item: any) => ({ name: item.name, fileId: item.fileId, data: null })));
          }
        }
      } catch (err) { if (import.meta.env.DEV) console.warn('[ProjectListSidebar] loop-pack load failed:', err); }
    })();
  }, []);

  const getOrCreatePack = async () => {
    if (packId) return packId;
    try {
      const packs = await api.listSamplePacks();
      let pack = packs.find((p: any) => p.name === 'My Loops');
      if (!pack) {
        pack = await api.createSamplePack({ name: 'My Loops' });
      }
      setPackId(pack.id);
      return pack.id;
    } catch { return null; }
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files).filter((f) =>
      f.type.startsWith('audio/') || f.name.match(/\.(wav|mp3|flac|aiff|ogg|m4a|aac)$/i)
    );
    for (const file of files) {
      const loopName = file.name.replace(/\.[^.]+$/, '');
      try {
        // Get or create the pack
        const pid = await getOrCreatePack();
        if (!pid) continue;
        // Upload the file
        const { fileId } = await api.uploadFile(pid, file);
        // Add to sample pack
        await api.addSamplePackItem(pid, { name: loopName, fileId });
        // Decode for waveform
        const arrayBuffer = await file.arrayBuffer();
        const audioCtx = new AudioContext();
        const buffer = await audioCtx.decodeAudioData(arrayBuffer);
        const data = buffer.getChannelData(0);
        audioCtx.close();
        setLoops(prev => [...prev, { name: loopName, fileId, data }]);
      } catch (err) {
        console.error('Loop upload failed:', err);
        setLoops(prev => [...prev, { name: loopName, data: null }]);
      }
    }
  };

  return (
    <div className="mx-1 my-1.5">
      <div
        className={`relative rounded-lg overflow-hidden transition-all ${dragOver ? 'ring-1 ring-purple-400/50' : ''}`}
        style={{ border: '1px dashed rgba(124,58,237,0.3)', background: 'rgba(10,4,18,0.6)' }}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
      >
        <div className="absolute inset-0 opacity-20 pointer-events-none" style={{ background: 'linear-gradient(90deg, #00FFC8, #7C3AED, #EC4899, #F59E0B, #00B4D8, #00FFC8)', backgroundSize: '200% 100%', animation: 'shimmer 3s linear infinite' }} />
        <div className="relative flex items-center gap-2 px-3 py-2">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#7C3AED" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 opacity-60"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></svg>
          <span className="text-[11px] text-white/50 font-medium">Drag loops here</span>
        </div>
        <style>{`@keyframes shimmer { 0% { background-position: 0% 50%; } 100% { background-position: 200% 50%; } }`}</style>
      </div>
      {loops.length > 0 && (
        <div className="mt-1 space-y-0.5">
          {loops.map((loop, i) => (
            <LoopItemRow key={i} name={loop.name} data={loop.data} onRemove={() => setLoops(prev => prev.filter((_, idx) => idx !== i))} />
          ))}
        </div>
      )}
    </div>
  );
}

function LoopItemRow({ name, data, onRemove }: { name: string; data: Float32Array | null; onRemove: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    if (data) {
      const step = Math.max(1, Math.floor(data.length / w));
      for (let x = 0; x < w; x++) {
        let max = 0;
        for (let j = 0; j < step; j++) {
          const idx = x * step + j;
          if (idx < data.length) max = Math.max(max, Math.abs(data[idx]));
        }
        const barH = max * h * 0.9;
        ctx.fillStyle = `rgba(0, 255, 200, ${0.3 + max * 0.5})`;
        ctx.fillRect(x, (h - barH) / 2, 1, barH);
      }
    } else {
      // Fallback: random waveform from name
      let seed = 0;
      for (let i = 0; i < name.length; i++) seed = ((seed << 5) - seed + name.charCodeAt(i)) | 0;
      for (let x = 0; x < w; x++) {
        seed = (seed * 16807 + 12345) & 0x7fffffff;
        const amp = (seed % 100) / 100;
        ctx.fillStyle = `rgba(0, 255, 200, ${0.2 + amp * 0.3})`;
        ctx.fillRect(x, (h - amp * h * 0.7) / 2, 1, amp * h * 0.7);
      }
    }
  }, [name, data]);

  return (
    <div
      className="group flex items-center gap-1.5 px-1.5 py-1 rounded-md hover:bg-white/[0.04] transition-colors cursor-grab active:cursor-grabbing"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', JSON.stringify({ type: 'loop', name }));
        e.dataTransfer.effectAllowed = 'copy';
      }}
    >
      <canvas ref={canvasRef} width={40} height={20} className="shrink-0 rounded-sm" style={{ background: 'rgba(10,4,18,0.6)', border: '1px solid rgba(255,255,255,0.06)' }} />
      <span className="text-[10px] text-white/60 truncate flex-1">{name}</span>
      <button onClick={onRemove} className="opacity-0 group-hover:opacity-100 text-white/30 hover:text-red-400 transition-all shrink-0">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
      </button>
    </div>
  );
}

function ProjectListSidebar({
  projects,
  allProjects,
  selectedId,
  onSelect,
  onCreate,
  onCreateBeat,
  samplePacks,
  selectedPackId,
  onSelectPack,
  onCreatePack,
  friends,
}: {
  projects: { id: string; name: string }[];
  allProjects: any[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onCreateBeat: () => void;
  samplePacks: SamplePack[];
  selectedPackId: string | null;
  onSelectPack: (id: string) => void;
  onCreatePack: () => void;
  friends: { id: string; displayName: string; avatarUrl: string | null }[];
}) {
  const favoritesOpen = true;
  const [projectsOpen, setProjectsOpen] = useState(true);
  const [packsOpen, setPacksOpen] = useState(false);
  const beatsOpen = true;
  const [sectionOrder, setSectionOrder] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem('ghost_sidebar_order');
      if (saved) return JSON.parse(saved);
    } catch {}
    return ['collabs', 'projects', 'favorites', 'samples'];
  });
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem('ghost_favorites') || '[]')); } catch { return new Set(); }
  });
  const [projectOrder, setProjectOrder] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem('ghost_project_order');
      if (saved) return JSON.parse(saved);
    } catch {}
    return [];
  });
  const sortByOrder = (items: any[]) => {
    const indexOf = (id: string) => {
      const i = projectOrder.indexOf(id);
      return i === -1 ? Number.MAX_SAFE_INTEGER : i;
    };
    return [...items].sort((a, b) => indexOf(a.id) - indexOf(b.id));
  };
  const toggleFavorite = (id: string) => {
    setFavoriteIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      localStorage.setItem('ghost_favorites', JSON.stringify([...next]));
      return next;
    });
  };

  return (
    <div className="flex flex-col h-full">

      <Reorder.Group axis="y" values={sectionOrder} onReorder={(newOrder) => { setSectionOrder(newOrder); localStorage.setItem('ghost_sidebar_order', JSON.stringify(newOrder)); }} className="flex-1 overflow-y-auto min-h-0" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {sectionOrder.map((sectionKey) => {
          if (sectionKey === 'collabs') return null;
          if (sectionKey === 'projects') return (
        <Reorder.Item key="projects" value="projects" style={{ listStyle: 'none' }} className="cursor-grab active:cursor-grabbing" whileDrag={{ scale: 1.02, zIndex: 50, boxShadow: '0 4px 20px rgba(0,0,0,0.4)' }}>
        {/* My Beats dropdown */}
        <div>
          <div className="px-3 pt-4 pb-1.5 flex items-center justify-between cursor-grab active:cursor-grabbing">
            <span className="text-[11px] font-semibold text-white/40 uppercase tracking-[0.12em]">
              Projects
            </span>
          </div>
          {beatsOpen && (
            <div className="px-2 pb-1.5 space-y-0.5">
              <button onClick={onCreateBeat} className="w-full flex items-center gap-2 px-2 py-1.5 text-[13px] text-purple-400 hover:text-purple-300 hover:bg-white/[0.04] rounded-md transition-colors">
                <span className="text-[15px]">+</span> New Projects
              </button>
              {(() => {
                const beats = sortByOrder(allProjects.filter((p: any) => p.projectType === 'beat'));
                const ids = beats.map((p: any) => p.id);
                return (
                  <Reorder.Group
                    axis="y"
                    values={ids}
                    onReorder={(newIds) => {
                      setProjectOrder(newIds);
                      localStorage.setItem('ghost_project_order', JSON.stringify(newIds));
                    }}
                    style={{ listStyle: 'none', padding: 0, margin: 0 }}
                  >
                    {beats.map((p: any) => (
                      <Reorder.Item
                        key={p.id}
                        value={p.id}
                        style={{ listStyle: 'none' }}
                        whileDrag={{ scale: 1.02, zIndex: 50, boxShadow: '0 4px 20px rgba(0,0,0,0.4)' }}
                        onClick={() => onSelect(p.id)}
                        className={`flex items-center w-full px-2 py-1.5 text-[13px] rounded-md transition-colors cursor-grab active:cursor-grabbing ${
                          selectedId === p.id && !selectedPackId
                            ? 'bg-white/[0.08] text-white font-medium'
                            : 'text-ghost-text-muted font-normal hover:bg-white/[0.04] hover:text-ghost-text-secondary'
                        }`}
                      >
                        <span className="flex items-center gap-2 flex-1 min-w-0">
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-ghost-green shrink-0">
                            <polygon points="5 3 19 12 5 21 5 3" />
                          </svg>
                          <span className="truncate">{p.name}</span>
                        </span>
                        <button
                          onClick={(e) => { e.stopPropagation(); toggleFavorite(p.id); }}
                          onPointerDown={(e) => e.stopPropagation()}
                          className="text-yellow-400 transition-colors hover:text-yellow-300 shrink-0 ml-2"
                          title={favoriteIds.has(p.id) ? 'Remove from favorites' : 'Add to favorites'}
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill={favoriteIds.has(p.id) ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2.5">
                            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                          </svg>
                        </button>
                      </Reorder.Item>
                    ))}
                  </Reorder.Group>
                );
              })()}
              {allProjects.filter((p: any) => p.projectType === 'beat').length === 0 && (
                <p className="px-2 py-1.5 text-[13px] text-ghost-text-muted italic">No beats yet</p>
              )}
            </div>
          )}
        </div>
        </Reorder.Item>
          );
          if (sectionKey === 'favorites') return (
        <Reorder.Item key="favorites" value="favorites" style={{ listStyle: 'none' }} className="cursor-grab active:cursor-grabbing" whileDrag={{ scale: 1.02, zIndex: 50, boxShadow: '0 4px 20px rgba(0,0,0,0.4)' }}>
        {/* Favorites dropdown */}
        <div>
          <div className="px-3 pt-4 pb-1.5 flex items-center justify-between cursor-grab active:cursor-grabbing">
            <span className="text-[11px] font-semibold text-white/40 uppercase tracking-[0.12em]">
              Favorites
            </span>
          </div>
          {favoritesOpen && (
            <div className="px-2 pb-1.5 space-y-0.5">
              {allProjects.filter((p: any) => favoriteIds.has(p.id)).map((p: any) => (
                <button
                  key={p.id}
                  onClick={() => onSelect(p.id)}
                  className={`w-full text-left px-2 py-1.5 text-[13px] rounded-md transition-colors ${
                    selectedId === p.id && !selectedPackId
                      ? 'bg-white/[0.08] text-white font-medium'
                      : 'text-ghost-text-muted font-normal hover:bg-white/[0.04] hover:text-ghost-text-secondary'
                  }`}
                >
                  <span className="flex items-center gap-2">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-ghost-green shrink-0">
                      <polygon points="5 3 19 12 5 21 5 3" />
                    </svg>
                    {p.name}
                  </span>
                </button>
              ))}
              {samplePacks.filter((sp) => favoriteIds.has(sp.id)).map((sp) => (
                <button
                  key={sp.id}
                  onClick={() => onSelectPack(sp.id)}
                  className={`w-full text-left px-2 py-1.5 text-[13px] rounded-md transition-colors ${
                    selectedPackId === sp.id
                      ? 'bg-white/[0.08] text-white font-medium'
                      : 'text-ghost-text-muted font-normal hover:bg-white/[0.04] hover:text-ghost-text-secondary'
                  }`}
                >
                  <span className="flex items-center gap-2">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-ghost-purple">
                      <path d="M9 18V5l12-2v13" />
                      <circle cx="6" cy="18" r="3" />
                      <circle cx="18" cy="16" r="3" />
                    </svg>
                    {sp.name}
                  </span>
                </button>
              ))}
              {projects.filter((p) => favoriteIds.has(p.id)).length === 0 && samplePacks.filter((sp) => favoriteIds.has(sp.id)).length === 0 && (
                <p className="px-2 py-1.5 text-[13px] text-ghost-text-muted italic">No favorites yet</p>
              )}
            </div>
          )}
        </div>
        </Reorder.Item>
          );
          if (sectionKey === 'samples') return null;
          return null;
        })}

        {/* Friends */}
      </Reorder.Group>

      {/* Storage usage */}
      <StorageBar />
    </div>
  );
}

function StorageBar() {
  const loadedTracks = useAudioStore((s) => s.loadedTracks);
  const limit = 2 * 1024 * 1024 * 1024; // 2 GB

  // Calculate usage from loaded audio buffers
  let used = 0;
  loadedTracks.forEach((track) => {
    if (track.buffer) {
      // AudioBuffer size = channels * length * 4 bytes per float32 sample
      used += track.buffer.numberOfChannels * track.buffer.length * 4;
    }
  });

  const usedGB = used / (1024 * 1024 * 1024);
  const limitGB = limit / (1024 * 1024 * 1024);
  const pct = limit > 0 ? Math.min((used / limit) * 100, 100) : 0;
  const isWarning = pct > 80;
  const isCritical = pct > 95;

  return (
    <div className="shrink-0 px-3 py-3 border-t border-white/[0.06]">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[12px] text-white/50 font-medium">
          {usedGB.toFixed(2)} GB of {limitGB} GB used
        </span>
      </div>
      <div className="h-1.5 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.06)' }}>
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{
            width: `${pct}%`,
            background: isCritical
              ? 'linear-gradient(90deg, #ED4245, #FF6B6B)'
              : isWarning
                ? 'linear-gradient(90deg, #F0B232, #ED4245)'
                : 'linear-gradient(90deg, #7C3AED, #00FFC8)',
            boxShadow: isCritical
              ? '0 0 8px rgba(237,66,69,0.4)'
              : '0 0 8px rgba(124,58,237,0.3)',
          }}
        />
      </div>
      {pct > 80 && (
        <p className="text-[9px] text-ghost-warning-amber mt-1">Storage almost full — upgrade for more space</p>
      )}
    </div>
  );
}

export default ProjectListSidebar;
