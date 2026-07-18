import type { MessageChatHistoryItem } from "./messageChatHistoryTypes";

/**
 * Fallback weight for media-only bubbles when `text` is empty.
 * Photos are tall in the list; under-weighting them let a 20k char page pull
 * 200+ media rows and freeze the tab on decode.
 */
const MEDIA_MESSAGE_CHAR_WEIGHT = 320;

/** Count characters used for history window budgets. */
export function messageCharacterWeight(item: MessageChatHistoryItem): number {
  const textLen = item.text?.length ?? 0;
  if (textLen > 0) return textLen;
  if (item.has_media || item.content_kind) return MEDIA_MESSAGE_CHAR_WEIGHT;
  return 1;
}

export function totalCharacterWeight(
  messages: readonly MessageChatHistoryItem[],
): number {
  let total = 0;
  for (const message of messages) {
    total += messageCharacterWeight(message);
  }
  return total;
}

export type CharacterRangeBounds = {
  startIndex: number;
  endIndex: number;
  charWeightAbove: number;
  charWeightBelow: number;
};

function findMessageIndexById(
  messages: readonly MessageChatHistoryItem[],
  messageId: number,
): number {
  if (messageId <= 0) return -1;
  return messages.findIndex((row) => row.telegram_message_id === messageId);
}

function expandUp(
  messages: readonly MessageChatHistoryItem[],
  anchorIndex: number,
  charBudget: number,
): { startIndex: number; charWeightAbove: number } {
  let startIndex = anchorIndex;
  let used = 0;
  for (let index = anchorIndex - 1; index >= 0; index -= 1) {
    const weight = messageCharacterWeight(messages[index]!);
    if (used > 0 && used + weight > charBudget) {
      startIndex = index;
      used += weight;
      break;
    }
    used += weight;
    startIndex = index;
    if (used >= charBudget) break;
  }
  return { startIndex, charWeightAbove: used };
}

function expandDown(
  messages: readonly MessageChatHistoryItem[],
  anchorIndex: number,
  charBudget: number,
): { endIndex: number; charWeightBelow: number } {
  let endIndex = anchorIndex;
  let used = messageCharacterWeight(messages[anchorIndex]!);
  for (let index = anchorIndex + 1; index < messages.length; index += 1) {
    const weight = messageCharacterWeight(messages[index]!);
    const withoutAnchor = used - messageCharacterWeight(messages[anchorIndex]!);
    if (withoutAnchor > 0 && withoutAnchor + weight > charBudget) {
      endIndex = index;
      used += weight;
      break;
    }
    used += weight;
    endIndex = index;
    if (used - messageCharacterWeight(messages[anchorIndex]!) >= charBudget) break;
  }
  return {
    endIndex,
    charWeightBelow: Math.max(0, used - messageCharacterWeight(messages[anchorIndex]!)),
  };
}

/**
 * Contiguous slice around `anchorIndex` within character budgets.
 * When the next message would exceed the budget, it is still included in full.
 */
export function sliceMessagesByCharacterBudget(
  messages: readonly MessageChatHistoryItem[],
  anchorIndex: number,
  charBudgetUp: number,
  charBudgetDown: number,
): CharacterRangeBounds {
  if (messages.length === 0) {
    return { startIndex: 0, endIndex: -1, charWeightAbove: 0, charWeightBelow: 0 };
  }
  const anchor = Math.max(0, Math.min(anchorIndex, messages.length - 1));
  const up = expandUp(messages, anchor, charBudgetUp);
  const down = expandDown(messages, anchor, charBudgetDown);
  return {
    startIndex: up.startIndex,
    endIndex: down.endIndex,
    charWeightAbove: up.charWeightAbove,
    charWeightBelow: down.charWeightBelow,
  };
}

