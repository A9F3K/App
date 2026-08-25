import fs from "fs";
import type { Client } from "tdl";
import { parseTdlibFileId, tdlibCustomEmojiIdParam } from "../../shared/telegramCustomEmojiId.js";
import { logGateway } from "./gatewayLog.js";

type TdFile = {
  local?: {
    path?: string;
    is_downloading_completed?: boolean;
    is_downloading_active?: boolean;
  };
};

function isTdlibFileObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return row._ === "file" || ("local" in row && "remote" in row);
}

function fileIdFromTdlibFile(value: unknown): number | null {
  if (!isTdlibFileObject(value)) return null;
  return parseTdlibFileId((value as { id?: unknown }).id);
}

/** TDLib `file` object, or `sticker` object (bytes on nested `sticker` file field). */
function pickTdlibFileId(value: unknown): number | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;

  const directFile = fileIdFromTdlibFile(row);
  if (directFile != null) return directFile;

  const stickerFile = fileIdFromTdlibFile(row.sticker);
  if (stickerFile != null) return stickerFile;

  if (row.sticker && typeof row.sticker === "object") {
    const nestedSticker = row.sticker as Record<string, unknown>;
    const deepFile = fileIdFromTdlibFile(nestedSticker.sticker);
    if (deepFile != null) return deepFile;
  }

  const topFile = fileIdFromTdlibFile(row.file);
  if (topFile != null) return topFile;

  const thumbnail = row.thumbnail;
  if (thumbnail && typeof thumbnail === "object") {
    const thumbFile = fileIdFromTdlibFile((thumbnail as { file?: unknown }).file);
    if (thumbFile != null) return thumbFile;
  }

  const preview = row.preview;
  if (preview && typeof preview === "object") {
    const fileId = pickTdlibFileId(preview);
    if (fileId != null) return fileId;
  }

  // Sticker row `id` is not a downloadable file id — only use top-level id for bare file refs.
  if (!("sticker" in row) && !("thumbnail" in row) && !("set_id" in row)) {
    const fallback = parseTdlibFileId(row.id);
    if (fallback != null) return fallback;
  }

  return null;
}

function pickTdlibFileIds(value: unknown, preferStatic = false): number[] {
  const ids: number[] = [];
  const push = (id: number | null) => {
    if (id != null && id > 0 && !ids.includes(id)) ids.push(id);
  };
  if (!value || typeof value !== "object") {
    push(pickTdlibFileId(value));
    return ids;
  }
  const row = value as Record<string, unknown>;
  const thumbnail = row.thumbnail;
  const thumbId =
    thumbnail && typeof thumbnail === "object"
      ? fileIdFromTdlibFile((thumbnail as { file?: unknown }).file)
      : null;
  const minithumbnail = row.minithumbnail;
  const miniId =
    minithumbnail && typeof minithumbnail === "object"
      ? fileIdFromTdlibFile((minithumbnail as { file?: unknown }).file)
      : null;

  if (preferStatic) {
    // Static WEBP/PNG thumbnail first; fall back to full sticker if no thumb.
    push(thumbId);
    push(miniId);
    push(pickTdlibFileId(value));
  } else {
    push(pickTdlibFileId(value));
    push(thumbId);
    push(miniId);
  }
  return ids;
}

function normalizeAnimatedEmojiInput(emoji: string): string[] {
  const trimmed = emoji.trim();
  if (!trimmed) return [];
  const variants = new Set<string>([trimmed]);
  const withoutFe0f = trimmed.replace(/\uFE0F/g, "");
  if (withoutFe0f && withoutFe0f !== trimmed) variants.add(withoutFe0f);
  if (!trimmed.includes("\uFE0F")) variants.add(`${trimmed}\uFE0F`);
  return [...variants];
}

function expandAnimatedEmojiCandidates(emoji: string): string[] {
  const variants = new Set<string>();
  const push = (value: string) => {
    for (const candidate of normalizeAnimatedEmojiInput(value)) {
      variants.add(candidate);
    }
  };
  push(emoji);
  const beforeZwj = emoji.split("\u200D")[0];
  if (beforeZwj && beforeZwj !== emoji) push(beforeZwj);
  const withoutSkinTone = emoji.replace(/[\u{1F3FB}-\u{1F3FF}]/gu, "");
  if (withoutSkinTone && withoutSkinTone !== emoji) push(withoutSkinTone);
  const withoutSkinToneBeforeZwj = withoutSkinTone.split("\u200D")[0];
  if (withoutSkinToneBeforeZwj && withoutSkinToneBeforeZwj !== withoutSkinTone) {
    push(withoutSkinToneBeforeZwj);
  }
  return [...variants];
}

const EMOJI_DOWNLOAD_TIMEOUT_MS = 20_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mimeFromPath(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".tgs")) return "application/x-tgsticker";
  if (lower.endsWith(".webm")) return "video/webm";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".gif")) return "image/gif";
  return "application/octet-stream";
}

async function waitForLocalFile(
  client: Client,
  fileId: number,
  forceSync = false,
): Promise<TdFile | null> {
  const deadline = Date.now() + EMOJI_DOWNLOAD_TIMEOUT_MS;
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
      /* keep polling */
    }
    await sleep(150);
  }
  return null;
}

