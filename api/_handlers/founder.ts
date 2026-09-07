/**
 * Founder financial model API.
 * POST /api/founder { password } — login + payload
 * GET  /api/founder — payload if session cookie / Bearer ok
 * POST /api/founder { action: "logout" }
 * POST /api/founder { action: "run_probe", minutes?: number } — short on-demand probe (max 5)
 */
import {
  buildFounderSessionClearCookie,
  buildFounderSessionSetCookie,
  founderPasswordConfigured,
  isFounderAuthorized,
  verifyFounderPassword,
} from "../_lib/founder-auth.js";
import {
  buildFounderModelBundle,
  buildProbeFromStoredJson,
} from "../_lib/founder-model.js";
import {
  buildConsumptionProbeResult,
  resolveOnDemandUnitCosts,
} from "../_lib/founder-ondemand.js";
import {
  fetchVercelUsageBreakdown,
  probeProviderCosts,
} from "../_lib/founder-providers.js";
import {
  fetchGcpUsageBreakdown,
  fetchRailwayUsageBreakdown,
} from "../_lib/founder-provider-costs.js";
import {
  getAiLimitsConfig,
  updateAiLimitsConfig,
} from "../../database/aiLimitsConfig.js";
import { syncAiFreeQuotaPro } from "../../database/aiFreeQuota.js";
import { findUsernamesByWalletAddress } from "../../database/wallets.js";
import {
  getProCatalogConfig,
  updateProCatalogConfig,
} from "../../database/proCatalogConfig.js";
import {
  buildProPlansFromCatalog,
  computeLaunchDiscountUsd,
  computeProMonthPrice,
  retailFromCogs,
  type ProCatalogConfig,
  type ProFeatureEnabledMap,
  type ProFeatureWeightMap,
} from "../../shared/proCatalog.js";
import { parseRequestJsonBody } from "../_lib/parse-request-body.js";
import {
  getFounderScreenTimeSnapshot,
  getFounderUserCounts,
} from "../../database/founderMetrics.js";
import {
  calibrateFromEvidence,
  buildDailyUsageSeries,
  getScreenEvidence,
  getTodayScreenRollup,
  listFounderCostSnapshots,
  regressOnDemandPerScreenHour,
  upsertTodayFounderCostSnapshot,
} from "../../database/founderCalibration.js";

type NodeRes = {
  setHeader(name: string, value: string): void;
  status(code: number): void;
  end(body?: string): void;
};

function jsonResponse(
  body: object,
  status: number,
  extraHeaders?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...(extraHeaders ?? {}),
    },
  });
}

async function respond(
  res: NodeRes | undefined,
  body: object,
  status: number,
  extraHeaders?: Record<string, string>,
): Promise<Response | void> {
  if (res) {
    res.setHeader("Content-Type", "application/json");
    if (extraHeaders) {
      for (const [k, v] of Object.entries(extraHeaders)) {
        res.setHeader(k, v);
      }
    }
    res.status(status);
    res.end(JSON.stringify(body));
    return;
  }
  return jsonResponse(body, status, extraHeaders);
}

function loadStoredProbe(vercel: Awaited<ReturnType<typeof fetchVercelUsageBreakdown>>) {
  const raw = process.env.FOUNDER_CONSUMPTION_PROBE_JSON?.trim();
  if (!raw) return null;
  try {
    return buildProbeFromStoredJson(JSON.parse(raw), vercel);
  } catch {
    return null;
  }
}

/**
 * Server-side compressed probe (same cadence math as the 5-min script, shorter wall time).
 * Runs up to `minutes` of simulated ticks without sleeping full duration when minutes is small;
 * for minutes>=5 it still caps wall clock at ~25s to stay inside serverless limits and
 * scales request counts as if the full window ran.
 */
