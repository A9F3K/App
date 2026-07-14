import type { Client } from "tdl";
import {
  applyReadOutboxToHistoryMessages,
  applyCumulativeOutgoingReadStatuses,
  chatKindFromTdChat,
  effectiveReadOutboxMessageId,
  enrichOutgoingReadStatuses,
  mapHistoryMessage,
  type ChatKind,
  type MappedChatHistoryMessage,
} from "./messageHistoryMap.js";
import { lastReadInboxMessageIdFromChat, lastReadOutboxMessageIdFromChat, memberCountFromChat, normalizeUnreadCount, type TdChat, type TdMessage } from "./chatPreview.js";
import type { TdUserProfileCache } from "./tdUserProfile.js";

export type { ChatKind, MappedChatHistoryMessage };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sortHistoryMessages(rows: MappedChatHistoryMessage[]): MappedChatHistoryMessage[] {
  return [...rows].sort((a, b) => {
    const byTime = Date.parse(a.sent_at) - Date.parse(b.sent_at);
    if (byTime !== 0) return byTime;
    return a.telegram_message_id - b.telegram_message_id;
  });
}

function oldestRawMessageId(messages: TdMessage[]): number | null {
  let oldest: number | null = null;
  for (const message of messages) {
    const telegramMessageId = Number(message.id);
    if (!Number.isFinite(telegramMessageId) || telegramMessageId <= 0) continue;
    if (oldest == null || telegramMessageId < oldest) oldest = telegramMessageId;
  }
  return oldest;
}

export async function resolveMyUserId(client: Client): Promise<number | null> {
  try {
    const me = (await client.invoke({ _: "getMe" })) as { id?: number };
    return typeof me.id === "number" ? me.id : null;
  } catch {
    return null;
  }
}

async function mapHistoryBatch(
  client: Client,
  messages: TdMessage[],
  chat: TdChat,
): Promise<MappedChatHistoryMessage[]> {
  const userCache = new Map<number, TdUserProfileCache>();
  const chatCache = new Map<number, { title: string; isChannel: boolean }>();
  const myUserId = await resolveMyUserId(client);
  const mapped = await Promise.all(
    messages.map((message) =>
      mapHistoryMessage(client, message, chat, userCache, chatCache, myUserId),
    ),
  );
  const rows: MappedChatHistoryMessage[] = [];
  const seenIds = new Set<number>();
  for (const row of mapped) {
    if (!row) continue;
    if (seenIds.has(row.telegram_message_id)) continue;
    seenIds.add(row.telegram_message_id);
    rows.push(row);
  }
  return sortHistoryMessages(rows);
}

