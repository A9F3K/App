/**
 * Feed catalogue → per-user rows: idempotent sync for `feed_default_messages` deliveries.
 */
import {
  FEED_CATALOG_FALLBACK_LOCALE,
  type FeedCatalogLocale,
  resolveFeedCatalogLocaleFromLanguageTag,
} from "../locales/resolveFeedCatalogLocale.js";
import { sql } from "./start.js";
import { normalizeUsername } from "./users.js";

export { resolveFeedCatalogLocaleFromLanguageTag as normalizeFeedLocale };
export type { FeedCatalogLocale };

/** Normalize DB timestamptz/string/Date for JSON (ISO 8601 UTC) so the client can parse local display. */
function feedRowSentAtIso(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const ms = raw < 12_000_000_000 ? raw * 1000 : raw;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof raw === "string") {
    const t = raw.trim();
    if (!t) return null;
    const asDate = new Date(t.includes("T") ? t : t.replace(" ", "T"));
    return Number.isNaN(asDate.getTime()) ? null : asDate.toISOString();
  }
  if (raw instanceof Date) {
    const t = raw.getTime();
    return Number.isNaN(t) ? null : raw.toISOString();
  }
  try {
    const s = String(raw).trim();
    if (!s) return null;
    const d = new Date(s.includes("T") ? s : s.replace(" ", "T"));
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  } catch {
    return null;
  }
}

function feedRowSentAtForClient(row: Record<string, unknown>): string | null {
  return feedRowSentAtIso(row.sent_at) ?? feedRowSentAtIso(row.created_at);
}

function parseDefaultMessageId(raw: unknown): bigint | null {
  if (raw == null) return null;
  if (typeof raw === "bigint") return raw;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    try {
      return BigInt(Math.trunc(raw));
    } catch {
      return null;
    }
  }
  if (typeof raw === "string") {
    const t = raw.trim();
    if (!/^-?\d+$/.test(t)) return null;
    try {
      return BigInt(t);
    } catch {
      return null;
    }
  }
  return null;
}

export type DeliverWelcomeFeedSummary = {
  telegramUsernameNorm: string;
  locale: string;
  explicitCatalogSize: number;
  extraCatalogSize: number;
  /** How many welcome demo keys matched a catalogue row for this locale. */
  welcomeRowsResolved: number;
};

export const FEED_WELCOME_DEFAULT_KEYS_EN = [
  "demo_wallet_created",
  "demo_creator_likely",
  "demo_nft_received",
  "demo_token_granted",
  "demo_incoming_task",
] as const;

/** Stable prefix on `feed_items.source_id` for catalogue-driven inserts. */
export const FEED_WELCOME_BUNDLE_MARKER = "welcome_bundle_demo_v1";

type TemplateBody = {
  card_type?: string;
  layout_variant?: string | null;
  payload?: Record<string, unknown>;
};

type CatalogRow = { id: bigint | number | string; key: string; body: unknown };

function parseTemplateBody(bodyRaw: unknown): TemplateBody | null {
  let bodyRawMut = bodyRaw;
  if (typeof bodyRawMut === "string") {
    try {
      bodyRawMut = JSON.parse(bodyRawMut) as TemplateBody;
    } catch {
      return null;
    }
  }
  if (!bodyRawMut || typeof bodyRawMut !== "object") return null;
  return bodyRawMut as TemplateBody;
}

async function mergeExplicitCatalogKeys(locale: FeedCatalogLocale): Promise<Map<string, CatalogRow>> {
  type CatalogRowTyped = CatalogRow & { body: TemplateBody };
  const merged = new Map<string, CatalogRowTyped>();
  const enRowsUnknown = await sql`
    SELECT id, key, body
    FROM feed_default_messages
    WHERE locale = ${"en"}
      AND key IN (
        ${FEED_WELCOME_DEFAULT_KEYS_EN[0]},
        ${FEED_WELCOME_DEFAULT_KEYS_EN[1]},
        ${FEED_WELCOME_DEFAULT_KEYS_EN[2]},
        ${FEED_WELCOME_DEFAULT_KEYS_EN[3]},
        ${FEED_WELCOME_DEFAULT_KEYS_EN[4]}
      );
  `;
  for (const r of enRowsUnknown as CatalogRowTyped[]) merged.set(r.key, r);

  if (locale !== "en") {
    const localeRowsUnknown = await sql`
      SELECT id, key, body
      FROM feed_default_messages
      WHERE locale = ${locale}
        AND key IN (
          ${FEED_WELCOME_DEFAULT_KEYS_EN[0]},
          ${FEED_WELCOME_DEFAULT_KEYS_EN[1]},
          ${FEED_WELCOME_DEFAULT_KEYS_EN[2]},
          ${FEED_WELCOME_DEFAULT_KEYS_EN[3]},
          ${FEED_WELCOME_DEFAULT_KEYS_EN[4]}
        );
    `;
    for (const r of localeRowsUnknown as CatalogRowTyped[]) merged.set(r.key, r);
  }
  return merged;
}