async function runCompressedProbe(minutes: number, vercel: Awaited<ReturnType<typeof fetchVercelUsageBreakdown>>) {
  const targetMinutes = Math.max(1, Math.min(5, minutes));
  const targetMs = targetMinutes * 60_000;
  const heartbeatMs = 30_000;
  const ticks = Math.max(1, Math.round(targetMs / heartbeatMs));
  // Execute a bounded number of real requests, then scale counts to full tick count.
  const liveTicks = Math.min(ticks, 8);
  const base = (
    process.env.EXPO_PUBLIC_API_BASE_URL ||
    process.env.VERCEL_URL ||
    "https://program.hyperlinks.space"
  )
    .toString()
    .replace(/\/$/, "");
  const origin = base.startsWith("http") ? base : `https://${base}`;

  const paths = ["/api/ping", "/api/feed", "/"];
  let requests = 0;
  let bytesIn = 0;
  let bytesOut = 0;
  let errors = 0;
  const byPath = new Map<string, { count: number; ok: number }>();

  const hit = async (path: string) => {
    requests += 1;
    const row = byPath.get(path) ?? { count: 0, ok: 0 };
    row.count += 1;
    try {
      const res = await fetch(`${origin}${path}`, {
        headers: { "Cache-Control": "no-store" },
      });
      const buf = Buffer.from(await res.arrayBuffer());
      bytesIn += buf.length;
      bytesOut += path.length + 80;
      if (res.ok || res.status === 401 || res.status === 403) row.ok += 1;
      else errors += 1;
    } catch {
      errors += 1;
    }
    byPath.set(path, row);
  };

  for (let i = 0; i < liveTicks; i++) {
    await hit("/api/ping");
    await hit(paths[i % paths.length]!);
  }

  const scale = ticks / liveTicks;
  const scaledRequests = Math.round(requests * scale);
  const scaledIn = Math.round(bytesIn * scale);
  const scaledOut = Math.round(bytesOut * scale);
  const endpoints = [...byPath.entries()].map(([path, v]) => ({
    path,
    count: Math.round(v.count * scale),
    ok: Math.round(v.ok * scale),
  }));

  return buildConsumptionProbeResult({
    durationMs: targetMs,
    requests: scaledRequests,
    bytesIn: scaledIn,
    bytesOut: scaledOut,
    errors,
    endpoints,
    units: resolveOnDemandUnitCosts(vercel.unitCosts),
    method: `compressed_server_probe:${liveTicks}_live_ticks_scaled_to_${ticks}_for_${targetMinutes}m @ ${origin}`,
  });
}

