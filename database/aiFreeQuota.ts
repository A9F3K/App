/**
 * Per-account AI token budgets:
 * - Free: lifetime allowance (founder-tunable)
 * - Pro: monthly allowance; optional on-demand DLLR after cap
 * - Model preference: auto | tinymodel | gateway/openai model id
 */
import { sql } from "./start.js";
import { normalizeUsername } from "./users.js";
import {
  DEFAULT_FREE_AI_TOKEN_LIMIT,
  DEFAULT_ON_DEMAND_USD_PER_1K,
  DEFAULT_PRO_MONTHLY_TOKEN_LIMIT,
  estimateOnDemandUsd,
  getAiLimitsConfig,
} from "./aiLimitsConfig.js";

/** @deprecated use getAiLimitsConfig().freeTokenLimit — kept for importers. */
export const FREE_AI_TOKEN_LIMIT = DEFAULT_FREE_AI_TOKEN_LIMIT;

export type AiModelMode = "auto" | "tinymodel" | "model";

export type AiBillingLane = "free" | "pro" | "on_demand";

export type AiFreeQuotaSnapshot = {
  tokensUsed: number;
  tokenLimit: number;
  tokensRemaining: number;
  /** True while Pro subscription is active (monthly cap still applies). */
  proUnlimited: boolean;
  proActive: boolean;
  limitReached: boolean;
  /** Pro monthly usage (0 when not Pro). */
  proTokensUsedMonth: number;
  proMonthlyLimit: number;
  proTokensRemaining: number;
  monthKey: string;
  onDemandEnabled: boolean;
  /** True when Pro monthly is exhausted and further turns need on-demand. */
  onDemandRequired: boolean;
  onDemandUsdPer1kTokens: number;
  modelMode: AiModelMode;
  /** Explicit model id when modelMode === "model" (gateway or OpenAI id). */
  modelId: string | null;
  billingLane: AiBillingLane;
  /** Spent DLLR in the active allowance lane. */
  dllrUsed: number;
  /** Included DLLR budget for the active lane. */
  dllrLimit: number;
  /** ISO expiry when Pro is active; null when free / revoked. */
  proExpiresAt: string | null;
};

export type AiRoutePreference = {
  modelMode: AiModelMode;
  modelId: string | null;
};

function asInt(raw: unknown): number {
  if (typeof raw === "bigint") return Number(raw);
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.max(0, Math.round(raw));
  if (typeof raw === "string" && raw.trim()) {
    const n = Number(raw);
    return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
  }
  return 0;
}