/** Other `kind = feed_default` catalogue rows (new keys) not in {@link FEED_WELCOME_DEFAULT_KEYS_EN}. */
async function mergeExtraCatalogRows(locale: FeedCatalogLocale): Promise<Map<string, CatalogRow>> {
  const merged = new Map<string, CatalogRow>();
  const enExtras = await sql`
    SELECT id, key, body
    FROM feed_default_messages
    WHERE kind = ${"feed_default"}
      AND locale = ${"en"}
      AND key NOT IN (
        ${FEED_WELCOME_DEFAULT_KEYS_EN[0]},
        ${FEED_WELCOME_DEFAULT_KEYS_EN[1]},
        ${FEED_WELCOME_DEFAULT_KEYS_EN[2]},
        ${FEED_WELCOME_DEFAULT_KEYS_EN[3]},
        ${FEED_WELCOME_DEFAULT_KEYS_EN[4]}
      );
  `;
  for (const r of enExtras as CatalogRow[]) merged.set(r.key, r);

  if (locale !== "en") {
    const localeExtras = await sql`
      SELECT id, key, body
      FROM feed_default_messages
      WHERE kind = ${"feed_default"}
        AND locale = ${locale}
        AND key NOT IN (
          ${FEED_WELCOME_DEFAULT_KEYS_EN[0]},
          ${FEED_WELCOME_DEFAULT_KEYS_EN[1]},
          ${FEED_WELCOME_DEFAULT_KEYS_EN[2]},
          ${FEED_WELCOME_DEFAULT_KEYS_EN[3]},
          ${FEED_WELCOME_DEFAULT_KEYS_EN[4]}
        );
    `;
    for (const r of localeExtras as CatalogRow[]) merged.set(r.key, r);
  }
  return merged;
}

async function insertCatalogFeedItem(opts: {
  telegramUsername: string;
  row: CatalogRow;
  key: string;
  welcomeOrder?: number;
}): Promise<void> {
  const telegramUsername = normalizeUsername(opts.telegramUsername);
  if (!telegramUsername) return;
  const { row, key } = opts;
  const defaultId = parseDefaultMessageId(row.id);
  if (defaultId == null) return;

  const bodyRaw = parseTemplateBody(row.body);
  if (!bodyRaw) return;
  const cardType =
    typeof bodyRaw.card_type === "string" && bodyRaw.card_type.trim() !== ""
      ? bodyRaw.card_type
      : "system_action";
  const layoutVariant =
    typeof bodyRaw.layout_variant === "string" ? bodyRaw.layout_variant : null;
  const rawPayload =
    bodyRaw.payload && typeof bodyRaw.payload === "object" ? bodyRaw.payload : {};
  const payload: Record<string, unknown> = { ...rawPayload, catalog_key: key };
  if (opts.welcomeOrder != null) {
    payload.welcome_order = opts.welcomeOrder;
  }

  const seq = opts.welcomeOrder ?? defaultId;
  await sql`
    INSERT INTO feed_items (
      telegram_username,
      sent_at,
      source_type,
      card_type,
      layout_variant,
      default_message_id,
      source_id,
      payload,
      read_at
    )
    VALUES (
      ${telegramUsername},
      NOW(),
      ${"welcome_bundle"},
      ${cardType},
      ${layoutVariant},
      ${defaultId},
      ${`${FEED_WELCOME_BUNDLE_MARKER}:${key}:${seq}`},
      ${JSON.stringify(payload)}::jsonb,
      NOW()
    )
    ON CONFLICT (telegram_username, default_message_id)
      WHERE default_message_id IS NOT NULL
      DO NOTHING;
  `;
}

