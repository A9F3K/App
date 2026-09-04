import { Platform } from "react-native";

import { WEB_AEROPORT_STACK, WEB_UI_SANS_STACK } from "../../fonts";
import {
  CHOOSE_CURRENCY_TABLE_BALANCE_COLUMN_FLOOR_PX,
  CHOOSE_CURRENCY_TABLE_CELL_PADDING_HORIZONTAL_PX,
  CHOOSE_CURRENCY_TABLE_CURRENCY_COLUMN_FLOOR_PX,
  CHOOSE_CURRENCY_TABLE_CURRENCY_ICON_SIZE_PX,
  CHOOSE_CURRENCY_TABLE_CURRENCY_ICON_TEXT_GAP_PX,
  CHOOSE_CURRENCY_TABLE_LAST_YEAR_COLUMN_FLOOR_PX,
  CHOOSE_CURRENCY_TABLE_MARKET_CAP_COLUMN_FLOOR_PX,
  CHOOSE_CURRENCY_TABLE_MARKET_CAP_LAYOUT_SAMPLES,
  CHOOSE_CURRENCY_TABLE_MINI_CHART_MIN_WIDTH_PX,
  CHOOSE_CURRENCY_TABLE_NETWORKS_COLUMN_FLOOR_PX,
  CHOOSE_CURRENCY_TABLE_RANK_CELL_PADDING_RIGHT_PX,
  CHOOSE_CURRENCY_TABLE_RANK_COLUMN_FLOOR_PX,
  CHOOSE_CURRENCY_TABLE_RANK_LAYOUT_SAMPLE,
  CHOOSE_CURRENCY_TABLE_RATE_COLUMN_FLOOR_PX,
  CHOOSE_CURRENCY_TABLE_RATE_LAYOUT_SAMPLES,
  CHOOSE_CURRENCY_TABLE_VOLUME_COLUMN_FLOOR_PX,
  CHOOSE_CURRENCY_TABLE_VOLUME_LAYOUT_SAMPLES,
} from "./chooseCurrencyTableConstants";
import type { ChooseCurrencyColumnKey, ChooseCurrencyRow } from "./chooseCurrencyTableTypes";
import {
  CROSS_NAMEPLATE_GAP_PX,
  CROSS_NAMEPLATE_WIDTH_PX,
  isDllrCurrencyRow,
} from "./CrossTokenNameplate";

const HEADER_FONT_SIZE_PX = 15;
const HEADER_LINE_HEIGHT_PX = 20;
const CELL_FONT_SIZE_PX = 15;
const CELL_LINE_HEIGHT_PX = 20;
const CURRENCY_NAME_FONT_SIZE_PX = 15;
const CURRENCY_NAME_LINE_HEIGHT_PX = 20;

/** Rows sampled for ideal-width measurement (spread across the loaded catalog). */
const IDEAL_WIDTH_SAMPLE_SIZE = 12;

export type ChooseCurrencyColumnMetrics = {
  key: ChooseCurrencyColumnKey;
  /** Content-driven minimum (header + stable sample). */
  minWidthPx: number;
  /** Preferred width before shell capping. */
  idealWidthPx: number;
  /** Relative share of spare shell width after mins are assigned. */
  flexWeight: number;
  /** Hard ceiling as a fraction of shell width (0–1). */
  maxShellFraction: number;
  /** Absolute floor when column is visible. */
  floorWidthPx: number;
};

type TextMeasureStyle = {
  fontFamily: string;
  fontSizePx: number;
  lineHeightPx: number;
  fontWeight?: string;
};

function estimateTextWidthPx(text: string, style: TextMeasureStyle): number {
  if (!text) return 0;
  const weightFactor = style.fontFamily.includes("SemiBold") || style.fontWeight === "600" ? 1.06 : 1;
  return Math.ceil(text.length * style.fontSizePx * 0.56 * weightFactor);
}

