/**
 * Shared Pro Access catalog: per-feature dollar prices, staged launch flags, term discounts.
 * Charged month price = sum(enabled feature prices) + profit margin ($).
 * Feature prices are independent (millicent precision, min $0.001) — no fixed $20 budget.
 */

/** @deprecated Kept for older UI copy; list price is now dynamic. */
export const PRO_FULL_MONTH_LIST_USD = 20;
/** Minimum founder-tunable feature / launch / margin price ($0.001). */
export const PRO_MIN_FEATURE_USD = 0.001;

export const PRO_FEATURE_IDS = [
  "aiModels",
  "proxyVpn",
  "blockchainChat",
  "unlimitedAccounts",
  "cashback",
  "nftCollection",
  "menuCustomization",
] as const;

export type ProFeatureId = (typeof PRO_FEATURE_IDS)[number];

export type ProFeatureWeightMap = Record<ProFeatureId, number>;
export type ProFeatureEnabledMap = Record<ProFeatureId, boolean>;

/** Default per-feature prices (independent; AI alone is the launch SKU). */
export const DEFAULT_PRO_FEATURE_WEIGHTS: ProFeatureWeightMap = {
  aiModels: 5,
  proxyVpn: 3,
  blockchainChat: 3,
  unlimitedAccounts: 3,
  cashback: 2,
  nftCollection: 2,
  menuCustomization: 2,
};

/** Launch: AI only. */
export const DEFAULT_PRO_FEATURE_ENABLED: ProFeatureEnabledMap = {
  aiModels: true,
  proxyVpn: false,
  blockchainChat: false,
  unlimitedAccounts: false,
  cashback: false,
  nftCollection: false,
  menuCustomization: false,
};

export type ProCatalogConfig = {
  /**
   * Gross margin fraction on consumption COGS (0–0.9). Retail ≈ COGS / (1 − margin).
   * Synced from {@link profitMarginUsd} / full list when the catalog is normalized.
   */
  targetProfitMargin: number;
  /** Fixed profit added on top of enabled feature prices (millicent precision). */
  profitMarginUsd: number;
  /** Percent off 3× monthly for quarter term. */
  quarterDiscountPct: number;
  /** Percent off 12× monthly for year term. */
  yearDiscountPct: number;
  featureWeights: ProFeatureWeightMap;
  featureEnabled: ProFeatureEnabledMap;
  /** Sum of all feature prices + profit margin (dynamic list). */
  fullMonthListUsd: number;
};

export const DEFAULT_PRO_CATALOG: ProCatalogConfig = {
  targetProfitMargin: 0,
  profitMarginUsd: 0,
  quarterDiscountPct: 10,
  yearDiscountPct: 20,
  featureWeights: { ...DEFAULT_PRO_FEATURE_WEIGHTS },
  featureEnabled: { ...DEFAULT_PRO_FEATURE_ENABLED },
  // 5+3+3+3+2+2+2
  fullMonthListUsd: 20,
};

export type ProCatalogPlan = {
  id: "month" | "quarter" | "year";
  months: number;
  priceUsd: number;
  monthlyUsd: number;
  listPriceUsd?: number;
  highlight?: boolean;
};

/** @deprecated Prefer {@link roundUsdCents}. */
export function roundWholeUsd(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.max(0, Math.round(n));
}

/** Round to the nearest millicent ($0.001); values below {@link PRO_MIN_FEATURE_USD} become 0. */
export function roundUsdCents(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  const millis = Math.round(n * 1000) / 1000;
  return millis < PRO_MIN_FEATURE_USD ? 0 : millis;
}

export function sumFeatureWeights(
  weights: ProFeatureWeightMap,
  enabled?: ProFeatureEnabledMap | null,
): number {
  let sum = 0;
  for (const id of PRO_FEATURE_IDS) {
    if (enabled && !enabled[id]) continue;
    const w = weights[id];
    if (Number.isFinite(w) && w > 0) sum += w;
  }
  return Math.round(sum * 1000) / 1000;
}

/** Clamp a founder-entered feature price (independent; no $20 rebalance). */
export function normalizeFeatureWeights(
  raw: Partial<ProFeatureWeightMap> | null | undefined,
): ProFeatureWeightMap {
  const next = { ...DEFAULT_PRO_FEATURE_WEIGHTS };
  if (!raw) return next;
  for (const id of PRO_FEATURE_IDS) {
    const v = raw[id];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
      next[id] = roundUsdCents(v);
    }
  }
  // AI must remain a payable launch SKU.
  if (next.aiModels < PRO_MIN_FEATURE_USD) next.aiModels = PRO_MIN_FEATURE_USD;
  return next;
}

/**
 * @deprecated AI price is edited like any other feature weight.
 * Kept so older call sites set aiModels without rebalancing.
 */
export function withAiLaunchWeight(
  current: ProFeatureWeightMap,
  aiLaunchUsd: number,
): ProFeatureWeightMap {
  return normalizeFeatureWeights({
    ...current,
    aiModels: Math.max(PRO_MIN_FEATURE_USD, roundUsdCents(aiLaunchUsd)),
  });
}

export function normalizeFeatureEnabled(
  raw: Partial<ProFeatureEnabledMap> | null | undefined,
): ProFeatureEnabledMap {
  const next = { ...DEFAULT_PRO_FEATURE_ENABLED };
  if (!raw) return next;
  for (const id of PRO_FEATURE_IDS) {
    if (typeof raw[id] === "boolean") next[id] = raw[id]!;
  }
  // Always keep at least AI enabled so the product has a payable SKU.
  if (!PRO_FEATURE_IDS.some((id) => next[id])) next.aiModels = true;
  return next;
}

