import * as Clipboard from "expo-clipboard";
import { useCallback, useState } from "react";
import { ActivityIndicator, Platform, Pressable, Text, View } from "react-native";
import Svg, { Path } from "react-native-svg";
import { postAiAgentChatAction } from "../../../api/aiAgentChatsClient";
import { useAppStrings } from "../../../locales/AppStringsContext";
import { FONT_UI_SANS_REGULAR, WEB_UI_SANS_STACK } from "../../fonts";
import { typographyRect15, useColors } from "../../theme";

export type AiThreadMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  model?: string | null;
  likedByMe?: boolean;
  likeCount?: number;
};

const ICON = 18;
const ICON_GAP = 14;
const BUBBLE_PAD_Y = 10;

function CopyIcon({ color }: { color: string }) {
  return (
    <Svg width={ICON} height={ICON} viewBox="0 0 24 24" fill="none">
      <Path
        d="M9 9h10v12H9z"
        stroke={color}
        strokeWidth={1.5}
        strokeLinejoin="round"
      />
      <Path
        d="M5 15V3h10"
        stroke={color}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

function ShareIcon({ color }: { color: string }) {
  return (
    <Svg width={ICON} height={ICON} viewBox="0 0 24 24" fill="none">
      <Path
        d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7"
        stroke={color}
        strokeWidth={1.5}
        strokeLinecap="round"
      />
      <Path
        d="M12 3v12M12 3l-4 4M12 3l4 4"
        stroke={color}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

function LikeIcon({ color, filled }: { color: string; filled?: boolean }) {
  return (
    <Svg width={ICON} height={ICON} viewBox="0 0 24 24" fill={filled ? color : "none"}>
      <Path
        d="M7 11v10H4a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1h3Zm0 0V8.5A3.5 3.5 0 0 1 10.5 5h.3c.9 0 1.7.5 2.1 1.3L14 9h4.2a2 2 0 0 1 1.9 2.6l-1.4 5A2 2 0 0 1 16.8 18H7"
        stroke={color}
        strokeWidth={1.5}
        strokeLinejoin="round"
      />
    </Svg>
  );
}

type Props = {
  chatId: string;
  messages: AiThreadMessage[];
  sending?: boolean;
  /** When false, hide copy/share/like (support staff thread). */
  showActions?: boolean;
  onMessagesChange: (next: AiThreadMessage[]) => void;
};

function shareUrlForToken(token: string): string {
  if (Platform.OS === "web" && typeof window !== "undefined") {
    return `${window.location.origin}/ai-share/${token}`;
  }
  return `https://program.hyperlinks.space/ai-share/${token}`;
}

export function AiAgentChatThread({
  chatId,
  messages,
  sending,
  showActions = true,
  onMessagesChange,
}: Props) {
  const colors = useColors();
  const { t } = useAppStrings();
  const [busyShareId, setBusyShareId] = useState<string | null>(null);
  const [busyLikeId, setBusyLikeId] = useState<string | null>(null);

  const bodyStyle = [
    typographyRect15,
    {
      color: colors.primary,
      fontFamily: Platform.OS === "web" ? WEB_UI_SANS_STACK : FONT_UI_SANS_REGULAR,
      lineHeight: 22,
    },
  ];

  const onCopy = useCallback(async (text: string) => {
    await Clipboard.setStringAsync(text);
  }, []);

  const onShare = useCallback(
    async (messageId: string) => {
      if (!chatId || busyShareId) return;
      setBusyShareId(messageId);
      try {
        const res = await postAiAgentChatAction({ action: "share", chatId });
        const token = typeof res.shareToken === "string" ? res.shareToken : null;
        if (!res.ok || !token) return;
        await Clipboard.setStringAsync(shareUrlForToken(token));
      } finally {
        setBusyShareId(null);
      }
    },
    [busyShareId, chatId],
  );

  const onLike = useCallback(
    async (message: AiThreadMessage) => {
      if (busyLikeId) return;
      setBusyLikeId(message.id);
      try {
        const res = await postAiAgentChatAction({
          action: "like",
          messageId: message.id,
        });
        if (!res.ok) return;
        const liked = Boolean(res.liked);
        const likeCount = Number(res.likeCount ?? 0);
        onMessagesChange(
          messages.map((m) =>
            m.id === message.id ? { ...m, likedByMe: liked, likeCount } : m,
          ),
        );
      } finally {
        setBusyLikeId(null);
      }
    },
    [busyLikeId, messages, onMessagesChange],
  );

  return (
    <View style={{ paddingTop: 20, gap: 24 }}>
      {messages.map((m) => {
        const isUser = m.role === "user";
        return (
          <View key={m.id} style={{ alignItems: isUser ? "flex-end" : "flex-start" }}>
            {isUser ? (
              <View
                style={{
                  maxWidth: "88%",
                  backgroundColor: colors.undercover,
                  paddingHorizontal: 14,
                  paddingVertical: BUBBLE_PAD_Y,
                  borderRadius: 16,
                }}
              >
                <Text style={bodyStyle}>{m.content}</Text>
              </View>
            ) : (
              <View style={{ width: "100%", maxWidth: "100%" }}>
                <Text style={bodyStyle}>{m.content}</Text>
                {showActions ? (
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: ICON_GAP,
                    marginTop: 10,
                  }}
                >
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t("ai.agents.copy")}
                    hitSlop={8}
                    onPress={() => void onCopy(m.content)}
                  >
                    <CopyIcon color={colors.secondary} />
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t("ai.agents.share")}
                    hitSlop={8}
                    disabled={busyShareId === m.id}
                    onPress={() => void onShare(m.id)}
                  >
                    <ShareIcon color={colors.secondary} />
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t("ai.agents.like")}
                    hitSlop={8}
                    disabled={busyLikeId === m.id}
                    onPress={() => void onLike(m)}
                  >
                    <LikeIcon color={colors.secondary} filled={Boolean(m.likedByMe)} />
                  </Pressable>
                </View>
                ) : null}
              </View>
            )}
          </View>
        );
      })}
      {sending ? (
        <View style={{ paddingVertical: 8 }}>
          <ActivityIndicator color={colors.secondary} />
        </View>
      ) : null}
    </View>
  );
}
