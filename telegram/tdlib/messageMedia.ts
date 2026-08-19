import fs from "fs";
import type { Client } from "tdl";
import type { TdMessage } from "./chatPreview.js";
import { logGateway } from "./gatewayLog.js";
import {
  listPhotoSizeCandidates,
  readPhotoMinithumbnail,
  type PhotoSizeCandidate,
} from "./photoParse.js";

type TdFile = {
  id?: number;
  local?: {
    path?: string;
    is_downloading_completed?: boolean;
    is_downloading_active?: boolean;
  };
};

const MEDIA_DOWNLOAD_TIMEOUT_MS = 45_000;
const MEDIA_VIDEO_DOWNLOAD_TIMEOUT_MS = 60_000;
/** Reject minithumbnail-sized downloads masquerading as full photo.sizes files. */
const PHOTO_MIN_FULL_DIMENSION_PX = 120;
const PHOTO_MIN_FULL_BYTES = 12_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mediaDownloadTimeoutMs(contentType: string | undefined): number {
  if (contentType === "messageVideo" || contentType === "messageAnimation") {
    return MEDIA_VIDEO_DOWNLOAD_TIMEOUT_MS;
  }
  if (contentType === "messagePhoto") return MEDIA_DOWNLOAD_TIMEOUT_MS;
  if (contentType === "messageAudio") return 90_000;
  return 30_000;
}

function mimeFromPath(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".webm")) return "video/webm";
  if (lower.endsWith(".tgs")) return "application/x-tgsticker";
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".m4a") || lower.endsWith(".aac")) return "audio/mp4";
  if (lower.endsWith(".ogg") || lower.endsWith(".opus")) return "audio/ogg";
  if (lower.endsWith(".flac")) return "audio/flac";
  if (lower.endsWith(".wav")) return "audio/wav";
  return "image/jpeg";
}

async function waitForLocalFile(
  client: Client,
  fileId: number,
  timeoutMs = MEDIA_DOWNLOAD_TIMEOUT_MS,
  forceSync = false,
): Promise<TdFile | null> {
  const deadline = Date.now() + timeoutMs;
  let syncAttempted = forceSync;

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

function readJpegDimensions(data: Buffer): { width: number; height: number } | null {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < data.length) {
    if (data[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = data[offset + 1];
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2;
      continue;
    }
    const segmentLength = data.readUInt16BE(offset + 2);
    if (segmentLength < 2 || offset + 2 + segmentLength > data.length) return null;
    if (marker >= 0xc0 && marker <= 0xc3) {
      const height = data.readUInt16BE(offset + 5);
      const width = data.readUInt16BE(offset + 7);
      if (width > 0 && height > 0) return { width, height };
      return null;
    }
    offset += 2 + segmentLength;
  }
  return null;
}

function photoBytesLookFullSize(
  data: Buffer,
  declaredWidth?: number | null,
  declaredHeight?: number | null,
): boolean {
  if (data.length >= PHOTO_MIN_FULL_BYTES) return true;
  const w = declaredWidth ?? readJpegDimensions(data)?.width ?? 0;
  const h = declaredHeight ?? readJpegDimensions(data)?.height ?? 0;
  return w >= PHOTO_MIN_FULL_DIMENSION_PX || h >= PHOTO_MIN_FULL_DIMENSION_PX;
}

function pickThumbnailFileId(media: unknown): number | null {
  if (!media || typeof media !== "object") return null;
  const thumb = (media as { thumbnail?: { file?: { id?: number } } }).thumbnail;
  const id = thumb?.file?.id;
  return typeof id === "number" ? id : null;
}

function pickPhotoFileId(content: Record<string, unknown>): number | null {
  return listPhotoSizeCandidates(content)[0]?.fileId ?? null;
}

function pickFileIdFromTdFile(file: unknown): number | null {
  if (!file || typeof file !== "object") return null;
  const id = (file as { id?: number }).id;
  return typeof id === "number" ? id : null;
}

function pickNestedFileId(media: unknown): number | null {
  if (!media || typeof media !== "object") return null;
  const row = media as Record<string, unknown>;
  const direct = pickFileIdFromTdFile(row);
  if (direct != null) return direct;
  for (const key of ["video", "animation", "sticker", "document", "photo", "audio"]) {
    const nested = row[key];
    const id = pickFileIdFromTdFile(nested);
    if (id != null) return id;
  }
  return null;
}

function mimeFromMessageContent(content: Record<string, unknown>): string | null {
  const type = content._;
  if (type === "messageVideo") {
    const mime = (content.video as { mime_type?: string } | undefined)?.mime_type;
    return typeof mime === "string" && mime.trim() ? mime.trim() : null;
  }
  if (type === "messageAnimation") {
    const mime = (content.animation as { mime_type?: string } | undefined)?.mime_type;
    return typeof mime === "string" && mime.trim() ? mime.trim() : null;
  }
  if (type === "messageSticker") {
    const mime = (content.sticker as { mime_type?: string } | undefined)?.mime_type;
    return typeof mime === "string" && mime.trim() ? mime.trim() : null;
  }
  if (type === "messageAudio") {
    const mime = (content.audio as { mime_type?: string } | undefined)?.mime_type;
    return typeof mime === "string" && mime.trim() ? mime.trim() : "audio/mpeg";
  }
  return null;
}

function mediaFileIdFromMessage(message: TdMessage): number | null {
  const content = message.content;
  if (!content || typeof content !== "object") return null;
  const row = content as Record<string, unknown>;
  const type = row._;
  if (type === "messagePhoto") return pickPhotoFileId(row);
  if (type === "messageVideo") {
    const video = row.video as { video?: { id?: number }; thumbnail?: unknown } | undefined;
    return pickNestedFileId(video);
  }
  if (type === "messageAnimation") {
    const animation = row.animation as { animation?: { id?: number }; thumbnail?: unknown } | undefined;
    return pickNestedFileId(animation);
  }
  if (type === "messageSticker") {
    const sticker = row.sticker as { sticker?: { id?: number }; thumbnail?: unknown } | undefined;
    return pickNestedFileId(sticker);
  }
  if (type === "messageAudio") {
    const audio = row.audio as { audio?: { id?: number }; thumbnail?: unknown } | undefined;
    return pickNestedFileId(audio);
  }
  return null;
}

async function readLocalFileBytes(
  client: Client,
  fileId: number,
  timeoutMs = MEDIA_DOWNLOAD_TIMEOUT_MS,
): Promise<{ data: Buffer; path: string } | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const file = await waitForLocalFile(client, fileId, timeoutMs, attempt > 0);
    const path = file?.local?.path;
    if (!path || !fs.existsSync(path)) continue;
    try {
      const data = fs.readFileSync(path);
      if (data.length === 0) continue;
      return { data, path };
    } catch {
      /* try again */
    }
  }
  return null;
}

