import type { MessageChatHistoryItem } from "../components/messages/messageChatHistoryTypes";
import {
  messageCharacterWeight,
  sliceMessagesByCharacterBudget,
  totalCharacterWeight,
  trimMessagesAroundAnchorCharBudget,
  trimMessagesToTailCharBudget,
} from "../components/messages/messageChatCharacterRange";
import { resolveFirstUnreadMessageId, resolveLastReadMessageId } from "../components/messages/messageListLayout";
import { MESSAGE_CHAT_HISTORY_PAGE_SIZE } from "../components/messages/messageChatLayout";
import {
  fetchTelegramChatHistoryPage,
  type ChatHistoryPageResult,
} from "./fetchTelegramChatHistoryPage";
import { warmupTelegramChatSession } from "./warmupTelegramChatSession";

const FETCH_PAGE_SIZE = MESSAGE_CHAT_HISTORY_PAGE_SIZE;
const MAX_FETCH_ROUNDS = 40;

function seedContextMessageCount(charBudget: number): number {
  return Math.max(4, Math.min(30, Math.ceil(charBudget / 400)));
}

function mergeSortedMessages(
  existing: MessageChatHistoryItem[],
  incoming: MessageChatHistoryItem[],
): MessageChatHistoryItem[] {
  const byId = new Map<number, MessageChatHistoryItem>();
  for (const row of existing) byId.set(row.telegram_message_id, row);
  for (const row of incoming) byId.set(row.telegram_message_id, row);
  return [...byId.values()].sort((a, b) => {
    const byTime = Date.parse(a.sent_at) - Date.parse(b.sent_at);
    if (byTime !== 0) return byTime;
    return a.telegram_message_id - b.telegram_message_id;
  });
}

async function fetchPageWithWarmup(
  chatId: number,
  peerUserId: number | null | undefined,
  beforeMessageId?: number | null,
  sinceMessageId?: number | null,
  aroundUnread = false,
  aroundMessageId?: number | null,
  olderAbove?: number | null,
  newerBelow?: number | null,
): Promise<ChatHistoryPageResult> {
  let result = await fetchTelegramChatHistoryPage(
    chatId,
    FETCH_PAGE_SIZE,
    peerUserId,
    beforeMessageId,
    sinceMessageId,
    aroundUnread,
    aroundMessageId,
    olderAbove,
    newerBelow,
  );
  if (
    result.error === "session_not_ready" ||
    result.error === "history_unavailable"
  ) {
    await warmupTelegramChatSession(chatId);
    result = await fetchTelegramChatHistoryPage(
      chatId,
      FETCH_PAGE_SIZE,
      peerUserId,
      beforeMessageId,
      sinceMessageId,
      aroundUnread,
      aroundMessageId,
      olderAbove,
      newerBelow,
    );
  }
  return result;
}

export type CharacterRangeHistoryResult = ChatHistoryPageResult & {
  anchorMessageId: number | null;
};

function applyPageMeta(
  target: {
    chatKind: ChatHistoryPageResult["chatKind"];
    hasMoreOlder: boolean;
    nextBeforeMessageId: number | null;
    lastReadOutboxMessageId: number | null;
    lastReadInboxMessageId: number | null;
    memberCount: number | null;
    selfUserId: number | null;
  },
  page: ChatHistoryPageResult,
): void {
  target.chatKind = page.chatKind ?? target.chatKind;
  target.hasMoreOlder = page.hasMoreOlder;
  target.nextBeforeMessageId = page.nextBeforeMessageId;
  if (page.lastReadOutboxMessageId != null) {
    target.lastReadOutboxMessageId = page.lastReadOutboxMessageId;
  }
  if (page.lastReadInboxMessageId != null) {
    target.lastReadInboxMessageId = page.lastReadInboxMessageId;
  }
  target.memberCount = page.memberCount ?? target.memberCount;
  target.selfUserId = page.selfUserId ?? target.selfUserId;
}