export async function fetchChatHistory(
  client: Client,
  chatId: number,
  limit = 50,
  beforeMessageId?: number | null,
): Promise<{
  chat_kind: ChatKind;
  self_user_id: number | null;
  messages: MappedChatHistoryMessage[];
  has_more_older: boolean;
  next_before_message_id: number | null;
  last_read_outbox_message_id: number | null;
}> {
  try {
    await client.invoke({ _: "openChat", chat_id: chatId });
  } catch {
    /* already open */
  }

  const pageLimit = Math.min(Math.max(limit, 1), 100);
  const loadOlder =
    typeof beforeMessageId === "number" &&
    Number.isFinite(beforeMessageId) &&
    beforeMessageId > 0;
  const rawBatchLimit = Math.min(100, Math.max(pageLimit, 50));

  const chat = (await client.invoke({ _: "getChat", chat_id: chatId })) as TdChat;
  const chatKind = chatKindFromTdChat(chat);
  const selfUserId = await resolveMyUserId(client);

  const loadPage = async (cursorMessageId?: number | null): Promise<TdMessage[]> => {
    const fromMessageId =
      typeof cursorMessageId === "number" &&
      Number.isFinite(cursorMessageId) &&
      cursorMessageId > 0
        ? cursorMessageId
        : 0;
    const requestLimit =
      fromMessageId > 0 ? Math.min(100, pageLimit + 1) : rawBatchLimit;
    // TDLib: offset 0 starts at from_message_id; negative offset adds *newer* messages.
    const history = (await client.invoke({
      _: "getChatHistory",
      chat_id: chatId,
      from_message_id: fromMessageId,
      offset: 0,
      limit: requestLimit,
      only_local: false,
    })) as { messages?: TdMessage[] };
    const raw = Array.isArray(history.messages) ? history.messages : [];
    return raw.filter((message) => {
      const telegramMessageId = Number(message.id);
      if (fromMessageId <= 0) return true;
      return Number.isFinite(telegramMessageId) && telegramMessageId < fromMessageId;
    });
  };

  const mappedById = new Map<number, MappedChatHistoryMessage>();
  let cursorMessageId: number | null = loadOlder ? beforeMessageId! : null;
  let lastBatchWasFull = false;
  let lastRawOldestId: number | null = null;
  let batches = 0;
  const maxBatches = 20;
  const batchFullThreshold = loadOlder ? pageLimit : rawBatchLimit;

  while (batches < maxBatches) {
    let raw = await loadPage(cursorMessageId);
    // tdesktop/TDLib: first older page can briefly return empty while the
    // server slice is still warming after openChat — retry with backoff
    // before treating the edge as EOF.
    if (loadOlder && batches === 0 && raw.length === 0) {
      for (const delayMs of [500, 1000, 1500]) {
        await sleep(delayMs);
        raw = await loadPage(cursorMessageId);
        if (raw.length > 0) {
          break;
        }
      }
    }
    if (!loadOlder && batches === 0 && raw.length < Math.min(rawBatchLimit, 5)) {
      await sleep(600);
      raw = await loadPage(null);
    }
    if (raw.length === 0) {
      lastBatchWasFull = false;
      break;
    }

    lastBatchWasFull = raw.length >= batchFullThreshold;
    lastRawOldestId = oldestRawMessageId(raw) ?? lastRawOldestId;
    const freshChat = (await client.invoke({ _: "getChat", chat_id: chatId })) as TdChat;
    const mapped = await mapHistoryBatch(client, raw, freshChat);
    for (const row of mapped) {
      mappedById.set(row.telegram_message_id, row);
    }

    if (mappedById.size >= pageLimit || !lastBatchWasFull) {
      break;
    }

    const oldestRawId = oldestRawMessageId(raw);
    if (oldestRawId == null) {
      lastBatchWasFull = false;
      break;
    }
    cursorMessageId = oldestRawId;
    batches += 1;
  }

  const sorted = sortHistoryMessages([...mappedById.values()]);
  const finalChat = (await client.invoke({ _: "getChat", chat_id: chatId })) as TdChat;
  const pageSlice = sorted.slice(-pageLimit);
  let messages = applyReadOutboxToHistoryMessages(pageSlice, finalChat);
  if (chatKind === "private") {
    messages = await enrichOutgoingReadStatuses(client, finalChat, messages);
    messages = applyReadOutboxToHistoryMessages(messages, finalChat);
    messages = applyCumulativeOutgoingReadStatuses(messages);
  }
  const oldestReturnedId = messages[0]?.telegram_message_id ?? null;
  // tdesktop/TDLib: short pages are common and are not EOF. For older loads,
  // keep pagination open whenever this page returned rows — the next request
  // returning empty is what closes the edge.
  const hasMoreOlder = loadOlder
    ? messages.length > 0 ||
      (lastBatchWasFull && lastRawOldestId != null)
    : sorted.length > pageLimit || (lastBatchWasFull && oldestReturnedId != null);
  const nextBeforeMessageId = loadOlder
    ? messages.length > 0
      ? oldestReturnedId
      : lastBatchWasFull && lastRawOldestId != null
        ? lastRawOldestId
        : null
    : hasMoreOlder && oldestReturnedId != null
      ? oldestReturnedId
      : null;

  const lastReadOutbox = effectiveReadOutboxMessageId(
    lastReadOutboxMessageIdFromChat(finalChat),
    ...messages
      .filter((row) => row.is_outgoing && row.outgoing_status === "read")
      .map((row) => row.telegram_message_id),
  );

  const memberCount = await memberCountFromChat(client, finalChat);

  return {
    chat_kind: chatKind,
    self_user_id: selfUserId,
    member_count: memberCount,
    messages,
    has_more_older: hasMoreOlder,
    next_before_message_id: nextBeforeMessageId,
    last_read_outbox_message_id: lastReadOutbox,
    last_read_inbox_message_id: lastReadInboxMessageIdFromChat(finalChat),
  };
}

