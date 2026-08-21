import { useSyncExternalStore } from "react";

type SendFormState = {
  address: string;
  comment: string;
};

let state: SendFormState = { address: "", comment: "" };
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function setSendFormAddress(address: string) {
  if (state.address === address) return;
  state = { ...state, address };
  emit();
}

export function setSendFormComment(comment: string) {
  if (state.comment === comment) return;
  state = { ...state, comment };
  emit();
}

export function getSendFormState(): SendFormState {
  return state;
}

export function subscribeSendForm(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useSendFormState(): SendFormState {
  return useSyncExternalStore(subscribeSendForm, getSendFormState, getSendFormState);
}
