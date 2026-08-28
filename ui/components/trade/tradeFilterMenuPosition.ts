/**
 * Market-page 24h / Any chain filter menus: open below the chip when the
 * full dialog fits, otherwise flip above so the chip stays visible.
 *
 * Height math matches `menuHeightPx` in MessageChatVoiceMoreMenu.
 */

export const TRADE_FILTER_MENU_GAP_PX = 6;
export const TRADE_FILTER_MENU_VIEWPORT_MARGIN_PX = 8;

const MENU_PADDING_PX = 15;
const MENU_ITEM_HEIGHT_PX = 15;
const MENU_ITEM_GAP_PX = 20;

export type TradeFilterMenuSide = "below" | "above";

export type TradeFilterMenuAnchor = {
  x: number;
  y: number;
  side: TradeFilterMenuSide;
};

export function tradeFilterMenuHeightPx(itemCount: number): number {
  const items = Math.max(1, itemCount);
  return (
    MENU_PADDING_PX * 2 +
    MENU_ITEM_HEIGHT_PX * items +
    MENU_ITEM_GAP_PX * Math.max(0, items - 1)
  );
}

export function resolveTradeFilterMenuAnchor({
  chipX,
  chipY,
  chipHeight,
  itemCount,
  windowHeight,
}: {
  chipX: number;
  chipY: number;
  chipHeight: number;
  itemCount: number;
  windowHeight: number;
}): TradeFilterMenuAnchor {
  const menuHeight = tradeFilterMenuHeightPx(itemCount);
  const belowTop = Math.round(chipY + chipHeight + TRADE_FILTER_MENU_GAP_PX);
  const fitsBelow =
    belowTop + menuHeight <= windowHeight - TRADE_FILTER_MENU_VIEWPORT_MARGIN_PX;
  if (fitsBelow) {
    return { x: Math.round(chipX), y: belowTop, side: "below" };
  }
  return {
    x: Math.round(chipX),
    y: Math.round(chipY - TRADE_FILTER_MENU_GAP_PX - menuHeight),
    side: "above",
  };
}
