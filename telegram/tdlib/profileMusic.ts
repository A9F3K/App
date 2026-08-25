import fs from "fs";
import type { Client } from "tdl";

export type TelegramProfileAudioTrack = {
  user_id: number;
  file_id: number;
  artist: string;
  title: string;
  duration_sec: number;
  size_bytes: number;
  cover_data_url: string | null;
  cover_file_id: number | null;
};

type TdFile = {
  id?: number;
  size?: number;
  expected_size?: number;
  local?: {
    path?: string;
    is_downloading_completed?: boolean;
    is_downloading_active?: boolean;
    downloaded_size?: number;
    downloaded_prefix_size?: number;
  };
};

export type AudioHttpResponse = {
  statusCode: number;
  setHeader: (name: string, value: string | number) => void;
  write: (chunk: Buffer | string) => boolean;
  end: (chunk?: Buffer | string) => void;
  destroyed?: boolean;
};

type ByteRange = {
  start: number;
  end: number | null;
};

const AUDIO_DOWNLOAD_TIMEOUT_MS = 90_000;
const COVER_DOWNLOAD_TIMEOUT_MS = 20_000;
/** Start HTTP audio as soon as Telegram has this many prefix bytes (keep small for fast first sound). */
const AUDIO_STREAM_START_BYTES = 16 * 1024;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fileIdFromUnknown(value: unknown): number | null {
  const rec = asRecord(value);
  const id = Number(rec?.id);
  return Number.isFinite(id) && id > 0 ? Math.trunc(id) : null;
}

function fileSizeFromUnknown(value: unknown): number {
  const rec = asRecord(value);
  const size = Number(rec?.size ?? rec?.expected_size ?? 0);
  return Number.isFinite(size) && size > 0 ? Math.trunc(size) : 0;
}

function minithumbnailDataUrl(value: unknown): string | null {
  const rec = asRecord(value);
  const data = rec?.data;
  if (typeof data === "string" && data.trim()) {
    const raw = data.trim();
    if (raw.startsWith("data:")) return raw;
    return `data:image/jpeg;base64,${raw}`;
  }
  if (Buffer.isBuffer(data) && data.length > 0) {
    return `data:image/jpeg;base64,${data.toString("base64")}`;
  }
  return null;
}

function coverFileIdFromAudio(audio: Record<string, unknown>): number | null {
  const thumb = asRecord(audio.album_cover_thumbnail);
  const nestedFile = thumb?.file ?? thumb?.photo;
  return fileIdFromUnknown(nestedFile);
}

export function parseTdProfileAudio(
  value: unknown,
  userId: number,
): TelegramProfileAudioTrack | null {
  const audio = asRecord(value);
  if (!audio) return null;
  const file = audio.audio ?? audio.file;
  const fileId = fileIdFromUnknown(file);
  if (fileId == null) return null;
  const artist =
    (typeof audio.performer === "string" && audio.performer.trim()) ||
    (typeof audio.artist === "string" && audio.artist.trim()) ||
    "";
  const title =
    (typeof audio.title === "string" && audio.title.trim()) ||
    (typeof audio.file_name === "string" && audio.file_name.trim()) ||
    "";
  if (!artist && !title) return null;
  const duration = Number(audio.duration);
  return {
    user_id: userId,
    file_id: fileId,
    artist: artist || title,
    title: artist && title ? title : "",
    duration_sec: Number.isFinite(duration) && duration > 0 ? Math.trunc(duration) : 0,
    size_bytes: fileSizeFromUnknown(file),
    cover_data_url: minithumbnailDataUrl(audio.album_cover_minithumbnail),
    cover_file_id: coverFileIdFromAudio(audio),
  };
}

export async function listUserProfileAudios(
  client: Client,
  userId: number,
): Promise<TelegramProfileAudioTrack[]> {
  if (!Number.isFinite(userId) || userId === 0) return [];
  const uid = Math.trunc(userId);
  const pageLimit = 100;
  const tracks: TelegramProfileAudioTrack[] = [];
  const seen = new Set<number>();
  try {
    let offset = 0;
    for (let page = 0; page < 20; page += 1) {
      const result = (await client.invoke({
        _: "getUserProfileAudios",
        user_id: uid,
        offset,
        limit: pageLimit,
      })) as { audios?: unknown; total_count?: number };
      const rows = Array.isArray(result.audios) ? result.audios : [];
      for (const row of rows) {
        const track = parseTdProfileAudio(row, uid);
        if (!track || seen.has(track.file_id)) continue;
        seen.add(track.file_id);
        tracks.push(track);
      }
      if (rows.length === 0) break;
      offset += rows.length;
      const total = Number(result.total_count ?? 0);
      if (Number.isFinite(total) && total > 0 && offset >= total) break;
      if (rows.length < pageLimit) break;
    }
    return tracks;
  } catch {
    return tracks;
  }
}

