import { useCallback, useEffect, useState } from 'react';
import type { Comment } from '@ghost/types';
import { api } from '../lib/api';
import { getSocket } from '../lib/socket';
import { devWarn } from '../lib/log';

// Timeline-positioned comment threads. The server already supports
// `positionBeats` and `parentId` on the comments table — this hook is the
// client-side glue. Subscribes to the project room's comment-added /
// -updated / -deleted socket events so collaborators see new pins land
// in real time.

export interface ArrangementComment extends Comment {}

export function useArrangementComments(projectId: string | null) {
  const [comments, setComments] = useState<ArrangementComment[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchAll = useCallback(async () => {
    if (!projectId) { setComments([]); return; }
    try {
      setLoading(true);
      const data = await api.listComments(projectId);
      setComments(data || []);
    } catch (err) { devWarn('useArrangementComments.fetchAll', err); }
    finally { setLoading(false); }
  }, [projectId]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // Live sync — listen for comment events on the project's socket room.
  // The session store joins/leaves the room separately; this just attaches
  // listeners while the hook is mounted.
  useEffect(() => {
    if (!projectId) return;
    const socket = getSocket();
    if (!socket) return;

    // Protocol declares `comment` as `unknown` (it's serialised on the wire);
    // cast at the boundary so the rest of the handler is well-typed.
    const onAdded = (payload: { projectId: string; comment: unknown }) => {
      if (payload.projectId !== projectId) return;
      const c = payload.comment as ArrangementComment;
      setComments((prev) => prev.some((x) => x.id === c.id) ? prev : [c, ...prev]);
    };
    const onUpdated = (payload: { projectId: string; comment: unknown }) => {
      if (payload.projectId !== projectId) return;
      const c = payload.comment as ArrangementComment;
      setComments((prev) => prev.map((x) => (x.id === c.id ? { ...x, ...c } : x)));
    };
    const onDeleted = (payload: { projectId: string; commentId: string }) => {
      if (payload.projectId !== projectId) return;
      // Cascade-delete replies whose parentId matches the removed comment.
      setComments((prev) => prev.filter((x) => x.id !== payload.commentId && x.parentId !== payload.commentId));
    };

    socket.on('comment-added', onAdded);
    socket.on('comment-updated', onUpdated);
    socket.on('comment-deleted', onDeleted);
    return () => {
      socket.off('comment-added', onAdded);
      socket.off('comment-updated', onUpdated);
      socket.off('comment-deleted', onDeleted);
    };
  }, [projectId]);

  const addComment = useCallback(async (text: string, positionBeats: number, parentId?: string) => {
    if (!projectId) return null;
    try {
      const created = await api.addComment(projectId, { text, positionBeats, parentId });
      // Optimistic insert — the socket event will dedupe on id.
      setComments((prev) => prev.some((c) => c.id === created.id) ? prev : [created, ...prev]);
      return created;
    } catch (err) { devWarn('useArrangementComments.addComment', err); return null; }
  }, [projectId]);

  const deleteComment = useCallback(async (commentId: string) => {
    if (!projectId) return;
    try {
      await api.deleteComment(projectId, commentId);
      setComments((prev) => prev.filter((c) => c.id !== commentId && c.parentId !== commentId));
    } catch (err) { devWarn('useArrangementComments.deleteComment', err); }
  }, [projectId]);

  return { comments, loading, fetchAll, addComment, deleteComment };
}
