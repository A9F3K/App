import {
  createContext,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { View } from "react-native";
import type { MessageChatRowData } from "../components/messages/MessageChatRow";
import { MessageChatProfileSheet } from "../components/messages/MessageChatProfileSheet";
import { ActiveVoiceCallDock } from "../components/messages/ActiveVoiceCallDock";
import { GlobalMusicControlBar } from "../components/music/GlobalMusicControlBar";
import { MusicPlayerEngine } from "../music/MusicPlayerEngine";
import { PrivateCallLoadingShell } from "../components/messages/PrivateCallLoadingShell";
import { useColors } from "../theme";
import { logPageDisplay } from "../pageDisplayLog";
import { unlockVoiceAutoplay } from "../telegram/unlockVoiceAutoplay";
import { startPrivateCallRingback } from "../telegram/privateCallRingback";
import {
  clearQueuedNormalNetworkFetches,
  demoteQueuedNetworkFetches,
} from "../components/messages/networkFetchQueue";
import { fetchTelegramUserProfile } from "../telegram/fetchTelegramUserProfile";

/** Lazy — avoids ProfileContext ↔ VoicePopover circular import via private-call host. */
const MessageChatPrivateCallHost = lazy(() =>
  import("../components/messages/MessageChatPrivateCallHost").then((mod) => ({
    default: mod.MessageChatPrivateCallHost,
  })),
);

/** Minimal peer identity needed to open the profile sheet (chat list, header, voice, bubbles). */
export type ProfileSheetTarget = {
  telegram_chat_id: number;
  title: string;
  peer_user_id?: number | null;
  peer_username?: string | null;
  chat_username?: string | null;
  chat_kind?: MessageChatRowData["chat_kind"] | null;
  avatar_url?: string | null;
  peer_emoji_status_custom_emoji_id?: string | null;
  peer_accent_color_light?: string | null;
  peer_accent_color_dark?: string | null;
  presence_kind?: MessageChatRowData["presence_kind"];
  presence_at?: string | null;
  peer_is_bot?: boolean;
  member_count?: number | null;
};

function toProfileChat(target: ProfileSheetTarget | MessageChatRowData): MessageChatRowData {
  if ("id" in target && typeof (target as MessageChatRowData).id === "number" && "subtitle" in target) {
    return target as MessageChatRowData;
  }
  const t = target as ProfileSheetTarget;
  return {
    id: 0,
    telegram_chat_id: Math.trunc(t.telegram_chat_id),
    title: t.title?.trim() || "User",
    subtitle: "",
    avatar_url: t.avatar_url ?? null,
    last_message_at: null,
    unread_count: 0,
    peer_user_id: t.peer_user_id ?? null,
    peer_username: t.peer_username ?? null,
    chat_username: t.chat_username ?? null,
    chat_kind: t.chat_kind ?? (t.peer_user_id != null ? "private" : null),
    peer_emoji_status_custom_emoji_id: t.peer_emoji_status_custom_emoji_id ?? null,
    peer_accent_color_light: t.peer_accent_color_light ?? null,
    peer_accent_color_dark: t.peer_accent_color_dark ?? null,
    presence_kind: t.presence_kind ?? null,
    presence_at: t.presence_at ?? null,
    peer_is_bot: t.peer_is_bot ?? false,
    member_count: t.member_count ?? null,
  };
}

type ProfileContextValue = {
  profileSheetVisible: boolean;
  profileChat: MessageChatRowData | null;
  openProfileSheet: (target: ProfileSheetTarget | MessageChatRowData) => void;
  closeProfileSheet: () => void;
  startPrivateCall: (target: ProfileSheetTarget | MessageChatRowData) => void;
  endPrivateCall: () => void;
};

const ProfileContext = createContext<ProfileContextValue | null>(null);

export function ProfileProvider({ children }: { children: ReactNode }) {
  const [profileSheetVisible, setProfileSheetVisible] = useState(false);
  const [profileChat, setProfileChat] = useState<MessageChatRowData | null>(null);
  const [privateCallChat, setPrivateCallChat] = useState<MessageChatRowData | null>(null);
  const [privateCallVisible, setPrivateCallVisible] = useState(false);
  const [privateCallOpenSeq, setPrivateCallOpenSeq] = useState(0);
  const [privateCallAlive, setPrivateCallAlive] = useState(false);

  const openProfileSheet = useCallback((target: ProfileSheetTarget | MessageChatRowData) => {
    const chat = toProfileChat(target);
    logPageDisplay("messages_profile_open", {
      chatId: chat.telegram_chat_id,
      peerUserId: chat.peer_user_id ?? null,
      title: chat.title,
    });
    demoteQueuedNetworkFetches();
    clearQueuedNormalNetworkFetches();
    void fetchTelegramUserProfile(
      chat.telegram_chat_id,
      chat.peer_user_id ?? null,
      undefined,
      { priority: "critical" },
    );
    setProfileChat(chat);
    setProfileSheetVisible(true);
  }, []);

  const closeProfileSheet = useCallback(() => {
    setProfileSheetVisible(false);
  }, []);

  /** Minimize only — keep the TDLib call alive and show the global dock. */
  const minimizePrivateCall = useCallback(() => {
    setPrivateCallVisible(false);
  }, []);

  /** Hang up and tear down the private-call host. */
  const endPrivateCall = useCallback(() => {
    setPrivateCallVisible(false);
    setPrivateCallAlive(false);
    setPrivateCallChat(null);
  }, []);

  const reopenPrivateCall = useCallback(() => {
    setPrivateCallOpenSeq((n) => n + 1);
    setPrivateCallVisible(true);
  }, []);

  const startPrivateCall = useCallback((target: ProfileSheetTarget | MessageChatRowData) => {
    const chat = toProfileChat(target);
    // Must run in the phone-button gesture so ringback AudioContext can play.
    unlockVoiceAutoplay();
    startPrivateCallRingback();
    void import("../components/messages/MessageChatPrivateCallHost");
    logPageDisplay("messages_private_call_start", {
      chatId: chat.telegram_chat_id,
      peerUserId: chat.peer_user_id ?? null,
      title: chat.title,
    });
    setProfileSheetVisible(false);
    setPrivateCallChat(chat);
    setPrivateCallAlive(true);
    setPrivateCallOpenSeq((n) => n + 1);
    setPrivateCallVisible(true);
  }, []);

  const value = useMemo(
    () => ({
      profileSheetVisible,
      profileChat,
      openProfileSheet,
      closeProfileSheet,
      startPrivateCall,
      endPrivateCall,
    }),
    [
      profileSheetVisible,
      profileChat,
      openProfileSheet,
      closeProfileSheet,
      startPrivateCall,
      endPrivateCall,
    ],
  );

  const colors = useColors();

  return (
    <ProfileContext.Provider value={value}>
      <View style={{ flex: 1, minHeight: 0, width: "100%", alignSelf: "stretch" }}>
        <GlobalMusicControlBar colors={colors} />
        <ActiveVoiceCallDock colors={colors} inline />
        <View style={{ flex: 1, minHeight: 0, width: "100%", alignSelf: "stretch" }}>
          {children}
        </View>
      </View>
      <MusicPlayerEngine />
      <MessageChatProfileSheet
        visible={profileSheetVisible}
        chat={profileChat}
        onClose={closeProfileSheet}
        onCall={() => {
          if (profileChat) startPrivateCall(profileChat);
        }}
      />
      {privateCallAlive && privateCallChat ? (
        <Suspense
          fallback={
            privateCallVisible ? (
              <PrivateCallLoadingShell chat={privateCallChat} onClose={minimizePrivateCall} />
            ) : null
          }
        >
          <MessageChatPrivateCallHost
            peer={{ chat: privateCallChat }}
            visible={privateCallVisible}
            openSeq={privateCallOpenSeq}
            onClose={minimizePrivateCall}
            onHangUp={endPrivateCall}
            onReopen={reopenPrivateCall}
          />
        </Suspense>
      ) : null}
    </ProfileContext.Provider>
  );
}

export function useProfileSheet(): ProfileContextValue {
  const ctx = useContext(ProfileContext);
  if (!ctx) {
    throw new Error("useProfileSheet must be used within ProfileProvider");
  }
  return ctx;
}
