import { useSyncExternalStore } from "react";

import { SWAP_GRAM_TOKEN, type SwapPairToken } from "../swap/swapPairTypes";

type GetPanelFormState = {
  tonConnected: boolean;
  amount: string;
  token: SwapPairToken;
};

let state: GetPanelFormState = {
  tonConnected: false,
  amount: "",
  token: SWAP_GRAM_TOKEN,
};

const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function setGetPanelFormState(patch: Partial<GetPanelFormState>) {
  const next: GetPanelFormState = {
    tonConnected: patch.tonConnected ?? state.tonConnected,
    amount: patch.amount ?? state.amount,
    token: patch.token ?? state.token,
  };
  if (
    next.tonConnected === state.tonConnected &&
    next.amount === state.amount &&
    next.token === state.token
  ) {
    return;
  }
  state = next;
  emit();
}

export function getGetPanelFormState(): GetPanelFormState {
  return state;
}

export function subscribeGetPanelForm(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
