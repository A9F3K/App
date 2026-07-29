import { useEffect, useRef } from "react";
import { buildApiUrl } from "../../../api/_base";
import { logPageDisplay } from "../../pageDisplayLog";
import {
  parseTelegramVoiceCallMessage,
  type TelegramVoiceCallMessage,
} from "../../telegram/sendTelegramChatVoiceCallMessage";

type Options = {
  enabled: boolean;
  chatId: number;
  groupCallId: number | null;
  getSinceRevision: () => number | null;
  onReadyMessages: (messages: TelegramVoiceCallMessage[], revision: number) => void;
  onMessage: (message: TelegramVoiceCallMessage, revision: number) => void;
};

const STREAM_RECONNECT_MS = 3_000;

/**
 * SSE for TDLib updateNewGroupCallMessage — in-call ephemeral chat overlays.
 */
export function useTelegramVoiceCallMessagesStream({
  enabled,
  chatId,
  groupCallId,
  getSinceRevision,
  onReadyMessages,
  onMessage,
}: Options): void {
  const getSinceRevisionRef = useRef(getSinceRevision);
  getSinceRevisionRef.current = getSinceRevision;
  const onReadyRef = useRef(onReadyMessages);
  onReadyRef.current = onReadyMessages;
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  useEffect(() => {
    if (!enabled || !Number.isFinite(chatId) || chatId === 0) return;
    if (typeof EventSource === "undefined") return;

    let closed = false;
    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const open = () => {
      if (closed) return;
      const params = new URLSearchParams({
        chat_id: String(Math.trunc(chatId)),
      });
      if (groupCallId != null && groupCallId > 0) {
        params.set("group_call_id", String(groupCallId));
      }
      const since = getSinceRevisionRef.current();
      if (since != null && since > 0) {
        params.set("since_revision", String(since));
      }
      const url = buildApiUrl(
        `/api/telegram-messages-voice-call-messages-stream?${params.toString()}`,
      );
      es = new EventSource(url, { withCredentials: true });

      es.addEventListener("ready", (event) => {
        try {
          const data = JSON.parse((event as MessageEvent).data) as {
            revision?: number;
            messages?: unknown;
          };
          const revision = Number(data.revision);
          const messages = Array.isArray(data.messages)
            ? data.messages
                .map((row) => parseTelegramVoiceCallMessage(row))
                .filter((row): row is TelegramVoiceCallMessage => row != null)
            : [];
          onReadyRef.current(
            messages,
            Number.isFinite(revision) && revision >= 0 ? revision : 0,
          );
        } catch {
          /* ignore malformed */
        }
      });

      es.addEventListener("call_message", (event) => {
        try {
          const data = JSON.parse((event as MessageEvent).data) as {
            revision?: number;
            message?: unknown;
          };
          const row = parseTelegramVoiceCallMessage(data.message);
          if (!row) return;
          const revision = Number(data.revision);
          onMessageRef.current(
            row,
            Number.isFinite(revision) && revision >= 0 ? revision : 0,
          );
        } catch {
          /* ignore malformed */
        }
      });

      es.addEventListener("reconnect", () => {
        es?.close();
        es = null;
        if (closed) return;
        reconnectTimer = setTimeout(open, STREAM_RECONNECT_MS);
      });

      es.onerror = () => {
        es?.close();
        es = null;
        if (closed) return;
        reconnectTimer = setTimeout(open, STREAM_RECONNECT_MS);
        logPageDisplay("messages_voice_call_messages_stream_error", {
          chatId,
          groupCallId,
          level: "warn",
        });
      };
    };

    open();

    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      es?.close();
    };
  }, [enabled, chatId, groupCallId]);
}
