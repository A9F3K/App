/**
 * Unit economics + scale scenarios for Hyperlinks Space Program.
 * Separates fixed infra from on-demand (usage-scaled) Vercel/API cost.
 */
import type { FounderScreenTimeSnapshot } from "../../database/founderMetrics.js";
import type { FounderCalibrationResult } from "../../database/founderCalibration.js";
import type { VercelUsageBreakdown } from "./founder-vercel-usage.js";
import {
  buildConsumptionProbeResult,
  calibrateOnDemandPerActiveHourUsd,
  resolveOnDemandUnitCosts,
  type ConsumptionProbeResult,
} from "./founder-ondemand.js";
import {
  resolveFounderCostInputs,
  resolveFounderTariffs,
  sumRecord,
  type FounderCostInputs,
  type FounderTariffs,
} from "./founder-costs.js";

export type ScaleScenario = {
  id: string;
  label: string;
  payingUsers: number;
  avgScreenHoursPerDay: number;
  paidMixArpuMonthlyUsd: number;
  revenueMonthlyUsd: number;
  fixedInfraMonthlyUsd: number;
  onDemandMonthlyUsd: number;
  /** @deprecated alias of fixedInfra + onDemand for older UI */
  infraMonthlyUsd: number;
  variableMonthlyUsd: number;
  personalMonthlyUsd: number;
  totalCostMonthlyUsd: number;
  profitMonthlyUsd: number;
  profitAnnualUsd: number;
  runwayMonthsIfCashZero: number | null;
  notes: string;
};