async function readDownloadedFile(
  client: Client,
  fileId: number,
  logContext: Record<string, unknown>,
): Promise<{ data: Buffer; mime: string } | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const file = await waitForLocalFile(client, fileId, attempt > 0);
    const path = file?.local?.path;
    if (!path || !fs.existsSync(path)) continue;
    try {
      const data = fs.readFileSync(path);
      if (data.length === 0) continue;
      const resolved = { data, mime: mimeFromPath(path) };
      logGateway("telegram_emoji_ok", {
        ...logContext,
        fileId,
        bytes: data.length,
        mime: resolved.mime,
        pathExt: path.split(".").pop() ?? null,
        attempt,
      });
      return resolved;
    } catch {
      /* retry once with forced sync download */
    }
  }

  logGateway("telegram_emoji_file_missing", { ...logContext, fileId });
  return null;
}

const bytesCache = new Map<string, { data: Buffer; mime: string }>();
const unavailableCache = new Set<string>();

function cacheKey(kind: "custom" | "animated", id: string, preferStatic = false): string {
  return preferStatic ? `${kind}:static:${id}` : `${kind}:${id}`;
}

async function fetchCustomEmojiSticker(
  client: Client,
  id: string,
  attempt: number,
): Promise<unknown | null> {
  const customEmojiIdParam = tdlibCustomEmojiIdParam(id);
  if (!customEmojiIdParam) return null;

  const result = (await client.invoke({
    _: "getCustomEmojiStickers",
    custom_emoji_ids: [customEmojiIdParam],
  })) as { stickers?: unknown[] };

  const sticker = result.stickers?.[0];
  if (sticker) return sticker;

  logGateway("custom_emoji_sticker_missing", {
    customEmojiId: id,
    attempt,
    stickerCount: Array.isArray(result.stickers) ? result.stickers.length : 0,
  });
  return null;
}

export async function readCustomEmojiBytes(
  client: Client,
  customEmojiId: string,
  options?: { preferStatic?: boolean },
): Promise<{ data: Buffer; mime: string } | null> {
  const id = customEmojiId.trim();
  if (!id) return null;
  const preferStatic = Boolean(options?.preferStatic);

  const key = cacheKey("custom", id, preferStatic);
  if (unavailableCache.has(key)) return null;
  const cached = bytesCache.get(key);
  if (cached) return cached;

  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const sticker = await fetchCustomEmojiSticker(client, id, attempt);
      const fileIds = pickTdlibFileIds(sticker, preferStatic);
      if (fileIds.length === 0) {
        logGateway("custom_emoji_sticker_missing", {
          customEmojiId: id,
          attempt,
          preferStatic,
          stickerCount: sticker ? 1 : 0,
          stickerKeys:
            sticker && typeof sticker === "object"
              ? Object.keys(sticker as object)
              : null,
        });
        if (attempt < 3) {
          await sleep(500 * (attempt + 1));
          continue;
        }
        unavailableCache.add(key);
        return null;
      }

      let firstResolved: { data: Buffer; mime: string } | null = null;
      for (const fileId of fileIds) {
        const resolved = await readDownloadedFile(client, fileId, {
          customEmojiId: id,
          source: preferStatic ? "custom_static" : "custom",
          attempt,
        });
        if (!resolved) continue;
        if (!firstResolved) firstResolved = resolved;
        const isAnimatedMime =
          resolved.mime === "application/x-tgsticker" || resolved.mime.startsWith("video/");
        if (!preferStatic || !isAnimatedMime) {
          bytesCache.set(key, resolved);
          return resolved;
        }
      }
      if (firstResolved) {
        bytesCache.set(key, firstResolved);
        return firstResolved;
      }
      if (attempt < 3) {
        await sleep(500 * (attempt + 1));
        continue;
      }
      unavailableCache.add(key);
      return null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logGateway("custom_emoji_error", { customEmojiId: id, message, attempt, preferStatic });
      if (attempt < 3) {
        await sleep(500 * (attempt + 1));
        continue;
      }
      unavailableCache.add(key);
      return null;
    }
  }

  unavailableCache.add(key);
  return null;
}

export async function readAnimatedEmojiBytes(
  client: Client,
  emoji: string,
): Promise<{ data: Buffer; mime: string } | null> {
  const candidates = expandAnimatedEmojiCandidates(emoji);
  if (candidates.length === 0) return null;

  for (const value of candidates) {
    const key = cacheKey("animated", value);
    if (unavailableCache.has(key)) continue;
    const cached = bytesCache.get(key);
    if (cached) return cached;

    try {
      const result = (await client.invoke({
        _: "getAnimatedEmoji",
        emoji: value,
      })) as { sticker?: unknown };

      const fileId = pickTdlibFileId(result.sticker);
      if (fileId == null) {
        logGateway("animated_emoji_sticker_missing", {
          emoji: value,
          stickerKeys:
            result.sticker && typeof result.sticker === "object"
              ? Object.keys(result.sticker as object)
              : null,
        });
        continue;
      }

      const resolved = await readDownloadedFile(client, fileId, { emoji: value, source: "animated" });
      if (resolved) {
        bytesCache.set(key, resolved);
        return resolved;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logGateway("animated_emoji_error", { emoji: value, message });
    }
    unavailableCache.add(key);
  }

  for (const value of candidates) {
    unavailableCache.add(cacheKey("animated", value));
  }
  return null;
}

export async function readTelegramEmojiBytes(
  client: Client,
  options: { customEmojiId?: string; emoji?: string; preferStatic?: boolean },
): Promise<{ data: Buffer; mime: string } | null> {
  const customEmojiId = options.customEmojiId?.trim();
  if (customEmojiId) {
    return readCustomEmojiBytes(client, customEmojiId, {
      preferStatic: Boolean(options.preferStatic),
    });
  }
  const emoji = options.emoji?.trim();
  if (emoji) return readAnimatedEmojiBytes(client, emoji);
  return null;
}