/** Load a symmetric window around a message id (older above + newer below). */
export async function fetchChatHistoryAroundMessage(
  client: Client,
  chatId: number,
  anchorMessageId: number,
  limit = 50,
  olderAbove?: number,
  newerBelow?: number,
): Promise<{
  chat_kind: ChatKind;
  self_user_id: number | null;
  messages: MappedChatHistoryMessage[];
  has_more_older: boolean;
  next_before_message_id: number | null;
  last_read_outbox_message_id: number | null;
  last_read_inbox_message_id: number | null;
  member_count: number | null;
}> {
  const anchorId = Math.trunc(anchorMessageId);
  if (!Number.isFinite(anchorId) || anchorId <= 0) {
    const fallback = await fetchChatHistory(client, chatId, limit);
    return { ...fallback, member_count: await memberCountFromChat(client, (await client.invoke({ _: "getChat", chat_id: chatId })) as TdChat) };
  }

  try {
    await client.invoke({ _: "openChat", chat_id: chatId });
  } catch {
    /* already open */
  }

  const pageLimit = Math.min(Math.max(limit, 1), 100);
  const chat = (await client.invoke({ _: "getChat", chat_id: chatId })) as TdChat;
  const chatKind = chatKindFromTdChat(chat);
  const selfUserId = await resolveMyUserId(client);

  const contextBefore = Math.min(
    Math.max(0, olderAbove ?? Math.max(2, Math.floor(pageLimit * 0.2))),
    pageLimit - 1,
  );
  const defaultNewer = Math.max(1, pageLimit - contextBefore);
  const newerWanted = Math.min(
    Math.max(1, newerBelow ?? defaultNewer),
    pageLimit - contextBefore,
  );

  const rawById = new Map<number, TdMessage>();
  const collectRaw = (messages: TdMessage[]) => {
    for (const message of messages) {
      const telegramMessageId = Number(message.id);
      if (!Number.isFinite(telegramMessageId) || telegramMessageId <= 0) continue;
      rawById.set(telegramMessageId, message);
    }
  };

  if (newerWanted > 0) {
    const newerHistory = (await client.invoke({
      _: "getChatHistory",
      chat_id: chatId,
      from_message_id: anchorId,
      offset: -Math.max(newerWanted, 1),
      limit: Math.min(100, newerWanted + 1),
      only_local: false,
    })) as { messages?: TdMessage[] };
    collectRaw(
      (Array.isArray(newerHistory.messages) ? newerHistory.messages : []).filter((message) => {
        const telegramMessageId = Number(message.id);
        return Number.isFinite(telegramMessageId) && telegramMessageId >= anchorId;
      }),
    );
  }

  if (contextBefore > 0) {
    // TDLib requires offset <= 0; offset 0 returns from_message_id and older messages.
    const olderHistory = (await client.invoke({
      _: "getChatHistory",
      chat_id: chatId,
      from_message_id: anchorId,
      offset: 0,
      limit: Math.min(100, contextBefore + 1),
      only_local: false,
    })) as { messages?: TdMessage[] };
    collectRaw(
      (Array.isArray(olderHistory.messages) ? olderHistory.messages : []).filter((message) => {
        const telegramMessageId = Number(message.id);
        return Number.isFinite(telegramMessageId) && telegramMessageId < anchorId;
      }),
    );
  }

  let messages: MappedChatHistoryMessage[] = [];
  if (rawById.size > 0) {
    const freshChat = (await client.invoke({ _: "getChat", chat_id: chatId })) as TdChat;
    let mapped = await mapHistoryBatch(client, [...rawById.values()], freshChat);
    mapped = applyReadOutboxToHistoryMessages(mapped, freshChat);
    if (chatKind === "private") {
      mapped = await enrichOutgoingReadStatuses(client, freshChat, mapped);
      mapped = applyReadOutboxToHistoryMessages(mapped, freshChat);
      mapped = applyCumulativeOutgoingReadStatuses(mapped);
    }
    const sorted = sortHistoryMessages(mapped);
    if (sorted.length <= pageLimit) {
      messages = sorted;
    } else {
      // Keep a window centered on the anchor — never drop older context by
      // taking only the oldest pageLimit rows (that hides the unread band).
      const anchorIndex = sorted.findIndex(
        (row) => row.telegram_message_id === anchorId,
      );
      if (anchorIndex < 0) {
        messages = sorted.slice(0, pageLimit);
      } else {
        const olderWanted = Math.min(
          contextBefore,
          Math.max(0, pageLimit - 1),
        );
        let startIndex = Math.max(0, anchorIndex - olderWanted);
        let endIndex = Math.min(sorted.length - 1, startIndex + pageLimit - 1);
        if (endIndex - startIndex + 1 < pageLimit) {
          startIndex = Math.max(0, endIndex - pageLimit + 1);
        }
        messages = sorted.slice(startIndex, endIndex + 1);
      }
    }
  }

  const finalChat = (await client.invoke({ _: "getChat", chat_id: chatId })) as TdChat;
  const oldestReturnedId = messages[0]?.telegram_message_id ?? null;
  // A short around-window (e.g. unread open with only 16 rows) must not
  // permanently advertise older history when the older half already filled
  // `contextBefore`. Incomplete older fills still keep pagination open so
  // scroll-up can continue loading.
  const olderInWindow = messages.filter(
    (row) => row.telegram_message_id < anchorId,
  ).length;
  const hasMoreOlder =
    messages.length >= pageLimit ||
    (contextBefore > 0 && olderInWindow < contextBefore);
  const nextBeforeMessageId =
    hasMoreOlder && oldestReturnedId != null ? oldestReturnedId : null;

  const lastReadOutbox = effectiveReadOutboxMessageId(
    lastReadOutboxMessageIdFromChat(finalChat),
    ...messages
      .filter((row) => row.is_outgoing && row.outgoing_status === "read")
      .map((row) => row.telegram_message_id),
  );

  const memberCount = await memberCountFromChat(client, finalChat);

  return {
    chat_kind: chatKind,
    self_user_id: selfUserId,
    member_count: memberCount,
    messages,
    has_more_older: hasMoreOlder,
    next_before_message_id: nextBeforeMessageId,
    last_read_outbox_message_id: lastReadOutbox,
    last_read_inbox_message_id: lastReadInboxMessageIdFromChat(finalChat),
  };
}