export function clampMargin(raw: unknown, fallback = 0.5): number {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(0.9, Math.max(0, n));
}

export function clampDiscountPct(raw: unknown, fallback: number): number {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(50, Math.max(0, Math.round(n)));
}

export function clampProfitMarginUsd(raw: unknown, fallback = 0): number {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n < 0) return fallback;
  return roundUsdCents(n);
}

/** Gross margin fraction: profit $ / (features + profit). */
export function profitMarginFraction(featuresSumUsd: number, profitMarginUsd: number): number {
  const features = Math.max(0, featuresSumUsd);
  const profit = Math.max(0, profitMarginUsd);
  const retail = features + profit;
  if (retail <= 1e-9) return 0;
  return clampMargin(profit / retail, 0);
}

export function normalizeProCatalog(
  raw: Partial<ProCatalogConfig> | null | undefined,
): ProCatalogConfig {
  const featureWeights = normalizeFeatureWeights(raw?.featureWeights);
  const featureEnabled = normalizeFeatureEnabled(raw?.featureEnabled);
  const profitMarginUsd = clampProfitMarginUsd(
    raw?.profitMarginUsd,
    DEFAULT_PRO_CATALOG.profitMarginUsd,
  );
  const allFeaturesSum = sumFeatureWeights(featureWeights);
  const fullMonthListUsd = Math.round((allFeaturesSum + profitMarginUsd) * 1000) / 1000;
  return {
    targetProfitMargin: profitMarginFraction(allFeaturesSum, profitMarginUsd),
    profitMarginUsd,
    quarterDiscountPct: clampDiscountPct(
      raw?.quarterDiscountPct,
      DEFAULT_PRO_CATALOG.quarterDiscountPct,
    ),
    yearDiscountPct: clampDiscountPct(raw?.yearDiscountPct, DEFAULT_PRO_CATALOG.yearDiscountPct),
    featureWeights,
    featureEnabled,
    fullMonthListUsd,
  };
}

/** Charged monthly price = sum(enabled features) + profit margin $. */
export function computeProMonthPrice(cfg: ProCatalogConfig): number {
  const sum = sumFeatureWeights(cfg.featureWeights, cfg.featureEnabled);
  const total = Math.round((sum + Math.max(0, cfg.profitMarginUsd)) * 1000) / 1000;
  return Math.max(PRO_MIN_FEATURE_USD, roundUsdCents(total) || PRO_MIN_FEATURE_USD);
}

/** Discount vs full list (all features enabled + margin). */
export function computeLaunchDiscountUsd(cfg: ProCatalogConfig): number {
  return Math.max(0, roundUsdCents(cfg.fullMonthListUsd - computeProMonthPrice(cfg)));
}

/**
 * Apply target margin to a COGS amount.
 * retail = cogs / (1 − margin) so margin is gross margin on retail.
 */
export function retailFromCogs(cogsUsd: number, margin: number): number {
  const m = clampMargin(margin, 0.5);
  const c = Number.isFinite(cogsUsd) && cogsUsd > 0 ? cogsUsd : 0;
  const denom = Math.max(0.1, 1 - m);
  return Math.round((c / denom) * 1e6) / 1e6;
}

export function buildProPlansFromCatalog(cfg: ProCatalogConfig): ProCatalogPlan[] {
  const month = computeProMonthPrice(cfg);
  const listMonth = cfg.fullMonthListUsd;
  const quarterList = Math.round(listMonth * 3 * 1000) / 1000;
  const yearList = Math.round(listMonth * 12 * 1000) / 1000;
  const quarter = Math.max(
    month,
    roundUsdCents(month * 3 * (1 - cfg.quarterDiscountPct / 100)),
  );
  const year = Math.max(
    month,
    roundUsdCents(month * 12 * (1 - cfg.yearDiscountPct / 100)),
  );
  return [
    {
      id: "month",
      months: 1,
      priceUsd: month,
      monthlyUsd: month,
      listPriceUsd: month < listMonth - 1e-9 ? listMonth : undefined,
    },
    {
      id: "quarter",
      months: 3,
      priceUsd: quarter,
      monthlyUsd: Math.round((quarter / 3) * 1000) / 1000,
      listPriceUsd: quarter < quarterList - 1e-9 ? quarterList : undefined,
    },
    {
      id: "year",
      months: 12,
      priceUsd: year,
      monthlyUsd: Math.round((year / 12) * 1000) / 1000,
      listPriceUsd: year < yearList - 1e-9 ? yearList : undefined,
      highlight: true,
    },
  ];
}

export function enabledProFeatureIds(cfg: ProCatalogConfig): ProFeatureId[] {
  return PRO_FEATURE_IDS.filter((id) => cfg.featureEnabled[id]);
}

export const PRO_FEATURE_LABELS: Record<ProFeatureId, string> = {
  aiModels: "AI models",
  proxyVpn: "Proxy & VPN",
  blockchainChat: "Blockchain chat",
  unlimitedAccounts: "Unlimited messenger accounts",
  cashback: "DLLR cashback",
  nftCollection: "NFT collection",
  menuCustomization: "Menu customization",
};
