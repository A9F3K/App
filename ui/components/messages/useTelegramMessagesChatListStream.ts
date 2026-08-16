import { useEffect } from "react";

type Options = {
  enabled: boolean;
  getSinceRevision: () => number | null;
  onRevision: (revision: number) => void;
  onStreamHealthyChange?: (healthy: boolean) => void;
};

/** Native / non-web: chat list uses HTTP polling only. */
export function useTelegramMessagesChatListStream(options: Options): void {
  const { enabled, onStreamHealthyChange } = options;
  useEffect(() => {
    onStreamHealthyChange?.(false);
  }, [enabled, onStreamHealthyChange]);
}