export function sliceMessagesByCharacterBudgetAroundId(
  messages: readonly MessageChatHistoryItem[],
  anchorMessageId: number,
  charBudgetUp: number,
  charBudgetDown: number,
): CharacterRangeBounds {
  const anchorIndex = findMessageIndexById(messages, anchorMessageId);
  if (anchorIndex < 0) {
    if (messages.length === 0) {
      return { startIndex: 0, endIndex: -1, charWeightAbove: 0, charWeightBelow: 0 };
    }
    return sliceMessagesByCharacterBudget(
      messages,
      messages.length - 1,
      charBudgetUp,
      charBudgetDown,
    );
  }
  return sliceMessagesByCharacterBudget(
    messages,
    anchorIndex,
    charBudgetUp,
    charBudgetDown,
  );
}

/** Keep the newest `charBudget` characters (tail-anchored trim). */
export function trimMessagesToTailCharBudget(
  messages: MessageChatHistoryItem[],
  charBudget: number,
): MessageChatHistoryItem[] {
  if (messages.length === 0 || totalCharacterWeight(messages) <= charBudget) {
    return messages;
  }
  let startIndex = messages.length;
  let used = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const weight = messageCharacterWeight(messages[index]!);
    if (used > 0 && used + weight > charBudget) {
      startIndex = index;
      break;
    }
    used += weight;
    startIndex = index;
    if (used >= charBudget) break;
  }
  return messages.slice(startIndex);
}

/** Keep the oldest `charBudget` characters (head-anchored trim). */
export function trimMessagesToHeadCharBudget(
  messages: MessageChatHistoryItem[],
  charBudget: number,
): MessageChatHistoryItem[] {
  if (messages.length === 0 || totalCharacterWeight(messages) <= charBudget) {
    return messages;
  }
  let endIndex = -1;
  let used = 0;
  for (let index = 0; index < messages.length; index += 1) {
    const weight = messageCharacterWeight(messages[index]!);
    if (used > 0 && used + weight > charBudget) {
      endIndex = index;
      break;
    }
    used += weight;
    endIndex = index;
    if (used >= charBudget) break;
  }
  return messages.slice(0, endIndex + 1);
}

/** Trim loaded buffer to character budgets above and below `anchorMessageId`. */
export function trimMessagesAroundAnchorCharBudget(
  messages: MessageChatHistoryItem[],
  anchorMessageId: number,
  charBudgetUp: number,
  charBudgetDown: number,
): MessageChatHistoryItem[] {
  if (messages.length === 0) return messages;
  const anchorIndex = findMessageIndexById(messages, anchorMessageId);
  if (anchorIndex < 0) return messages;
  const anchorWeight = messageCharacterWeight(messages[anchorIndex]!);
  const maxTotal = charBudgetUp + charBudgetDown + anchorWeight;
  if (totalCharacterWeight(messages) <= maxTotal) return messages;
  const bounds = sliceMessagesByCharacterBudget(
    messages,
    anchorIndex,
    charBudgetUp,
    charBudgetDown,
  );
  if (bounds.endIndex < bounds.startIndex) return messages;
  return messages.slice(bounds.startIndex, bounds.endIndex + 1);
}

export function resolveScrollAnchorMessageId(
  messages: readonly MessageChatHistoryItem[],
  options: {
    anchorMessageId?: number | null;
    atTop?: boolean;
    atBottom?: boolean;
    topVisibleMessageId?: number | null;
  },
): number {
  if (messages.length === 0) return 0;
  if (options.atBottom) {
    return messages[messages.length - 1]!.telegram_message_id;
  }
  if (options.atTop) {
    return messages[0]!.telegram_message_id;
  }
  if (options.topVisibleMessageId != null && options.topVisibleMessageId > 0) {
    return options.topVisibleMessageId;
  }
  if (options.anchorMessageId != null && options.anchorMessageId > 0) {
    const index = findMessageIndexById(messages, options.anchorMessageId);
    if (index >= 0) return options.anchorMessageId;
  }
  return messages[Math.max(0, messages.length - 1)]!.telegram_message_id;
}