/** Load `charBudget` characters upward from the chat tail (open at bottom). */
export async function fetchChatHistoryTailCharBudget(
  chatId: number,
  peerUserId: number | null | undefined,
  charBudget: number,
): Promise<CharacterRangeHistoryResult> {
  let messages: MessageChatHistoryItem[] = [];
  let hasMoreOlder = false;
  let nextBeforeMessageId: number | null = null;
  let chatKind: ChatHistoryPageResult["chatKind"] = null;
  let lastReadOutboxMessageId: number | null = null;
  let lastReadInboxMessageId: number | null = null;
  let memberCount: number | null = null;
  let selfUserId: number | null = null;
  let cursor: number | null = null;

  for (let round = 0; round < MAX_FETCH_ROUNDS; round += 1) {
    const result = await fetchPageWithWarmup(chatId, peerUserId, cursor);
    if (result.error) {
      return { ...result, messages, anchorMessageId: null };
    }
    chatKind = result.chatKind;
    lastReadOutboxMessageId = result.lastReadOutboxMessageId ?? lastReadOutboxMessageId;
    lastReadInboxMessageId = result.lastReadInboxMessageId ?? lastReadInboxMessageId;
    memberCount = result.memberCount;
    selfUserId = result.selfUserId;
    if (result.messages.length === 0) {
      hasMoreOlder = result.hasMoreOlder;
      nextBeforeMessageId = result.nextBeforeMessageId;
      break;
    }
    messages =
      cursor == null
        ? result.messages
        : mergeSortedMessages(result.messages, messages);
    hasMoreOlder = result.hasMoreOlder;
    nextBeforeMessageId = result.nextBeforeMessageId;
    if (totalCharacterWeight(messages) >= charBudget) break;
    if (!result.hasMoreOlder || result.nextBeforeMessageId == null) break;
    cursor = result.nextBeforeMessageId;
  }

  messages = trimMessagesToTailCharBudget(messages, charBudget);
  const anchorMessageId =
    messages.length > 0 ? messages[messages.length - 1]!.telegram_message_id : null;

  return {
    messages,
    chatKind,
    error: null,
    hasMoreOlder,
    nextBeforeMessageId,
    lastReadOutboxMessageId,
    lastReadInboxMessageId,
    memberCount,
    selfUserId,
    anchorMessageId,
  };
}

/** Load `charBudget` characters downward from the oldest fetched page (open at top). */
export async function fetchChatHistoryHeadCharBudget(
  chatId: number,
  peerUserId: number | null | undefined,
  charBudget: number,
): Promise<CharacterRangeHistoryResult> {
  let messages: MessageChatHistoryItem[] = [];
  let cursor: number | null = null;
  let hasMoreOlder = false;
  let nextBeforeMessageId: number | null = null;
  let chatKind: ChatHistoryPageResult["chatKind"] = null;
  let lastReadOutboxMessageId: number | null = null;
  let lastReadInboxMessageId: number | null = null;
  let memberCount: number | null = null;
  let selfUserId: number | null = null;

  for (let round = 0; round < MAX_FETCH_ROUNDS; round += 1) {
    const result = await fetchPageWithWarmup(chatId, peerUserId, cursor);
    if (result.error) {
      return { ...result, messages, anchorMessageId: null };
    }
    chatKind = result.chatKind;
    lastReadOutboxMessageId = result.lastReadOutboxMessageId ?? lastReadOutboxMessageId;
    lastReadInboxMessageId = result.lastReadInboxMessageId ?? lastReadInboxMessageId;
    memberCount = result.memberCount;
    selfUserId = result.selfUserId;
    if (result.messages.length === 0) break;
    messages =
      cursor == null
        ? result.messages
        : mergeSortedMessages(result.messages, messages);
    hasMoreOlder = result.hasMoreOlder;
    nextBeforeMessageId = result.nextBeforeMessageId;
    const bounds = sliceMessagesByCharacterBudget(messages, 0, 0, charBudget);
    if (bounds.endIndex >= bounds.startIndex) {
      let downWeight = 0;
      for (let index = bounds.startIndex; index <= bounds.endIndex; index += 1) {
        downWeight += messageCharacterWeight(messages[index]!);
      }
      if (downWeight >= charBudget) break;
    }
    if (!result.hasMoreOlder || result.nextBeforeMessageId == null) break;
    cursor = result.nextBeforeMessageId;
  }

  if (messages.length === 0) {
    return {
      messages,
      chatKind,
      error: null,
      hasMoreOlder,
      nextBeforeMessageId,
      lastReadOutboxMessageId,
      lastReadInboxMessageId,
      memberCount,
      selfUserId,
      anchorMessageId: null,
    };
  }

  const bounds = sliceMessagesByCharacterBudget(messages, 0, 0, charBudget);
  const sliced =
    bounds.endIndex >= bounds.startIndex
      ? messages.slice(bounds.startIndex, bounds.endIndex + 1)
      : messages;
  const anchorMessageId = sliced[0]?.telegram_message_id ?? null;

  return {
    messages: sliced,
    chatKind,
    error: null,
    hasMoreOlder,
    nextBeforeMessageId,
    lastReadOutboxMessageId,
    lastReadInboxMessageId,
    memberCount,
    selfUserId,
    anchorMessageId,
  };
}