export type BreakevenPoint = {
  payingUsersInfraOnly: number;
  payingUsersWithPersonalBurn: number;
  assumptions: string;
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function personalBase(inputs: FounderCostInputs): number {
  return sumRecord(inputs.personal);
}

/** Fixed monthly stack (does not scale with screen hours). */
export function fixedInfraBase(
  inputs: FounderCostInputs,
  vercelFixedUsdMonth?: number | null,
): number {
  const vercel =
    vercelFixedUsdMonth != null && vercelFixedUsdMonth > 0
      ? vercelFixedUsdMonth
      : inputs.infra.vercelUsdMonth;
  return (
    inputs.infra.railwayUsdMonth +
    vercel +
    inputs.infra.gcpUsdMonth +
    inputs.infra.neonUsdMonth +
    inputs.infra.aiUsdMonth +
    inputs.infra.otherInfraUsdMonth
  );
}

/**
 * Fixed stays flat (with TDLib step); on-demand grows with users × screen hours.
 */
function estimateInfraAtScale(
  inputs: FounderCostInputs,
  payingUsers: number,
  avgHoursPerDay: number,
  opts?: { vercelFixedUsdMonth?: number | null },
): { fixed: number; onDemand: number } {
  const base = fixedInfraBase(inputs, opts?.vercelFixedUsdMonth);
  const activeHoursMonth = payingUsers * avgHoursPerDay * 30;
  const onDemand = activeHoursMonth * inputs.variablePerActiveHourUsd;
  const over = Math.max(0, payingUsers - inputs.tdlibFixedUntilUsers);
  const tdlibStep =
    over > 0 ? (over / inputs.tdlibFixedUntilUsers) * inputs.infra.railwayUsdMonth : 0;
  return { fixed: base + tdlibStep, onDemand };
}

export function buildScaleScenarios(
  tariffs: FounderTariffs,
  inputs: FounderCostInputs,
  observedHoursPerDay: number | null,
  opts?: { vercelFixedUsdMonth?: number | null },
): ScaleScenario[] {
  const hours =
    observedHoursPerDay && observedHoursPerDay > 0.05 ? observedHoursPerDay : 2.5;
  const arpu = tariffs.blendedArpuMonthlyUsd;
  const personal = personalBase(inputs);

  const rows: Array<{ id: string; label: string; users: number; hours: number; note: string }> = [
    {
      id: "solo",
      label: "You only (today)",
      users: 1,
      hours: Math.max(hours, 2),
      note: "Fixed stack dominates; on-demand is small at 1 user.",
    },
    {
      id: "solo_2h",
      label: "1 user · 2h/day on-demand",
      users: 1,
      hours: 2,
      note: "Probe-scaled monthly on-demand at 2h/day.",
    },
    {
      id: "solo_3h",
      label: "1 user · 3h/day on-demand",
      users: 1,
      hours: 3,
      note: "Probe-scaled monthly on-demand at 3h/day.",
    },
    {
      id: "friends10",
      label: "10 paying · 2.5h/day",
      users: 10,
      hours: 2.5,
      note: "On-demand starts to matter vs fixed.",
    },
    {
      id: "be_infra",
      label: "Infra breakeven",
      users: 0,
      hours: 2.5,
      note: "Revenue covers fixed+on-demand (no personal burn).",
    },
    {
      id: "be_life",
      label: "Life breakeven",
      users: 0,
      hours: 2.5,
      note: "Revenue covers infra + rent/food/Cursor/etc.",
    },
    {
      id: "u50",
      label: "50 paying · 2.5h/day",
      users: 50,
      hours: 2.5,
      note: "On-demand grows linearly with users×hours.",
    },
    {
      id: "u100",
      label: "100 paying · 2.5h/day",
      users: 100,
      hours: 2.5,
      note: "Watch Fluid CPU + transfer line items on Vercel.",
    },
    {
      id: "u100_2h",
      label: "100 paying · 2h/day",
      users: 100,
      hours: 2,
      note: "Lower engagement → lower on-demand.",
    },
    {
      id: "u100_3h",
      label: "100 paying · 3h/day",
      users: 100,
      hours: 3,
      note: "Higher engagement → higher on-demand.",
    },
    {
      id: "u250",
      label: "250 paying · 2.5h/day",
      users: 250,
      hours: 2.5,
      note: "TDLib fixed step may kick in above FOUNDER_TDLIB_FIXED_UNTIL_USERS.",
    },
    {
      id: "u1000",
      label: "1,000 paying · 2h/day",
      users: 1000,
      hours: 2,
      note: "On-demand is a first-class COGS line, not a rounding error.",
    },
  ];

  const be = computeBreakeven(tariffs, inputs, 2.5, opts);
  rows[4]!.users = Math.max(1, be.payingUsersInfraOnly);
  rows[5]!.users = Math.max(1, be.payingUsersWithPersonalBurn);

  return rows.map((row) => {
    const { fixed, onDemand } = estimateInfraAtScale(inputs, row.users, row.hours, opts);
    const revenue = row.users * arpu;
    const life = row.id === "be_infra" ? 0 : personal;
    const totalCost = fixed + onDemand + life;
    const profit = revenue - totalCost;
    return {
      id: row.id,
      label: row.label,
      payingUsers: row.users,
      avgScreenHoursPerDay: round2(row.hours),
      paidMixArpuMonthlyUsd: round2(arpu),
      revenueMonthlyUsd: round2(revenue),
      fixedInfraMonthlyUsd: round2(fixed),
      onDemandMonthlyUsd: round2(onDemand),
      infraMonthlyUsd: round2(fixed + onDemand),
      variableMonthlyUsd: round2(onDemand),
      personalMonthlyUsd: round2(life),
      totalCostMonthlyUsd: round2(totalCost),
      profitMonthlyUsd: round2(profit),
      profitAnnualUsd: round2(profit * 12),
      runwayMonthsIfCashZero: profit >= 0 ? null : round2(0),
      notes: row.note,
    };
  });
}

export function computeBreakeven(
  tariffs: FounderTariffs,
  inputs: FounderCostInputs,
  avgHoursPerDay: number,
  opts?: { vercelFixedUsdMonth?: number | null },
): BreakevenPoint {
  const arpu = Math.max(0.01, tariffs.blendedArpuMonthlyUsd);
  const solve = (includePersonal: boolean): number => {
    let n = 1;
    for (let i = 0; i < 40; i++) {
      const { fixed, onDemand } = estimateInfraAtScale(inputs, n, avgHoursPerDay, opts);
      const need = fixed + onDemand + (includePersonal ? personalBase(inputs) : 0);
      const next = Math.ceil(need / arpu);
      if (next === n) return n;
      n = Math.max(1, next);
    }
    return n;
  };
  return {
    payingUsersInfraOnly: solve(false),
    payingUsersWithPersonalBurn: solve(true),
    assumptions: `Blended ARPU $${arpu.toFixed(2)}/mo; ~${avgHoursPerDay.toFixed(2)} active h/user/day; on-demand $${inputs.variablePerActiveHourUsd.toFixed(4)}/active-hour; fixed stack separate from usage.`,
  };
}

export type LaunchExperiment = {
  windowNote: string;
  estimatedFixedInfraUsdMonth: number;
  estimatedVariablePerActiveHourUsd: number;
  costIfOneUserOneHourUsd: number;
  costIfOneUserObservedDayUsd: number;
  costIfOneUserMonthAtObservedHoursUsd: number;
  onDemandMonthAt2hUsd: number;
  onDemandMonthAt3hUsd: number;
  explanation: string;
};

export function buildLaunchExperiment(
  inputs: FounderCostInputs,
  screen: FounderScreenTimeSnapshot,
  opts?: {
    vercelFixedUsdMonth?: number | null;
    /** Override hours/day when calibration has a better 7d average. */
    hoursPerDayOverride?: number | null;
  },
): LaunchExperiment {
  const fixed = fixedInfraBase(inputs, opts?.vercelFixedUsdMonth);
  const override = opts?.hoursPerDayOverride;
  const hoursPerDay =
    override != null && override > 0.05
      ? override
      : screen.avgHoursPerActiveUserPerDay7d > 0.05
        ? screen.avgHoursPerActiveUserPerDay7d
        : 2.5;
  const oneHourOnDemand = inputs.variablePerActiveHourUsd;
  const oneHour = fixed / (30 * 24) + oneHourOnDemand;
  const oneDay = fixed / 30 + hoursPerDay * oneHourOnDemand;
  const oneMonth = fixed + hoursPerDay * 30 * oneHourOnDemand;
  return {
    windowNote:
      screen.tablesExist && screen.last7d.sessions > 0
        ? `Live rates · ~${hoursPerDay.toFixed(2)}h/user/day (7d) · on-demand $${oneHourOnDemand.toFixed(4)}/active-hour from calibration + provider pulls.`
        : "On-demand from probe/list prices until screen-time fills in.",
    estimatedFixedInfraUsdMonth: round2(fixed),
    estimatedVariablePerActiveHourUsd: round2(inputs.variablePerActiveHourUsd * 10000) / 10000,
    costIfOneUserOneHourUsd: round2(oneHour),
    costIfOneUserObservedDayUsd: round2(oneDay),
    costIfOneUserMonthAtObservedHoursUsd: round2(oneMonth),
    onDemandMonthAt2hUsd: round2(2 * 30 * oneHourOnDemand),
    onDemandMonthAt3hUsd: round2(3 * 30 * oneHourOnDemand),
    explanation:
      "Fixed (Railway/TDLib, Vercel Pro, AI floor) does not shrink with one idle user. On-demand (Fluid CPU, transfers, invocations) grows with users × screen hours — use the 2h/3h rows for marginal usage cost.",
  };
}

export type FounderStrategy = {
  sales: string[];
  hiring: string[];
  milestones: Array<{ when: string; what: string }>;
};

export function buildFounderStrategy(breakeven: BreakevenPoint): FounderStrategy {
  return {
    sales: [
      "Sell Pro to people already living in Telegram + TON (traders, builders, power DMs) — lead with unlimited accounts + AI + cashback, not generic ‘wallet’.",
      "Ship payment rails (DLLR / TON Connect / direct transfer) so the tariff dialog converts; until then every demo is a leak.",
      "Weekly founder-led demos (TG voice / screen share) → private invite codes; track invite → paid in the founder dashboard later.",
      "Content: short clips of chat+swap+Pro in one surface; post in TON/Telegram communities; avoid broad paid ads until payback < 30 days.",
      "Partner: 2–3 mini-app / toolkit accounts for distribution; revenue share only after infra breakeven.",
    ],
    hiring: [
      `Stay solo until ~${breakeven.payingUsersWithPersonalBurn} paying users cover life burn — hiring earlier burns runway.`,
      "First hire: part-time support / community (Telegram) OR contractor for payment+billing — not a second full-time eng.",
      "Second: growth (content + partnerships) once 100+ paying and churn < 8%/mo.",
      "Third: backend/TDLib reliability when concurrent connected accounts exceed FOUNDER_TDLIB_FIXED_UNTIL_USERS.",
      "Comp: equity-heavy early; cash salaries only after life breakeven + 3 months buffer.",
    ],
    milestones: [
      {
        when: "Now → infra BE",
        what: "Close payment, instrument COGS weekly, convert your own usage into case study metrics.",
      },
      {
        when: `~${breakeven.payingUsersInfraOnly} paying`,
        what: "Servers+AI paid by customers; keep personal burn lean; freeze non-essential Cursor/cloud spend spikes.",
      },
      {
        when: `~${breakeven.payingUsersWithPersonalBurn} paying`,
        what: "Rent/food/Cursor covered; start a small paid acquisition or partner test with capped budget.",
      },
      {
        when: "50–100 paying",
        what: "Hire light support; productize onboarding; raise prices only if capacity is the bottleneck.",
      },
      {
        when: "250+ paying",
        what: "Full-time #2; separate growth vs reliability; consider entity/accounting hygiene.",
      },
    ],
  };
}

export function buildFounderModelBundle(
  screen: FounderScreenTimeSnapshot,
  opts?: {
    vercel?: VercelUsageBreakdown | null;
    probe?: ConsumptionProbeResult | null;
    calibration?: FounderCalibrationResult | null;
    railwayTotalUsdMonth?: number | null;
    gcpUsdMonth?: number | null;
    tariffsOverride?: {
      monthUsd: number;
      quarterTotalUsd: number;
      yearTotalUsd: number;
    } | null;
  },
) {
  const tariffs = opts?.tariffsOverride
    ? resolveFounderTariffs(opts.tariffsOverride)
    : resolveFounderTariffs();
  const costs = resolveFounderCostInputs();
  const vercel = opts?.vercel ?? null;
  const probe = opts?.probe ?? null;
  const calibrationResult = opts?.calibration ?? null;

  if (calibrationResult) {
    costs.variablePerActiveHourUsd = calibrationResult.onDemandUsdPerActiveHour;
  } else {
    const screenHoursMonth = Math.max(
      screen.last30d.activeHours,
      screen.totalActiveHours,
    );
    const calibrated = calibrateOnDemandPerActiveHourUsd({
      vercelOnDemandUsdMonth: vercel?.source === "live" ? vercel.onDemandUsdMonth : null,
      screenActiveHoursMonth: screenHoursMonth,
      probeUsdPerActiveHour: probe?.onDemandUsdPerActiveHour ?? null,
      envFallback: costs.variablePerActiveHourUsd,
    });
    costs.variablePerActiveHourUsd = calibrated.usdPerActiveHour;
  }

  const vercelFixed =
    vercel?.source === "live" ? vercel.fixedUsdMonth : null;
  if (vercel?.source === "live" && vercel.fixedUsdMonth > 0) {
    costs.infra.vercelUsdMonth = vercel.fixedUsdMonth;
  }
  if (opts?.railwayTotalUsdMonth != null && opts.railwayTotalUsdMonth > 0) {
    costs.infra.railwayUsdMonth = opts.railwayTotalUsdMonth;
  }
  if (opts?.gcpUsdMonth != null && opts.gcpUsdMonth >= 0) {
    costs.infra.gcpUsdMonth = opts.gcpUsdMonth;
  }

  const observedHours = screen.avgHoursPerActiveUserPerDay7d;
  const scaleHours =
    observedHours > 0.05
      ? observedHours
      : calibrationResult && calibrationResult.avgUser.hoursPerDay7d > 0.05
        ? calibrationResult.avgUser.hoursPerDay7d
        : 2.5;
  const breakeven = computeBreakeven(tariffs, costs, scaleHours, {
    vercelFixedUsdMonth: vercelFixed,
  });

  const screenHoursMonth = Math.max(
    screen.last30d.activeHours,
    screen.totalActiveHours,
  );
  const observedOnDemandUsdMonth = round2(
    costs.variablePerActiveHourUsd * screenHoursMonth,
  );
  const fixedInfra = round2(fixedInfraBase(costs, vercelFixed));
  const personal = round2(personalBase(costs));

  return {
    tariffs,
    costs,
    calibration: calibrationResult
      ? {
          onDemandUsdPerActiveHour: calibrationResult.onDemandUsdPerActiveHour,
          source: calibrationResult.source,
          confidence: calibrationResult.confidence,
          priorUsdPerActiveHour: calibrationResult.priorUsdPerActiveHour,
          liveUsdPerActiveHour: calibrationResult.liveUsdPerActiveHour,
          regressionUsdPerActiveHour: calibrationResult.regressionUsdPerActiveHour,
          vercelOnDemandUsdMonth: vercel?.onDemandUsdMonth ?? null,
          vercelFixedUsdMonth: vercel?.fixedUsdMonth ?? null,
          screenActiveHoursMonth: round2(screenHoursMonth),
          evidence: calibrationResult.evidence,
          avgUser: calibrationResult.avgUser,
          notes: calibrationResult.notes,
        }
      : {
          onDemandUsdPerActiveHour: costs.variablePerActiveHourUsd,
          source: "legacy",
          confidence: 0,
          priorUsdPerActiveHour: costs.variablePerActiveHourUsd,
          liveUsdPerActiveHour: null,
          regressionUsdPerActiveHour: null,
          vercelOnDemandUsdMonth: vercel?.onDemandUsdMonth ?? null,
          vercelFixedUsdMonth: vercel?.fixedUsdMonth ?? null,
          screenActiveHoursMonth: round2(screenHoursMonth),
          evidence: null,
          avgUser: {
            hoursPerDay7d: scaleHours,
            onDemandUsdMonthAtObserved: round2(
              costs.variablePerActiveHourUsd * scaleHours * 30,
            ),
            onDemandUsdMonthAt2h: round2(costs.variablePerActiveHourUsd * 2 * 30),
            onDemandUsdMonthAt3h: round2(costs.variablePerActiveHourUsd * 3 * 30),
          },
          notes: [] as string[],
        },
    infraTotalUsdMonth: fixedInfra,
    personalTotalUsdMonth: personal,
    /** Fixed + personal + on-demand attributed to observed screen hours (30d). */
    observedOnDemandUsdMonth,
    burnTotalUsdMonth: round2(fixedInfra + personal + observedOnDemandUsdMonth),
    breakeven,
    launchExperiment: buildLaunchExperiment(costs, screen, {
      vercelFixedUsdMonth: vercelFixed,
      hoursPerDayOverride: scaleHours,
    }),
    consumptionProbe: probe,
    scenarios: buildScaleScenarios(tariffs, costs, scaleHours, {
      vercelFixedUsdMonth: vercelFixed,
    }),
    strategy: buildFounderStrategy(breakeven),
  };
}

export function buildProbeFromStoredJson(
  raw: unknown,
  vercel?: VercelUsageBreakdown | null,
): ConsumptionProbeResult | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const units = resolveOnDemandUnitCosts(vercel?.unitCosts);
  const endpoints = Array.isArray(o.endpoints)
    ? (o.endpoints as Array<{ path?: string; count?: number; ok?: number }>).map((e) => ({
        path: String(e.path ?? ""),
        count: Number(e.count) || 0,
        ok: Number(e.ok) || 0,
      }))
    : [];
  return buildConsumptionProbeResult({
    durationMs: Number(o.durationMs) || 0,
    requests: Number(o.requests) || 0,
    bytesIn: Number(o.bytesIn) || 0,
    bytesOut: Number(o.bytesOut) || 0,
    errors: Number(o.errors) || 0,
    endpoints,
    units,
    method: String(o.method ?? "stored_probe"),
  });
}
