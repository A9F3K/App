import { SwapDealActionRow } from "./SwapDealActionRow";

type Props = {
  /** @deprecated Deal state comes from {@link useSwapDealActionState}. */
  dllrAmount?: number | null;
  /** @deprecated Deal state comes from {@link useSwapDealActionState}. */
  buySymbol?: string;
};

/** Inline (2-column) swap deal row under the form. */
export function SwapActionRow(_props: Props) {
  return <SwapDealActionRow density="compact" />;
}