function resolveMediaMime(
  content: Record<string, unknown>,
  path: string,
  preferVideoMime: boolean,
): string {
  const contentMime = mimeFromMessageContent(content);
  const pathMime = mimeFromPath(path);
  let mime = contentMime ?? pathMime;
  const contentType = (content as { _?: string })._;
  if (
    preferVideoMime &&
    !contentMime &&
    (contentType === "messageVideo" || contentType === "messageAnimation") &&
    pathMime === "image/jpeg"
  ) {
    mime = "video/mp4";
  }
  if (contentType === "messageAudio" && (!contentMime || pathMime === "image/jpeg")) {
    mime = contentMime ?? "audio/mpeg";
  }
  return mime;
}

function mediaPhotoCandidatesFromMessage(message: TdMessage): PhotoSizeCandidate[] {
  const content = message.content;
  if (!content || typeof content !== "object") return [];
  const row = content as Record<string, unknown>;
  if (row._ !== "messagePhoto") return [];
  return listPhotoSizeCandidates(row);
}

function mediaFileIdsFromMessage(message: TdMessage): number[] {
  const photoCandidates = mediaPhotoCandidatesFromMessage(message);
  if (photoCandidates.length > 0) {
    return photoCandidates.map((row) => row.fileId);
  }
  const primary = mediaFileIdFromMessage(message);
  return primary != null ? [primary] : [];
}

function mediaThumbnailFileIdFromMessage(message: TdMessage): number | null {
  const content = message.content;
  if (!content || typeof content !== "object") return null;
  const row = content as Record<string, unknown>;
  const type = row._;
  if (type === "messageVideo") return pickThumbnailFileId(row.video);
  if (type === "messageAnimation") return pickThumbnailFileId(row.animation);
  if (type === "messageSticker") return pickThumbnailFileId(row.sticker);
  if (type === "messageAudio") {
    const audio = row.audio as
      | { thumbnail?: unknown; album_cover_thumbnail?: { file?: unknown } }
      | undefined;
    return pickThumbnailFileId(audio) ?? pickFileIdFromTdFile(audio?.album_cover_thumbnail?.file);
  }
  return null;
}

export type MessageMediaFetchMode = "full" | "preview";

