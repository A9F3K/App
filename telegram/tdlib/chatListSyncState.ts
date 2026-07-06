import { getLiveChatList } from "./liveChatCache.js";

export type ChatListSyncStatusPayload = {
  inProgress: boolean;
  cachedCount: number;
  positionedComplete: boolean;
  tier3Available: boolean;
  tier3InProgress: boolean;
};

type UserSyncMeta = {
  positionedComplete: boolean;
  tier3Available: boolean;
};

const syncMeta = new Map<string, UserSyncMeta>();
const backgroundSyncInflight = new Set<string>();
const tier3SyncInflight = new Set<string>();

type Tier3ListCursor = {
  offsetOrder: string;
  offsetChatId: number;
  exhausted: boolean;
};

const tier3ListCursors = new Map<string, Tier3ListCursor>();

function tier3CursorFor(telegramUsername: string): Tier3ListCursor {
  let cursor = tier3ListCursors.get(telegramUsername);
  if (!cursor) {
    cursor = {
      offsetOrder: "9223372036854775807",
      offsetChatId: 0,
      exhausted: false,
    };
    tier3ListCursors.set(telegramUsername, cursor);
  }
  return cursor;
}

export function resetTier3ListCursor(telegramUsername: string): void {
  tier3ListCursors.delete(telegramUsername);
}

export function getTier3ListCursor(telegramUsername: string): Tier3ListCursor {
  return tier3CursorFor(telegramUsername);
}

function metaFor(telegramUsername: string): UserSyncMeta {
  let meta = syncMeta.get(telegramUsername);
  if (!meta) {
    meta = { positionedComplete: false, tier3Available: false };
    syncMeta.set(telegramUsername, meta);
  }
  return meta;
}

export function resetChatListSyncMeta(
  telegramUsername: string,
  patch?: Partial<UserSyncMeta>,
): void {
  const next: UserSyncMeta = {
    positionedComplete: patch?.positionedComplete ?? false,
    tier3Available: patch?.tier3Available ?? false,
  };
  syncMeta.set(telegramUsername, next);
  if (patch?.tier3Available === false) {
    resetTier3ListCursor(telegramUsername);
  }
}

export function setPositionedComplete(telegramUsername: string, complete: boolean): void {
  metaFor(telegramUsername).positionedComplete = complete;
}

export function setTier3Available(telegramUsername: string, available: boolean): void {
  metaFor(telegramUsername).tier3Available = available;
}

export function isPositionedComplete(telegramUsername: string): boolean {
  return metaFor(telegramUsername).positionedComplete;
}

export function isTier3Available(telegramUsername: string): boolean {
  return metaFor(telegramUsername).tier3Available;
}

export function isBackgroundChatSyncInProgress(telegramUsername: string): boolean {
  return backgroundSyncInflight.has(telegramUsername);
}

export function isTier3ChatSyncInProgress(telegramUsername: string): boolean {
  return tier3SyncInflight.has(telegramUsername);
}

export function markBackgroundChatSyncStart(telegramUsername: string): boolean {
  if (backgroundSyncInflight.has(telegramUsername)) return false;
  backgroundSyncInflight.add(telegramUsername);
  return true;
}

export function markBackgroundChatSyncEnd(telegramUsername: string): void {
  backgroundSyncInflight.delete(telegramUsername);
}

export function markTier3ChatSyncStart(telegramUsername: string): boolean {
  if (tier3SyncInflight.has(telegramUsername)) return false;
  tier3SyncInflight.add(telegramUsername);
  return true;
}

export function markTier3ChatSyncEnd(telegramUsername: string): void {
  tier3SyncInflight.delete(telegramUsername);
}

export function buildChatListSyncStatus(telegramUsername: string): ChatListSyncStatusPayload {
  const meta = metaFor(telegramUsername);
  const positionedInProgress = isBackgroundChatSyncInProgress(telegramUsername);
  const tier3InProgress = isTier3ChatSyncInProgress(telegramUsername);
  return {
    inProgress: positionedInProgress || tier3InProgress,
    cachedCount: getLiveChatList(telegramUsername)?.length ?? 0,
    positionedComplete: meta.positionedComplete,
    tier3Available: meta.tier3Available,
    tier3InProgress,
  };
}