function measureTextWidthPxWeb(text: string, style: TextMeasureStyle): number {
  if (!text || Platform.OS !== "web" || typeof document === "undefined") {
    return estimateTextWidthPx(text, style);
  }

  const probe = document.createElement("span");
  probe.style.position = "fixed";
  probe.style.left = "-9999px";
  probe.style.top = "0";
  probe.style.visibility = "hidden";
  probe.style.pointerEvents = "none";
  probe.style.whiteSpace = "nowrap";
  probe.style.fontFamily = style.fontFamily;
  probe.style.fontSize = `${style.fontSizePx}px`;
  probe.style.fontWeight = style.fontWeight ?? "400";
  probe.style.lineHeight = `${style.lineHeightPx}px`;
  probe.textContent = text;
  document.body.appendChild(probe);
  const width = Math.ceil(probe.getBoundingClientRect().width);
  document.body.removeChild(probe);
  return width;
}

function measureTextWidthPx(text: string, style: TextMeasureStyle): number {
  if (Platform.OS === "web") {
    return measureTextWidthPxWeb(text, style);
  }
  return estimateTextWidthPx(text, style);
}

const headerTextStyle: TextMeasureStyle = {
  fontFamily: WEB_AEROPORT_STACK,
  fontSizePx: HEADER_FONT_SIZE_PX,
  lineHeightPx: HEADER_LINE_HEIGHT_PX,
};

const cellTextStyle: TextMeasureStyle = {
  fontFamily: WEB_AEROPORT_STACK,
  fontSizePx: CELL_FONT_SIZE_PX,
  lineHeightPx: CELL_LINE_HEIGHT_PX,
};

const currencyNameTextStyle: TextMeasureStyle = {
  fontFamily: WEB_UI_SANS_STACK,
  fontSizePx: CURRENCY_NAME_FONT_SIZE_PX,
  lineHeightPx: CURRENCY_NAME_LINE_HEIGHT_PX,
  fontWeight: "600",
};

const currencyTickerTextStyle: TextMeasureStyle = {
  fontFamily: WEB_AEROPORT_STACK,
  fontSizePx: CURRENCY_NAME_FONT_SIZE_PX,
  lineHeightPx: CURRENCY_NAME_LINE_HEIGHT_PX,
};

const COLUMN_FLOOR_PX: Record<ChooseCurrencyColumnKey, number> = {
  rank: CHOOSE_CURRENCY_TABLE_RANK_COLUMN_FLOOR_PX,
  currency: CHOOSE_CURRENCY_TABLE_CURRENCY_COLUMN_FLOOR_PX,
  balance: CHOOSE_CURRENCY_TABLE_BALANCE_COLUMN_FLOOR_PX,
  rate: CHOOSE_CURRENCY_TABLE_RATE_COLUMN_FLOOR_PX,
  networks: CHOOSE_CURRENCY_TABLE_NETWORKS_COLUMN_FLOOR_PX,
  marketCap: CHOOSE_CURRENCY_TABLE_MARKET_CAP_COLUMN_FLOOR_PX,
  volume: CHOOSE_CURRENCY_TABLE_VOLUME_COLUMN_FLOOR_PX,
  lastYear: CHOOSE_CURRENCY_TABLE_LAST_YEAR_COLUMN_FLOOR_PX,
};

const COLUMN_FLEX_WEIGHT: Record<ChooseCurrencyColumnKey, number> = {
  rank: 0,
  currency: 5,
  balance: 1.2,
  rate: 1.2,
  marketCap: 1,
  networks: 0.85,
  volume: 0.85,
  lastYear: 0.55,
};

const COLUMN_MAX_SHELL_FRACTION: Record<ChooseCurrencyColumnKey, number> = {
  rank: 0.1,
  currency: 0.5,
  balance: 0.2,
  rate: 0.2,
  marketCap: 0.18,
  networks: 0.16,
  volume: 0.16,
  lastYear: 0.14,
};