async function startAudioDownload(
  client: Client,
  fileId: number,
  offset = 0,
): Promise<void> {
  try {
    await client.invoke({
      _: "downloadFile",
      file_id: fileId,
      priority: 32,
      offset: Math.max(0, Math.trunc(offset)),
      limit: 0,
      synchronous: false,
    });
  } catch {
    /* poll getFile anyway */
  }
}

function localPrefixBytes(file: TdFile): number {
  const local = file.local;
  if (!local) return 0;
  const prefix = Number(local.downloaded_prefix_size ?? local.downloaded_size ?? 0);
  return Number.isFinite(prefix) && prefix > 0 ? Math.trunc(prefix) : 0;
}

async function waitForLocalFile(
  client: Client,
  fileId: number,
  timeoutMs: number,
  options?: { minBytes?: number; offset?: number },
): Promise<TdFile | null> {
  const minBytes = options?.minBytes ?? Number.POSITIVE_INFINITY;
  const deadline = Date.now() + timeoutMs;
  await startAudioDownload(client, fileId, options?.offset ?? 0);
  while (Date.now() < deadline) {
    try {
      const file = (await client.invoke({ _: "getFile", file_id: fileId })) as TdFile;
      const filePath = file.local?.path;
      if (filePath && fs.existsSync(filePath)) {
        const diskSize = fs.statSync(filePath).size;
        const prefix = Math.max(localPrefixBytes(file), diskSize);
        if (file.local?.is_downloading_completed || prefix >= minBytes || diskSize >= minBytes) {
          return file;
        }
      }
      if (!file.local?.is_downloading_active) {
        await startAudioDownload(client, fileId, options?.offset ?? 0);
      }
    } catch {
      /* keep polling until deadline */
    }
    await sleep(40);
  }
  return null;
}

async function readLocalFileBytes(
  client: Client,
  fileId: number,
  timeoutMs: number,
): Promise<{ data: Buffer; path: string } | null> {
  const file = await waitForLocalFile(client, fileId, timeoutMs);
  const filePath = file?.local?.path;
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    return { data: fs.readFileSync(filePath), path: filePath };
  } catch {
    return null;
  }
}

function fileTotalBytes(file: TdFile | null | undefined, diskSize = 0): number | null {
  const size = Number(file?.size ?? file?.expected_size ?? 0);
  if (Number.isFinite(size) && size > 0) return Math.trunc(size);
  if (file?.local?.is_downloading_completed && diskSize > 0) return diskSize;
  return null;
}

function parseBytesRange(header: string | null | undefined, total: number | null): ByteRange | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!match) return null;
  const startRaw = match[1] ?? "";
  const endRaw = match[2] ?? "";
  if (!startRaw && endRaw && total != null && total > 0) {
    const suffix = Number(endRaw);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    return { start: Math.max(0, total - Math.trunc(suffix)), end: total - 1 };
  }
  const start = Number(startRaw);
  if (!Number.isFinite(start) || start < 0) return null;
  if (!endRaw) return { start: Math.trunc(start), end: total != null && total > 0 ? total - 1 : null };
  const end = Number(endRaw);
  if (!Number.isFinite(end) || end < start) return null;
  return { start: Math.trunc(start), end: Math.trunc(end) };
}

function mimeFromAudioPath(filePath: string, fallback?: string | null): string {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".m4a") || lower.endsWith(".mp4")) return "audio/mp4";
  if (lower.endsWith(".ogg") || lower.endsWith(".opus")) return "audio/ogg";
  if (lower.endsWith(".wav")) return "audio/wav";
  if (lower.endsWith(".flac")) return "audio/flac";
  if (typeof fallback === "string" && fallback.trim()) return fallback.trim();
  return "audio/mpeg";
}

export async function readProfileAudioBytes(
  client: Client,
  userId: number,
  fileId: number,
): Promise<{ data: Buffer; mime: string } | null> {
  if (!Number.isFinite(userId) || userId === 0) return null;
  if (!Number.isFinite(fileId) || fileId <= 0) return null;
  const bytes = await readLocalFileBytes(client, Math.trunc(fileId), AUDIO_DOWNLOAD_TIMEOUT_MS);
  if (!bytes) return null;
  return { data: bytes.data, mime: mimeFromAudioPath(bytes.path) };
}

export async function streamProfileAudioToHttp(
  client: Client,
  userId: number,
  fileId: number,
  res: AudioHttpResponse,
  rangeHeader?: string | null,
): Promise<boolean> {
  if (!Number.isFinite(userId) || userId === 0) return false;
  if (!Number.isFinite(fileId) || fileId <= 0) return false;
  return streamLocalAudioFileToHttp(client, Math.trunc(fileId), res, rangeHeader);
}