/** Load a window around the inbox read cursor (first-unread area), not the latest tail. */
export async function fetchChatHistoryAroundUnread(
  client: Client,
  chatId: number,
  limit = 50,
  lastReadInboxHint?: number | null,
): Promise<{
  chat_kind: ChatKind;
  self_user_id: number | null;
  messages: MappedChatHistoryMessage[];
  has_more_older: boolean;
  next_before_message_id: number | null;
  last_read_outbox_message_id: number | null;
  last_read_inbox_message_id: number | null;
  member_count: number | null;
}> {
  try {
    await client.invoke({ _: "openChat", chat_id: chatId });
  } catch {
    /* already open */
  }

  const pageLimit = Math.min(Math.max(limit, 1), 100);
  const chat = (await client.invoke({ _: "getChat", chat_id: chatId })) as TdChat;
  const unreadCount = normalizeUnreadCount(chat);
  const hintRaw = Number(lastReadInboxHint);
  const hint =
    Number.isFinite(hintRaw) && hintRaw > 0 ? Math.trunc(hintRaw) : null;
  const lastReadInbox =
    lastReadInboxMessageIdFromChat(chat) ?? hint;

  if (unreadCount <= 0) {
    const fallback = await fetchChatHistory(client, chatId, limit);
    return {
      ...fallback,
      last_read_inbox_message_id: lastReadInboxMessageIdFromChat(
        (await client.invoke({ _: "getChat", chat_id: chatId })) as TdChat,
      ),
      member_count: await memberCountFromChat(client, chat),
    };
  }

  if (lastReadInbox == null) {
    // Unreads exist but TDLib has no inbox cursor yet — still avoid a blind tail open.
    // Anchor near the newest messages with room above so the client can scroll to first unread in-window.
    const fallback = await fetchChatHistory(client, chatId, limit);
    return {
      ...fallback,
      last_read_inbox_message_id: null,
      member_count: await memberCountFromChat(client, chat),
    };
  }

  // telegram-tt Around: keep a solid band of older context above the read
  // cursor, then fill the rest with unread/newer rows (not a hard 20-cap).
  const minOlder = Math.min(30, Math.max(2, pageLimit - 1));
  const contextBefore = Math.min(
    Math.max(minOlder, Math.floor(pageLimit * 0.45)),
    pageLimit - 1,
  );
  const newerWanted = Math.min(
    pageLimit - contextBefore,
    Math.max(Math.floor(pageLimit * 0.4), unreadCount + 6),
  );
  const olderAbove = contextBefore;
  // Prefer enough room for older+newer; allow up to pageLimit (caller may pass 80–120).
  const aroundLimit = Math.min(pageLimit, contextBefore + newerWanted + 1);

  const around = await fetchChatHistoryAroundMessage(
    client,
    chatId,
    lastReadInbox,
    aroundLimit,
    olderAbove,
  );
  return {
    ...around,
    last_read_inbox_message_id:
      around.last_read_inbox_message_id ?? lastReadInbox,
  };
}

