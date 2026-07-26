/** Header and body row content box (px). */
export const CHOOSE_CURRENCY_TABLE_ROW_HEIGHT_PX = 40;

/** Vertical padding above and below each body row block (px). */
export const CHOOSE_CURRENCY_TABLE_ROW_PADDING_VERTICAL_PX = 10;

/** Horizontal padding inside centered columns (px). */
export const CHOOSE_CURRENCY_TABLE_CELL_PADDING_HORIZONTAL_PX = 10;

/** `#` column keeps page inset on the left; only right inner padding (px). */
export const CHOOSE_CURRENCY_TABLE_RANK_CELL_PADDING_RIGHT_PX = 10;

export const CHOOSE_CURRENCY_TABLE_CURRENCY_ICON_SIZE_PX = 20;

export const CHOOSE_CURRENCY_TABLE_CURRENCY_ICON_TEXT_GAP_PX = 8;

/** Mini chart slot in Last Year column (px tall; width tracks column width). */
export const CHOOSE_CURRENCY_TABLE_MINI_CHART_HEIGHT_PX = 40;

export const CHOOSE_CURRENCY_TABLE_MINI_CHART_MIN_WIDTH_PX = 40;

/**
 * Absolute floor widths (px) — columns never shrink below these when visible.
 * Dynamic max widths are derived from shell width in the layout resolver.
 */
export const CHOOSE_CURRENCY_TABLE_RANK_COLUMN_FLOOR_PX = 22;
export const CHOOSE_CURRENCY_TABLE_CURRENCY_COLUMN_FLOOR_PX = 88;
export const CHOOSE_CURRENCY_TABLE_BALANCE_COLUMN_FLOOR_PX = 52;
export const CHOOSE_CURRENCY_TABLE_RATE_COLUMN_FLOOR_PX = 76;
export const CHOOSE_CURRENCY_TABLE_NETWORKS_COLUMN_FLOOR_PX = 56;
export const CHOOSE_CURRENCY_TABLE_MARKET_CAP_COLUMN_FLOOR_PX = 88;
export const CHOOSE_CURRENCY_TABLE_VOLUME_COLUMN_FLOOR_PX = 80;

/** Representative market-cap strings for column width measurement. */
export const CHOOSE_CURRENCY_TABLE_MARKET_CAP_LAYOUT_SAMPLES = [
  "2.1T$+",
  "3T$+",
  "16b$+",
  "999b$+",
  "2.1 трлн. $ +",
  "3 трлн. $ +",
  "16 млрд. $ +",
  "999 млрд. $ +",
] as const;

/** Representative volume strings for column width measurement. */
export const CHOOSE_CURRENCY_TABLE_VOLUME_LAYOUT_SAMPLES = [
  "123m$",
  "999m$",
  "123 млн. $ +",
  "999 млн. $ +",
] as const;
export const CHOOSE_CURRENCY_TABLE_LAST_YEAR_COLUMN_FLOOR_PX = 44;

/** Representative rate strings for column width measurement (micro-cap tokens). */
export const CHOOSE_CURRENCY_TABLE_RATE_LAYOUT_SAMPLES = [
  "$1",
  "$1.72",
  "$0.5781",
  "$0.00000012",
  "$1.2e-8",
] as const;

/** Rank column sizing — list can exceed 999 rows. */
export const CHOOSE_CURRENCY_TABLE_RANK_LAYOUT_SAMPLE = "9999";

/** Minimum shell width to keep rank + currency visible. */
export const CHOOSE_CURRENCY_TABLE_MIN_SHELL_WIDTH_PX = 120;

/** Minimum vertical scroll-thumb height (px) in the choose-currency list. */
export const CHOOSE_CURRENCY_TABLE_SCROLL_INDICATOR_THUMB_MIN_PX = 30;
