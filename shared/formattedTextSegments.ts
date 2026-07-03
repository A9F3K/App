import { parseCustomEmojiId } from "./telegramCustomEmojiId";

export type FormattedTextSegment =
  | { kind: "text"; text: string }
  | { kind: "link"; text: string; url: string }
  | { kind: "bot_command"; text: string; command: string }
  | { kind: "custom_emoji"; text: string; custom_emoji_id: string }
  | { kind: "animated_emoji"; text: string; emoji: string };

export function segmentsPlainText(segments: FormattedTextSegment[]): string {
  return segments.map((segment) => segment.text).join("");
}

export function segmentsContainTelegramEmoji(segments: FormattedTextSegment[]): boolean {
  return segments.some((segment) => segment.kind === "custom_emoji" || segment.kind === "animated_emoji");
}

/** Custom emoji replacing a word/phrase (e.g. styled "Alipay") — not a single pictograph slot. */
export function isCustomEmojiTextLabel(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (/\p{Extended_Pictographic}/u.test(trimmed)) return false;
  return trimmed.length > 1;
}

/** @deprecated Use {@link segmentsContainTelegramEmoji}. */
export function segmentsContainCustomEmoji(segments: FormattedTextSegment[]): boolean {
  return segmentsContainTelegramEmoji(segments);
}

const UNICODE_EMOJI_PATTERN =
  /\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?)*/gu;

function splitTextIntoAnimatedEmojiSegments(text: string): FormattedTextSegment[] {
  if (!text) return [];
  const segments: FormattedTextSegment[] = [];
  let lastIndex = 0;
  const pattern = new RegExp(UNICODE_EMOJI_PATTERN.source, "gu");
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    const start = match.index;
    if (start > lastIndex) {
      segments.push({ kind: "text", text: text.slice(lastIndex, start) });
    }
    const emoji = match[0];
    segments.push({ kind: "animated_emoji", text: emoji, emoji });
    lastIndex = start + emoji.length;
  }

  if (lastIndex < text.length) {
    segments.push({ kind: "text", text: text.slice(lastIndex) });
  }

  return segments.length > 0 ? segments : [{ kind: "text", text }];
}

/** Split plain text segments into Telegram animated-emoji segments (client-side fallback). */
export function enrichSegmentsWithStandardEmojis(segments: FormattedTextSegment[]): FormattedTextSegment[] {
  if (segments.some((segment) => segment.kind === "animated_emoji")) {
    return segments;
  }
  const enriched: FormattedTextSegment[] = [];
  for (const segment of segments) {
    if (segment.kind !== "text" || !segment.text) {
      enriched.push(segment);
      continue;
    }
    enriched.push(...splitTextIntoAnimatedEmojiSegments(segment.text));
  }
  return enriched;
}

export function normalizeFormattedTextSegments(raw: unknown): FormattedTextSegment[] | null {
  if (!Array.isArray(raw)) return null;
  const segments: FormattedTextSegment[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (row.kind === "text" && typeof row.text === "string") {
      segments.push({ kind: "text", text: row.text });
      continue;
    }
    if (row.kind === "link" && typeof row.text === "string" && typeof row.url === "string") {
      segments.push({ kind: "link", text: row.text, url: row.url });
      continue;
    }
    if (row.kind === "bot_command" && typeof row.text === "string" && typeof row.command === "string") {
      const command = row.command.trim();
      if (command.startsWith("/")) {
        segments.push({ kind: "bot_command", text: row.text, command });
      }
      continue;
    }
    if (row.kind === "custom_emoji" && typeof row.text === "string") {
      const customEmojiId = parseCustomEmojiId(row.custom_emoji_id);
      if (!customEmojiId) continue;
      segments.push({
        kind: "custom_emoji",
        text: row.text,
        custom_emoji_id: customEmojiId,
      });
      continue;
    }
    if (row.kind === "animated_emoji" && typeof row.text === "string" && typeof row.emoji === "string") {
      const emoji = row.emoji.trim();
      if (emoji) {
        segments.push({ kind: "animated_emoji", text: row.text, emoji });
      }
    }
  }
  return segments.length > 0 ? segments : null;
}
