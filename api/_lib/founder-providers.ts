/**
 * Optional live cost probes (Railway / Vercel billing).
 */
import type { FounderCostInputs } from "./founder-costs.js";
import {
  fetchVercelUsageBreakdown,
  type VercelUsageBreakdown,
} from "./founder-vercel-usage.js";

export type ProviderCostProbe = {
  source: "live" | "env" | "unavailable";
  label: string;
  usdMonthEstimate: number | null;
  detail?: string;
  raw?: unknown;
};

async function probeRailway(envUsd: number): Promise<ProviderCostProbe> {
  const token = process.env.RAILWAY_API_TOKEN?.trim();
  if (!token) {
    return {
      source: "env",
      label: "Railway",
      usdMonthEstimate: envUsd,
      detail: "RAILWAY_API_TOKEN not set — using FOUNDER_COST_RAILWAY_USD_MONTH",
    };
  }
  const isUuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token);
  try {
    const res = await fetch("https://backboard.railway.app/graphql/v2", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(isUuid
          ? { "Project-Access-Token": token }
          : { Authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify({
        query: isUuid
          ? `{ __typename }`
          : `{ me { id email } }`,
      }),
    });
    if (!res.ok) {
      return {
        source: "env",
        label: "Railway",
        usdMonthEstimate: envUsd,
        detail: `Railway API HTTP ${res.status} — using env estimate`,
      };
    }
    const json = (await res.json()) as { data?: unknown; errors?: unknown };
    if (json.errors) {
      return {
        source: "env",
        label: "Railway",
        usdMonthEstimate: envUsd,
        detail: "Railway token rejected — using env estimate",
        raw: json.errors,
      };
    }
    return {
      source: "live",
      label: "Railway",
      usdMonthEstimate: envUsd,
      detail: isUuid
        ? "Railway project token reachable (metrics). Billing $ from live usage when RAILWAY_PROJECT_ID is set."
        : "Railway account reachable. Billing dollars from estimatedUsage/metrics when configured.",
      raw: json.data ?? json,
    };
  } catch (err) {
    return {
      source: "env",
      label: "Railway",
      usdMonthEstimate: envUsd,
      detail: err instanceof Error ? err.message : "railway_probe_failed",
    };
  }
}

function probeGcp(envUsd: number, gcpLive?: { source: string; usdMonth: number; detail: string }): ProviderCostProbe {
  if (gcpLive?.source === "live") {
    return {
      source: "live",
      label: "Google Cloud",
      usdMonthEstimate: gcpLive.usdMonth,
      detail: gcpLive.detail,
    };
  }
  const hasSa = Boolean(process.env.GCP_SERVICE_ACCOUNT_JSON?.trim());
  return {
    source: hasSa || envUsd > 0 ? "env" : "unavailable",
    label: "Google Cloud",
    usdMonthEstimate: envUsd,
    detail:
      gcpLive?.detail ||
      (hasSa
        ? "GCP SA present — enable Billing → BigQuery export for live daily $, or set FOUNDER_COST_GCP_USD_MONTH."
        : "No GCP billing export wired — using FOUNDER_COST_GCP_USD_MONTH (often $0 while TDLib is on Railway)."),
  };
}

export async function probeProviderCosts(
  inputs: FounderCostInputs,
  vercelUsage?: VercelUsageBreakdown | null,
  gcpUsage?: { source: string; usdMonth: number; detail: string } | null,
): Promise<ProviderCostProbe[]> {
  const [railway, vercelLive] = await Promise.all([
    probeRailway(inputs.infra.railwayUsdMonth),
    vercelUsage
      ? Promise.resolve(vercelUsage)
      : fetchVercelUsageBreakdown(30),
  ]);

  const vercelProbe: ProviderCostProbe =
    vercelLive.source === "live"
      ? {
          source: "live",
          label: "Vercel",
          usdMonthEstimate: vercelLive.totalUsd,
          detail: `${vercelLive.detail} · fixed $${vercelLive.fixedUsdMonth.toFixed(2)}/mo · on-demand $${vercelLive.onDemandUsdMonth.toFixed(2)}/mo`,
          raw: {
            fixedUsdMonth: vercelLive.fixedUsdMonth,
            onDemandUsdMonth: vercelLive.onDemandUsdMonth,
            topServices: vercelLive.byService.slice(0, 8),
          },
        }
      : {
          source: "env",
          label: "Vercel",
          usdMonthEstimate: inputs.infra.vercelUsdMonth,
          detail: vercelLive.detail || "using FOUNDER_COST_VERCEL_USD_MONTH",
        };

  return [
    railway,
    vercelProbe,
    probeGcp(inputs.infra.gcpUsdMonth, gcpUsage ?? undefined),
    {
      source: "env",
      label: "Neon",
      usdMonthEstimate: inputs.infra.neonUsdMonth,
      detail: "FOUNDER_COST_NEON_USD_MONTH (free tier → 0 until paid)",
    },
    {
      source: "env",
      label: "AI (OpenAI / gateway)",
      usdMonthEstimate: inputs.infra.aiUsdMonth,
      detail: "FOUNDER_COST_AI_USD_MONTH — update from OpenAI usage dashboard",
    },
  ];
}

export { fetchVercelUsageBreakdown };