/** Catalogue welcome demos are not “unread notifications” — mark any leftover rows as read. */
export async function markWelcomeFeedItemsRead(telegramUsername: string): Promise<void> {
  const u = normalizeUsername(telegramUsername);
  if (!u) return;
  await sql`
    UPDATE feed_items
    SET read_at = NOW()
    WHERE lower(btrim(telegram_username)) = ${u}
      AND source_type = ${"welcome_bundle"}
      AND read_at IS NULL;
  `;
}

export type WalletTopUpFeedInsert = {
  telegramUsername: string;
  sourceId: string;
  amountLabel: string;
  symbol: string;
  title: string;
  subtitle: string;
  trailingLabel: string;
};

/** Idempotent wallet top-up notification (`read_at` null until the user opens it). */
export async function insertWalletTopUpFeedItem(
  opts: WalletTopUpFeedInsert,
): Promise<{ id: number; inserted: boolean } | null> {
  const telegramUsername = normalizeUsername(opts.telegramUsername);
  const sourceId = opts.sourceId.trim();
  if (!telegramUsername || !sourceId) return null;

  const payload = {
    title: opts.title,
    subtitle: opts.subtitle,
    trailing_label: opts.trailingLabel,
    amount: opts.amountLabel,
    symbol: opts.symbol,
    icon: { type: "svg_url", url: "/welcome_messages/token.svg" },
  };

  const rows = await sql`
    INSERT INTO feed_items (
      telegram_username,
      sent_at,
      source_type,
      card_type,
      layout_variant,
      source_id,
      payload
    )
    VALUES (
      ${telegramUsername},
      NOW(),
      ${"wallet_topup"},
      ${"reward_token"},
      ${"value_trailing"},
      ${sourceId},
      ${JSON.stringify(payload)}::jsonb
    )
    ON CONFLICT (telegram_username, source_id)
      WHERE source_id IS NOT NULL
      DO NOTHING
    RETURNING id;
  `;

  const inserted = Array.isArray(rows) && rows.length > 0;
  if (inserted) {
    return { id: Number((rows[0] as { id: unknown }).id), inserted: true };
  }

  const existing = await sql`
    SELECT id
    FROM feed_items
    WHERE lower(btrim(telegram_username)) = ${telegramUsername}
      AND source_id = ${sourceId}
    LIMIT 1;
  `;
  const idRaw = Array.isArray(existing) && existing[0] ? (existing[0] as { id: unknown }).id : null;
  if (idRaw == null) return null;
  return { id: Number(idRaw), inserted: false };
}

