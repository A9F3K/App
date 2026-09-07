/**
 * Persisted Pro catalog (feature launch flags, prices, margin, term discounts).
 */
import { sql } from "./start.js";
import {
  DEFAULT_PRO_CATALOG,
  normalizeProCatalog,
  type ProCatalogConfig,
  type ProFeatureEnabledMap,
  type ProFeatureWeightMap,
} from "../shared/proCatalog.js";

export async function ensureProCatalogConfigTable(): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS founder_pro_catalog (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      target_profit_margin DOUBLE PRECISION NOT NULL DEFAULT 0.5,
      profit_margin_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
      quarter_discount_pct INTEGER NOT NULL DEFAULT 10,
      year_discount_pct INTEGER NOT NULL DEFAULT 20,
      feature_weights JSONB NOT NULL DEFAULT '{}'::jsonb,
      feature_enabled JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `;
  await sql`
    ALTER TABLE founder_pro_catalog
      ADD COLUMN IF NOT EXISTS profit_margin_usd DOUBLE PRECISION NOT NULL DEFAULT 0;
  `;
  await sql`
    INSERT INTO founder_pro_catalog (id)
    VALUES (1)
    ON CONFLICT (id) DO NOTHING;
  `;
}

function parseJsonObject(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  if (typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return {};
}

export async function getProCatalogConfig(): Promise<ProCatalogConfig> {
  await ensureProCatalogConfigTable();
  const rows = await sql`
    SELECT
      target_profit_margin,
      profit_margin_usd,
      quarter_discount_pct,
      year_discount_pct,
      feature_weights,
      feature_enabled
    FROM founder_pro_catalog
    WHERE id = 1
    LIMIT 1;
  `;
  const row = rows[0] as
    | {
        target_profit_margin?: unknown;
        profit_margin_usd?: unknown;
        quarter_discount_pct?: unknown;
        year_discount_pct?: unknown;
        feature_weights?: unknown;
        feature_enabled?: unknown;
      }
    | undefined;
  if (!row) return { ...DEFAULT_PRO_CATALOG };

  const weightsRaw = parseJsonObject(row.feature_weights);
  const enabledRaw = parseJsonObject(row.feature_enabled);
  const weightsEmpty = Object.keys(weightsRaw).length === 0;
  const enabledEmpty = Object.keys(enabledRaw).length === 0;

  return normalizeProCatalog({
    targetProfitMargin:
      typeof row.target_profit_margin === "number"
        ? row.target_profit_margin
        : DEFAULT_PRO_CATALOG.targetProfitMargin,
    profitMarginUsd:
      typeof row.profit_margin_usd === "number"
        ? row.profit_margin_usd
        : DEFAULT_PRO_CATALOG.profitMarginUsd,
    quarterDiscountPct:
      typeof row.quarter_discount_pct === "number"
        ? row.quarter_discount_pct
        : DEFAULT_PRO_CATALOG.quarterDiscountPct,
    yearDiscountPct:
      typeof row.year_discount_pct === "number"
        ? row.year_discount_pct
        : DEFAULT_PRO_CATALOG.yearDiscountPct,
    featureWeights: weightsEmpty
      ? DEFAULT_PRO_CATALOG.featureWeights
      : (weightsRaw as Partial<ProFeatureWeightMap>),
    featureEnabled: enabledEmpty
      ? DEFAULT_PRO_CATALOG.featureEnabled
      : (enabledRaw as Partial<ProFeatureEnabledMap>),
  });
}

export async function updateProCatalogConfig(
  patch: Partial<ProCatalogConfig>,
): Promise<ProCatalogConfig> {
  await ensureProCatalogConfigTable();
  const current = await getProCatalogConfig();
  const next = normalizeProCatalog({
    ...current,
    ...patch,
    featureWeights: patch.featureWeights
      ? { ...current.featureWeights, ...patch.featureWeights }
      : current.featureWeights,
    featureEnabled: patch.featureEnabled
      ? { ...current.featureEnabled, ...patch.featureEnabled }
      : current.featureEnabled,
  });
  await sql`
    UPDATE founder_pro_catalog
    SET
      target_profit_margin = ${next.targetProfitMargin},
      profit_margin_usd = ${next.profitMarginUsd},
      quarter_discount_pct = ${next.quarterDiscountPct},
      year_discount_pct = ${next.yearDiscountPct},
      feature_weights = ${JSON.stringify(next.featureWeights)}::jsonb,
      feature_enabled = ${JSON.stringify(next.featureEnabled)}::jsonb,
      updated_at = NOW()
    WHERE id = 1;
  `;
  return next;
}