async function readMessageMediaPreviewBytes(
  client: Client,
  message: TdMessage,
  contentRow: Record<string, unknown>,
  contentType: string | undefined,
): Promise<{ data: Buffer; mime: string } | null> {
  const preferVideoMime =
    contentType === "messageVideo" || contentType === "messageAnimation";

  if (preferVideoMime) {
    const thumbnailId = mediaThumbnailFileIdFromMessage(message);
    if (thumbnailId != null) {
      const local = await readLocalFileBytes(client, thumbnailId, 15_000);
      if (local) {
        return { data: local.data, mime: mimeFromPath(local.path) };
      }
    }
    return null;
  }

  if (contentType === "messagePhoto") {
    const mini = readPhotoMinithumbnail(contentRow);
    if (mini) return { data: mini.data, mime: "image/jpeg" };
    const candidates = listPhotoSizeCandidates(contentRow);
    const smallest = candidates[candidates.length - 1];
    if (smallest != null) {
      const local = await readLocalFileBytes(client, smallest.fileId, 15_000);
      if (local) {
        return { data: local.data, mime: mimeFromPath(local.path) };
      }
    }
  }

  const thumbnailId = mediaThumbnailFileIdFromMessage(message);
  if (thumbnailId != null) {
    const local = await readLocalFileBytes(client, thumbnailId, 15_000);
    if (local) {
      return { data: local.data, mime: mimeFromPath(local.path) };
    }
  }

  return null;
}

export async function readMessageMediaBytes(
  client: Client,
  chatId: number,
  messageId: number,
  mode: MessageMediaFetchMode = "full",
): Promise<{ data: Buffer; mime: string } | null> {
  let message: TdMessage;
  try {
    message = (await client.invoke({
      _: "getMessage",
      chat_id: chatId,
      message_id: messageId,
    })) as TdMessage;
  } catch {
    return null;
  }

  const content = message.content;
  if (!content || typeof content !== "object") return null;
  const contentRow = content as Record<string, unknown>;
  const contentType = contentRow._;

  if (mode === "preview") {
    const preview = await readMessageMediaPreviewBytes(
      client,
      message,
      contentRow,
      typeof contentType === "string" ? contentType : undefined,
    );
    logGateway("message_media_preview", {
      chatId,
      messageId,
      contentType,
      ok: preview != null,
      bytes: preview?.data.length ?? 0,
      mime: preview?.mime ?? null,
    });
    return preview;
  }

  const photoCandidates = mediaPhotoCandidatesFromMessage(message);
  const candidates: Array<{ fileId: number; width: number | null; height: number | null; type: string }> =
    photoCandidates.length > 0
      ? photoCandidates
      : mediaFileIdsFromMessage(message).map((fileId) => ({
          fileId,
          width: null,
          height: null,
          type: "",
        }));

  logGateway("message_media_full_start", {
    chatId,
    messageId,
    contentType,
    photoFileIdCount: candidates.length,
    photoFileIds: candidates.slice(0, 5).map((row) => row.fileId),
    photoSizeTypes: candidates.slice(0, 5).map((row) => row.type || null),
  });

  const downloadTimeoutMs = mediaDownloadTimeoutMs(
    typeof contentType === "string" ? contentType : undefined,
  );
  const preferVideoMime =
    contentType === "messageVideo" || contentType === "messageAnimation";

  for (const candidate of candidates) {
    const local = await readLocalFileBytes(client, candidate.fileId, downloadTimeoutMs);
    if (!local) continue;
    const mime = resolveMediaMime(contentRow, local.path, preferVideoMime);
    if (preferVideoMime && mime.startsWith("image/")) continue;
    if (
      contentType === "messagePhoto" &&
      !photoBytesLookFullSize(local.data, candidate.width, candidate.height)
    ) {
      const dims = readJpegDimensions(local.data);
      logGateway("message_media_full_skip_thumbnail", {
        chatId,
        messageId,
        fileId: candidate.fileId,
        photoSizeType: candidate.type || null,
        declaredWidth: candidate.width,
        declaredHeight: candidate.height,
        bytes: local.data.length,
        mime,
        width: dims?.width ?? null,
        height: dims?.height ?? null,
      });
      continue;
    }
    logGateway("message_media_full_ok", {
      chatId,
      messageId,
      fileId: candidate.fileId,
      photoSizeType: candidate.type || null,
      declaredWidth: candidate.width,
      declaredHeight: candidate.height,
      bytes: local.data.length,
      mime,
      pathExt: local.path.split(".").pop() ?? null,
    });
    return { data: local.data, mime };
  }

  if (contentType === "messagePhoto" || preferVideoMime) {
    logGateway("message_media_full_unavailable", {
      chatId,
      messageId,
      contentType,
      photoFileIdCount: candidates.length,
    });
  }

  return null;
}
