import { useMemo, useRef, useState } from 'react';
import { useSampleLibrary } from '../../hooks/useSampleLibrary';
import type { SampleLibraryFile, SampleLibraryFolder } from '../../lib/api';
import { devWarn } from '../../lib/log';

// MIME used when a library file is dragged into the arrangement. The drop
// handler in ArrangementComponents looks for this and calls the copy-to-
// project endpoint so the file shows up as a track without a re-upload.
export const SAMPLE_LIBRARY_DRAG_MIME = 'application/x-ghost-sample-library';

export default function SampleLibrarySection() {
  const { folders, files, createFolder, deleteFolder, uploadFile, deleteFile } = useSampleLibrary();
  const [open, setOpen] = useState(false);
  const [expandedFolder, setExpandedFolder] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [rootDragOver, setRootDragOver] = useState(false);
  const [dragFolderId, setDragFolderId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const rootFiles = useMemo(() => files.filter((f) => !f.folderId), [files]);
  const byFolder = useMemo(() => {
    const m = new Map<string, SampleLibraryFile[]>();
    for (const f of files) {
      if (!f.folderId) continue;
      if (!m.has(f.folderId)) m.set(f.folderId, []);
      m.get(f.folderId)!.push(f);
    }
    return m;
  }, [files]);

  const isAudio = (f: File) => {
    if (f.type.startsWith('audio/')) return true;
    return /\.(wav|mp3|flac|aiff|ogg|m4a|aac)$/i.test(f.name);
  };

  // Recursively collect audio files under a directory entry.
  const collectFilesInDirectory = async (dirEntry: any): Promise<File[]> => {
    const out: File[] = [];
    const reader = dirEntry.createReader();
    const readBatch = () => new Promise<any[]>((resolve) => reader.readEntries((entries: any[]) => resolve(entries)));
    let batch: any[] = [];
    do {
      batch = await readBatch();
      for (const e of batch) {
        if (e.isFile) {
          await new Promise<void>((resolve) => {
            e.file((file: File) => { if (isAudio(file)) out.push(file); resolve(); });
          });
        } else if (e.isDirectory) {
          const sub = await collectFilesInDirectory(e);
          out.push(...sub);
        }
      }
    } while (batch.length > 0);
    return out;
  };

  // Walk the drop. If a target folder is given, every audio file lands there
  // (flattened). If dropping onto root, each top-level directory in the drop
  // becomes (or reuses) a matching library folder and its audio files go
  // inside it. Loose files at the root of the drop land at library root.
  const processDrop = async (
    items: DataTransferItemList | null,
    fallbackFiles: FileList | null,
    targetFolderId: string | null,
  ): Promise<{ folderId: string | null; file: File }[]> => {
    const results: { folderId: string | null; file: File }[] = [];
    // Folders we create mid-drop so a drop with multiple same-named roots
    // doesn't double-create.
    const justCreated = new Map<string, string>();

    const resolveFolderId = async (name: string): Promise<string | null> => {
      if (justCreated.has(name)) return justCreated.get(name)!;
      const existing = folders.find((f) => f.name === name);
      if (existing) return existing.id;
      const created = await createFolder(name);
      if (created) {
        justCreated.set(name, created.id);
        return created.id;
      }
      return null;
    };

    if (items && items.length > 0 && typeof (items[0] as any).webkitGetAsEntry === 'function') {
      // Snapshot entries first — DataTransferItemList is invalidated after
      // the handler returns, and our awaits push it past that boundary.
      const entries: any[] = [];
      for (let i = 0; i < items.length; i++) {
        const entry = (items[i] as any).webkitGetAsEntry?.();
        if (entry) entries.push(entry);
      }
      for (const entry of entries) {
        if (entry.isFile) {
          await new Promise<void>((resolve) => {
            entry.file((file: File) => {
              if (isAudio(file)) results.push({ folderId: targetFolderId, file });
              resolve();
            });
          });
        } else if (entry.isDirectory) {
          // Dropping onto an existing folder flattens; dropping onto root
          // makes the directory become a new library folder.
          const destFolderId = targetFolderId ?? await resolveFolderId(entry.name);
          const inside = await collectFilesInDirectory(entry);
          for (const f of inside) results.push({ folderId: destFolderId, file: f });
        }
      }
    } else if (fallbackFiles) {
      for (const f of Array.from(fallbackFiles)) {
        if (isAudio(f)) results.push({ folderId: targetFolderId, file: f });
      }
    }
    return results;
  };

  const handleDropOnto = async (e: React.DragEvent, folderId: string | null) => {
    e.preventDefault();
    e.stopPropagation();
    setRootDragOver(false);
    setDragFolderId(null);
    const items = e.dataTransfer.items;
    const files = e.dataTransfer.files;
    setUploading(true);
    const list = await processDrop(items, files, folderId);
    for (const { folderId: destId, file } of list) {
      await uploadFile(file, destId);
    }
    setUploading(false);
  };

  const handlePickFiles = async (fileList: FileList | null) => {
    if (!fileList) return;
    const list = Array.from(fileList).filter(isAudio);
    if (list.length === 0) return;
    setUploading(true);
    for (const f of list) await uploadFile(f, null);
    setUploading(false);
  };

  const newFolderPrompt = async () => {
    const name = window.prompt('New folder name:');
    if (!name || !name.trim()) return;
    await createFolder(name.trim());
  };

  const confirmDeleteFolder = async (folder: SampleLibraryFolder) => {
    const items = byFolder.get(folder.id)?.length ?? 0;
    const msg = items > 0
      ? `Delete "${folder.name}" and its ${items} file${items === 1 ? '' : 's'}?`
      : `Delete "${folder.name}"?`;
    if (!window.confirm(msg)) return;
    await deleteFolder(folder.id);
  };

  const confirmDeleteFile = async (f: SampleLibraryFile) => {
    if (!window.confirm(`Delete "${f.displayName}"?`)) return;
    await deleteFile(f.id);
  };

  const clearAll = async () => {
    const total = files.length;
    const folderCount = folders.length;
    if (total === 0 && folderCount === 0) return;
    if (!window.confirm(`Delete everything in your Sample Library? This removes ${total} file${total === 1 ? '' : 's'} and ${folderCount} folder${folderCount === 1 ? '' : 's'}.`)) return;
    setUploading(true);
    // Delete root-level files first, then folders (their delete endpoint
    // cascades the files inside).
    for (const f of files.filter((f) => !f.folderId)) await deleteFile(f.id);
    for (const folder of folders) await deleteFolder(folder.id);
    setUploading(false);
  };

  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        className="group w-full flex items-center gap-2 px-3 pt-4 pb-2 cursor-grab active:cursor-grabbing select-none"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-ghost-green shrink-0">
          <path d="M3 7h18M3 12h18M3 17h18" />
          <path d="M3 7l3-3h5l2 2h8v14H3z" />
        </svg>
        <span className="text-[14px] font-bold text-white tracking-tight">Sample Library</span>
        <span className="ml-auto text-[11px] font-semibold text-white/30 tabular-nums">{files.length}</span>
      </button>

      {open && (
        <div className="px-2 pb-2 space-y-1">
          {/* Root drop zone + controls */}
          <div
            onDragOver={(e) => { e.preventDefault(); setRootDragOver(true); }}
            onDragLeave={() => setRootDragOver(false)}
            onDrop={(e) => handleDropOnto(e, null)}
            className={`rounded-md border border-dashed px-2 py-2 text-[11px] flex items-center justify-between gap-2 transition-colors ${rootDragOver ? 'border-ghost-green bg-ghost-green/10 text-ghost-green' : 'border-white/10 text-white/40'}`}
          >
            <span className="truncate">{uploading ? 'Uploading…' : 'Drop audio or folders here'}</span>
            <span className="flex items-center gap-1 shrink-0">
              <button
                title="Upload files"
                onClick={(e) => { e.stopPropagation(); inputRef.current?.click(); }}
                className="px-1.5 py-0.5 rounded hover:bg-white/[0.08] text-white/50 hover:text-white"
              >
                ↑
              </button>
              <button
                title="New folder"
                onClick={(e) => { e.stopPropagation(); newFolderPrompt(); }}
                className="px-1.5 py-0.5 rounded hover:bg-white/[0.08] text-white/50 hover:text-white"
              >
                +
              </button>
              {(folders.length > 0 || files.length > 0) && (
                <button
                  title="Clear all samples"
                  onClick={(e) => { e.stopPropagation(); clearAll(); }}
                  className="px-1.5 py-0.5 rounded hover:bg-red-500/20 text-white/40 hover:text-red-300"
                >
                  🗑
                </button>
              )}
            </span>
            <input
              ref={inputRef}
              type="file"
              multiple
              accept="audio/*,.wav,.mp3,.flac,.aiff,.ogg,.m4a,.aac"
              style={{ display: 'none' }}
              onChange={(e) => { handlePickFiles(e.target.files); e.target.value = ''; }}
            />
          </div>

          {/* Folders */}
          {folders.map((folder) => {
            const inside = byFolder.get(folder.id) || [];
            const isExpanded = expandedFolder === folder.id;
            const isDropTarget = dragFolderId === folder.id;
            return (
              <div key={folder.id}>
                <div
                  onDragOver={(e) => { e.preventDefault(); setDragFolderId(folder.id); }}
                  onDragLeave={() => setDragFolderId(null)}
                  onDrop={(e) => handleDropOnto(e, folder.id)}
                  className={`w-full flex items-center gap-2 px-2 py-1.5 text-[13px] rounded-md transition-colors ${isDropTarget ? 'bg-ghost-green/10 text-ghost-green' : 'text-ghost-text-muted hover:bg-white/[0.04] hover:text-ghost-text-secondary'}`}
                >
                  <button onClick={() => setExpandedFolder(isExpanded ? null : folder.id)} className="flex items-center gap-2 min-w-0 flex-1 text-left">
                    <span className="shrink-0 w-[14px] text-[11px] text-white/40">{isExpanded ? '▾' : '▸'}</span>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-ghost-green/70 shrink-0">
                      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                    </svg>
                    <span className="truncate">{folder.name}</span>
                  </button>
                  <span className="shrink-0 text-[10px] text-white/30 tabular-nums">{inside.length}</span>
                  <button
                    title="Delete folder"
                    onClick={(e) => { e.stopPropagation(); confirmDeleteFolder(folder); }}
                    className="shrink-0 px-1 text-white/30 hover:text-red-400"
                  >
                    ×
                  </button>
                </div>
                {isExpanded && inside.map((f) => <LibraryFileRow key={f.id} file={f} onDelete={() => confirmDeleteFile(f)} />)}
              </div>
            );
          })}

          {/* Root files */}
          {rootFiles.map((f) => <LibraryFileRow key={f.id} file={f} onDelete={() => confirmDeleteFile(f)} />)}

          {folders.length === 0 && rootFiles.length === 0 && (
            <div className="text-[11px] text-white/30 px-2 py-3 text-center italic">Empty — drop audio in to get started.</div>
          )}
        </div>
      )}
    </div>
  );
}

