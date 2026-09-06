/**
 * Public shared AI agent chat — view transcript; sign in to claim into your account & continue.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";

import {
  getSharedAiAgentChat,
  postAiAgentChatAction,
} from "../../api/aiAgentChatsClient";
import { useAuth } from "../../auth/AuthContext";
import { useAppStrings } from "../../locales/AppStringsContext";
import { FONT_UI_SANS_REGULAR, WEB_UI_SANS_STACK } from "../../ui/fonts";
import { layout, typographyRect15, useColors } from "../../ui/theme";

const CLAIMED_CHAT_STORAGE_KEY = "hsp_ai_claimed_chat_id";
const SHARE_RETURN_KEY = "hsp_ai_share_return";

type SharedMessage = {
  id: string;
  role: string;
  content: string;
};

export default function AiSharePage() {
  const colors = useColors();
  const { t } = useAppStrings();
  const router = useRouter();
  const { token: tokenParam } = useLocalSearchParams<{ token?: string }>();
  const token = typeof tokenParam === "string" ? tokenParam : "";
  const { isAuthenticated, authReady } = useAuth();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [messages, setMessages] = useState<SharedMessage[]>([]);
  const [claiming, setClaiming] = useState(false);

  useEffect(() => {
    if (!token) {
      setLoading(false);
      setError("not_found");
      return;
    }
    let cancelled = false;
    void (async () => {
      setLoading(true);
      const res = await getSharedAiAgentChat(token);
      if (cancelled) return;
      if (!res.ok || !res.chat) {
        setError(res.error ?? "not_found");
        setLoading(false);
        return;
      }
      setTitle(res.chat.title);
      setMessages(
        (res.messages ?? []).map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
        })),
      );
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const claimAndContinue = useCallback(async () => {
    if (!token || claiming) return;
    setClaiming(true);
    try {
      const res = await postAiAgentChatAction({
        action: "claim_share",
        shareToken: token,
      });
      const chat = res.chat as { id?: string } | undefined;
      if (res.ok && chat?.id && Platform.OS === "web" && typeof sessionStorage !== "undefined") {
        sessionStorage.setItem(CLAIMED_CHAT_STORAGE_KEY, chat.id);
      }
      router.replace("/");
    } finally {
      setClaiming(false);
    }
  }, [claiming, router, token]);

  useEffect(() => {
    if (!authReady || !isAuthenticated || !token || loading || error) return;
    if (Platform.OS === "web" && typeof sessionStorage !== "undefined") {
      const pending = sessionStorage.getItem(SHARE_RETURN_KEY);
      if (pending === token) {
        sessionStorage.removeItem(SHARE_RETURN_KEY);
        void claimAndContinue();
      }
    }
  }, [authReady, isAuthenticated, token, loading, error, claimAndContinue]);

  const onSignInToContinue = useCallback(() => {
    if (Platform.OS === "web" && typeof sessionStorage !== "undefined") {
      sessionStorage.setItem(SHARE_RETURN_KEY, token);
    }
    router.push("/welcome");
  }, [router, token]);

  const bodyStyle = useMemo(
    () => [
      typographyRect15,
      {
        color: colors.primary,
        fontFamily: Platform.OS === "web" ? WEB_UI_SANS_STACK : FONT_UI_SANS_REGULAR,
        lineHeight: 22,
      },
    ],
    [colors.primary],
  );

  if (loading || !authReady) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  if (error) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <Text style={bodyStyle}>{t("ai.share.notFound")}</Text>
      </View>
    );
  }

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { borderBottomColor: colors.highlight }]}>
        <Text style={[styles.title, { color: colors.primary }]} numberOfLines={1}>
          {title || t("ai.agents.newAgent")}
        </Text>
        <Text style={[typographyRect15, { color: colors.secondary, marginTop: 4 }]}>
          {t("ai.share.readonlyHint")}
        </Text>
      </View>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingHorizontal: layout.contentSideInsetPx,
          paddingVertical: 20,
          gap: 20,
        }}
      >
        {messages.map((m) => {
          const isUser = m.role === "user";
          return (
            <View
              key={m.id}
              style={{ alignItems: isUser ? "flex-end" : "flex-start" }}
            >
              {isUser ? (
                <View
                  style={{
                    maxWidth: "88%",
                    backgroundColor: colors.undercover,
                    paddingHorizontal: 14,
                    paddingVertical: 10,
                    borderRadius: 16,
                  }}
                >
                  <Text style={bodyStyle}>{m.content}</Text>
                </View>
              ) : (
                <Text style={bodyStyle}>{m.content}</Text>
              )}
            </View>
          );
        })}
      </ScrollView>
      <View style={[styles.footer, { borderTopColor: colors.highlight }]}>
        {isAuthenticated ? (
          <Pressable
            onPress={() => void claimAndContinue()}
            disabled={claiming}
            style={[styles.cta, { borderColor: colors.highlight }]}
          >
            <Text style={[typographyRect15, { color: colors.primary }]}>
              {claiming ? t("common.loading") : t("ai.share.continueInApp")}
            </Text>
          </Pressable>
        ) : (
          <Pressable
            onPress={onSignInToContinue}
            style={[styles.cta, { borderColor: colors.highlight }]}
          >
            <Text style={[typographyRect15, { color: colors.primary }]}>
              {t("ai.share.signInToContinue")}
            </Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, minHeight: 0 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  header: {
    paddingHorizontal: layout.contentSideInsetPx,
    paddingVertical: 16,
    borderBottomWidth: 1,
  },
  title: {
    fontFamily: Platform.OS === "web" ? WEB_UI_SANS_STACK : FONT_UI_SANS_REGULAR,
    fontSize: 18,
    fontWeight: "600",
  },
  footer: {
    borderTopWidth: 1,
    padding: layout.contentSideInsetPx,
  },
  cta: {
    borderWidth: 1,
    paddingVertical: 12,
    alignItems: "center",
  },
});
