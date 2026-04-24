import { Hono } from 'hono';
import { z } from 'zod';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db/index.js';
import { files } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { authMiddleware, type AuthUser } from '../middleware/auth.js';
import { assertMember, assertEditor } from '../lib/membership.js';
import { getUploadUrl, getDownloadUrl, isR2Configured, uploadToR2, downloadFromR2 } from '../services/storage.js';
import { createReadStream } from 'node:fs';
import { mkdir, stat, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { parseWavPeaks, getCachedPeaks, setCachedPeaks } from '../lib/peaks.js';
import { analyseWav } from '../lib/bpm.js';

const UPLOADS_DIR = resolve(import.meta.dirname, '../../uploads');

const fileRoutes = new Hono();
fileRoutes.use('*', authMiddleware);

const uploadUrlSchema = z.object({
  fileName: z.string().min(1),
  fileSize: z.number().positive(),
  mimeType: z.string().min(1),
});

fileRoutes.post('/upload-url', async (c) => {
  const user = c.get('user') as AuthUser;
  const projectId = c.req.param('id');
  const body = uploadUrlSchema.parse(await c.req.json());

  await assertEditor(projectId, user.id);

  const fileId = crypto.randomUUID();
  const s3Key = `projects/${projectId}/${fileId}/${body.fileName}`;

  await db.insert(files).values({
    id: fileId, projectId, uploadedBy: user.id,
    fileName: body.fileName, fileSize: body.fileSize, mimeType: body.mimeType,
    s3Key, createdAt: new Date().toISOString(),
  }).run();

  try {
    const url = await getUploadUrl(s3Key, body.mimeType);
    return c.json({ success: true, data: { fileId, uploadUrl: url } });
  } catch {
    return c.json({ success: true, data: { fileId, uploadUrl: null } });
  }
});

// Direct file upload (uploads to R2 if configured, otherwise local disk)
fileRoutes.post('/upload', async (c) => {
  const user = c.get('user') as AuthUser;
  const projectId = c.req.param('id');

  await assertEditor(projectId, user.id);

  const formData = await c.req.formData();
  const file = formData.get('file') as File | null;
  if (!file) throw new HTTPException(400, { message: 'No file provided' });

  const fileId = crypto.randomUUID();
  const buffer = Buffer.from(await file.arrayBuffer());
  const mimeType = file.type || 'audio/wav';

  let s3Key: string;

  if (isR2Configured()) {
    s3Key = `projects/${projectId}/${fileId}/${file.name}`;
    await uploadToR2(s3Key, buffer, mimeType);
  } else {
    const projectDir = join(UPLOADS_DIR, projectId);
    await mkdir(projectDir, { recursive: true });
    s3Key = join(projectDir, `${fileId}_${file.name}`);
    const fsp = await import('node:fs/promises');
    await fsp.writeFile(s3Key, buffer);
  }

  // Pre-compute peaks at upload time so project loads can include them
  // inline with zero extra round trips. Non-WAV uploads just skip this.
  let peaksJson: string | null = null;
  try {
    const parsed = parseWavPeaks(buffer, 1024);
    peaksJson = JSON.stringify(parsed);
    setCachedPeaks(`${fileId}:1024`, parsed);
  } catch {
    peaksJson = null;
  }

  // BPM + beat analysis for tempo-aware placement and future time-stretch.
  let analysis: ReturnType<typeof analyseWav> = null;
  try { analysis = analyseWav(buffer); } catch (err) { console.warn('[files.upload] bpm analysis failed:', err); }

  await db.insert(files).values({
    id: fileId, projectId, uploadedBy: user.id,
    fileName: file.name, fileSize: file.size, mimeType,
    s3Key, peaks: peaksJson,
    detectedBpm: analysis?.bpm ?? null,
    bpmConfidence: analysis?.confidence ?? null,
    firstBeatOffset: analysis?.firstBeatOffset ?? null,
    beatsJson: analysis ? JSON.stringify(analysis.beats) : null,
    createdAt: new Date().toISOString(),
  }).run();

  return c.json({ success: true, data: { fileId, fileName: file.name } });
});

// Direct file download (streams from R2 if key looks like an S3 path, otherwise local disk)
fileRoutes.get('/:fileId/download', async (c) => {
  const fileId = c.req.param('fileId');
  const [file] = await db.select().from(files).where(eq(files.id, fileId)).limit(1).all();
  if (!file) throw new HTTPException(404, { message: 'File not found' });

  const isS3Path = file.s3Key.startsWith('projects/');

  if (isS3Path && isR2Configured()) {
    try {
      const { stream, contentLength, contentType } = await downloadFromR2(file.s3Key);
      return new Response(stream, {
        headers: {
          'Content-Type': contentType || file.mimeType || 'audio/wav',
          'Content-Disposition': `inline; filename="${file.fileName}"`,
          'Content-Length': contentLength.toString(),
          'Accept-Ranges': 'bytes',
        },
      });
    } catch {
      throw new HTTPException(404, { message: 'File not found in storage' });
    }
  }

  // Local disk fallback
  try {
    const fileStat = await stat(file.s3Key);
    const stream = createReadStream(file.s3Key);

    c.header('Content-Type', file.mimeType || 'audio/wav');
    c.header('Content-Disposition', `inline; filename="${file.fileName}"`);
    c.header('Content-Length', fileStat.size.toString());
    c.header('Accept-Ranges', 'bytes');

    return new Response(Readable.toWeb(stream) as ReadableStream, {
      headers: c.res.headers,
    });
  } catch {
    throw new HTTPException(404, { message: 'File not found on disk' });
  }
});

// Fast waveform peaks — returns ~1024 downsampled peak+RMS values as tiny JSON.
// Lets the client render a waveform instantly without downloading the full WAV
// or running decodeAudioData. Falls back to a 404 for non-WAV files so the
// client can use its existing decode path.
fileRoutes.get('/:fileId/peaks', async (c) => {
  const fileId = c.req.param('fileId');
  const bins = Math.min(4096, Math.max(64, parseInt(c.req.query('bins') || '1024', 10) || 1024));

  const cacheKey = `${fileId}:${bins}`;
  const cached = getCachedPeaks(cacheKey);
  if (cached) {
    c.header('Cache-Control', 'public, max-age=31536000, immutable');
    return c.json(cached);
  }

  const [file] = await db.select().from(files).where(eq(files.id, fileId)).limit(1).all();
  if (!file) throw new HTTPException(404, { message: 'File not found' });

  // DB-persisted peaks (from upload time) — fastest path.
  if (file.peaks) {
    try {
      const parsed = JSON.parse(file.peaks);
      setCachedPeaks(cacheKey, parsed);
      c.header('Cache-Control', 'public, max-age=31536000, immutable');
      return c.json(parsed);
    } catch {
      // fall through to regeneration
    }
  }

  let buf: Buffer;
  try {
    const isS3Path = file.s3Key.startsWith('projects/');
    if (isS3Path && isR2Configured()) {
      const { stream } = await downloadFromR2(file.s3Key);
      const chunks: Uint8Array[] = [];
      const reader = (stream as any).getReader ? (stream as ReadableStream<Uint8Array>).getReader() : null;
      if (reader) {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) chunks.push(value);
        }
      } else {
        // Node Readable fallback
        for await (const chunk of stream as any) chunks.push(chunk);
      }
      buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    } else {
      buf = await readFile(file.s3Key);
    }
  } catch {
    throw new HTTPException(404, { message: 'File not readable' });
  }

  try {
    const data = parseWavPeaks(buf, bins);
    setCachedPeaks(cacheKey, data);
    // Backfill: persist to DB so future reads skip the WAV parse entirely.
    if (bins === 1024) {
      try { await db.update(files).set({ peaks: JSON.stringify(data) }).where(eq(files.id, fileId)).run(); } catch (err) { console.warn('[files.peaks] persist failed:', err); }
    }
    c.header('Cache-Control', 'public, max-age=31536000, immutable');
    return c.json(data);
  } catch {
    throw new HTTPException(415, { message: 'Peaks extraction only supports WAV for now' });
  }
});

fileRoutes.get('/:fileId/download-url', async (c) => {
  const fileId = c.req.param('fileId');
  const [file] = await db.select().from(files).where(eq(files.id, fileId)).limit(1).all();
  if (!file) throw new HTTPException(404, { message: 'File not found' });

  try {
    const url = await getDownloadUrl(file.s3Key);
    return c.json({ success: true, data: { downloadUrl: url } });
  } catch {
    return c.json({ success: true, data: { downloadUrl: null } });
  }
});

fileRoutes.get('/', async (c) => {
  const projectId = c.req.param('id');
  const result = await db.select().from(files).where(eq(files.projectId, projectId)).all();
  return c.json({ success: true, data: result });
});

export default fileRoutes;