function LibraryFileRow({ file, onDelete }: { file: SampleLibraryFile; onDelete: () => void }) {
  const onDragStart = (e: React.DragEvent) => {
    try {
      const payload = JSON.stringify({ id: file.id, name: file.displayName });
      e.dataTransfer.setData(SAMPLE_LIBRARY_DRAG_MIME, payload);
      // Also set text/plain so a failed drop onto the OS shows the file name.
      e.dataTransfer.setData('text/plain', file.displayName);
      e.dataTransfer.effectAllowed = 'copy';
    } catch (err) { devWarn('LibraryFileRow.onDragStart', err); }
  };
  return (
    <div
      draggable
      onDragStart={onDragStart}
      className="group w-full flex items-center gap-2 pl-6 pr-2 py-1 text-[12px] rounded-md text-white/55 hover:bg-white/[0.04] hover:text-white cursor-grab active:cursor-grabbing select-none"
      title={`${file.displayName} — drag into the arrangement`}
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-ghost-green/60">
        <path d="M9 18V5l12-2v13" />
        <circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />
      </svg>
      <span className="truncate flex-1">{file.displayName}</span>
      <button
        title="Delete sample"
        onClick={(e) => { e.stopPropagation(); onDelete(); }}
        className="shrink-0 px-1 text-white/30 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"
      >
        ×
      </button>
    </div>
  );
}
