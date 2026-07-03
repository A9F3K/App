import type { FormattedTextSegment } from "../../../shared/formattedTextSegments";
import {
  enrichSegmentsWithStandardEmojis,
  normalizeFormattedTextSegments,
  segmentsContainTelegramEmoji,
} from "../../../shared/formattedTextSegments";
import { parseMessageTextLinks } from "./parseMessageTextLinks";
import { enrichSegmentsWithBotCommands } from "./parseMessageBotCommands";

const PICTOGRAPHIC_EMOJI_PATTERN = /\p{Extended_Pictographic}/u;

export function textContainsPictographicEmoji(text: string): boolean {
  return PICTOGRAPHIC_EMOJI_PATTERN.test(text);
}

/** Chat titles are plain strings in TDLib — upgrade Unicode emoji to animated fetches. */
export function resolveTitleDisplaySegments(title: string): FormattedTextSegment[] | null {
  const trimmed = title.trim();
  if (!trimmed || !textContainsPictographicEmoji(trimmed)) return null;
  return enrichSegmentsWithStandardEmojis([{ kind: "text", text: trimmed }]);
}

/** Unified bubble/list segment pipeline — same formatting for cached, live, and paged history. */
export function resolveMessageDisplaySegments(
  text: string,
  segments?: FormattedTextSegment[] | null,
): FormattedTextSegment[] | null {
  const normalized = normalizeFormattedTextSegments(segments);
  const trimmed = text.trim();
  let base =
    normalized ??
    (trimmed
      ? (parseMessageTextLinks(trimmed) as FormattedTextSegment[])
      : null);
  if (!base?.length) return null;
  base = enrichSegmentsWithBotCommands(base);
  return enrichSegmentsWithStandardEmojis(base);
}

export function preferRicherTextSegments(
  preferred: FormattedTextSegment[] | null | undefined,
  fallback: FormattedTextSegment[] | null | undefined,
): FormattedTextSegment[] | null {
  if (!preferred?.length) return fallback ?? null;
  if (!fallback?.length) return preferred;
  const preferredHasEmoji = segmentsContainTelegramEmoji(preferred);
  const fallbackHasEmoji = segmentsContainTelegramEmoji(fallback);
  if (preferredHasEmoji && !fallbackHasEmoji) return preferred;
  if (fallbackHasEmoji && !preferredHasEmoji) return fallback;
  return preferred;
}

export function formattedSegmentsEqual(
  a: FormattedTextSegment[] | null | undefined,
  b: FormattedTextSegment[] | null | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return !a && !b;
  if (a.length !== b.length) return false;
  return a.every((seg, index) => {
    const other = b[index];
    if (!other || seg.kind !== other.kind || seg.text !== other.text) return false;
    if (seg.kind === "link" && other.kind === "link") return seg.url === other.url;
    if (seg.kind === "bot_command" && other.kind === "bot_command") {
      return seg.command === other.command;
    }
    if (seg.kind === "custom_emoji" && other.kind === "custom_emoji") {
      return seg.custom_emoji_id === other.custom_emoji_id;
    }
    if (seg.kind === "animated_emoji" && other.kind === "animated_emoji") {
      return seg.emoji === other.emoji;
    }
    return true;
  });
}
