import { useCallback } from "react";
import { useWindowDimensions, View } from "react-native";
import { useAppStrings } from "../../../locales/AppStringsContext";
import {
  closeSwapCurrencyPicker,
  isSwapCurrencySide,
  markSwapFormPreferred,
  useSwapCurrencyPicker,
} from "../../swap/swapCurrencyPicker";
import { useChooseCurrencyChrome } from "../../swap/chooseCurrencyChrome";
import { mapChooseCurrencyRowToSwapPairToken } from "../../swap/mapChooseCurrencyRowToSwapPairToken";
import {
  selectSwapBuyTokenForDllr,
  setSwapTokenForSide,
} from "../../swap/swapPairStore";
import { useChooseCurrencyRows } from "../../swap/useChooseCurrencyRows";
import { layout } from "../../theme";
import { useAuthenticatedHomeSplitLayoutMetrics } from "../AuthenticatedHomeSplitLayoutMetricsContext";
import { ChooseCurrencySubheader } from "./ChooseCurrencySubheader";
import { ChooseCurrencyTable } from "./ChooseCurrencyTable";
import { SwapDealActionRow } from "./SwapDealActionRow";
import { SmartGradientDivider } from "../smart/SmartGradientDivider";
import type { ChooseCurrencyRow } from "./chooseCurrencyTableTypes";

type Props = {
  onFilterPress?: () => void;
  onBackPress?: () => void;
  walletAddress?: string | null;
  /**
   * After a row is chosen and the picker closes. Narrow `/swap/currency` uses
   * this to `router.back()`; browse mode on `/swap` stays on the swap screen.
   */
  onAfterSelect?: () => void;
};

/** Wide split-column picker body (subheader + list area). */
export function ChooseCurrencyPanelContent({
  onFilterPress,
  onBackPress,
  walletAddress,
  onAfterSelect,
}: Props) {
  const { t } = useAppStrings();
  const { width: windowWidth } = useWindowDimensions();
  const pickerMode = useSwapCurrencyPicker();
  const pickerActive = pickerMode != null;
  const isBrowse = pickerMode === "browse";
  const { rows, isLoading, isFetchingMore, error, loadMore } =
    useChooseCurrencyRows(walletAddress, pickerActive);
  const contentInset = layout.bottomBar.horizontalPadding;
  const splitMetrics = useAuthenticatedHomeSplitLayoutMetrics();
  const scrollShellBleed = { marginHorizontal: -contentInset };
  /** Full middle column width; table subtracts side insets so columns align with the deal footer. */
  const columnShellWidthPx = splitMetrics?.middleColumnWidthPx ?? 0;
  const { showSubheaderBack, titleAlign } = useChooseCurrencyChrome();
  /** Inline deal row when the 3-column bottom bar is not showing (≤2 columns). */
  const showInlineDealAction =
    windowWidth <= layout.authenticatedHome.secondBreakpoint;

  const handleBack = useCallback(() => {
    closeSwapCurrencyPicker();
    onBackPress?.();
  }, [onBackPress]);

  const handleSelectRow = useCallback(
    (row: ChooseCurrencyRow) => {
      const token = mapChooseCurrencyRowToSwapPairToken(row);
      if (isBrowse || pickerMode == null) {
        selectSwapBuyTokenForDllr(token);
        markSwapFormPreferred();
      } else if (isSwapCurrencySide(pickerMode)) {
        setSwapTokenForSide(pickerMode, token);
        markSwapFormPreferred();
      }
      closeSwapCurrencyPicker();
      onAfterSelect?.();
    },
    [isBrowse, onAfterSelect, pickerMode],
  );

  return (
    <View style={{ flex: 1, width: "100%", alignSelf: "stretch", minHeight: 0 }}>
      <View style={scrollShellBleed}>
        <ChooseCurrencySubheader
          onBackPress={handleBack}
          onFilterPress={onFilterPress}
          showBack={isBrowse ? false : showSubheaderBack}
          showFilter
          titleAlign={isBrowse ? "left" : titleAlign}
          title={isBrowse ? t("swap.currencies.title") : undefined}
        />
      </View>
      <View style={{ flex: 1, minHeight: 0, ...scrollShellBleed }}>
        <ChooseCurrencyTable
          rows={rows}
          isLoading={isLoading}
          isFetchingMore={isFetchingMore}
          loadError={error}
          onLoadMore={loadMore}
          onSelectRow={handleSelectRow}
          columnShellWidthPx={columnShellWidthPx}
          prefetchCharts={pickerActive}
        />
      </View>
      {showInlineDealAction ? (
        <View style={{ width: "100%", alignSelf: "stretch" }}>
          {/* Same rule as under the currencies table column legend. */}
          <SmartGradientDivider />
          <View
            style={{
              width: "100%",
              paddingVertical: 15,
            }}
          >
            <SwapDealActionRow density="compact" />
          </View>
        </View>
      ) : null}
    </View>
  );
}
