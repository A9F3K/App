import { useSyncExternalStore } from "react";

export type SwapCurrencySide = "buy" | "sell";

/** `browse` = Currencies home list; `buy`/`sell` = choose-token from the swap form. */
export type SwapCurrencyPickerMode = SwapCurrencySide | "browse";

let activeMode: SwapCurrencyPickerMode | null = null;
/**
 * After the user leaves Currencies into the swap form, narrow `/swap` remounts
 * must not force browse again (e.g. returning from `/swap/currency`).
 */
let preferSwapForm = false;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) {
    listener();
  }
}

export function openSwapCurrencyPicker(mode: SwapCurrencyPickerMode) {
  if (mode === "browse") {
    preferSwapForm = false;
  }
  if (activeMode === mode) return;
  activeMode = mode;
  emit();
}

/** Open the Currencies list as the Swap entry surface. */
export function openSwapCurrenciesBrowse() {
  openSwapCurrencyPicker("browse");
}

export function closeSwapCurrencyPicker() {
  if (activeMode === null) return;
  activeMode = null;
  emit();
}

/** Call when a Currencies-home row opens the swap form. */
export function markSwapFormPreferred() {
  preferSwapForm = true;
}

export function shouldOpenSwapCurrenciesBrowseOnSwapScreen(): boolean {
  return !preferSwapForm;
}

function subscribe(onStoreChange: () => void) {
  listeners.add(onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
  };
}

function getSnapshot() {
  return activeMode;
}

function getServerSnapshot() {
  return null as SwapCurrencyPickerMode | null;
}

export function useSwapCurrencyPicker(): SwapCurrencyPickerMode | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

export function isSwapCurrencySide(
  mode: SwapCurrencyPickerMode | null | undefined,
): mode is SwapCurrencySide {
  return mode === "buy" || mode === "sell";
}