/** Messages newer than sinceMessageId — for live tail sync without re-fetching the whole page. */
export async function fetchChatHistorySince(
  client: Client,
  chatId: number,
  sinceMessageId: number,
  limit = 50,
): Promise<{
  chat_kind: ChatKind;
  self_user_id: number | null;
  member_count: number | null;
  messages: MappedChatHistoryMessage[];
  last_read_outbox_message_id: number | null;
}> {
  const sinceId = Math.trunc(sinceMessageId);
  if (!Number.isFinite(sinceId) || sinceId <= 0) {
    throw new Error("invalid_since_message_id");
  }

  try {
    await client.invoke({ _: "openChat", chat_id: chatId });
  } catch {
    /* already open */
  }

  const pageLimit = Math.min(Math.max(limit, 1), 100);
  const chat = (await client.invoke({ _: "getChat", chat_id: chatId })) as TdChat;
  const chatKind = chatKindFromTdChat(chat);
  const selfUserId = await resolveMyUserId(client);

  const history = (await client.invoke({
    _: "getChatHistory",
    chat_id: chatId,
    from_message_id: sinceId,
    offset: -pageLimit,
    limit: pageLimit,
    only_local: false,
  })) as { messages?: TdMessage[] };
  const raw = (Array.isArray(history.messages) ? history.messages : []).filter((message) => {
    const telegramMessageId = Number(message.id);
    return Number.isFinite(telegramMessageId) && telegramMessageId > sinceId;
  });

  let messages: MappedChatHistoryMessage[] = [];
  if (raw.length > 0) {
    let mapped = await mapHistoryBatch(client, raw, chat);
    mapped = applyReadOutboxToHistoryMessages(mapped, chat);
    if (chatKind === "private") {
      mapped = await enrichOutgoingReadStatuses(client, chat, mapped);
      mapped = applyReadOutboxToHistoryMessages(mapped, chat);
      mapped = applyCumulativeOutgoingReadStatuses(mapped);
    }
    messages = sortHistoryMessages(mapped);
  }

  const lastReadOutbox = effectiveReadOutboxMessageId(
    lastReadOutboxMessageIdFromChat(chat),
    ...messages
      .filter((row) => row.is_outgoing && row.outgoing_status === "read")
      .map((row) => row.telegram_message_id),
  );
  const memberCount = await memberCountFromChat(client, chat);

  return {
    chat_kind: chatKind,
    self_user_id: selfUserId,
    member_count: memberCount,
    messages,
    last_read_outbox_message_id: lastReadOutbox,
    last_read_inbox_message_id: lastReadInboxMessageIdFromChat(chat),
  };
}

