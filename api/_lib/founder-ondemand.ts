/**
 * 1-user on-demand consumption probe + monthly extrapolation (2–3h/day).
 */
export type ConsumptionProbeResult = {
  durationMs: number;
  durationMinutes: number;
  requests: number;
  bytesIn: number;
  bytesOut: number;
  errors: number;
  endpoints: Array<{ path: string; count: number; ok: number }>;
  /** Estimated Vercel on-demand $ for this probe window. */
  estimatedOnDemandUsd: number;
  /** $/active-hour from the probe. */
  onDemandUsdPerActiveHour: number;
  monthlyAtHoursPerDay: {
    h2: { activeHoursMonth: number; onDemandUsdMonth: number };
    h2_5: { activeHoursMonth: number; onDemandUsdMonth: number };
    h3: { activeHoursMonth: number; onDemandUsdMonth: number };
  };
  method: string;
};

export type OnDemandUnitCosts = {
  functionInvocationUsd: number;
  /** Per GB transferred (Fast Origin Transfer). */
  transferGbUsd: number;
  /** Rough active-CPU $ per invocation-second equivalent floor. */
  perRequestCpuUsd: number;
};

/** Defaults from Vercel Pro Fluid / transfer list prices (overridden by live FOCUS units). */
export const DEFAULT_ONDEMAND_UNIT_COSTS: OnDemandUnitCosts = {
  functionInvocationUsd: 0.6 / 1_000_000,
  transferGbUsd: 0.15,
  perRequestCpuUsd: 0.00002,
};

export function resolveOnDemandUnitCosts(live?: {
  functionInvocationUsd: number | null;
  fluidActiveCpuHourUsd: number | null;
  fastOriginTransferGbUsd: number | null;
}): OnDemandUnitCosts {
  return {
    functionInvocationUsd:
      live?.functionInvocationUsd && live.functionInvocationUsd > 0
        ? live.functionInvocationUsd
        : DEFAULT_ONDEMAND_UNIT_COSTS.functionInvocationUsd,
    transferGbUsd:
      live?.fastOriginTransferGbUsd && live.fastOriginTransferGbUsd > 0
        ? live.fastOriginTransferGbUsd
        : DEFAULT_ONDEMAND_UNIT_COSTS.transferGbUsd,
    perRequestCpuUsd: DEFAULT_ONDEMAND_UNIT_COSTS.perRequestCpuUsd,
  };
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function estimateProbeOnDemandUsd(input: {
  requests: number;
  bytesIn: number;
  bytesOut: number;
  units: OnDemandUnitCosts;
}): number {
  const transferGb = (input.bytesIn + input.bytesOut) / (1024 * 1024 * 1024);
  return (
    input.requests * input.units.functionInvocationUsd +
    input.requests * input.units.perRequestCpuUsd +
    transferGb * input.units.transferGbUsd
  );
}

export function buildConsumptionProbeResult(input: {
  durationMs: number;
  requests: number;
  bytesIn: number;
  bytesOut: number;
  errors: number;
  endpoints: Array<{ path: string; count: number; ok: number }>;
  units: OnDemandUnitCosts;
  method: string;
}): ConsumptionProbeResult {
  const durationMs = Math.max(1, input.durationMs);
  const durationMinutes = durationMs / 60_000;
  const estimatedOnDemandUsd = estimateProbeOnDemandUsd(input);
  const hours = durationMs / 3_600_000;
  const onDemandUsdPerActiveHour = estimatedOnDemandUsd / Math.max(hours, 1e-9);

  const monthAt = (hPerDay: number) => {
    const activeHoursMonth = hPerDay * 30;
    return {
      activeHoursMonth: round2(activeHoursMonth),
      onDemandUsdMonth: round2(onDemandUsdPerActiveHour * activeHoursMonth),
    };
  };

  return {
    durationMs,
    durationMinutes: round2(durationMinutes),
    requests: input.requests,
    bytesIn: input.bytesIn,
    bytesOut: input.bytesOut,
    errors: input.errors,
    endpoints: input.endpoints,
    estimatedOnDemandUsd: round4(estimatedOnDemandUsd),
    onDemandUsdPerActiveHour: round4(onDemandUsdPerActiveHour),
    monthlyAtHoursPerDay: {
      h2: monthAt(2),
      h2_5: monthAt(2.5),
      h3: monthAt(3),
    },
    method: input.method,
  };
}

/**
 * Calibrate $/active-hour from live Vercel on-demand + observed screen hours.
 * Falls back to probe rate, then env default.
 */
export function calibrateOnDemandPerActiveHourUsd(input: {
  vercelOnDemandUsdMonth: number | null;
  screenActiveHoursMonth: number;
  /** Share of Vercel on-demand attributed to interactive screen time (rest = bots/deploys/SEO). */
  attribution?: number;
  probeUsdPerActiveHour: number | null;
  envFallback: number;
}): { usdPerActiveHour: number; source: string } {
  const attr = input.attribution ?? 0.55;
  if (input.probeUsdPerActiveHour && input.probeUsdPerActiveHour > 0) {
    const intensity = Number(process.env.FOUNDER_CONNECTED_INTENSITY_MULTIPLIER ?? "15");
    const intensitySafe = Number.isFinite(intensity) && intensity > 0 ? intensity : 15;
    const probeRate = input.probeUsdPerActiveHour * intensitySafe;
    // Prefer probe for marginal 1-user cost; blend with live if available.
    if (
      input.vercelOnDemandUsdMonth &&
      input.vercelOnDemandUsdMonth > 0 &&
      input.screenActiveHoursMonth >= 20
    ) {
      const liveRate =
        (input.vercelOnDemandUsdMonth * attr) / input.screenActiveHoursMonth;
      // Cap liveRate so sparse early telemetry doesn't explode $/hour.
      const liveCapped = Math.min(liveRate, probeRate * 8);
      const blended = probeRate * 0.75 + liveCapped * 0.25;
      return {
        usdPerActiveHour: blended,
        source: `blend:5min_probe×${intensitySafe}+vercel_ondemand/screen_hours`,
      };
    }
    return {
      usdPerActiveHour: probeRate,
      source: `5min_probe×${intensitySafe}_telegram_intensity`,
    };
  }
  if (
    input.vercelOnDemandUsdMonth &&
    input.vercelOnDemandUsdMonth > 0 &&
    input.screenActiveHoursMonth > 0.25
  ) {
    return {
      usdPerActiveHour:
        (input.vercelOnDemandUsdMonth * attr) / input.screenActiveHoursMonth,
      source: "vercel_ondemand/screen_hours",
    };
  }
  return { usdPerActiveHour: input.envFallback, source: "env_fallback" };
}