type AroundCharBudgetOptions = {
  /** Reuse an already-fetched page (e.g. around-unread seed) instead of re-requesting. */
  seedResult?: ChatHistoryPageResult;
};

/** Load symmetric character windows around a message id. */
export async function fetchChatHistoryAroundCharBudget(
  chatId: number,
  peerUserId: number | null | undefined,
  anchorMessageId: number,
  charBudgetUp: number,
  charBudgetDown: number,
  options?: AroundCharBudgetOptions,
): Promise<CharacterRangeHistoryResult> {
  const anchorId = Math.trunc(anchorMessageId);
  let messages: MessageChatHistoryItem[] = [];
  const pageMeta = {
    chatKind: null as ChatHistoryPageResult["chatKind"],
    hasMoreOlder: false,
    nextBeforeMessageId: null as number | null,
    lastReadOutboxMessageId: null as number | null,
    lastReadInboxMessageId: null as number | null,
    memberCount: null as number | null,
    selfUserId: null as number | null,
  };

  const seed = options?.seedResult;
  if (seed && !seed.error) {
    messages = seed.messages;
    applyPageMeta(pageMeta, seed);
  } else {
    const contextUp = seedContextMessageCount(charBudgetUp);
    const contextDown = seedContextMessageCount(charBudgetDown);
    const aroundSeed = await fetchPageWithWarmup(
      chatId,
      peerUserId,
      null,
      null,
      false,
      anchorId,
      contextUp,
      contextDown,
    );
    if (aroundSeed.error) {
      return { ...aroundSeed, anchorMessageId: anchorId };
    }
    messages = aroundSeed.messages;
    applyPageMeta(pageMeta, aroundSeed);
  }

  if (!messages.some((row) => row.telegram_message_id === anchorId)) {
    const contextUp = seedContextMessageCount(charBudgetUp);
    const contextDown = seedContextMessageCount(charBudgetDown);
    const aroundSeed = await fetchPageWithWarmup(
      chatId,
      peerUserId,
      null,
      null,
      false,
      anchorId,
      contextUp,
      contextDown,
    );
    if (aroundSeed.error) {
      return { ...aroundSeed, anchorMessageId: anchorId };
    }
    messages = mergeSortedMessages(messages, aroundSeed.messages);
    applyPageMeta(pageMeta, aroundSeed);
  }

  let olderCursor =
    pageMeta.nextBeforeMessageId ??
    (messages.length > 0 ? messages[0]!.telegram_message_id : null);
  for (let round = 0; round < MAX_FETCH_ROUNDS; round += 1) {
    const anchorIndex = messages.findIndex(
      (row) => row.telegram_message_id === anchorId,
    );
    if (anchorIndex < 0) break;
    let usedUp = 0;
    for (let index = anchorIndex - 1; index >= 0; index -= 1) {
      usedUp += messageCharacterWeight(messages[index]!);
    }
    if (usedUp >= charBudgetUp) break;
    if (olderCursor == null) break;
    const older = await fetchPageWithWarmup(chatId, peerUserId, olderCursor);
    if (older.error) {
      pageMeta.hasMoreOlder = older.hasMoreOlder;
      pageMeta.nextBeforeMessageId = older.nextBeforeMessageId;
      break;
    }
    if (older.messages.length === 0) {
      pageMeta.hasMoreOlder = older.hasMoreOlder;
      pageMeta.nextBeforeMessageId = older.nextBeforeMessageId;
      break;
    }
    messages = mergeSortedMessages(older.messages, messages);
    pageMeta.hasMoreOlder = older.hasMoreOlder;
    pageMeta.nextBeforeMessageId = older.nextBeforeMessageId;
    olderCursor =
      older.nextBeforeMessageId ??
      older.messages[0]?.telegram_message_id ??
      messages[0]?.telegram_message_id ??
      null;
    applyPageMeta(pageMeta, older);
  }

  for (let round = 0; round < MAX_FETCH_ROUNDS; round += 1) {
    const anchorIndex = messages.findIndex(
      (row) => row.telegram_message_id === anchorId,
    );
    if (anchorIndex < 0) break;
    let usedDown = 0;
    for (let index = anchorIndex + 1; index < messages.length; index += 1) {
      usedDown += messageCharacterWeight(messages[index]!);
    }
    if (usedDown >= charBudgetDown) break;
    const tailId = messages[messages.length - 1]?.telegram_message_id ?? 0;
    if (tailId <= 0) break;
    const newer = await fetchPageWithWarmup(chatId, peerUserId, null, tailId);
    if (newer.error || newer.messages.length === 0) break;
    messages = mergeSortedMessages(messages, newer.messages);
    applyPageMeta(pageMeta, newer);
  }

  messages = trimMessagesAroundAnchorCharBudget(
    messages,
    anchorId,
    charBudgetUp,
    charBudgetDown,
  );

  const oldestId = messages[0]?.telegram_message_id ?? null;
  if (oldestId != null) {
    pageMeta.nextBeforeMessageId = oldestId;
  }

  return {
    messages,
    chatKind: pageMeta.chatKind,
    error: null,
    hasMoreOlder: pageMeta.hasMoreOlder,
    nextBeforeMessageId: pageMeta.nextBeforeMessageId,
    lastReadOutboxMessageId: pageMeta.lastReadOutboxMessageId,
    lastReadInboxMessageId: pageMeta.lastReadInboxMessageId,
    memberCount: pageMeta.memberCount,
    selfUserId: pageMeta.selfUserId,
    anchorMessageId: anchorId,
  };
}

