import fs from "fs";
import type { Client } from "tdl";
import { parseCustomEmojiId, parseTdlibFileId, readCustomEmojiIdField } from "../../shared/telegramCustomEmojiId.js";
import {
  normalizeTelegramProfilePhotoMarkup,
  parseTdlibBackgroundFill,
  type TelegramProfilePhotoMarkup,
} from "../../shared/telegramProfilePhoto.js";
import { logGateway } from "./gatewayLog.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function pickFirstRecord(
  source: Record<string, unknown>,
  keys: string[],
): Record<string, unknown> | null {
  for (const key of keys) {
    const row = asRecord(source[key]);
    if (row) return row;
  }
  return null;
}

function fileIdFromTdFile(value: unknown): number | null {
  const direct = parseTdlibFileId(value);
  if (direct != null) return direct;
  const row = asRecord(value);
  if (!row) return null;
  return parseTdlibFileId(row.id) ?? parseTdlibFileId(row.file);
}

function animationFileId(photo: Record<string, unknown>, preferSmall: boolean): number | null {
  const small = asRecord(photo.small_animation ?? photo.smallAnimation);
  const big = asRecord(photo.animation);
  const first = preferSmall ? small ?? big : big ?? small;
  if (!first) return null;
  return fileIdFromTdFile(first.file ?? first);
}

function markupFromChatPhoto(photo: Record<string, unknown> | null): TelegramProfilePhotoMarkup | null {
  if (!photo) return null;
  const sticker = asRecord(photo.sticker);
  const type = asRecord(sticker?.type);
  const customEmojiId =
    (type ? readCustomEmojiIdField(type) : null) ??
    parseCustomEmojiId(type?.custom_emoji_id) ??
    parseCustomEmojiId(type?.customEmojiId) ??
    (sticker ? readCustomEmojiIdField(sticker) : null);
  const fill = parseTdlibBackgroundFill(sticker?.background_fill ?? sticker?.backgroundFill);
  const hasAnimation = Boolean(
    animationFileId(photo, true) ?? animationFileId(photo, false),
  );
  const addedRaw = photo.added_date ?? photo.addedDate;
  const addedSec =
    typeof addedRaw === "number" && Number.isFinite(addedRaw) && addedRaw > 0
      ? Math.trunc(addedRaw)
      : typeof addedRaw === "string" && /^\d+$/.test(addedRaw.trim())
        ? Number(addedRaw.trim())
        : null;
  const added_at =
    addedSec != null && addedSec > 0 ? new Date(addedSec * 1000).toISOString() : null;
  if (!customEmojiId && !fill && !hasAnimation && !added_at) return null;
  return {
    custom_emoji_id: customEmojiId,
    fill,
    has_animation: hasAnimation,
    added_at,
  };
}

export function pickChatPhotoFromUserFullInfo(
  full: Record<string, unknown>,
): Record<string, unknown> | null {
  return (
    pickFirstRecord(full, ["personal_photo", "personalPhoto"]) ??
    pickFirstRecord(full, ["photo"]) ??
    pickFirstRecord(full, ["public_photo", "publicPhoto"])
  );
}

export function profilePhotoHasAnimationFlag(user: Record<string, unknown> | null): boolean {
  const photo = asRecord(user?.profile_photo ?? user?.profilePhoto);
  return photo?.has_animation === true || photo?.hasAnimation === true;
}

async function loadFirstUserProfilePhoto(
  client: Client,
  userId: number,
): Promise<Record<string, unknown> | null> {
  try {
    const list = (await client.invoke({
      _: "getUserProfilePhotos",
      user_id: userId,
      offset: 0,
      limit: 1,
    })) as { photos?: unknown[] };
    return Array.isArray(list.photos) ? asRecord(list.photos[0]) : null;
  } catch {
    return null;
  }
}

export async function resolveUserChatPhoto(
  client: Client,
  userId: number,
): Promise<Record<string, unknown> | null> {
  try {
    const full = (await client.invoke({
      _: "getUserFullInfo",
      user_id: userId,
    })) as Record<string, unknown>;
    const fromFull = pickChatPhotoFromUserFullInfo(full);
    if (fromFull) return fromFull;
  } catch {
    /* fall through to photo list */
  }
  return loadFirstUserProfilePhoto(client, userId);
}

export async function resolveUserProfilePhotoMarkup(
  client: Client,
  userId: number,
  user?: Record<string, unknown> | null,
  full?: Record<string, unknown> | null,
): Promise<TelegramProfilePhotoMarkup | null> {
  let photo = full ? pickChatPhotoFromUserFullInfo(full) : null;
  let source: "userFullInfo" | "getUserProfilePhotos" | "none" = photo ? "userFullInfo" : "none";
  if (!photo) {
    photo = await loadFirstUserProfilePhoto(client, userId);
    if (photo) source = "getUserProfilePhotos";
  }
  const markup = markupFromChatPhoto(photo);
  const hasAnimationFlag = profilePhotoHasAnimationFlag(user ?? null);
  const merged = markup
    ? { ...markup, has_animation: markup.has_animation || hasAnimationFlag }
    : hasAnimationFlag
      ? { custom_emoji_id: null, fill: null, has_animation: true, added_at: null }
      : null;
  if (merged) {
    logGateway("user_profile_photo_markup", {
      userId,
      source,
      customEmojiId: merged.custom_emoji_id,
      fillKind: merged.fill?.kind ?? null,
      hasAnimation: merged.has_animation,
    });
  }
  return merged ? normalizeTelegramProfilePhotoMarkup(merged) : null;
}

type TdFile = {
  local?: {
    path?: string;
    is_downloading_completed?: boolean;
    is_downloading_active?: boolean;
  };
};

const ANIMATION_DOWNLOAD_TIMEOUT_MS = 20_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mimeFromAnimationPath(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".webm")) return "video/webm";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  return "video/mp4";
}

async function waitForLocalFile(client: Client, fileId: number): Promise<TdFile | null> {
  const deadline = Date.now() + ANIMATION_DOWNLOAD_TIMEOUT_MS;
  let syncAttempted = false;
  while (Date.now() < deadline) {
    try {
      const file = (await client.invoke({ _: "getFile", file_id: fileId })) as TdFile;
      if (file.local?.is_downloading_completed && file.local.path) return file;
      if (!file.local?.is_downloading_active && !file.local?.is_downloading_completed) {
        await client.invoke({
          _: "downloadFile",
          file_id: fileId,
          priority: 24,
          offset: 0,
          limit: 0,
          synchronous: syncAttempted,
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

export async function readUserAvatarAnimationBytes(
  client: Client,
  userId: number,
): Promise<{ data: Buffer; mime: string } | "no_avatar" | null> {
  const photo = await resolveUserChatPhoto(client, userId);
  if (!photo) return "no_avatar";
  const fileId = animationFileId(photo, true) ?? animationFileId(photo, false);
  if (fileId == null) return "no_avatar";
  for (let attempt = 0; attempt < 2; attempt++) {
    const file = await waitForLocalFile(client, fileId);
    const path = file?.local?.path;
    if (!path || !fs.existsSync(path)) continue;
    try {
      const data = fs.readFileSync(path);
      if (data.length === 0) continue;
      return { data, mime: mimeFromAnimationPath(path) };
    } catch {
      /* retry */
    }
  }
  return null;
}
