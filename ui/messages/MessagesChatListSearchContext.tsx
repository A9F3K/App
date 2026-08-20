import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
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

/**
 * Safe outside `MessagesChatListSearchProvider` — returns false when inactive.
 * Provider must wrap both the messages UI and root chrome (FloatingShield / footer strip).
 */
export function useMessagesChatListSearchActiveOptional(): boolean {
  const ctx = useContext(MessagesChatListSearchContext);
  return ctx?.listSearchActive ?? false;
}

export function MessagesChatListSearchProvider({ children }: { children: ReactNode }) {
  const [chatListSearchQuery, setChatListSearchQuery] = useState("");
  const [chatListSearchFocused, setChatListSearchFocused] = useState(false);

  const dismissChatListSearch = useCallback(() => {
    setChatListSearchFocused(false);
    setChatListSearchQuery("");
  }, []);

  const listSearchActive = chatListSearchFocused || chatListSearchQuery.trim().length > 0;

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