function asIso(raw: unknown): string | null {
  if (raw == null) return null;
  if (raw instanceof Date) {
    const t = raw.getTime();
    return Number.isNaN(t) ? null : raw.toISOString();
  }
  const s = String(raw).trim();
  if (!s) return null;
  const d = new Date(s.includes("T") ? s : s.replace(" ", "T"));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function asBool(raw: unknown): boolean {
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number") return raw !== 0;
  if (typeof raw === "string") {
    const s = raw.trim().toLowerCase();
    return s === "true" || s === "1" || s === "yes";
  }
  return false;
}

function parseModelMode(raw: unknown): AiModelMode {
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (s === "tinymodel") return "tinymodel";
  if (s === "model") return "model";
  return "auto";
}

function utcMonthKey(d = new Date()): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function isProActive(proExpiresAt: string | null): boolean {
  if (!proExpiresAt) return false;
  const t = Date.parse(proExpiresAt);
  return Number.isFinite(t) && t > Date.now();
}

type QuotaRow = {
  tokens_used?: unknown;
  pro_expires_at?: unknown;
  pro_tokens_used_month?: unknown;
  pro_month_key?: unknown;
  on_demand_enabled?: unknown;
  model_mode?: unknown;
  model_id?: unknown;
};

function toSnapshot(
  row: QuotaRow | null | undefined,
  limits: {
    freeTokenLimit: number;
    proMonthlyTokenLimit: number;
    onDemandUsdPer1kTokens: number;
  },
): AiFreeQuotaSnapshot {
  const tokensUsed = asInt(row?.tokens_used);
  const proExpiresAt = asIso(row?.pro_expires_at);
  const proActive = isProActive(proExpiresAt);
  const monthKey = utcMonthKey();
  const storedMonth =
    typeof row?.pro_month_key === "string" && row.pro_month_key.trim()
      ? row.pro_month_key.trim()
      : "";
  const proTokensUsedMonth =
    proActive && storedMonth === monthKey ? asInt(row?.pro_tokens_used_month) : 0;
  const onDemandEnabled = asBool(row?.on_demand_enabled);
  const modelMode = parseModelMode(row?.model_mode);
  const modelIdRaw =
    typeof row?.model_id === "string" && row.model_id.trim() ? row.model_id.trim() : null;
  const modelId = modelMode === "model" ? modelIdRaw : null;

  const freeRemaining = Math.max(0, limits.freeTokenLimit - tokensUsed);
  const proRemaining = Math.max(0, limits.proMonthlyTokenLimit - proTokensUsedMonth);
  const onDemandRequired = proActive && proRemaining <= 0;

  let billingLane: AiBillingLane = "free";
  let tokenLimit = limits.freeTokenLimit;
  let tokensRemaining = freeRemaining;
  let limitReached = tokensUsed >= limits.freeTokenLimit;

  if (proActive) {
    if (proRemaining > 0) {
      billingLane = "pro";
      tokenLimit = limits.proMonthlyTokenLimit;
      tokensRemaining = proRemaining;
      limitReached = false;
    } else if (onDemandEnabled) {
      billingLane = "on_demand";
      tokenLimit = limits.proMonthlyTokenLimit;
      tokensRemaining = 0;
      limitReached = false;
    } else {
      billingLane = "pro";
      tokenLimit = limits.proMonthlyTokenLimit;
      tokensRemaining = 0;
      limitReached = true;
    }
  }

  return {
    tokensUsed: proActive ? proTokensUsedMonth : tokensUsed,
    tokenLimit,
    tokensRemaining,
    proUnlimited: proActive,
    proActive,
    limitReached,
    proTokensUsedMonth,
    proMonthlyLimit: limits.proMonthlyTokenLimit,
    proTokensRemaining: proRemaining,
    monthKey,
    onDemandEnabled,
    onDemandRequired,
    onDemandUsdPer1kTokens: limits.onDemandUsdPer1kTokens,
    modelMode,
    modelId,
    billingLane,
    /** Overall consumption in DLLR for the active lane (free lifetime or Pro month). */
    dllrUsed: estimateOnDemandUsd(
      proActive ? proTokensUsedMonth : tokensUsed,
      limits.onDemandUsdPer1kTokens,
    ),
    dllrLimit: estimateOnDemandUsd(tokenLimit, limits.onDemandUsdPer1kTokens),
    proExpiresAt: proActive ? proExpiresAt : null,
  };
}

export async function ensureAiFreeQuotaTable(): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS user_ai_free_quota (
      username TEXT PRIMARY KEY,
      tokens_used INTEGER NOT NULL DEFAULT 0,
      pro_expires_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `;
  await sql`ALTER TABLE user_ai_free_quota ADD COLUMN IF NOT EXISTS pro_tokens_used_month INTEGER NOT NULL DEFAULT 0;`;
  await sql`ALTER TABLE user_ai_free_quota ADD COLUMN IF NOT EXISTS pro_month_key TEXT;`;
  await sql`ALTER TABLE user_ai_free_quota ADD COLUMN IF NOT EXISTS on_demand_enabled BOOLEAN NOT NULL DEFAULT FALSE;`;
  await sql`ALTER TABLE user_ai_free_quota ADD COLUMN IF NOT EXISTS model_mode TEXT NOT NULL DEFAULT 'auto';`;
  await sql`ALTER TABLE user_ai_free_quota ADD COLUMN IF NOT EXISTS model_id TEXT;`;
}

async function loadLimits() {
  try {
    return await getAiLimitsConfig();
  } catch {
    return {
      freeTokenLimit: DEFAULT_FREE_AI_TOKEN_LIMIT,
      proMonthlyTokenLimit: DEFAULT_PRO_MONTHLY_TOKEN_LIMIT,
      onDemandUsdPer1kTokens: DEFAULT_ON_DEMAND_USD_PER_1K,
    };
  }
}

async function fetchRow(username: string): Promise<QuotaRow | undefined> {
  const rows = await sql`
    SELECT
      tokens_used,
      pro_expires_at,
      pro_tokens_used_month,
      pro_month_key,
      on_demand_enabled,
      model_mode,
      model_id
    FROM user_ai_free_quota
    WHERE username = ${username}
    LIMIT 1;
  `;
  return rows[0] as QuotaRow | undefined;
}

export function estimateTextTokens(...parts: Array<string | null | undefined>): number {
  let chars = 0;
  for (const part of parts) {
    if (typeof part === "string" && part.length > 0) chars += part.length;
  }
  return Math.max(1, Math.ceil(chars / 4));
}

export async function getAiFreeQuota(usernameRaw: string): Promise<AiFreeQuotaSnapshot> {
  const username = normalizeUsername(usernameRaw);
  const limits = await loadLimits();
  if (!username) return toSnapshot(null, limits);
  await ensureAiFreeQuotaTable();
  const row = await fetchRow(username);
  return toSnapshot(row, limits);
}

export async function syncAiFreeQuotaPro(opts: {
  username: string;
  expiresAt: string | null;
}): Promise<AiFreeQuotaSnapshot> {
  const username = normalizeUsername(opts.username);
  const limits = await loadLimits();
  if (!username) return toSnapshot(null, limits);
  await ensureAiFreeQuotaTable();
  const expiresAt = opts.expiresAt && Date.parse(opts.expiresAt) > Date.now() ? opts.expiresAt : null;
  const rows = await sql`
    INSERT INTO user_ai_free_quota (username, tokens_used, pro_expires_at, updated_at)
    VALUES (${username}, 0, ${expiresAt}, NOW())
    ON CONFLICT (username) DO UPDATE SET
      pro_expires_at = EXCLUDED.pro_expires_at,
      updated_at = NOW()
    RETURNING
      tokens_used,
      pro_expires_at,
      pro_tokens_used_month,
      pro_month_key,
      on_demand_enabled,
      model_mode,
      model_id;
  `;
  return toSnapshot(rows[0] as QuotaRow, limits);
}

export async function updateAiUserPrefs(opts: {
  username: string;
  onDemandEnabled?: boolean;
  modelMode?: AiModelMode;
  modelId?: string | null;
}): Promise<AiFreeQuotaSnapshot> {
  const username = normalizeUsername(opts.username);
  const limits = await loadLimits();
  if (!username) return toSnapshot(null, limits);
  await ensureAiFreeQuotaTable();

  const current = await fetchRow(username);
  const onDemand =
    opts.onDemandEnabled !== undefined
      ? Boolean(opts.onDemandEnabled)
      : asBool(current?.on_demand_enabled);
  const modelMode =
    opts.modelMode !== undefined ? opts.modelMode : parseModelMode(current?.model_mode);
  let modelId: string | null =
    opts.modelId !== undefined
      ? opts.modelId && opts.modelId.trim()
        ? opts.modelId.trim().slice(0, 120)
        : null
      : typeof current?.model_id === "string"
        ? current.model_id
        : null;
  if (modelMode !== "model") modelId = null;

  const rows = await sql`
    INSERT INTO user_ai_free_quota (
      username,
      tokens_used,
      on_demand_enabled,
      model_mode,
      model_id,
      updated_at
    )
    VALUES (${username}, 0, ${onDemand}, ${modelMode}, ${modelId}, NOW())
    ON CONFLICT (username) DO UPDATE SET
      on_demand_enabled = EXCLUDED.on_demand_enabled,
      model_mode = EXCLUDED.model_mode,
      model_id = EXCLUDED.model_id,
      updated_at = NOW()
    RETURNING
      tokens_used,
      pro_expires_at,
      pro_tokens_used_month,
      pro_month_key,
      on_demand_enabled,
      model_mode,
      model_id;
  `;
  return toSnapshot(rows[0] as QuotaRow, limits);
}

/**
 * Consume tokens after a successful AI turn.
 * Returns null when the turn was not allowed (limit hit, on-demand off).
 */
export async function consumeAiFreeTokens(opts: {
  username: string;
  tokens: number;
}): Promise<(AiFreeQuotaSnapshot & { billedLane: AiBillingLane; costUsd: number }) | null> {
  const username = normalizeUsername(opts.username);
  const add = Math.max(0, Math.round(opts.tokens));
  const limits = await loadLimits();
  if (!username) {
    const snap = toSnapshot(null, limits);
    return { ...snap, billedLane: "free", costUsd: 0 };
  }
  await ensureAiFreeQuotaTable();

  const before = await getAiFreeQuota(username);
  if (before.limitReached) return null;

  const monthKey = utcMonthKey();
  let billedLane: AiBillingLane = before.billingLane;
  let costUsd = 0;

  if (before.proActive) {
    if (before.proTokensRemaining > 0) {
      billedLane = "pro";
      const rows = await sql`
        INSERT INTO user_ai_free_quota (
          username, tokens_used, pro_tokens_used_month, pro_month_key, updated_at
        )
        VALUES (${username}, 0, ${add}, ${monthKey}, NOW())
        ON CONFLICT (username) DO UPDATE SET
          pro_tokens_used_month = CASE
            WHEN user_ai_free_quota.pro_month_key IS DISTINCT FROM ${monthKey}
              THEN ${add}
            ELSE user_ai_free_quota.pro_tokens_used_month + ${add}
          END,
          pro_month_key = ${monthKey},
          updated_at = NOW()
        RETURNING
          tokens_used,
          pro_expires_at,
          pro_tokens_used_month,
          pro_month_key,
          on_demand_enabled,
          model_mode,
          model_id;
      `;
      const snap = toSnapshot(rows[0] as QuotaRow, limits);
      return { ...snap, billedLane, costUsd: 0 };
    }
    if (!before.onDemandEnabled) return null;
    billedLane = "on_demand";
    costUsd = estimateOnDemandUsd(add, limits.onDemandUsdPer1kTokens);
    const rows = await sql`
      INSERT INTO user_ai_free_quota (username, tokens_used, updated_at)
      VALUES (${username}, 0, NOW())
      ON CONFLICT (username) DO UPDATE SET updated_at = NOW()
      RETURNING
        tokens_used,
        pro_expires_at,
        pro_tokens_used_month,
        pro_month_key,
        on_demand_enabled,
        model_mode,
        model_id;
    `;
    const snap = toSnapshot(rows[0] as QuotaRow, limits);
    return { ...snap, billedLane, costUsd };
  }

  billedLane = "free";
  const rows = await sql`
    INSERT INTO user_ai_free_quota (username, tokens_used, updated_at)
    VALUES (${username}, ${add}, NOW())
    ON CONFLICT (username) DO UPDATE SET
      tokens_used = user_ai_free_quota.tokens_used + ${add},
      updated_at = NOW()
    RETURNING
      tokens_used,
      pro_expires_at,
      pro_tokens_used_month,
      pro_month_key,
      on_demand_enabled,
      model_mode,
      model_id;
  `;
  const snap = toSnapshot(rows[0] as QuotaRow, limits);
  return { ...snap, billedLane, costUsd: 0 };
}

/** Pre-flight: true when the account may start another AI turn. */
export async function canStartAiFreeTurn(usernameRaw: string): Promise<{
  ok: boolean;
  quota: AiFreeQuotaSnapshot;
  reason?: "free_ai_limit" | "pro_ai_limit";
}> {
  const quota = await getAiFreeQuota(usernameRaw);
  if (!quota.limitReached) return { ok: true, quota };
  return {
    ok: false,
    quota,
    reason: quota.proActive ? "pro_ai_limit" : "free_ai_limit",
  };
}

export function routePreferenceFromQuota(quota: AiFreeQuotaSnapshot): AiRoutePreference {
  return { modelMode: quota.modelMode, modelId: quota.modelId };
}