function sampleLayoutRows(rows: readonly ChooseCurrencyRow[]): readonly ChooseCurrencyRow[] {
  if (rows.length <= IDEAL_WIDTH_SAMPLE_SIZE) return rows;
  const sampled: ChooseCurrencyRow[] = [];
  for (let i = 0; i < IDEAL_WIDTH_SAMPLE_SIZE; i++) {
    const index = Math.floor((i * (rows.length - 1)) / (IDEAL_WIDTH_SAMPLE_SIZE - 1));
    sampled.push(rows[index]!);
  }
  return sampled;
}

function stableLayoutRows(rows: readonly ChooseCurrencyRow[]): readonly ChooseCurrencyRow[] {
  return rows.length > 0 ? rows.slice(0, 1) : rows;
}

function rankContentWidthPx(header: string): number {
  return Math.max(
    measureTextWidthPx(header, headerTextStyle),
    measureTextWidthPx(CHOOSE_CURRENCY_TABLE_RANK_LAYOUT_SAMPLE, cellTextStyle),
  );
}

function rateContentWidthPx(header: string, rowRates: readonly string[]): number {
  return Math.max(
    measureTextWidthPx(header, headerTextStyle),
    ...rowRates.map((value) => measureTextWidthPx(value, cellTextStyle)),
    ...CHOOSE_CURRENCY_TABLE_RATE_LAYOUT_SAMPLES.map((value) =>
      measureTextWidthPx(value, cellTextStyle),
    ),
  );
}

function compactUsdContentWidthPx(header: string, rowValues: readonly string[], layoutSamples: readonly string[]): number {
  return Math.max(
    measureTextWidthPx(header, headerTextStyle),
    ...rowValues.map((value) => measureTextWidthPx(value, cellTextStyle)),
    ...layoutSamples.map((value) => measureTextWidthPx(value, cellTextStyle)),
  );
}

function currencyContentWidthPx(header: string, rows: readonly ChooseCurrencyRow[]): number {
  const headerWidth = measureTextWidthPx(header, headerTextStyle);
  const rowWidths = rows.map((row) => {
    const nameWidth = measureTextWidthPx(row.currency.name, currencyNameTextStyle);
    const tickerWidth = measureTextWidthPx(row.currency.ticker, currencyTickerTextStyle);
    const nameLineWidth = isDllrCurrencyRow(row)
      ? nameWidth + CROSS_NAMEPLATE_GAP_PX + CROSS_NAMEPLATE_WIDTH_PX
      : nameWidth;
    const textWidth = Math.max(nameLineWidth, tickerWidth);
    return (
      CHOOSE_CURRENCY_TABLE_CURRENCY_ICON_SIZE_PX +
      CHOOSE_CURRENCY_TABLE_CURRENCY_ICON_TEXT_GAP_PX +
      textWidth
    );
  });
  return Math.max(headerWidth, ...rowWidths);
}

function textContentWidthPx(header: string, values: readonly string[]): number {
  return Math.max(
    measureTextWidthPx(header, headerTextStyle),
    ...values.map((value) => measureTextWidthPx(value, cellTextStyle)),
  );
}

function paddedWidth(contentWidthPx: number, columnKey: ChooseCurrencyColumnKey): number {
  if (columnKey === "rank") {
    return contentWidthPx + CHOOSE_CURRENCY_TABLE_RANK_CELL_PADDING_RIGHT_PX;
  }
  return contentWidthPx + CHOOSE_CURRENCY_TABLE_CELL_PADDING_HORIZONTAL_PX * 2;
}

function clampFloor(key: ChooseCurrencyColumnKey, widthPx: number): number {
  return Math.max(COLUMN_FLOOR_PX[key], Math.ceil(widthPx));
}

