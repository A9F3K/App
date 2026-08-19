import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

type MessagesChatListSearchContextValue = {
  chatListSearchQuery: string;
  setChatListSearchQuery: (next: string) => void;
  chatListSearchFocused: boolean;
  setChatListSearchFocused: (next: boolean) => void;
  dismissChatListSearch: () => void;
  /** True while the recents strip or an active query is showing search results. */
  listSearchActive: boolean;
};

const MessagesChatListSearchContext = createContext<MessagesChatListSearchContextValue | null>(
  null,
);

/** Global snapshot for chrome outside the provider tree (e.g. footer strip in `_layout`). */
let listSearchActiveExternal = false;
const listSearchActiveListeners = new Set<() => void>();

function setListSearchActiveExternal(next: boolean): void {
  if (listSearchActiveExternal === next) return;
  listSearchActiveExternal = next;
  for (const listener of listSearchActiveListeners) {
    listener();
  }
}

export function subscribeMessagesChatListSearchActive(listener: () => void): () => void {
  listSearchActiveListeners.add(listener);
  return () => {
    listSearchActiveListeners.delete(listener);
  };
}

export function getMessagesChatListSearchActiveSnapshot(): boolean {
  return listSearchActiveExternal;
}

/** Safe outside `MessagesChatListSearchProvider` — returns false when inactive. */
export function useMessagesChatListSearchActiveOptional(): boolean {
  return useSyncExternalStore(
    subscribeMessagesChatListSearchActive,
    getMessagesChatListSearchActiveSnapshot,
    () => false,
  );
}

export function MessagesChatListSearchProvider({ children }: { children: ReactNode }) {
  const [chatListSearchQuery, setChatListSearchQuery] = useState("");
  const [chatListSearchFocused, setChatListSearchFocused] = useState(false);

  const dismissChatListSearch = useCallback(() => {
    setChatListSearchFocused(false);
    setChatListSearchQuery("");
  }, []);

  const listSearchActive = chatListSearchFocused || chatListSearchQuery.trim().length > 0;

  useEffect(() => {
    setListSearchActiveExternal(listSearchActive);
    return () => setListSearchActiveExternal(false);
  }, [listSearchActive]);

  const value = useMemo(
    () => ({
      chatListSearchQuery,
      setChatListSearchQuery,
      chatListSearchFocused,
      setChatListSearchFocused,
      dismissChatListSearch,
      listSearchActive,
    }),
    [
      chatListSearchQuery,
      chatListSearchFocused,
      dismissChatListSearch,
      listSearchActive,
    ],
  );

  return (
    <MessagesChatListSearchContext.Provider value={value}>
      {children}
    </MessagesChatListSearchContext.Provider>
  );
}

export function useMessagesChatListSearch(): MessagesChatListSearchContextValue {
  const ctx = useContext(MessagesChatListSearchContext);
  if (!ctx) {
    throw new Error("useMessagesChatListSearch must be used within MessagesChatListSearchProvider");
  }
  return ctx;
}
