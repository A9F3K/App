import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Platform,
  Text,
  View,
  useWindowDimensions,
  type LayoutChangeEvent,
} from "react-native";

import {
  listAiAgentChats,
  postAiAgentChatAction,
  type AiAgentMessageDto,
} from "../../../api/aiAgentChatsClient";
import {
  fetchMySupportChat,
  sendSupportUserMessage,
} from "../../../api/supportClient";
import { useAppStrings } from "../../../locales/AppStringsContext";
import { layout, typographyRect15, useColors } from "../../theme";
import { useAuthenticatedHomeSplitLayoutMetrics } from "../AuthenticatedHomeSplitLayoutMetricsContext";
import { useBottomBarLayout } from "../BottomBarLayoutContext";
import { HspScrollColumn, type HspScrollColumnHandle } from "../HspScrollColumn";
import { subscribeOpenSupportChat } from "../../support/openSupportChat";
import { AiAgentChatThread, type AiThreadMessage } from "./AiAgentChatThread";
import { AiAgentRenameDialog } from "./AiAgentRenameDialog";
import { AiAgentsColumnHeader, type AiAgentTab } from "./AiAgentsColumnHeader";
import { AiSearchPromptButton } from "./AiSearchPromptButton";

const TOP_GAP_PX = 20;
const PARAGRAPH_GAP_PX = 15;
const BODY_TO_PROMPTS_GAP_PX = 15;
const PROMPT_BUTTON_GAP_PX = 15;

const BODY_FONT_SIZE_PX = 15;
const BODY_LINE_HEIGHT_PX = 25;

const PREMADE_PROMPT_KEYS = [
  "global.bottomBar.premade1",
  "global.bottomBar.premade2",
  "global.bottomBar.premade3",
] as const;

const CLAIMED_CHAT_STORAGE_KEY = "hsp_ai_claimed_chat_id";
const SUPPORT_TAB_ID = "support-inbox";

function newAgentTabId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function createIdleTab(title?: string): AiAgentTab {
  return {
    id: newAgentTabId(),
    title: title ?? "",
    started: false,
    messages: [],
    messagesLoaded: true,
  };
}

function mapDtoMessages(rows: AiAgentMessageDto[]): AiThreadMessage[] {
  return rows
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({
      id: m.id,
      role: m.role as "user" | "assistant",
      content: m.content,
      model: m.model,
      likedByMe: Boolean(m.liked_by_me),
      likeCount: Number(m.like_count ?? 0),
    }));
}

/** Default empty-state body shared by every idle agent tab. */
function AiAgentTabEmptyBody({
  columnWidth,
  onPromptPress,
  supportMode,
}: {
  columnWidth: number;
  onPromptPress: (prompt: string) => void;
  supportMode?: boolean;
}) {
  const colors = useColors();
  const { t } = useAppStrings();
  const prompts = useMemo(() => PREMADE_PROMPT_KEYS.map((key) => t(key)), [t]);

  const bodyStyle = [
    typographyRect15,
    {
      fontSize: BODY_FONT_SIZE_PX,
      lineHeight: BODY_LINE_HEIGHT_PX,
      fontWeight: "400" as const,
      color: colors.primary,
    },
  ];

  if (supportMode) {
    return (
      <>
        <View style={{ height: TOP_GAP_PX }} />
        <Text style={bodyStyle}>{t("ai.support.empty")}</Text>
      </>
    );
  }

  return (
    <>
      <View style={{ height: TOP_GAP_PX }} />
      <Text style={bodyStyle}>{t("ai.search.emptyIntro")}</Text>
      <View style={{ height: PARAGRAPH_GAP_PX }} />
      <Text style={bodyStyle}>{t("ai.search.emptyList")}</Text>
      <View style={{ height: PARAGRAPH_GAP_PX }} />
      <Text style={bodyStyle}>{t("ai.search.emptyTryPrompts")}</Text>
      <View style={{ height: BODY_TO_PROMPTS_GAP_PX }} />
      {prompts.map((prompt, index) => (
        <View key={PREMADE_PROMPT_KEYS[index]}>
          {index > 0 ? <View style={{ height: PROMPT_BUTTON_GAP_PX }} /> : null}
          <AiSearchPromptButton
            label={prompt}
            columnWidth={columnWidth}
            onPress={() => onPromptPress(prompt)}
          />
        </View>
      ))}
    </>
  );
}

