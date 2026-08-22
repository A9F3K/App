import { layout } from "../theme";

export const BOTTOM_BAR_ROW_FIT_EPSILON_PX = 1;

/**
 * Width available for a leading summary label once trailing fixed chrome and
 * explicit inter-element gaps are subtracted from the row.
 */
export function bottomBarSummarySlotWidthPx(input: {
  rowWidthPx: number;
  buttonWidthPx: number;
  /** Width of a middle label (e.g. swap notice) between summary and button. */
  middleWidthPx?: number;
  /** Gap between middle label and button (swap notice uses marginRight). */
  middleTrailingGapPx?: number;
  /** Gap between summary and button when there is no middle label. */
  summaryTrailingGapPx?: number;
}): number {
  const rowWidth = Math.max(0, Math.trunc(input.rowWidthPx));
  const buttonWidth = Math.max(0, Math.trunc(input.buttonWidthPx));
  const middleWidth = Math.max(0, Math.trunc(input.middleWidthPx ?? 0));
  const middleTrailingGap = Math.max(0, Math.trunc(input.middleTrailingGapPx ?? 0));
  const summaryTrailingGap = Math.max(
    0,
    Math.trunc(
      input.summaryTrailingGapPx ?? layout.bottomBar.textToSendIconGapPx,
    ),
  );
  const trailingGap = middleWidth > 0 ? middleTrailingGap : summaryTrailingGap;
  return Math.max(0, rowWidth - buttonWidth - middleWidth - trailingGap);
}

export function bottomBarLabelFitsSlot(
  labelWidthPx: number,
  slotWidthPx: number,
  epsilonPx = BOTTOM_BAR_ROW_FIT_EPSILON_PX,
): boolean {
  return (
    labelWidthPx > 0 &&
    slotWidthPx > 0 &&
    labelWidthPx <= slotWidthPx + epsilonPx
  );
}
