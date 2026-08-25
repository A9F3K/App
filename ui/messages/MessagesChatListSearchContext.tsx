import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

/** Shared ref: chat row pointerdown during search — defer field blur so the list does not swap mid-click. */
const chatListSearchRowPressRef = { current: false };

export function markChatListSearchRowPressPending(): void {
  chatListSearchRowPressRef.current = true;
}

type MessagesChatListSearchContextValue = {
  chatListSearchQuery: string;
  setChatListSearchQuery: (next: string) => void;
  chatListSearchFocused: boolean;
  setChatListSearchFocused: (next: boolean) => void;
  /** Blur handler for the search field — ignores blur caused by tapping a search result. */
  handleChatListSearchBlur: () => void;
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
    chatListSearchRowPressRef.current = false;
    setChatListSearchFocused(false);
    setChatListSearchQuery("");
  }, []);

  const handleChatListSearchBlur = useCallback(() => {
    // Blur runs before the chat row click; defer so search results stay mounted for the press.
    requestAnimationFrame(() => {
      setTimeout(() => {
        if (chatListSearchRowPressRef.current) {
          chatListSearchRowPressRef.current = false;
          return;
        }
        setChatListSearchFocused(false);
      }, 0);
    });
  }, []);

  const listSearchActive = chatListSearchFocused || chatListSearchQuery.trim().length > 0;

  const value = useMemo(
    () => ({
      chatListSearchQuery,
      setChatListSearchQuery,
      chatListSearchFocused,
      setChatListSearchFocused,
      handleChatListSearchBlur,
      dismissChatListSearch,
      listSearchActive,
    }),
    [
      chatListSearchQuery,
      chatListSearchFocused,
      dismissChatListSearch,
      handleChatListSearchBlur,
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
