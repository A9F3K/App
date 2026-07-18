type Options = {
  enabled: boolean;
  chatId: number;
  getSinceRevision: () => number | null;
  onRevision: (revision: number) => void;
  onStreamActiveChange?: (active: boolean) => void;
};

/** Native: no EventSource — history stays on poll / list-signature path. */
export function useTelegramChatHistoryStream(_options: Options): void {
  /* no-op */
}
