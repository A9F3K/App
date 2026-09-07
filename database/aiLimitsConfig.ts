/**
 * Founder-tunable AI token budgets (free lifetime, Pro monthly, on-demand $/1k).
 */
import { sql } from "./start.js";

export const DEFAULT_FREE_AI_TOKEN_LIMIT = 250_000; // ≈ $0.50 at default on-demand rate
/** Included Pro allowance per calendar month (UTC). */
export const DEFAULT_PRO_MONTHLY_TOKEN_LIMIT = 2_500_000; // ≈ $5.00 at default on-demand rate
/** DLLR charged per 1k tokens after the Pro monthly cap when on-demand is on. */
export const DEFAULT_ON_DEMAND_USD_PER_1K = 0.002;

export type AiLimitsConfig = {
  freeTokenLimit: number;
  proMonthlyTokenLimit: number;
  onDemandUsdPer1kTokens: number;
};

function asPositiveInt(raw: unknown, fallback: number): number {
  if (typeof raw === "bigint") {
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback;
  }
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return Math.round(raw);
  if (typeof raw === "string" && raw.trim()) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.round(n);
  }
  return fallback;
}

function asPositiveNumber(raw: unknown, fallback: number): number {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return raw;
  if (typeof raw === "string" && raw.trim()) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return fallback;
}

export async function ensureAiLimitsConfigTable(): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS founder_ai_limits (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      free_token_limit INTEGER NOT NULL DEFAULT 4500,
      pro_monthly_token_limit INTEGER NOT NULL DEFAULT 200000,
      on_demand_usd_per_1k_tokens DOUBLE PRECISION NOT NULL DEFAULT 0.002,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `;
  await sql`
    INSERT INTO founder_ai_limits (id)
    VALUES (1)
    ON CONFLICT (id) DO NOTHING;
  `;
}

export async function getAiLimitsConfig(): Promise<AiLimitsConfig> {
  await ensureAiLimitsConfigTable();
  const rows = await sql`
    SELECT free_token_limit, pro_monthly_token_limit, on_demand_usd_per_1k_tokens
    FROM founder_ai_limits
    WHERE id = 1
    LIMIT 1;
  `;
  const row = rows[0] as
    | {
        free_token_limit?: unknown;
        pro_monthly_token_limit?: unknown;
        on_demand_usd_per_1k_tokens?: unknown;
      }
    | undefined;
  return {
    freeTokenLimit: asPositiveInt(row?.free_token_limit, DEFAULT_FREE_AI_TOKEN_LIMIT),
    proMonthlyTokenLimit: asPositiveInt(
      row?.pro_monthly_token_limit,
      DEFAULT_PRO_MONTHLY_TOKEN_LIMIT,
    ),
    onDemandUsdPer1kTokens: asPositiveNumber(
      row?.on_demand_usd_per_1k_tokens,
      DEFAULT_ON_DEMAND_USD_PER_1K,
    ),
  };
}

export async function updateAiLimitsConfig(
  patch: Partial<AiLimitsConfig>,
): Promise<AiLimitsConfig> {
  await ensureAiLimitsConfigTable();
  const current = await getAiLimitsConfig();
  const next: AiLimitsConfig = {
    freeTokenLimit:
      patch.freeTokenLimit != null && patch.freeTokenLimit > 0
        ? Math.round(patch.freeTokenLimit)
        : current.freeTokenLimit,
    proMonthlyTokenLimit:
      patch.proMonthlyTokenLimit != null && patch.proMonthlyTokenLimit > 0
        ? Math.round(patch.proMonthlyTokenLimit)
        : current.proMonthlyTokenLimit,
    onDemandUsdPer1kTokens:
      patch.onDemandUsdPer1kTokens != null && patch.onDemandUsdPer1kTokens > 0
        ? patch.onDemandUsdPer1kTokens
        : current.onDemandUsdPer1kTokens,
  };
  await sql`
    UPDATE founder_ai_limits
    SET
      free_token_limit = ${next.freeTokenLimit},
      pro_monthly_token_limit = ${next.proMonthlyTokenLimit},
      on_demand_usd_per_1k_tokens = ${next.onDemandUsdPer1kTokens},
      updated_at = NOW()
    WHERE id = 1;
  `;
  return next;
}

export function estimateOnDemandUsd(tokens: number, usdPer1k: number): number {
  const t = Math.max(0, Math.round(tokens));
  const rate = usdPer1k > 0 ? usdPer1k : DEFAULT_ON_DEMAND_USD_PER_1K;
  return Math.round(((t / 1000) * rate) * 1e6) / 1e6;
}