function buildColumnMetrics(
  key: ChooseCurrencyColumnKey,
  minContentPx: number,
  idealContentPx: number,
): ChooseCurrencyColumnMetrics {
  const minWidthPx = clampFloor(key, paddedWidth(minContentPx, key));
  const idealWidthPx = Math.max(minWidthPx, clampFloor(key, paddedWidth(idealContentPx, key)));

  return {
    key,
    minWidthPx,
    idealWidthPx,
    flexWeight: COLUMN_FLEX_WEIGHT[key],
    maxShellFraction: COLUMN_MAX_SHELL_FRACTION[key],
    floorWidthPx: COLUMN_FLOOR_PX[key],
  };
}

export function buildChooseCurrencyColumnMetrics(
  headers: Record<ChooseCurrencyColumnKey, string>,
  rows: readonly ChooseCurrencyRow[],
): readonly ChooseCurrencyColumnMetrics[] {
  const stableRows = stableLayoutRows(rows);
  const idealRows = rows.length > 0 ? sampleLayoutRows(rows) : rows;

  return [
    buildColumnMetrics(
      "rank",
      rankContentWidthPx(headers.rank),
      rankContentWidthPx(headers.rank),
    ),
    buildColumnMetrics(
      "currency",
      currencyContentWidthPx(headers.currency, stableRows),
      currencyContentWidthPx(headers.currency, idealRows),
    ),
    buildColumnMetrics(
      "balance",
      textContentWidthPx(headers.balance, stableRows.map((row) => row.balance)),
      textContentWidthPx(headers.balance, idealRows.map((row) => row.balance)),
    ),
    buildColumnMetrics(
      "rate",
      rateContentWidthPx(headers.rate, stableRows.map((row) => row.rate)),
      rateContentWidthPx(headers.rate, idealRows.map((row) => row.rate)),
    ),
    buildColumnMetrics(
      "marketCap",
      compactUsdContentWidthPx(
        headers.marketCap,
        stableRows.map((row) => row.marketCap),
        CHOOSE_CURRENCY_TABLE_MARKET_CAP_LAYOUT_SAMPLES,
      ),
      compactUsdContentWidthPx(
        headers.marketCap,
        idealRows.map((row) => row.marketCap),
        CHOOSE_CURRENCY_TABLE_MARKET_CAP_LAYOUT_SAMPLES,
      ),
    ),
    buildColumnMetrics(
      "networks",
      textContentWidthPx(headers.networks, stableRows.map((row) => row.networks)),
      textContentWidthPx(headers.networks, idealRows.map((row) => row.networks)),
    ),
    buildColumnMetrics(
      "volume",
      compactUsdContentWidthPx(
        headers.volume,
        stableRows.map((row) => row.volume),
        CHOOSE_CURRENCY_TABLE_VOLUME_LAYOUT_SAMPLES,
      ),
      compactUsdContentWidthPx(
        headers.volume,
        idealRows.map((row) => row.volume),
        CHOOSE_CURRENCY_TABLE_VOLUME_LAYOUT_SAMPLES,
      ),
    ),
    buildColumnMetrics(
      "lastYear",
      Math.max(measureTextWidthPx(headers.lastYear, headerTextStyle), CHOOSE_CURRENCY_TABLE_MINI_CHART_MIN_WIDTH_PX),
      Math.max(measureTextWidthPx(headers.lastYear, headerTextStyle), CHOOSE_CURRENCY_TABLE_MINI_CHART_MIN_WIDTH_PX),
    ),
  ];
}

/** @deprecated Use buildChooseCurrencyColumnMetrics + resolveChooseCurrencyColumnLayout. */
export function buildChooseCurrencyColumnMinWidthsPx(
  headers: Record<ChooseCurrencyColumnKey, string>,
  rows: readonly ChooseCurrencyRow[],
): Record<ChooseCurrencyColumnKey, number> {
  const metrics = buildChooseCurrencyColumnMetrics(headers, rows);
  return Object.fromEntries(metrics.map((m) => [m.key, m.minWidthPx])) as Record<
    ChooseCurrencyColumnKey,
    number
  >;
}