/** Open on the unread divider: one around-unread seed, then expand around last-read. */
export async function fetchChatHistoryAroundUnreadCharBudget(
  chatId: number,
  peerUserId: number | null | undefined,
  charBudgetUp: number,
  charBudgetDown: number,
): Promise<CharacterRangeHistoryResult> {
  const unreadSeed = await fetchPageWithWarmup(
    chatId,
    peerUserId,
    null,
    null,
    true,
  );
  if (unreadSeed.error) {
    return { ...unreadSeed, anchorMessageId: null };
  }

  const firstUnread = resolveFirstUnreadMessageId(
    unreadSeed.messages,
    unreadSeed.lastReadInboxMessageId,
  );
  const lastReadId = resolveLastReadMessageId(
    unreadSeed.messages,
    unreadSeed.lastReadInboxMessageId,
  );
  const anchorId = lastReadId ?? firstUnread;
  if (anchorId == null) {
    const messages = trimMessagesToTailCharBudget(
      unreadSeed.messages,
      charBudgetUp + charBudgetDown,
    );
    return {
      messages,
      chatKind: unreadSeed.chatKind,
      error: null,
      hasMoreOlder: unreadSeed.hasMoreOlder,
      nextBeforeMessageId: unreadSeed.nextBeforeMessageId,
      lastReadOutboxMessageId: unreadSeed.lastReadOutboxMessageId,
      lastReadInboxMessageId: unreadSeed.lastReadInboxMessageId,
      memberCount: unreadSeed.memberCount,
      selfUserId: unreadSeed.selfUserId,
      anchorMessageId:
        messages.length > 0
          ? messages[messages.length - 1]!.telegram_message_id
          : null,
    };
  }

  return fetchChatHistoryAroundCharBudget(
    chatId,
    peerUserId,
    anchorId,
    charBudgetUp,
    charBudgetDown,
    { seedResult: unreadSeed },
  );
}

