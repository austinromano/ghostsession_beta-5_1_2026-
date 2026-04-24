import { Hono } from 'hono';
import { z } from 'zod';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db/index.js';
import { sampleLibraryFolders, sampleLibraryFiles, files, tracks } from '../db/schema.js';
import { eq, and, asc } from 'drizzle-orm';
import { authMiddleware, type AuthUser } from '../middleware/auth.js';
import { assertEditor } from '../lib/membership.js';
import { isR2Configured, uploadToR2, downloadFromR2, deleteFromR2 } from '../services/storage.js';
import { createReadStream } from 'node:fs';
import { mkdir, stat, unlink, copyFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { parseWavPeaks, setCachedPeaks } from '../lib/peaks.js';
import { analyseWav, type BpmAnalysis } from '../lib/bpm.js';

const UPLOADS_DIR = resolve(import.meta.dirname, '../../uploads');

const sampleLibraryRoutes = new Hono();
sampleLibraryRoutes.use('*', authMiddleware);

const createFolderSchema = z.object({ name: z.string().min(1).max(80) });

// GET / — list user's folders and files
sampleLibraryRoutes.get('/', async (c) => {
  const user = c.get('user') as AuthUser;
  const folders = await db.select().from(sampleLibraryFolders)
    .where(eq(sampleLibraryFolders.userId, user.id))
    .orderBy(asc(sampleLibraryFolders.name))
    .all();
  const rows = await db.select().from(sampleLibraryFiles)
    .where(eq(sampleLibraryFiles.userId, user.id))
    .orderBy(asc(sampleLibraryFiles.displayName))
    .all();
  // Strip the storage key (backend detail) and expand beats_json so the
  // client gets a real array to work with.
  const fileList = rows.map(({ s3Key, beatsJson, ...rest }) => ({
    ...rest,
    beats: beatsJson ? (() => { try { return JSON.parse(beatsJson); } catch { return null; } })() : null,
  }));
  return c.json({ success: true, data: { folders, files: fileList } });
});

// POST /folders — create a folder
sampleLibraryRoutes.post('/folders', async (c) => {
  const user = c.get('user') as AuthUser;
  const body = createFolderSchema.parse(await c.req.json());
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.insert(sampleLibraryFolders).values({
    id, userId: user.id, name: body.name, createdAt: now,
  }).run();
  return c.json({ success: true, data: { id, userId: user.id, name: body.name, createdAt: now } }, 201);
});

// DELETE /folders/:id — delete folder and every file inside it (cascades storage too)
sampleLibraryRoutes.delete('/folders/:id', async (c) => {
  const user = c.get('user') as AuthUser;
  const folderId = c.req.param('id');

  const [folder] = await db.select().from(sampleLibraryFolders)
    .where(eq(sampleLibraryFolders.id, folderId)).limit(1).all();
  if (!folder || folder.userId !== user.id) {
    throw new HTTPException(404, { message: 'Folder not found' });
  }

  // Find every file in this folder and remove the underlying storage first.
  const inFolder = await db.select().from(sampleLibraryFiles)
    .where(and(eq(sampleLibraryFiles.folderId, folderId), eq(sampleLibraryFiles.userId, user.id)))
    .all();
  for (const f of inFolder) {
    try {
      if (f.s3Key.startsWith('library/')) {
        if (isR2Configured()) await deleteFromR2(f.s3Key);
      } else {
        await unlink(f.s3Key).catch(() => {});
      }
    } catch { /* ignore */ }
  }
  await db.delete(sampleLibraryFiles).where(and(eq(sampleLibraryFiles.folderId, folderId), eq(sampleLibraryFiles.userId, user.id))).run();
  await db.delete(sampleLibraryFolders).where(eq(sampleLibraryFolders.id, folderId)).run();
  return c.json({ success: true });
});

// POST /upload — multipart upload; optional folderId form field
sampleLibraryRoutes.post('/upload', async (c) => {
  const user = c.get('user') as AuthUser;
  const formData = await c.req.formData();
  const file = formData.get('file') as File | null;
  const folderIdRaw = formData.get('folderId');
  const folderId = typeof folderIdRaw === 'string' && folderIdRaw.length > 0 ? folderIdRaw : null;
  if (!file) throw new HTTPException(400, { message: 'No file provided' });

  if (folderId) {
    const [folder] = await db.select().from(sampleLibraryFolders)
      .where(eq(sampleLibraryFolders.id, folderId)).limit(1).all();
    if (!folder || folder.userId !== user.id) {
      throw new HTTPException(404, { message: 'Folder not found' });
    }
  }

  const id = crypto.randomUUID();
  const buffer = Buffer.from(await file.arrayBuffer());
  const mimeType = file.type || 'audio/wav';
  let s3Key: string;
  if (isR2Configured()) {
    s3Key = `library/${user.id}/${id}/${file.name}`;
    await uploadToR2(s3Key, buffer, mimeType);
  } else {
    const dir = join(UPLOADS_DIR, 'library', user.id);
    await mkdir(dir, { recursive: true });
    s3Key = join(dir, `${id}_${file.name}`);
    const fsp = await import('node:fs/promises');
    await fsp.writeFile(s3Key, buffer);
  }

  let peaksJson: string | null = null;
  try {
    const parsed = parseWavPeaks(buffer, 1024);
    peaksJson = JSON.stringify(parsed);
    setCachedPeaks(`${id}:1024`, parsed);
  } catch { peaksJson = null; }

  // BPM + beat analysis. Only works on WAV today; silently skips other
  // formats — we'll add format coverage when time-stretching lands.
  let analysis: BpmAnalysis | null = null;
  try { analysis = analyseWav(buffer); } catch (err) { console.warn('[sample-library] bpm analysis failed:', err); }

  const now = new Date().toISOString();
  await db.insert(sampleLibraryFiles).values({
    id, userId: user.id, folderId,
    fileName: file.name, displayName: file.name,
    fileSize: file.size, mimeType, s3Key, peaks: peaksJson,
    detectedBpm: analysis?.bpm ?? null,
    bpmConfidence: analysis?.confidence ?? null,
    firstBeatOffset: analysis?.firstBeatOffset ?? null,
    beatsJson: analysis ? JSON.stringify(analysis.beats) : null,
    createdAt: now,
  }).run();

  return c.json({
    success: true,
    data: {
      id, userId: user.id, folderId,
      fileName: file.name, displayName: file.name,
      fileSize: file.size, mimeType, peaks: peaksJson,
      detectedBpm: analysis?.bpm ?? null,
      bpmConfidence: analysis?.confidence ?? null,
      firstBeatOffset: analysis?.firstBeatOffset ?? null,
      beats: analysis?.beats ?? null,
      createdAt: now,
    },
  }, 201);
});

// DELETE /files/:id
sampleLibraryRoutes.delete('/files/:id', async (c) => {
  const user = c.get('user') as AuthUser;
  const fileId = c.req.param('id');
  const [row] = await db.select().from(sampleLibraryFiles)
    .where(eq(sampleLibraryFiles.id, fileId)).limit(1).all();
  if (!row || row.userId !== user.id) throw new HTTPException(404, { message: 'File not found' });

  try {
    if (row.s3Key.startsWith('library/')) {
      if (isR2Configured()) await deleteFromR2(row.s3Key);
    } else {
      await unlink(row.s3Key).catch(() => {});
    }
  } catch { /* ignore */ }

  await db.delete(sampleLibraryFiles).where(eq(sampleLibraryFiles.id, fileId)).run();
  return c.json({ success: true });
});

// GET /files/:id/audio — stream the library file
sampleLibraryRoutes.get('/files/:id/audio', async (c) => {
  const user = c.get('user') as AuthUser;
  const fileId = c.req.param('id');
  const [row] = await db.select().from(sampleLibraryFiles)
    .where(eq(sampleLibraryFiles.id, fileId)).limit(1).all();
  if (!row || row.userId !== user.id) throw new HTTPException(404, { message: 'File not found' });

  const isS3Path = row.s3Key.startsWith('library/');
  if (isS3Path && isR2Configured()) {
    const { stream, contentLength, contentType } = await downloadFromR2(row.s3Key);
    return new Response(stream, {
      headers: {
        'Content-Type': contentType || row.mimeType || 'audio/wav',
        'Content-Disposition': `inline; filename="${row.fileName}"`,
        'Content-Length': contentLength.toString(),
        'Accept-Ranges': 'bytes',
      },
    });
  }
  // local disk
  const fileStat = await stat(row.s3Key);
  const stream = createReadStream(row.s3Key);
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    headers: {
      'Content-Type': row.mimeType || 'audio/wav',
      'Content-Disposition': `inline; filename="${row.fileName}"`,
      'Content-Length': fileStat.size.toString(),
      'Accept-Ranges': 'bytes',
    },
  });
});

