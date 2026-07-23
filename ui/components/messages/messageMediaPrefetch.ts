import { buildApiUrl } from "../../../api/_base";
import { logPageDisplay } from "../../pageDisplayLog";
import {
  isDisplayableMediaMessage,
  type MessageChatHistoryItem,
} from "./messageChatHistoryTypes";
import {
  getCachedMessageMedia,
  prefetchMessageMedia,
} from "./messageMediaBlobCache";
import { resolvePreviewMediaUrl } from "./MessageChatMediaContent";
import { MESSAGE_CHAT_EDGE_PREFETCH_SCREENS } from "./messageChatLayout";
import { isVoiceDialogUiOpen } from "./voiceDialogUiGate";

/** Cap concurrent full-photo warmups per display-window tick (tdesktop nearby band). */
const DISPLAY_FULL_PREFETCH_MAX = 8;
const DISPLAY_PREVIEW_PREFETCH_MAX = 16;

type LayoutEntry = { y: number; height: number };

const lastPrefetchSignature = new Map<number, string>();

function resolveMediaUrl(chatId: number, messageId: number): string {
  return buildApiUrl(
    `/api/telegram-messages-media?chat_id=${chatId}&message_id=${messageId}`,
  );
}

/**
 * Warm photo preview + full blobs for the painted display window so scroll arrives
 * at already-decoded images (tdesktop: preload around viewport / in-window media).
 */
export function prefetchDisplayChatMedia(
  chatId: number,
  messages: readonly MessageChatHistoryItem[],
  options?: {
    scrollY?: number;
    layoutH?: number;
    layouts?: Map<number, LayoutEntry> | null;
    contentActive?: boolean;
  },
): void {
  if (isVoiceDialogUiOpen()) return;
  if (!Number.isFinite(chatId) || messages.length === 0) return;
  if (options?.contentActive === false) return;

  const scrollY = options?.scrollY ?? 0;
  const layoutH = Math.max(1, options?.layoutH ?? 480);
  const preloadBandPx = layoutH * MESSAGE_CHAT_EDGE_PREFETCH_SCREENS;
  const layouts = options?.layouts ?? null;

  const headId = messages[0]?.telegram_message_id ?? 0;
  const tailId = messages[messages.length - 1]?.telegram_message_id ?? 0;
  // Re-run when the painted window moves; scroll bucketing also refreshes heavy video band.
  const signature = `${messages.length}:${headId}:${tailId}:${Math.round(scrollY / layoutH)}`;
  if (lastPrefetchSignature.get(chatId) === signature) return;
  lastPrefetchSignature.set(chatId, signature);

  let previewQueued = 0;
  let fullQueued = 0;

  for (const item of messages) {
    if (!isDisplayableMediaMessage(item)) continue;
    const kind = item.content_kind ?? "other";
    const isPhoto = kind === "photo";
    const isStreamable = kind === "video" || kind === "animation";
    if (!isPhoto && !isStreamable && kind !== "sticker") continue;

    const uri = resolveMediaUrl(chatId, item.telegram_message_id);
    const previewUri = resolvePreviewMediaUrl(uri);

    if (previewQueued < DISPLAY_PREVIEW_PREFETCH_MAX && !getCachedMessageMedia(previewUri)) {
      // Keep off the critical/high lanes so visible mounts from MessageChatMediaContent win.
      prefetchMessageMedia(previewUri, { priority: "normal", preview: true });
      previewQueued += 1;
    }

    // Photos + stickers: full bytes only inside the preload band (was the whole
    // 80-message window — 35× full JPEGs at chat open froze the tab alongside voice).
    // Video/gif: same band rule.
    let wantFull = false;
    if (isPhoto || kind === "sticker" || isStreamable) {
      if (layouts) {
        const entry = layouts.get(item.telegram_message_id);
        if (entry) {
          const top = entry.y;
          const bottom = entry.y + entry.height;
          wantFull =
            bottom >= scrollY - preloadBandPx && top <= scrollY + layoutH + preloadBandPx;
        }
      } else if (isPhoto || kind === "sticker") {
        // No layouts yet (first paint): warm a small head of the window only.
        wantFull = fullQueued < 4;
      }
    }

    if (wantFull && fullQueued < DISPLAY_FULL_PREFETCH_MAX && !getCachedMessageMedia(uri)) {
      prefetchMessageMedia(uri, { priority: "normal", preview: false });
      fullQueued += 1;
    }
  }

  if (previewQueued > 0 || fullQueued > 0) {
    logPageDisplay("messages_media_prefetch_display", {
      chatId,
      displayCount: messages.length,
      previewQueued,
      fullQueued,
      scrollY: Math.round(scrollY),
      layoutH: Math.round(layoutH),
      preloadBandPx: Math.round(preloadBandPx),
    });
  }
}

export function clearDisplayChatMediaPrefetchSignature(chatId: number): void {
  lastPrefetchSignature.delete(chatId);
}
