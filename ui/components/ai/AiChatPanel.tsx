import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { applyFirstNavigateAction, postAiChat } from "../../../api/aiClient";
import { useAppStrings } from "../../../locales/AppStringsContext";
import { typographySansSemibold, useColors } from "../../theme";

type ChatMessage = {
  role: "user" | "assistant";
  text: string;
};

type Props = {
  initialPrompt?: string;
  screenRoute?: string;
};

export function AiChatPanel({ initialPrompt, screenRoute }: Props) {
  const colors = useColors();
  const { t, locale } = useAppStrings();
  const router = useRouter();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const initialSentRef = useRef(false);

  const sendMessage = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || loading) return;

      setError(null);
      setMessages((prev) => [...prev, { role: "user", text: trimmed }]);
      setLoading(true);

      try {
        const res = await postAiChat(trimmed, {
          route: screenRoute ?? "/",
          locale,
        });

        if (!res.ok) {
          const code = String(res.error ?? "");
          if (code === "ai_capacity" || code === "free_ai_limit" || code === "ai_not_configured") {
            setError(t("ai.capacity.body"));
          } else {
            setError(t("ai.errorGeneric"));
          }
          return;
        }

        if (res.output_text?.trim()) {
          setMessages((prev) => [
            ...prev,
            { role: "assistant", text: res.output_text!.trim() },
          ]);
        }

        applyFirstNavigateAction(router, res.actions);
      } catch {
        setError(t("ai.errorGeneric"));
      } finally {
        setLoading(false);
      }
    },
    [loading, locale, router, screenRoute, t],
  );

  useEffect(() => {
    const text = typeof initialPrompt === "string" ? initialPrompt.trim() : "";
    if (!text || initialSentRef.current) return;
    initialSentRef.current = true;
    void sendMessage(text);
  }, [initialPrompt, sendMessage]);

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <Text style={[styles.title, { color: colors.primary }]}>{t("ai.title")}</Text>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        {messages.length === 0 && !loading ? (
          <Text style={[styles.hint, { color: colors.secondary }]}>{t("ai.noPrompt")}</Text>
        ) : null}
        {messages.map((msg, idx) => (
          <View key={`${msg.role}-${idx}`} style={styles.messageBlock}>
            <Text style={[styles.roleLabel, { color: colors.secondary }]}>
              {msg.role === "user" ? t("ai.you") : t("ai.assistant")}
            </Text>
            <Text style={[styles.messageText, { color: colors.primary }]}>{msg.text}</Text>
          </View>
        ))}
        {loading ? (
          <View style={styles.loadingRow}>
            <ActivityIndicator color={colors.primary} />
            <Text style={[styles.loadingText, { color: colors.secondary }]}>
              {t("ai.thinking")}
            </Text>
          </View>
        ) : null}
        {error ? (
          <Text style={[styles.errorText, { color: colors.accent }]}>{error}</Text>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 16,
  },
  title: {
    ...typographySansSemibold,
    fontSize: 18,
    marginBottom: 12,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: 24,
    gap: 16,
  },
  hint: {
    fontSize: 14,
  },
  messageBlock: {
    gap: 4,
  },
  roleLabel: {
    fontSize: 12,
    fontWeight: "600",
    textTransform: "uppercase",
  },
  messageText: {
    fontSize: 15,
    lineHeight: 22,
  },
  loadingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  loadingText: {
    fontSize: 14,
  },
  errorText: {
    fontSize: 14,
  },
});