// GET /files/:id/peaks — serve pre-computed peaks so waveforms render instantly
sampleLibraryRoutes.get('/files/:id/peaks', async (c) => {
  const user = c.get('user') as AuthUser;
  const fileId = c.req.param('id');
  const [row] = await db.select().from(sampleLibraryFiles)
    .where(eq(sampleLibraryFiles.id, fileId)).limit(1).all();
  if (!row || row.userId !== user.id) throw new HTTPException(404, { message: 'File not found' });
  if (!row.peaks) throw new HTTPException(404, { message: 'No peaks available' });
  return c.json({ success: true, data: JSON.parse(row.peaks) });
});

// POST /files/:id/copy-to-project/:projectId — duplicate a library file into a
// project: copies the underlying storage into the project's bucket, inserts a
// row into `files` scoped to the project, and creates the track so it appears
// in the arrangement immediately.
sampleLibraryRoutes.post('/files/:id/copy-to-project/:projectId', async (c) => {
  const user = c.get('user') as AuthUser;
  const fileId = c.req.param('id');
  const projectId = c.req.param('projectId');

  await assertEditor(projectId, user.id);

  const [src] = await db.select().from(sampleLibraryFiles)
    .where(eq(sampleLibraryFiles.id, fileId)).limit(1).all();
  if (!src || src.userId !== user.id) throw new HTTPException(404, { message: 'File not found' });

  const newFileId = crypto.randomUUID();
  let destKey: string;
  if (isR2Configured() && src.s3Key.startsWith('library/')) {
    // Read from R2, write to project-scoped R2 key.
    const { stream } = await downloadFromR2(src.s3Key);
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    destKey = `projects/${projectId}/${newFileId}/${src.fileName}`;
    await uploadToR2(destKey, buf, src.mimeType);
  } else {
    // Local disk copy.
    const projectDir = join(UPLOADS_DIR, projectId);
    await mkdir(projectDir, { recursive: true });
    destKey = join(projectDir, `${newFileId}_${src.fileName}`);
    await copyFile(src.s3Key, destKey);
  }

  await db.insert(files).values({
    id: newFileId, projectId, uploadedBy: user.id,
    fileName: src.fileName, fileSize: src.fileSize, mimeType: src.mimeType,
    s3Key: destKey, peaks: src.peaks,
    // Carry the library's analysis across — saves re-running on copy.
    detectedBpm: src.detectedBpm, bpmConfidence: src.bpmConfidence,
    firstBeatOffset: src.firstBeatOffset, beatsJson: src.beatsJson,
    createdAt: new Date().toISOString(),
  }).run();

  // Create the track row so the arrangement renders it right away.
  const trackId = crypto.randomUUID();
  await db.insert(tracks).values({
    id: trackId, projectId, ownerId: user.id, name: src.displayName,
    type: 'fullmix', fileId: newFileId, fileName: src.fileName,
    createdAt: new Date().toISOString(),
  }).run();

  return c.json({ success: true, data: { trackId, fileId: newFileId } }, 201);
});

export default sampleLibraryRoutes;