/** Mark inbox read up to messageId via TDLib viewMessages (authoritative unread_count). */
export async function viewChatInboxMessagesUpTo(
  client: Client,
  chatId: number,
  messageId: number,
): Promise<{ unread_count: number; last_read_inbox_message_id: number | null }> {
  const mid = Math.trunc(messageId);
  if (!Number.isFinite(mid) || mid <= 0) {
    return { unread_count: 0, last_read_inbox_message_id: null };
  }

  try {
    await client.invoke({ _: "openChat", chat_id: chatId });
  } catch {
    /* already open */
  }

  await client.invoke({
    _: "viewMessages",
    chat_id: chatId,
    message_ids: [mid],
    source: { _: "messageSourceChatHistory" },
    force_read: true,
  });

  const chat = (await client.invoke({ _: "getChat", chat_id: chatId })) as TdChat;
  return {
    unread_count: normalizeUnreadCount(chat),
    last_read_inbox_message_id: lastReadInboxMessageIdFromChat(chat),
  };
}

/** Mark inbox messages as read (clears unread badge like Telegram when a chat is opened). */
export async function markChatInboxRead(client: Client, chatId: number): Promise<void> {
  try {
    await client.invoke({ _: "openChat", chat_id: chatId });
  } catch {
    /* already open */
  }

  try {
    const chat = (await client.invoke({ _: "getChat", chat_id: chatId })) as TdChat;
    const lastMessage = chat.last_message as { id?: number } | null | undefined;
    const lastId = Number(lastMessage?.id);
    if (Number.isFinite(lastId) && lastId > 0) {
      await client.invoke({
        _: "viewMessages",
        chat_id: chatId,
        message_ids: [Math.trunc(lastId)],
        force_read: true,
      });
    }
  } catch {
    /* best effort */
  }
}

const MAX_OUTGOING_TEXT_LENGTH = 4096;

export async function sendChatTextMessage(
  client: Client,
  chatId: number,
  text: string,
  replyToMessageId?: number | null,
): Promise<MappedChatHistoryMessage | null> {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > MAX_OUTGOING_TEXT_LENGTH) return null;

  try {
    await client.invoke({ _: "openChat", chat_id: chatId });
  } catch {
    /* already open or TDLib will reject send with a clearer error */
  }

  const replyId = Number(replyToMessageId);
  const message = (await client.invoke({
    _: "sendMessage",
    chat_id: chatId,
    ...(Number.isFinite(replyId) && replyId > 0
      ? {
          reply_to: {
            _: "inputMessageReplyToMessage",
            message_id: Math.trunc(replyId),
          },
        }
      : {}),
    input_message_content: {
      _: "inputMessageText",
      text: {
        _: "formattedText",
        text: trimmed,
        entities: [],
      },
    },
  })) as TdMessage;

  const chat = (await client.invoke({ _: "getChat", chat_id: chatId })) as TdChat;
  const myUserId = await resolveMyUserId(client);
  const mapped = await mapHistoryMessage(client, message, chat, new Map(), new Map(), myUserId);
  if (!mapped || !mapped.is_outgoing) return mapped;
  if (mapped.outgoing_status === "pending") {
    return { ...mapped, outgoing_status: "delivered" };
  }
  return mapped;
}

export async function editChatTextMessage(
  client: Client,
  chatId: number,
  messageId: number,
  text: string,
): Promise<MappedChatHistoryMessage | null> {
  const trimmed = text.trim();
  const telegramMessageId = Number(messageId);
  if (!trimmed || trimmed.length > MAX_OUTGOING_TEXT_LENGTH) return null;
  if (!Number.isFinite(telegramMessageId) || telegramMessageId <= 0) return null;

  const message = (await client.invoke({
    _: "editMessageText",
    chat_id: chatId,
    message_id: Math.trunc(telegramMessageId),
    input_message_content: {
      _: "inputMessageText",
      text: {
        _: "formattedText",
        text: trimmed,
        entities: [],
      },
    },
  })) as TdMessage;

  const chat = (await client.invoke({ _: "getChat", chat_id: chatId })) as TdChat;
  const myUserId = await resolveMyUserId(client);
  const mapped = await mapHistoryMessage(client, message, chat, new Map(), new Map(), myUserId);
  if (!mapped || !mapped.is_outgoing) return mapped;
  return mapped;
}