async function buildPayload(probeOverride?: ReturnType<typeof buildConsumptionProbeResult> | null) {
  try {
    const { ensureSchema } = await import("../../database/start.js");
    await ensureSchema();
  } catch {
    /* founder still returns with tablesExist=false */
  }

  const [screenTime, users, vercel, railway, gcp, evidence, today, regression, snapshots] =
    await Promise.all([
      getFounderScreenTimeSnapshot(),
      getFounderUserCounts(),
      fetchVercelUsageBreakdown(14),
      fetchRailwayUsageBreakdown(14),
      fetchGcpUsageBreakdown(14),
      getScreenEvidence(),
      getTodayScreenRollup(),
      regressOnDemandPerScreenHour(),
      listFounderCostSnapshots(30).catch(() => []),
    ]);

  const vercelFixed = vercel.source === "live" ? vercel.fixedUsdMonth : 0;
  const vercelOnDemand = vercel.source === "live" ? vercel.onDemandUsdMonth : 0;
  // Railway usage beyond plan ≈ on-demand; plan fee ≈ fixed.
  const railwayOnDemand = railway.usageUsdMonth;
  const railwayFixed = railway.fixedPlanUsdMonth;
  const gcpUsd = gcp.usdMonth;

  const liveOnDemandUsdMonth = vercelOnDemand + railwayOnDemand + Math.max(0, gcpUsd) * 0.5;
  const liveFixedUsdMonth = vercelFixed + railwayFixed + Math.max(0, gcpUsd) * 0.5;

  try {
    await upsertTodayFounderCostSnapshot({
      screenActiveMsToday: today.activeMs,
      screenUsersToday: today.users,
      screenSessionsToday: today.sessions,
      costs: {
        vercelFixedUsd: vercelFixed,
        vercelOnDemandUsd: vercelOnDemand,
        railwayUsd: railway.totalUsdMonth,
        gcpUsd,
        onDemandUsd: liveOnDemandUsdMonth,
        fixedUsd: liveFixedUsdMonth,
      },
      source: `vercel:${vercel.source}|railway:${railway.source}|gcp:${gcp.source}`,
    });
  } catch {
    /* snapshot optional — calibration still runs from live pulls */
  }

  const probe = probeOverride ?? loadStoredProbe(vercel);
  const { resolveFounderCostInputs } = await import("../_lib/founder-costs.js");
  const envCosts = resolveFounderCostInputs();

  const calibration = calibrateFromEvidence({
    evidence,
    liveOnDemandUsdMonth,
    liveFixedUsdMonth,
    probeUsdPerActiveHour: probe?.onDemandUsdPerActiveHour ?? null,
    envFallbackUsdPerActiveHour: envCosts.variablePerActiveHourUsd,
    regressionUsdPerActiveHour: regression,
  });

  const proCatalog = await getProCatalogConfig().catch(() => null);
  const catalogPlans = proCatalog ? buildProPlansFromCatalog(proCatalog) : null;
  const tariffsOverride = catalogPlans
    ? {
        monthUsd: catalogPlans[0]!.priceUsd,
        quarterTotalUsd: catalogPlans[1]!.priceUsd,
        yearTotalUsd: catalogPlans[2]!.priceUsd,
      }
    : null;

  const model = buildFounderModelBundle(screenTime, {
    vercel,
    probe,
    calibration,
    railwayTotalUsdMonth: railway.totalUsdMonth,
    gcpUsdMonth: gcp.usdMonth,
    tariffsOverride,
  });
  const providers = await probeProviderCosts(model.costs, vercel);
  const enrichedProviders = providers.map((p) => {
    if (p.label === "Railway") {
      return {
        source: railway.source,
        label: "Railway",
        usdMonthEstimate: railway.totalUsdMonth,
        detail: `${railway.detail} · usage $${railway.usageUsdMonth.toFixed(2)} + plan $${railway.fixedPlanUsdMonth.toFixed(2)}`,
        raw: railway.raw,
      };
    }
    if (p.label === "Google Cloud") {
      return {
        source: gcp.source,
        label: "Google Cloud",
        usdMonthEstimate: gcp.usdMonth,
        detail: gcp.detail,
      };
    }
    return p;
  });

  const dailyUsage = buildDailyUsageSeries({
    days: screenTime.dailyLast30d,
    onDemandUsdPerActiveHour: calibration.onDemandUsdPerActiveHour,
    fixedUsdPerDay: liveFixedUsdMonth / 30,
    snapshots,
    vercelByDay: (vercel.byDay ?? []).map((d) => ({
      day: d.day,
      totalUsd: d.totalUsd,
      source: vercel.source,
    })),
    railwayByDay: railway.byDay ?? [],
    gcpByDay: gcp.byDay ?? [],
  });

  const aiLimits = await getAiLimitsConfig().catch(() => null);
  const margin = proCatalog?.targetProfitMargin ?? 0.5;
  const aiCogsPer1k = aiLimits?.onDemandUsdPer1kTokens ?? 0.002;
  const consumptionEconomics = proCatalog
    ? {
        targetProfitMargin: margin,
        profitMarginUsd: proCatalog.profitMarginUsd,
        monthPriceUsd: computeProMonthPrice(proCatalog),
        launchDiscountUsd: computeLaunchDiscountUsd(proCatalog),
        fullMonthListUsd: proCatalog.fullMonthListUsd,
        screenTimeCogsPerActiveHourUsd: calibration.onDemandUsdPerActiveHour,
        screenTimeRetailPerActiveHourUsd: retailFromCogs(
          calibration.onDemandUsdPerActiveHour,
          margin,
        ),
        aiCogsPer1kTokensUsd: aiCogsPer1k,
        aiRetailPer1kTokensUsd: retailFromCogs(aiCogsPer1k, margin),
        note: "Users pay DLLR for screen-time (Vercel/Railway/GCP) and AI. Retail = COGS ÷ (1 − margin). Plan price = enabled features + profit margin $.",
      }
    : null;

  return {
    ok: true as const,
    generatedAt: new Date().toISOString(),
    screenTime,
    users,
    providers: enrichedProviders,
    vercelUsage: vercel,
    railwayUsage: railway,
    gcpUsage: gcp,
    dailyUsage,
    model,
    aiLimits,
    proCatalog,
    catalogPlans,
    consumptionEconomics,
    screenTimeHealth: {
      tablesExist: screenTime.tablesExist,
      hasSessions: screenTime.recentSessions.length > 0,
      hasTotals: screenTime.usersWithScreenTime > 0,
      note: screenTime.tablesExist
        ? screenTime.recentSessions.length > 0
          ? "Screen-time sessions are storing (heartbeats → user_screen_sessions + totals). Calibration confidence rises as hours, users, and cost snapshots accumulate."
          : "Tables exist but no sessions yet — open the app signed-in and keep a tab visible ~30s."
        : "Screen-time tables missing — run npm run db:migrate / redeploy so schema applies.",
    },
  };
}