/** Fetch older history until `charBudget` characters are accumulated. */
export async function fetchOlderHistoryCharBudget(
  chatId: number,
  peerUserId: number | null | undefined,
  beforeMessageId: number,
  charBudget: number,
): Promise<ChatHistoryPageResult> {
  let messages: MessageChatHistoryItem[] = [];
  let cursor: number | null = Math.trunc(beforeMessageId);
  let hasMoreOlder = false;
  let nextBeforeMessageId: number | null = null;
  let chatKind: ChatHistoryPageResult["chatKind"] = null;
  let lastReadOutboxMessageId: number | null = null;
  let lastReadInboxMessageId: number | null = null;
  let memberCount: number | null = null;
  let selfUserId: number | null = null;

  for (let round = 0; round < MAX_FETCH_ROUNDS; round += 1) {
    if (cursor == null) break;
    const result = await fetchPageWithWarmup(chatId, peerUserId, cursor);
    if (result.error) {
      return { ...result, messages };
    }
    chatKind = result.chatKind;
    lastReadOutboxMessageId = result.lastReadOutboxMessageId ?? lastReadOutboxMessageId;
    lastReadInboxMessageId = result.lastReadInboxMessageId ?? lastReadInboxMessageId;
    memberCount = result.memberCount;
    selfUserId = result.selfUserId;
    if (result.messages.length === 0) {
      hasMoreOlder = result.hasMoreOlder;
      nextBeforeMessageId = result.nextBeforeMessageId;
      break;
    }
    messages = mergeSortedMessages(result.messages, messages);
    hasMoreOlder = result.hasMoreOlder;
    nextBeforeMessageId = result.nextBeforeMessageId;
    if (totalCharacterWeight(messages) >= charBudget) break;
    if (!result.hasMoreOlder || result.nextBeforeMessageId == null) break;
    cursor = result.nextBeforeMessageId;
  }

  let used = 0;
  let startIndex = 0;
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

  return {
    messages: messages.slice(startIndex),
    chatKind,
    error: null,
    hasMoreOlder,
    nextBeforeMessageId,
    lastReadOutboxMessageId,
    lastReadInboxMessageId,
    memberCount,
    selfUserId,
  };
}

/** Fetch newer history until `charBudget` characters are accumulated. */
export async function fetchNewerHistoryCharBudget(
  chatId: number,
  peerUserId: number | null | undefined,
  sinceMessageId: number,
  charBudget: number,
): Promise<ChatHistoryPageResult> {
  let messages: MessageChatHistoryItem[] = [];
  let cursor = Math.trunc(sinceMessageId);
  let chatKind: ChatHistoryPageResult["chatKind"] = null;
  let lastReadOutboxMessageId: number | null = null;
  let lastReadInboxMessageId: number | null = null;
  let memberCount: number | null = null;
  let selfUserId: number | null = null;

  for (let round = 0; round < MAX_FETCH_ROUNDS; round += 1) {
    const result = await fetchPageWithWarmup(chatId, peerUserId, null, cursor);
    if (result.error) {
      return { ...result, messages };
    }
    chatKind = result.chatKind;
    lastReadOutboxMessageId = result.lastReadOutboxMessageId ?? lastReadOutboxMessageId;
    lastReadInboxMessageId = result.lastReadInboxMessageId ?? lastReadInboxMessageId;
    memberCount = result.memberCount;
    selfUserId = result.selfUserId;
    if (result.messages.length === 0) break;
    messages = mergeSortedMessages(messages, result.messages);
    if (totalCharacterWeight(messages) >= charBudget) break;
    const tailId = messages[messages.length - 1]?.telegram_message_id ?? 0;
    if (tailId <= cursor) break;
    cursor = tailId;
  }

  let used = 0;
  let endIndex = messages.length - 1;
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

  return {
    messages: messages.slice(0, endIndex + 1),
    chatKind,
    error: null,
    hasMoreOlder: false,
    nextBeforeMessageId: null,
    lastReadOutboxMessageId,
    lastReadInboxMessageId,
    memberCount,
    selfUserId,
  };
}
