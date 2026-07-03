import type { FormattedTextSegment } from "../../../shared/formattedTextSegments";

/** Telegram bot commands: /name or /name@bot, 1–32 chars after /. */
const BOT_COMMAND_BODY = /[a-zA-Z][\w]{0,31}/;
const BOT_COMMAND_PATTERN = new RegExp(
  `(^|[\\s\\n])(\\/${BOT_COMMAND_BODY.source}(?:@[a-zA-Z0-9_]+)?)`,
  "g",
);

export function isMessageBotCommandText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return false;
  return new RegExp(`^\\/${BOT_COMMAND_BODY.source}(?:@[a-zA-Z0-9_]+)?$`).test(trimmed);
}

export function parseBotCommandsInText(input: string): FormattedTextSegment[] {
  if (!input) return [];

  const segments: FormattedTextSegment[] = [];
  let lastIndex = 0;
  const pattern = new RegExp(BOT_COMMAND_PATTERN.source, "g");
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(input)) !== null) {
    const prefix = match[1] ?? "";
    const command = match[2] ?? "";
    const start = match.index;
    const commandStart = start + prefix.length;

    if (commandStart > lastIndex) {
      segments.push({ kind: "text", text: input.slice(lastIndex, commandStart) });
    }

    if (command) {
      segments.push({ kind: "bot_command", text: command, command });
    }

    lastIndex = commandStart + command.length;
  }

  if (lastIndex < input.length) {
    segments.push({ kind: "text", text: input.slice(lastIndex) });
  }

  return segments.length > 0 ? segments : [{ kind: "text", text: input }];
}

/** Split plain-text runs into bot-command link segments (after URL link parsing). */
export function enrichSegmentsWithBotCommands(
  segments: FormattedTextSegment[],
): FormattedTextSegment[] {
  const enriched: FormattedTextSegment[] = [];
  for (const segment of segments) {
    if (segment.kind !== "text" || !segment.text) {
      enriched.push(segment);
      continue;
    }
    const parts = parseBotCommandsInText(segment.text);
    if (parts.length === 1 && parts[0]!.kind === "text") {
      enriched.push(segment);
    } else {
      enriched.push(...parts);
    }
  }
  return enriched;
}

export function messageTextContainsBotCommand(input: string): boolean {
  return parseBotCommandsInText(input).some((segment) => segment.kind === "bot_command");
}
