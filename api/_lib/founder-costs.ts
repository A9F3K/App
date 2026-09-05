/**
 * Tariff + cost inputs for the founder model (env-overridable).
 */

function envNum(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export type FounderTariffs = {
  monthUsd: number;
  quarterTotalUsd: number;
  quarterMonthlyUsd: number;
  yearTotalUsd: number;
  yearMonthlyUsd: number;
  /** Blended ARPU used in scenarios (weighted mix). */
  blendedArpuMonthlyUsd: number;
  mix: { month: number; quarter: number; year: number };
};

export type FounderCostInputs = {
  infra: {
    railwayUsdMonth: number;
    vercelUsdMonth: number;
    gcpUsdMonth: number;
    neonUsdMonth: number;
    aiUsdMonth: number;
    otherInfraUsdMonth: number;
  };
  personal: {
    cursorUsdMonth: number;
    rentUsdMonth: number;
    foodUsdMonth: number;
    electricityUsdMonth: number;
    simUsdMonth: number;
    electronicsUsdMonth: number;
    otherPersonalUsdMonth: number;
  };
  /** Assumed variable COGS per active user-hour (Telegram+API) when live hours exist. */
  variablePerActiveHourUsd: number;
  /** Fixed gateway share that does not scale linearly until N concurrent TDLib users. */
  tdlibFixedUntilUsers: number;
};

export function resolveFounderTariffs(): FounderTariffs {
  const monthUsd = envNum("PRO_TARIFF_MONTH_USD", 20);
  const quarterTotalUsd = envNum("PRO_TARIFF_QUARTER_TOTAL_USD", 55.5);
  const yearTotalUsd = envNum("PRO_TARIFF_YEAR_TOTAL_USD", 204);
  const mixMonth = envNum("FOUNDER_MIX_MONTH", 0.55);
  const mixQuarter = envNum("FOUNDER_MIX_QUARTER", 0.25);
  const mixYear = envNum("FOUNDER_MIX_YEAR", 0.2);
  const mixSum = Math.max(1e-9, mixMonth + mixQuarter + mixYear);
  const month = mixMonth / mixSum;
  const quarter = mixQuarter / mixSum;
  const year = mixYear / mixSum;
  const quarterMonthlyUsd = quarterTotalUsd / 3;
  const yearMonthlyUsd = yearTotalUsd / 12;
  const blendedArpuMonthlyUsd =
    month * monthUsd + quarter * quarterMonthlyUsd + year * yearMonthlyUsd;
  return {
    monthUsd,
    quarterTotalUsd,
    quarterMonthlyUsd,
    yearTotalUsd,
    yearMonthlyUsd,
    blendedArpuMonthlyUsd,
    mix: { month, quarter, year },
  };
}

export function resolveFounderCostInputs(): FounderCostInputs {
  return {
    infra: {
      railwayUsdMonth: envNum("FOUNDER_COST_RAILWAY_USD_MONTH", 15),
      vercelUsdMonth: envNum("FOUNDER_COST_VERCEL_USD_MONTH", 20),
      gcpUsdMonth: envNum("FOUNDER_COST_GCP_USD_MONTH", 0),
      neonUsdMonth: envNum("FOUNDER_COST_NEON_USD_MONTH", 0),
      aiUsdMonth: envNum("FOUNDER_COST_AI_USD_MONTH", 20),
      otherInfraUsdMonth: envNum("FOUNDER_COST_OTHER_INFRA_USD_MONTH", 5),
    },
    personal: {
      cursorUsdMonth: envNum("FOUNDER_COST_CURSOR_USD_MONTH", 50),
      rentUsdMonth: envNum("FOUNDER_COST_RENT_USD_MONTH", 250),
      foodUsdMonth: envNum("FOUNDER_COST_FOOD_USD_MONTH", 150),
      electricityUsdMonth: envNum("FOUNDER_COST_ELECTRICITY_USD_MONTH", 40),
      simUsdMonth: envNum("FOUNDER_COST_SIM_USD_MONTH", 15),
      electronicsUsdMonth: envNum("FOUNDER_COST_ELECTRONICS_USD_MONTH", 50),
      otherPersonalUsdMonth: envNum("FOUNDER_COST_OTHER_PERSONAL_USD_MONTH", 30),
    },
    variablePerActiveHourUsd: envNum("FOUNDER_VARIABLE_PER_ACTIVE_HOUR_USD", 0.08),
    tdlibFixedUntilUsers: envNum("FOUNDER_TDLIB_FIXED_UNTIL_USERS", 25),
  };
}

export function sumRecord(values: Record<string, number>): number {
  return Object.values(values).reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
}