export async function countUnreadFeedItems(telegramUsername: string): Promise<number> {
  const u = normalizeUsername(telegramUsername);
  if (!u) return 0;
  const rows = await sql`
    SELECT COUNT(*)::int AS n
    FROM feed_items
    WHERE lower(btrim(telegram_username)) = ${u}
      AND read_at IS NULL
      AND dismissed_at IS NULL;
  `;
  const n = Array.isArray(rows) && rows[0] ? Number((rows[0] as { n: unknown }).n) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Mark one or more feed items read. Empty `ids` marks every unread row for the user. */
export async function markFeedItemsRead(opts: {
  telegramUsername: string;
  ids?: number[] | null;
}): Promise<{ marked: number; unreadCount: number }> {
  const u = normalizeUsername(opts.telegramUsername);
  if (!u) return { marked: 0, unreadCount: 0 };

  const ids = (opts.ids ?? [])
    .map((id) => Number(id))
    .filter((id) => Number.isFinite(id) && id > 0);

  let marked = 0;
  if (ids.length === 0) {
    const rows = await sql`
      UPDATE feed_items
      SET read_at = NOW()
      WHERE lower(btrim(telegram_username)) = ${u}
        AND read_at IS NULL
      RETURNING id;
    `;
    marked = Array.isArray(rows) ? rows.length : 0;
  } else {
    for (const id of ids) {
      const rows = await sql`
        UPDATE feed_items
        SET read_at = NOW()
        WHERE lower(btrim(telegram_username)) = ${u}
          AND read_at IS NULL
          AND id = ${id}
        RETURNING id;
      `;
      if (Array.isArray(rows) && rows.length > 0) marked += 1;
    }
  }

  return { marked, unreadCount: await countUnreadFeedItems(u) };
}

/**
 * Inserts **`feed_items`** for every **`feed_default_messages`** row (`kind = feed_default`)
 * this user has not yet received (matched by **`default_message_id`**). Safe to call on every `/api/feed`.
 */
export async function deliverWelcomeFeedIfNeeded(opts: {
  telegramUsername: string;
  localePreferred?: string | null;
}): Promise<DeliverWelcomeFeedSummary | null> {
  const telegramUsername = normalizeUsername(opts.telegramUsername);
  if (!telegramUsername) return null;

  const locale = resolveFeedCatalogLocaleFromLanguageTag(opts.localePreferred ?? null);
  const explicitMap = await mergeExplicitCatalogKeys(locale);
  const extraMap = await mergeExtraCatalogRows(locale);

  if (explicitMap.size === 0 && extraMap.size === 0) {
    return {
      telegramUsernameNorm: telegramUsername,
      locale,
      explicitCatalogSize: 0,
      extraCatalogSize: 0,
      welcomeRowsResolved: 0,
    };
  }

  let sortIndex = 0;
  for (const key of FEED_WELCOME_DEFAULT_KEYS_EN) {
    const row = explicitMap.get(key);
    if (!row) continue;
    sortIndex += 1;
    await insertCatalogFeedItem({
      telegramUsername,
      row,
      key,
      welcomeOrder: sortIndex,
    });
  }

  const extraKeys = [...extraMap.keys()].sort((a, b) => a.localeCompare(b));
  for (const key of extraKeys) {
    const row = extraMap.get(key);
    if (!row) continue;
    await insertCatalogFeedItem({ telegramUsername, row, key });
  }

  const welcomeRowsResolved = FEED_WELCOME_DEFAULT_KEYS_EN.filter((k) => explicitMap.has(k)).length;

  return {
    telegramUsernameNorm: telegramUsername,
    locale,
    explicitCatalogSize: explicitMap.size,
    extraCatalogSize: extraMap.size,
    welcomeRowsResolved,
  };
}

const WELCOME_TEXT_PAYLOAD_KEYS = ["title", "subtitle", "trailing_label"] as const;

function mergeCatalogTextIntoPayload(
  stored: Record<string, unknown>,
  catalogPayload: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...stored };
  for (const k of WELCOME_TEXT_PAYLOAD_KEYS) {
    const v = catalogPayload[k];
    if (typeof v === "string" && v.trim()) {
      next[k] = v;
    }
  }
  return next;
}

/** Load catalogue payloads for keys: requested locale overrides English per key; missing locale falls back to `en`. */
export async function fetchCatalogPayloadMapForLocale(
  keys: string[],
  displayLocale: FeedCatalogLocale,
): Promise<Map<string, Record<string, unknown>>> {
  const wanted = new Set(keys.filter((k) => k.trim().length > 0));
  const out = new Map<string, Record<string, unknown>>();
  if (wanted.size === 0) return out;

  const explicit = await mergeExplicitCatalogKeys(displayLocale);
  const extra = await mergeExtraCatalogRows(displayLocale);

  const ingest = (map: Map<string, CatalogRow>) => {
    for (const [key, row] of map) {
      if (!wanted.has(key)) continue;
      const body = parseTemplateBody(row.body);
      const p =
        body?.payload && typeof body.payload === "object" && !Array.isArray(body.payload)
          ? (body.payload as Record<string, unknown>)
          : {};
      out.set(key, p);
    }
  };

  ingest(explicit);
  ingest(extra);
  return out;
}

function catalogKeyFromSourceId(sourceId: unknown): string | null {
  if (typeof sourceId !== "string" || !sourceId.startsWith(`${FEED_WELCOME_BUNDLE_MARKER}:`)) {
    return null;
  }
  const parts = sourceId.split(":");
  if (parts.length < 3) return null;
  const key = parts[1]?.trim();
  return key || null;
}

