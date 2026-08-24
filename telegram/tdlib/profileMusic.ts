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
  };
};

const AUDIO_DOWNLOAD_TIMEOUT_MS = 90_000;
const COVER_DOWNLOAD_TIMEOUT_MS = 20_000;

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

async function waitForLocalFile(
  client: Client,
  fileId: number,
  timeoutMs: number,
): Promise<TdFile | null> {
  const deadline = Date.now() + timeoutMs;
  let syncAttempted = false;
  while (Date.now() < deadline) {
    try {
      const file = (await client.invoke({ _: "getFile", file_id: fileId })) as TdFile;
      if (file.local?.is_downloading_completed && file.local.path) return file;
      if (!file.local?.is_downloading_active) {
        await client.invoke({
          _: "downloadFile",
          file_id: fileId,
          priority: 32,
          offset: 0,
          limit: 0,
          synchronous: !syncAttempted,
        });
        syncAttempted = true;
        const refreshed = (await client.invoke({ _: "getFile", file_id: fileId })) as TdFile;
        if (refreshed.local?.is_downloading_completed && refreshed.local.path) return refreshed;
      }
    } catch {
      /* keep polling until deadline */
    }
    await sleep(200);
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
