import type { FormattedTextSegment } from "../../../shared/formattedTextSegments";

/** @username mentions (not emails). Min length 3 to match t.me public usernames. */
const MENTION_PATTERN = /(?<![A-Za-z0-9._])@([A-Za-z][A-Za-z0-9_]{2,})\b/g;

function splitTextWithMentions(text: string): FormattedTextSegment[] {
  if (!text) return [];
  const out: FormattedTextSegment[] = [];
  let last = 0;
  const pattern = new RegExp(MENTION_PATTERN.source, "g");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const start = match.index;
    if (start > last) {
      out.push({ kind: "text", text: text.slice(last, start) });
    }
    const username = match[1]!;
    out.push({
      kind: "link",
      text: match[0]!,
      url: `https://t.me/${username}`,
    });
    last = start + match[0]!.length;
  }
  if (last < text.length) {
    out.push({ kind: "text", text: text.slice(last) });
  }
  return out.length > 0 ? out : [{ kind: "text", text }];
}

/** Turn bare @username tokens in text segments into in-app t.me links. */
export function enrichSegmentsWithMentions(
  segments: FormattedTextSegment[],
): FormattedTextSegment[] {
  const out: FormattedTextSegment[] = [];
  for (const segment of segments) {
    if (segment.kind !== "text" || !segment.text.includes("@")) {
      out.push(segment);
      continue;
    }
    out.push(...splitTextWithMentions(segment.text));
  }
  return out;
}
