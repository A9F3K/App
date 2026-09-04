/** Client roster of connected Telegram messenger accounts (multi-account switcher). */

import { Platform } from "react-native";

export const FREE_MESSENGER_ACCOUNT_LIMIT = 5;

export type MessengerAccount = {
  key: string;
  slot: number;
  telegramUserId: number;
  title: string;
  username: string | null;
  avatarUrl: string | null;
  unreadCount: number;
  active: boolean;
};

type StoreState = {
  accounts: MessengerAccount[];
};

const STORAGE_KEY = "hsp_messenger_accounts_v1";
const listeners = new Set<() => void>();
let state: StoreState = { accounts: [] };
let hydrated = false;

function notify(): void {
  for (const listener of listeners) listener();
}

function persist(): void {
  if (Platform.OS !== "web" || typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* ignore */
  }
}

function hydrate(): void {
  if (hydrated) return;
  hydrated = true;
  if (Platform.OS !== "web" || typeof localStorage === "undefined") return;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as StoreState;
    if (Array.isArray(parsed?.accounts)) {
      state = {
        accounts: parsed.accounts.map((row) => ({
          key: String(row.key),
          slot: Number(row.slot) || 0,
          telegramUserId: Number(row.telegramUserId) || 0,
          title: String(row.title || "Account"),
          username: typeof row.username === "string" ? row.username : null,
          avatarUrl: typeof row.avatarUrl === "string" ? row.avatarUrl : null,
          unreadCount: Number(row.unreadCount) || 0,
          active: Boolean(row.active),
        })),
      };
    }
  } catch {
    /* ignore */
  }
}

export function getMessengerAccounts(): readonly MessengerAccount[] {
  hydrate();
  return state.accounts;
}

export function subscribeMessengerAccounts(listener: () => void): () => void {
  hydrate();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getActiveMessengerAccount(): MessengerAccount | null {
  hydrate();
  return state.accounts.find((a) => a.active) ?? state.accounts[0] ?? null;
}

export function upsertMessengerAccount(input: {
  slot: number;
  telegramUserId: number;
  title: string;
  username?: string | null;
  avatarUrl?: string | null;
  unreadCount?: number;
  makeActive?: boolean;
}): void {
  hydrate();
  const key = `slot:${input.slot}`;
  const makeActive = input.makeActive !== false;
  let found = false;
  let changed = false;
  const next = state.accounts.map((row) => {
    const matches = row.key === key || row.telegramUserId === input.telegramUserId;
    if (!matches) {
      if (makeActive && row.active) {
        changed = true;
        return { ...row, active: false };
      }
      return row;
    }
    found = true;
    const updated = {
      ...row,
      key,
      slot: input.slot,
      telegramUserId: input.telegramUserId,
      title: input.title.trim() || row.title,
      username: input.username?.trim() || row.username,
      avatarUrl: input.avatarUrl ?? row.avatarUrl,
      unreadCount:
        typeof input.unreadCount === "number" ? Math.max(0, Math.floor(input.unreadCount)) : row.unreadCount,
      active: makeActive ? true : row.active,
    };
    if (
      updated.key !== row.key ||
      updated.slot !== row.slot ||
      updated.telegramUserId !== row.telegramUserId ||
      updated.title !== row.title ||
      updated.username !== row.username ||
      updated.avatarUrl !== row.avatarUrl ||
      updated.unreadCount !== row.unreadCount ||
      updated.active !== row.active
    ) {
      changed = true;
    }
    return updated;
  });
  if (!found) {
    changed = true;
    if (makeActive) {
      for (let i = 0; i < next.length; i++) next[i] = { ...next[i]!, active: false };
    }
    next.push({
      key,
      slot: input.slot,
      telegramUserId: input.telegramUserId,
      title: input.title.trim() || "Account",
      username: input.username?.trim() || null,
      avatarUrl: input.avatarUrl ?? null,
      unreadCount:
        typeof input.unreadCount === "number" ? Math.max(0, Math.floor(input.unreadCount)) : 0,
      active: makeActive || next.length === 0,
    });
  }
  if (!changed) return;
  state = { accounts: next };
  persist();
  notify();
}

export function setActiveMessengerAccount(key: string): void {
  hydrate();
  state = {
    accounts: state.accounts.map((row) => ({ ...row, active: row.key === key })),
  };
  persist();
  notify();
}

export function setMessengerAccountUnread(key: string, unreadCount: number): void {
  hydrate();
  const nextCount = Number.isFinite(unreadCount) && unreadCount > 0 ? Math.floor(unreadCount) : 0;
  let changed = false;
  const next = state.accounts.map((row) => {
    if (row.key !== key || row.unreadCount === nextCount) return row;
    changed = true;
    return { ...row, unreadCount: nextCount };
  });
  if (!changed) return;
  state = { accounts: next };
  persist();
  notify();
}

export function removeMessengerAccount(key: string): void {
  hydrate();
  const remaining = state.accounts.filter((row) => row.key !== key);
  if (remaining.length > 0 && !remaining.some((row) => row.active)) {
    remaining[0] = { ...remaining[0]!, active: true };
  }
  state = { accounts: remaining };
  persist();
  notify();
}

export function clearMessengerAccounts(): void {
  hydrate();
  state = { accounts: [] };
  persist();
  notify();
}