export async function listFeedItemsForUser(
  telegramUsername: string,
  limit = 80,
  displayLocale: FeedCatalogLocale = FEED_CATALOG_FALLBACK_LOCALE,
): Promise<
  Array<{
    id: number;
    sent_at: string | null;
    source_type: string;
    card_type: string;
    layout_variant: string | null;
    payload: unknown;
    read_at: string | null;
  }>
> {
  const u = normalizeUsername(telegramUsername);
  if (!u) {
    return [];
  }

  const rows = await sql`
    SELECT id, sent_at, card_type, layout_variant, payload, read_at, source_type, default_message_id, source_id
    FROM feed_items
    WHERE lower(btrim(telegram_username)) = ${u}
    ORDER BY
      CASE
        WHEN trim(COALESCE(payload ->> 'welcome_order', '')) ~ '^[0-9]+$'
        THEN trim(payload ->> 'welcome_order')::bigint
        ELSE 1000000000000::bigint
      END ASC,
      sent_at ASC NULLS LAST,
      id ASC
    LIMIT ${Number(limit)};
  `;

  const rawRows = rows as Array<Record<string, unknown>>;

  const catalogKeys: string[] = [];
  for (const r of rawRows) {
    const stored =
      r.payload && typeof r.payload === "object" && !Array.isArray(r.payload)
        ? (r.payload as Record<string, unknown>)
        : {};
    const fromPayload =
      typeof stored.catalog_key === "string" && stored.catalog_key.trim()
        ? stored.catalog_key.trim()
        : null;
    if (fromPayload) {
      catalogKeys.push(fromPayload);
      continue;
    }
    const fromSource = catalogKeyFromSourceId(r.source_id);
    if (fromSource) catalogKeys.push(fromSource);
  }

  const catalogByKey = await fetchCatalogPayloadMapForLocale(catalogKeys, displayLocale);

  return rawRows.map((r) => {
    const stored =
      r.payload && typeof r.payload === "object" && !Array.isArray(r.payload)
        ? (r.payload as Record<string, unknown>)
        : {};
    let catalogKey =
      typeof stored.catalog_key === "string" && stored.catalog_key.trim()
        ? stored.catalog_key.trim()
        : null;
    if (!catalogKey) {
      catalogKey = catalogKeyFromSourceId(r.source_id);
    }

    const sourceType = String(r.source_type);
    const isWelcomeCatalog =
      sourceType === "welcome_bundle" || catalogKey != null || r.default_message_id != null;

    let payload: unknown = r.payload;
    if (isWelcomeCatalog && catalogKey) {
      const catalogPayload = catalogByKey.get(catalogKey);
      if (catalogPayload) {
        payload = mergeCatalogTextIntoPayload(stored, catalogPayload);
      }
    }

    return {
      id: Number(r.id),
      sent_at: feedRowSentAtForClient(r),
      source_type: sourceType,
      card_type: String(r.card_type),
      layout_variant: r.layout_variant == null ? null : String(r.layout_variant),
      payload,
      read_at: feedRowSentAtIso(r.read_at),
    };
  });
}

export type FeedItemForClient = Awaited<ReturnType<typeof listFeedItemsForUser>>[number];

/** Deliver missing welcome catalogue rows, then list feed items (no schema migrations). */
export async function bootstrapAuthenticatedFeedItems(opts: {
  telegramUsername: string;
  catalogLocale?: FeedCatalogLocale;
  localePreferred?: string | null;
  limit?: number;
}): Promise<FeedItemForClient[]> {
  const catalogLocale = opts.catalogLocale ?? FEED_CATALOG_FALLBACK_LOCALE;
  const deliverLocalePreferred =
    opts.localePreferred ??
    (catalogLocale !== FEED_CATALOG_FALLBACK_LOCALE ? catalogLocale : null);
  try {
    await deliverWelcomeFeedIfNeeded({
      telegramUsername: opts.telegramUsername,
      localePreferred: deliverLocalePreferred,
    });
  } catch {
    // Best effort — still return whatever rows exist.
  }
  try {
    await markWelcomeFeedItemsRead(opts.telegramUsername);
  } catch {
    /* ignore */
  }
  return listFeedItemsForUser(opts.telegramUsername, opts.limit ?? 80, catalogLocale);
}
