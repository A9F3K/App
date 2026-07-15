import { resolveTelegramDisplayName } from "./telegramDisplayName";
export const IRINA_TELEGRAM_USER_ID = 402111770;
/** Telegram user id for MMI (private chat title "MMI"). */
export const MMI_TELEGRAM_USER_ID = 217908042;
/** Telegram user id for Мама (private chat title "Мама"). */
export const MAMA_TELEGRAM_USER_ID = 7243866484;
/** Telegram user id for Алексей (private chat title "Алексей"). */
export const ALEXEY_TELEGRAM_USER_ID = 1843695608;
/** Telegram user id for Наталья Лавренова (private chat title with «Искусству быть!»). */
export const NATALYA_LAVRENOVA_TELEGRAM_USER_ID = 86649762;
/** Telegram user id for @anriltine (Vsevolod Ignatyev). */
export const ANRILTINE_TELEGRAM_USER_ID = 7221481736;
/** Telegram user id for @thedevs_admin ("The Devs." private chat). */
export const THE_DEVS_TELEGRAM_USER_ID = 7048804505;
/** Telegram user id for 🇪🇸Ņexx (private chat title "🇪🇸Ņexx"). */
export const NEXX_TELEGRAM_USER_ID = 5850966794;

export const SPECIAL_USER_BADGE_GAP_PX = 5;
export const SPECIAL_USER_BADGE_SIZE_PX = 20;

export type SpecialUserBadgeKind = "cross" | "status_tgs" | "peace_sign" | "art_sign" | "russian_flag" | "s_sign";

type SpecialUserRule = {
  displayName?: string;
  shine: boolean;
  badge: SpecialUserBadgeKind;
};

const ANDREY_DISPLAY_RULE: SpecialUserRule = {
  displayName: "Andrey Gennagevech",
  shine: true,
  badge: "russian_flag",
};

const SPECIAL_USER_RULES: Record<number, SpecialUserRule> = {
  [IRINA_TELEGRAM_USER_ID]: { shine: true, badge: "cross" },
  [MMI_TELEGRAM_USER_ID]: { displayName: "Petr Ignatyev", shine: true, badge: "status_tgs" },
  [MAMA_TELEGRAM_USER_ID]: { displayName: "Olga Valentinovna", shine: true, badge: "status_tgs" },
  [ALEXEY_TELEGRAM_USER_ID]: { displayName: "Alexey Ignatyev", shine: true, badge: "peace_sign" },
  [NATALYA_LAVRENOVA_TELEGRAM_USER_ID]: { shine: true, badge: "art_sign" },
  [ANRILTINE_TELEGRAM_USER_ID]: { shine: true, badge: "s_sign" },
  [THE_DEVS_TELEGRAM_USER_ID]: { shine: true, badge: "status_tgs" },
  [NEXX_TELEGRAM_USER_ID]: { shine: true, badge: "status_tgs" },
  1653333875: { shine: true, badge: "status_tgs" },
};

/** Contact-name queries used during TDLib sync to surface hidden/blocked private chats. */
export const SUPPLEMENTARY_CONTACT_SEARCH_QUERIES = [
  "Андрей",
  "Andrey",
  "Gennadyevich",
  "Gennagevech",
  "Gennad",
] as const;

function specialUserRuleByDisplayName(displayName: string): SpecialUserRule | null {
  const normalized = displayName.trim().toLowerCase();
  if (!normalized) return null;
  if (/андрей|andrey/.test(normalized) && /genn|генн/.test(normalized)) {
    return ANDREY_DISPLAY_RULE;
  }
  if (/the\s*devs/.test(normalized)) {
    return { shine: true, badge: "status_tgs" };
  }
  return null;
}

/** Private chats whose TDLib chat id should inherit a configured peer rule. */
const SPECIAL_USER_RULE_BY_CHAT_ID: Record<number, number> = {
  [THE_DEVS_TELEGRAM_USER_ID]: THE_DEVS_TELEGRAM_USER_ID,
};

function specialUserRuleByChatId(telegramChatId: number | null | undefined): SpecialUserRule | null {
  const chatId = Number(telegramChatId);
  if (!Number.isFinite(chatId) || chatId <= 0) return null;
  const mappedPeerId = SPECIAL_USER_RULE_BY_CHAT_ID[chatId] ?? chatId;
  return specialUserRule(mappedPeerId);
}

export function resolveSpecialUserRule(
  telegramUserId: number | null | undefined,
  displayName: string,
  telegramChatId?: number | null,
): SpecialUserRule | null {
  const byId = specialUserRule(telegramUserId);
  if (byId) return byId;
  const byChat = specialUserRuleByChatId(telegramChatId);
  if (byChat) return byChat;
  return specialUserRuleByDisplayName(displayName);
}

export function specialUserRule(telegramUserId: number | null | undefined): SpecialUserRule | null {
  if (telegramUserId == null || !Number.isFinite(telegramUserId) || telegramUserId <= 0) return null;
  return SPECIAL_USER_RULES[telegramUserId] ?? null;
}

export function specialUserDisplayName(
  telegramUserId: number | null | undefined,
  fallbackName: string,
  telegramChatId?: number | null,
): string {
  const override = resolveSpecialUserRule(telegramUserId, fallbackName, telegramChatId)?.displayName;
  if (override?.trim()) return override.trim();
  return resolveTelegramDisplayName({
    name: fallbackName,
    userId: telegramUserId,
  });
}

export function specialUserShowsShineName(
  telegramUserId: number | null | undefined,
  fallbackName = "",
  telegramChatId?: number | null,
): boolean {
  return resolveSpecialUserRule(telegramUserId, fallbackName, telegramChatId)?.shine ?? false;
}

export function specialUserBadgeKind(
  telegramUserId: number | null | undefined,
  fallbackName = "",
  telegramChatId?: number | null,
): SpecialUserBadgeKind | null {
  return resolveSpecialUserRule(telegramUserId, fallbackName, telegramChatId)?.badge ?? null;
}

export function specialUserBadgeExtraWidthPx(
  telegramUserId: number | null | undefined,
  fallbackName = "",
  telegramChatId?: number | null,
): number {
  if (!specialUserBadgeKind(telegramUserId, fallbackName, telegramChatId)) return 0;
  return SPECIAL_USER_BADGE_GAP_PX + SPECIAL_USER_BADGE_SIZE_PX;
}

/** Peer user ids that must stay in the chat list even when absent from TDLib main list. */
export function specialUserForceIncludedPeerUserIds(): number[] {
  return Object.keys(SPECIAL_USER_RULES)
    .map((id) => Number(id))
    .filter((id) => Number.isFinite(id) && id > 0);
}