async function handler(request: Request, res?: NodeRes): Promise<Response | void> {
  const method = (request.method ?? "GET").toUpperCase();
  if (method === "OPTIONS") {
    return respond(res, { ok: true }, 204);
  }

  if (!founderPasswordConfigured()) {
    return respond(
      res,
      {
        ok: false,
        error: "founder_password_not_configured",
        hint: "Set FOUNDER_DASHBOARD_PASSWORD (min 8 chars) on Vercel.",
      },
      503,
    );
  }

  try {
  if (method === "POST") {
    const body = await parseRequestJsonBody<{
      password?: unknown;
      action?: unknown;
      minutes?: unknown;
      freeTokenLimit?: unknown;
      proMonthlyTokenLimit?: unknown;
      onDemandUsdPer1kTokens?: unknown;
      targetProfitMargin?: unknown;
      quarterDiscountPct?: unknown;
      yearDiscountPct?: unknown;
      featureEnabled?: unknown;
      featureWeights?: unknown;
      applyMarginToOnDemand?: unknown;
      walletAddress?: unknown;
    }>(request);
    const action =
      typeof body.action === "string" ? body.action.trim().toLowerCase() : "login";

    if (action === "logout") {
      return respond(
        res,
        { ok: true, loggedOut: true },
        200,
        { "Set-Cookie": buildFounderSessionClearCookie() },
      );
    }

    if (action === "save_ai_limits") {
      if (!isFounderAuthorized(request)) {
        return respond(res, { ok: false, error: "unauthorized" }, 401);
      }
      const aiLimits = await updateAiLimitsConfig({
        freeTokenLimit:
          typeof body.freeTokenLimit === "number" ? body.freeTokenLimit : undefined,
        proMonthlyTokenLimit:
          typeof body.proMonthlyTokenLimit === "number"
            ? body.proMonthlyTokenLimit
            : undefined,
        onDemandUsdPer1kTokens:
          typeof body.onDemandUsdPer1kTokens === "number"
            ? body.onDemandUsdPer1kTokens
            : undefined,
      });
      return respond(res, { ok: true, aiLimits }, 200);
    }

    if (action === "save_pro_catalog") {
      if (!isFounderAuthorized(request)) {
        return respond(res, { ok: false, error: "unauthorized" }, 401);
      }
      const patch: Partial<ProCatalogConfig> = {};
      if (typeof body.profitMarginUsd === "number") {
        patch.profitMarginUsd = body.profitMarginUsd;
      } else if (typeof body.targetProfitMargin === "number") {
        // Legacy: percent margin only — keep as COGS margin; dollar margin unchanged.
        patch.targetProfitMargin = body.targetProfitMargin;
      }
      if (typeof body.quarterDiscountPct === "number") {
        patch.quarterDiscountPct = body.quarterDiscountPct;
      }
      if (typeof body.yearDiscountPct === "number") {
        patch.yearDiscountPct = body.yearDiscountPct;
      }
      if (body.featureEnabled && typeof body.featureEnabled === "object") {
        patch.featureEnabled = body.featureEnabled as Partial<ProFeatureEnabledMap>;
      }
      if (body.featureWeights && typeof body.featureWeights === "object") {
        patch.featureWeights = body.featureWeights as Partial<ProFeatureWeightMap>;
      }
      const proCatalog = await updateProCatalogConfig(patch);
      let aiLimits = await getAiLimitsConfig().catch(() => null);
      if (body.applyMarginToOnDemand === true) {
        // Baseline provider COGS → retail DLLR rate with target margin.
        const providerCogsPer1k = 0.001;
        aiLimits = await updateAiLimitsConfig({
          onDemandUsdPer1kTokens: retailFromCogs(
            providerCogsPer1k,
            proCatalog.targetProfitMargin,
          ),
        });
      }
      const plans = buildProPlansFromCatalog(proCatalog);
      return respond(
        res,
        {
          ok: true,
          proCatalog,
          catalogPlans: plans,
          aiLimits,
          monthPriceUsd: computeProMonthPrice(proCatalog),
          launchDiscountUsd: computeLaunchDiscountUsd(proCatalog),
        },
        200,
      );
    }

    if (action === "revoke_pro_by_wallet") {
      if (!isFounderAuthorized(request)) {
        return respond(res, { ok: false, error: "unauthorized" }, 401);
      }
      const walletAddress =
        typeof body.walletAddress === "string" ? body.walletAddress.trim() : "";
      if (!walletAddress) {
        return respond(res, { ok: false, error: "wallet_address_required" }, 400);
      }
      const usernames = await findUsernamesByWalletAddress(walletAddress);
      if (usernames.length === 0) {
        return respond(
          res,
          { ok: false, error: "wallet_not_found", walletAddress },
          404,
        );
      }
      const revoked: string[] = [];
      for (const username of usernames) {
        await syncAiFreeQuotaPro({ username, expiresAt: null });
        revoked.push(username);
      }
      return respond(
        res,
        {
          ok: true,
          walletAddress,
          revokedUsernames: revoked,
          count: revoked.length,
        },
        200,
      );
    }

    if (action === "run_probe" || action === "login") {
      const pwd = typeof body.password === "string" ? body.password : "";
      const authed =
        action === "run_probe"
          ? isFounderAuthorized(request) || (pwd ? verifyFounderPassword(pwd) : false)
          : verifyFounderPassword(pwd);
      if (!authed) {
        return respond(res, { ok: false, error: "unauthorized" }, 401);
      }

      if (action === "run_probe") {
        const minutes =
          typeof body.minutes === "number" && Number.isFinite(body.minutes)
            ? body.minutes
            : 5;
        const vercel = await fetchVercelUsageBreakdown(7);
        const probe = await runCompressedProbe(minutes, vercel);
        const payload = await buildPayload(probe);
        const headers =
          pwd && verifyFounderPassword(pwd)
            ? { "Set-Cookie": buildFounderSessionSetCookie() }
            : undefined;
        return respond(res, payload, 200, headers);
      }

      const payload = await buildPayload();
      return respond(res, payload, 200, {
        "Set-Cookie": buildFounderSessionSetCookie(),
      });
    }

    return respond(res, { ok: false, error: "invalid_action" }, 400);
  }

  if (method !== "GET") {
    return respond(res, { ok: false, error: "method_not_allowed" }, 405);
  }

  if (!isFounderAuthorized(request)) {
    return respond(res, { ok: false, error: "unauthorized" }, 401);
  }

  const payload = await buildPayload();
  return respond(res, payload, 200);
  } catch (err) {
    const message = err instanceof Error ? err.message : "founder_internal_error";
    return respond(res, { ok: false, error: message }, 500);
  }
}

export default handler;
export const GET = handler;
export const POST = handler;
export const OPTIONS = handler;
