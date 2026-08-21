import { useSyncExternalStore } from "react";

import { useAppStrings } from "../../../locales/AppStringsContext";
import { swapTokenDisplaySymbol } from "../../swap/swapPairTypes";
import {
  getGetPanelFormState,
  subscribeGetPanelForm,
} from "../../get/getPanelFormStore";

/** Centered Get CTA / footer summary from the live Get panel form. */
export function useGetActionSummary(): string {
  const { t, tf } = useAppStrings();
  const form = useSyncExternalStore(
    subscribeGetPanelForm,
    getGetPanelFormState,
    getGetPanelFormState,
  );

  if (!form.tonConnected) {
    return t("get.action.connectHint");
  }

  const symbol = swapTokenDisplaySymbol(form.token).toLowerCase();
  const amount = form.amount.trim();
  if (amount) {
    return tf("get.action.summaryWithAmount", { amount, symbol });
  }
  return tf("get.action.summary", { symbol });
}