/**
 * Triple-column AI pane: agent tabs + empty prompts until apply, then chat thread.
 * Typing in the bottom bar does not hide the empty state — only submitting does.
 */
export function AiSearchColumnEmptyState() {
  const colors = useColors();
  const { t } = useAppStrings();
  const { setDraftText, setAiSearchSubmit, setAiSearchPlaceholder } = useBottomBarLayout();
  const splitMetrics = useAuthenticatedHomeSplitLayoutMetrics();
  const { height: windowHeight, width: windowWidth } = useWindowDimensions();
  const scrollRef = useRef<HspScrollColumnHandle>(null);
  const [columnWidth, setColumnWidth] = useState(0);
  const [headerHeightPx, setHeaderHeightPx] = useState(0);
  const [viewportHeightPx, setViewportHeightPx] = useState(0);
  const [tabs, setTabs] = useState<AiAgentTab[]>(() => [createIdleTab()]);
  const [activeTabId, setActiveTabId] = useState(() => tabs[0]!.id);
  const [renameTabId, setRenameTabId] = useState<string | null>(null);
  const hydratedRef = useRef(false);

  const contentInset = layout.contentSideInsetPx;
  const scrollShellBleed = { marginHorizontal: -contentInset };
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0]!;
  const showEmptyBody = !activeTab?.started;
  const showCloseButtons = tabs.length > 1 || Boolean(activeTab?.started);

  const onColumnLayout = useCallback((event: LayoutChangeEvent) => {
    const next = Math.round(event.nativeEvent.layout.width);
    setColumnWidth((current) => (current === next ? current : next));
    const nextH = Math.round(event.nativeEvent.layout.height);
    setViewportHeightPx((current) => (current === nextH ? current : nextH));
  }, []);

  const onHeaderLayout = useCallback((event: LayoutChangeEvent) => {
    const next = Math.round(event.nativeEvent.layout.height);
    setHeaderHeightPx((current) => (current === next ? current : next));
  }, []);

  const remeasureScrollColumn = useCallback(() => {
    if (Platform.OS !== "web") return;
    requestAnimationFrame(() => {
      scrollRef.current?.syncScrollMetricsFromDom();
      requestAnimationFrame(() => scrollRef.current?.syncScrollMetricsFromDom());
    });
  }, []);

  useEffect(() => {
    remeasureScrollColumn();
  }, [
    remeasureScrollColumn,
    columnWidth,
    viewportHeightPx,
    headerHeightPx,
    windowHeight,
    windowWidth,
    splitMetrics?.columnCount,
    splitMetrics?.splitRowWidthPx,
    splitMetrics?.thirdColumnWidthPx,
    activeTab?.started,
    activeTab?.messages.length,
  ]);

  useEffect(() => {
    if (hydratedRef.current) return;
    hydratedRef.current = true;
    let cancelled = false;
    void (async () => {
      const listed = await listAiAgentChats();
      if (cancelled || !listed.ok || !listed.chats?.length) return;
      let focusId: string | null = null;
      if (Platform.OS === "web" && typeof sessionStorage !== "undefined") {
        focusId = sessionStorage.getItem(CLAIMED_CHAT_STORAGE_KEY);
        if (focusId) sessionStorage.removeItem(CLAIMED_CHAT_STORAGE_KEY);
      }
      const nextTabs: AiAgentTab[] = listed.chats.map((chat) => ({
        id: chat.id,
        title: chat.title,
        started: true,
        messages: [],
        messagesLoaded: false,
      }));
      if (!cancelled) {
        setTabs(nextTabs);
        setActiveTabId(
          focusId && nextTabs.some((t) => t.id === focusId)
            ? focusId
            : nextTabs[0]!.id,
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const openSupportTab = useCallback(() => {
    setTabs((current) => {
      const existing = current.find((tab) => tab.id === SUPPORT_TAB_ID);
      if (existing) return current;
      return [
        ...current,
        {
          id: SUPPORT_TAB_ID,
          kind: "support" as const,
          title: t("ai.agents.support"),
          started: false,
          messages: [],
          messagesLoaded: false,
        },
      ];
    });
    setActiveTabId(SUPPORT_TAB_ID);
    void (async () => {
      const res = await fetchMySupportChat();
      if (!res.ok) return;
      const messages: AiThreadMessage[] = (res.messages ?? []).map((m) => ({
        id: m.id,
        role: m.role === "staff" ? ("assistant" as const) : ("user" as const),
        content: m.content,
      }));
      setTabs((current) =>
        current.map((tab) =>
          tab.id === SUPPORT_TAB_ID
            ? {
                ...tab,
                kind: "support",
                title: t("ai.agents.support"),
                started: messages.length > 0,
                messages,
                messagesLoaded: true,
              }
            : tab,
        ),
      );
    })();
  }, [t]);

  useEffect(() => subscribeOpenSupportChat(openSupportTab), [openSupportTab]);

  const loadMessagesForTab = useCallback(async (chatId: string) => {
    if (chatId === SUPPORT_TAB_ID) {
      const res = await fetchMySupportChat();
      if (!res.ok) return;
      const messages: AiThreadMessage[] = (res.messages ?? []).map((m) => ({
        id: m.id,
        role: m.role === "staff" ? ("assistant" as const) : ("user" as const),
        content: m.content,
      }));
      setTabs((current) =>
        current.map((tab) =>
          tab.id === chatId
            ? {
                ...tab,
                kind: "support",
                messages,
                messagesLoaded: true,
                started: messages.length > 0,
              }
            : tab,
        ),
      );
      return;
    }
    const res = await postAiAgentChatAction({
      action: "list_messages",
      chatId,
    });
    if (!res.ok || !Array.isArray(res.messages)) return;
    const messages = mapDtoMessages(res.messages as AiAgentMessageDto[]);
    const title =
      res.chat && typeof (res.chat as { title?: string }).title === "string"
        ? (res.chat as { title: string }).title
        : undefined;
    setTabs((current) =>
      current.map((tab) =>
        tab.id === chatId
          ? {
              ...tab,
              title: title ?? tab.title,
              messages,
              messagesLoaded: true,
              started: true,
            }
          : tab,
      ),
    );
  }, []);

  useEffect(() => {
    const tab = tabs.find((t) => t.id === activeTabId);
    if (!tab?.started || tab.messagesLoaded) return;
    void loadMessagesForTab(tab.id);
  }, [activeTabId, tabs, loadMessagesForTab]);

  const onAddTab = useCallback(() => {
    const tab = createIdleTab(t("ai.agents.newAgent"));
    setTabs((current) => [...current, tab]);
    setActiveTabId(tab.id);
  }, [t]);

  const removeTabLocally = useCallback(
    (id: string) => {
      setTabs((current) => {
        if (current.length <= 1) {
          setDraftText("");
          const fresh = createIdleTab(t("ai.agents.newAgent"));
          setActiveTabId(fresh.id);
          return [fresh];
        }
        const index = current.findIndex((tab) => tab.id === id);
        if (index < 0) return current;
        const next = current.filter((tab) => tab.id !== id);
        setActiveTabId((active) => {
          if (active !== id) return active;
          const fallback = next[Math.min(index, next.length - 1)];
          return fallback?.id ?? active;
        });
        return next;
      });
    },
    [setDraftText, t],
  );

  const onCloseTab = useCallback(
    (id: string) => {
      const tab = tabs.find((t) => t.id === id);
      if (tab?.kind === "support") {
        removeTabLocally(id);
        return;
      }
      if (tab?.started) {
        void postAiAgentChatAction({ action: "delete", chatId: id });
      }
      removeTabLocally(id);
    },
    [removeTabLocally, tabs],
  );

  const onRenameTab = useCallback((id: string, title: string) => {
    if (id === SUPPORT_TAB_ID) return;
    setTabs((current) =>
      current.map((tab) => (tab.id === id ? { ...tab, title } : tab)),
    );
    void postAiAgentChatAction({ action: "rename", chatId: id, title });
  }, []);

  const onDeleteTab = useCallback(
    (id: string) => {
      if (id === SUPPORT_TAB_ID) {
        removeTabLocally(id);
        return;
      }
      void postAiAgentChatAction({ action: "delete", chatId: id });
      removeTabLocally(id);
    },
    [removeTabLocally],
  );

  const applyPrompt = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      const tabId = activeTabId;
      const active = tabs.find((tab) => tab.id === tabId);
      const tempUserId = `local-user-${Date.now()}`;

      if (active?.kind === "support" || tabId === SUPPORT_TAB_ID) {
        setTabs((current) =>
          current.map((tab) => {
            if (tab.id !== tabId) return tab;
            return {
              ...tab,
              kind: "support",
              started: true,
              sending: true,
              messagesLoaded: true,
              messages: [
                ...tab.messages,
                { id: tempUserId, role: "user" as const, content: trimmed },
              ],
            };
          }),
        );
        const res = await sendSupportUserMessage(trimmed);
        setTabs((current) =>
          current.map((tab) => {
            if (tab.id !== tabId) return tab;
            if (!res.ok || !res.message) {
              return {
                ...tab,
                sending: false,
                messages: [
                  ...tab.messages.filter((m) => m.id !== tempUserId),
                  { id: tempUserId, role: "user", content: trimmed },
                  {
                    id: `local-err-${Date.now()}`,
                    role: "assistant",
                    content: t("ai.support.sendFailed"),
                  },
                ],
              };
            }
            return {
              ...tab,
              sending: false,
              messages: [
                ...tab.messages.filter((m) => m.id !== tempUserId),
                {
                  id: res.message!.id,
                  role: "user",
                  content: res.message!.content,
                },
              ],
            };
          }),
        );
        return;
      }

      setTabs((current) =>
        current.map((tab) => {
          if (tab.id !== tabId) return tab;
          return {
            ...tab,
            started: true,
            sending: true,
            messagesLoaded: true,
            messages: [
              ...tab.messages,
              { id: tempUserId, role: "user" as const, content: trimmed },
            ],
          };
        }),
      );

      const res = await postAiAgentChatAction({
        action: "send",
        chatId: tabId,
        clientId: tabId,
        input: trimmed,
      });

      if (!res.ok) {
        setTabs((current) =>
          current.map((tab) => {
            if (tab.id !== tabId) return tab;
            return {
              ...tab,
              sending: false,
              messages: [
                ...tab.messages.filter((m) => m.id !== tempUserId),
                { id: tempUserId, role: "user", content: trimmed },
                {
                  id: `local-err-${Date.now()}`,
                  role: "assistant",
                  content: String(res.error ?? t("ai.errorGeneric")),
                },
              ],
            };
          }),
        );
        return;
      }

      const chat = res.chat as { id?: string; title?: string } | undefined;
      const userMessage = res.userMessage as AiAgentMessageDto | undefined;
      const assistantMessage = res.assistantMessage as AiAgentMessageDto | undefined;
      const serverChatId = typeof chat?.id === "string" ? chat.id : tabId;
      const title = typeof chat?.title === "string" ? chat.title : undefined;

      setTabs((current) =>
        current.map((tab) => {
          if (tab.id !== tabId) return tab;
          const withoutTemp = tab.messages.filter((m) => m.id !== tempUserId);
          const nextMessages: AiThreadMessage[] = [...withoutTemp];
          if (userMessage) {
            nextMessages.push({
              id: userMessage.id,
              role: "user",
              content: userMessage.content,
            });
          } else {
            nextMessages.push({ id: tempUserId, role: "user", content: trimmed });
          }
          if (assistantMessage) {
            nextMessages.push({
              id: assistantMessage.id,
              role: "assistant",
              content: assistantMessage.content,
              model: assistantMessage.model,
              likedByMe: false,
              likeCount: 0,
            });
          }
          return {
            ...tab,
            id: serverChatId,
            title: title ?? tab.title,
            started: true,
            sending: false,
            messagesLoaded: true,
            messages: nextMessages,
          };
        }),
      );
      if (serverChatId !== tabId) {
        setActiveTabId(serverChatId);
      }
    },
    [activeTabId, t, tabs],
  );

  useEffect(() => {
    setAiSearchSubmit((text) => {
      void applyPrompt(text);
    });
    return () => setAiSearchSubmit(null);
  }, [applyPrompt, setAiSearchSubmit]);

  useEffect(() => {
    if (activeTab?.kind === "support") {
      setAiSearchPlaceholder(t("global.bottomBar.askSupport"));
    } else {
      setAiSearchPlaceholder(null);
    }
    return () => setAiSearchPlaceholder(null);
  }, [activeTab?.kind, setAiSearchPlaceholder, t]);

  const renameTarget = tabs.find((tab) => tab.id === renameTabId);

  return (
    <View
      style={{ flex: 1, width: "100%", alignSelf: "stretch", minHeight: 0, flexDirection: "column" }}
      onLayout={onColumnLayout}
    >
      <View style={scrollShellBleed} onLayout={onHeaderLayout}>
        <AiAgentsColumnHeader
          tabs={tabs}
          activeTabId={activeTabId}
          onSelectTab={setActiveTabId}
          onCloseTab={onCloseTab}
          onAddTab={onAddTab}
          onRequestRename={(id) => setRenameTabId(id)}
          onRequestDelete={onDeleteTab}
          showCloseButtons={showCloseButtons}
        />
      </View>
      <HspScrollColumn
        scrollControllerRef={scrollRef}
        style={{ flex: 1, minHeight: 0, ...scrollShellBleed }}
        contentContainerStyle={{
          paddingHorizontal: contentInset,
          paddingBottom: contentInset,
        }}
        indicatorColor={colors.scrollIndicator}
        scrollbarRightInsetPx={0}
        scrollIndicatorExtendTopPx={headerHeightPx}
      >
        {showEmptyBody ? (
          <AiAgentTabEmptyBody
            key={activeTabId}
            columnWidth={columnWidth}
            onPromptPress={setDraftText}
            supportMode={activeTab?.kind === "support"}
          />
        ) : (
          <AiAgentChatThread
            chatId={activeTab.id}
            messages={activeTab.messages}
            sending={activeTab.sending}
            showActions={activeTab.kind !== "support"}
            onMessagesChange={(next) => {
              setTabs((current) =>
                current.map((tab) =>
                  tab.id === activeTab.id ? { ...tab, messages: next } : tab,
                ),
              );
            }}
          />
        )}
      </HspScrollColumn>
      <AiAgentRenameDialog
        visible={renameTabId != null}
        initialTitle={
          renameTarget?.title?.trim() || t("ai.agents.newAgent")
        }
        onClose={() => setRenameTabId(null)}
        onSave={(title) => {
          if (renameTabId) onRenameTab(renameTabId, title);
        }}
      />
    </View>
  );
}