/** Progressive HTTP stream for any TDLib audio file id (profile or chat message). */
export async function streamLocalAudioFileToHttp(
  client: Client,
  fileId: number,
  res: AudioHttpResponse,
  rangeHeader?: string | null,
): Promise<boolean> {
  if (!Number.isFinite(fileId) || fileId <= 0) return false;
  const id = Math.trunc(fileId);
  let probe: TdFile | null = null;
  try {
    probe = (await client.invoke({ _: "getFile", file_id: id })) as TdFile;
  } catch {
    probe = null;
  }
  const totalHint = fileTotalBytes(probe);
  const range = parseBytesRange(rangeHeader, totalHint);
  const startAt = range?.start ?? 0;
  if (range && totalHint != null && startAt >= totalHint) {
    res.statusCode = 416;
    res.setHeader("Content-Range", `bytes */${totalHint}`);
    res.end();
    return true;
  }
  const started = await waitForLocalFile(client, id, AUDIO_DOWNLOAD_TIMEOUT_MS, {
    minBytes: startAt > 0 ? startAt + 1 : AUDIO_STREAM_START_BYTES,
    offset: startAt,
  });
  const filePath = started?.local?.path;
  if (!filePath || !fs.existsSync(filePath)) return false;

  const mime = mimeFromAudioPath(filePath);
  let offset = startAt;
  let opened = false;
  const deadline = Date.now() + AUDIO_DOWNLOAD_TIMEOUT_MS;
  while (!res.destroyed && Date.now() < deadline) {
    let diskSize = 0;
    try {
      diskSize = fs.statSync(filePath).size;
    } catch {
      break;
    }
    let completed = false;
    let total = fileTotalBytes(started, diskSize);
    try {
      const file = (await client.invoke({ _: "getFile", file_id: id })) as TdFile;
      completed = Boolean(file.local?.is_downloading_completed);
      total = fileTotalBytes(file, diskSize) ?? total;
      if (!file.local?.is_downloading_active && !completed) {
        await startAudioDownload(client, id, startAt);
      }
    } catch {
      /* keep streaming disk bytes */
    }
    const rangeEnd =
      range?.end != null
        ? range.end
        : total != null && total > 0
          ? total - 1
          : null;
    const emitUntil = rangeEnd != null ? Math.min(diskSize, rangeEnd + 1) : diskSize;
    if (emitUntil > offset) {
      const length = emitUntil - offset;
      const chunk = Buffer.alloc(length);
      const fd = fs.openSync(filePath, "r");
      try {
        fs.readSync(fd, chunk, 0, length, offset);
      } finally {
        fs.closeSync(fd);
      }
      if (!opened) {
        const isPartial = startAt > 0 || Boolean(range);
        res.statusCode = isPartial ? 206 : 200;
        res.setHeader("Content-Type", mime);
        res.setHeader("Cache-Control", "private, max-age=60");
        res.setHeader("Accept-Ranges", "bytes");
        res.setHeader("Content-Disposition", "inline");
        // Prevent proxies (incl. Vercel) from buffering the whole body before the client hears audio.
        res.setHeader("X-Accel-Buffering", "no");
        if (total != null && total > 0) {
          const endByte = rangeEnd != null ? rangeEnd : total - 1;
          if (isPartial) {
            res.setHeader("Content-Range", `bytes ${startAt}-${endByte}/${total}`);
          }
          // Only advertise Content-Length when the file is fully on disk. Otherwise chunked
          // transfer lets the browser start decoding while Telegram is still downloading.
          const fullyOnDisk =
            completed && diskSize >= (total > 0 ? total : diskSize) && diskSize > startAt;
          if (fullyOnDisk) {
            res.setHeader("Content-Length", String(endByte - startAt + 1));
          }
        }
        opened = true;
      }
      offset += length;
      res.write(chunk);
    }
    if (rangeEnd != null && offset > rangeEnd) break;
    if (completed && diskSize <= offset) break;
    if (diskSize <= offset) await sleep(40);
  }
  if (!opened) return false;
  res.end();
  return offset > startAt;
}

export async function readProfileAudioCoverBytes(
  client: Client,
  userId: number,
  fileId: number,
): Promise<{ data: Buffer; mime: string } | null> {
  if (!Number.isFinite(userId) || userId === 0) return null;
  if (!Number.isFinite(fileId) || fileId <= 0) return null;
  const tracks = await listUserProfileAudios(client, Math.trunc(userId));
  const allowed = tracks.some((row) => row.cover_file_id === Math.trunc(fileId));
  if (!allowed) return null;
  const bytes = await readLocalFileBytes(client, Math.trunc(fileId), COVER_DOWNLOAD_TIMEOUT_MS);
  if (!bytes) return null;
  return { data: bytes.data, mime: "image/jpeg" };
}
