import { useEffect, useRef } from "react";
import { buildApiUrl } from "../../../api/_base";
import { logPageDisplay } from "../../pageDisplayLog";
import type { TelegramChatVoiceParticipant } from "../../telegram/fetchTelegramChatVoiceParticipants";
import type { VoiceParticipantsStreamSnapshot } from "./useTelegramVoiceParticipantsStream";

type Options = {
  enabled: boolean;
  chatId: number;
  groupCallId: number | null;
  getSinceRevision: () => number | null;
  onParticipants: (snapshot: VoiceParticipantsStreamSnapshot) => void;
  onStreamActiveChange?: (active: boolean) => void;
};

const STREAM_RECONNECT_MS = 3_000;

function parseParticipantsPayload(raw: string): VoiceParticipantsStreamSnapshot | null {
  try {
    const data = JSON.parse(raw) as {
      revision?: number;
      participant_count?: number;
      participants?: unknown;
      group_call_id?: unknown;
    };
    const revision = Number(data.revision);
    if (!Number.isFinite(revision) || revision < 0) return null;
    const participants = Array.isArray(data.participants)
      ? data.participants
          .map((row) => {
            if (!row || typeof row !== "object" || Array.isArray(row)) return null;
            const item = row as Record<string, unknown>;
            const userId = Number(item.user_id);
            const chatIdRaw = Number(item.chat_id);
            const isSpeaking = Boolean(item.is_speaking);
            return {
              user_id: Number.isFinite(userId) && userId > 0 ? Math.trunc(userId) : null,
              chat_id:
                Number.isFinite(chatIdRaw) && chatIdRaw !== 0 ? Math.trunc(chatIdRaw) : null,
              title: typeof item.title === "string" ? item.title : "",
              description: typeof item.description === "string" ? item.description : "",
              emoji_status_custom_emoji_id:
                typeof item.emoji_status_custom_emoji_id === "string" &&
                item.emoji_status_custom_emoji_id.trim()
                  ? item.emoji_status_custom_emoji_id.trim()
                  : null,
              is_speaking: isSpeaking,
              is_muted: isSpeaking ? false : Boolean(item.is_muted),
              is_self: Boolean(item.is_self),
            } satisfies TelegramChatVoiceParticipant;
          })
          .filter((row): row is TelegramChatVoiceParticipant => row != null)
      : [];
    const groupCallId = Number(data.group_call_id);
    return {
      revision: Math.trunc(revision),
      participant_count: Number.isFinite(Number(data.participant_count))
        ? Math.trunc(Number(data.participant_count))
        : participants.length,
      participants,
      group_call_id:
        Number.isFinite(groupCallId) && groupCallId > 0 ? Math.trunc(groupCallId) : null,
    };
  } catch {
    return null;
  }
}

/** SSE push from gateway — speaking/roster updates without hot polling. */
export function useTelegramVoiceParticipantsStream(options: Options): void {
  const { enabled, chatId, groupCallId, getSinceRevision, onParticipants, onStreamActiveChange } =
    options;
  const onParticipantsRef = useRef(onParticipants);
  const getSinceRevisionRef = useRef(getSinceRevision);
  const onStreamActiveChangeRef = useRef(onStreamActiveChange);

  useEffect(() => {
    onParticipantsRef.current = onParticipants;
  }, [onParticipants]);

  useEffect(() => {
    getSinceRevisionRef.current = getSinceRevision;
  }, [getSinceRevision]);

  useEffect(() => {
    onStreamActiveChangeRef.current = onStreamActiveChange;
  }, [onStreamActiveChange]);

  useEffect(() => {
    if (!enabled || !Number.isFinite(chatId) || chatId === 0 || typeof EventSource === "undefined") {
      onStreamActiveChangeRef.current?.(false);
      return;
    }

    let cancelled = false;
    let eventSource: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let streamActive = false;

    const setActive = (active: boolean) => {
      if (streamActive === active) return;
      streamActive = active;
      onStreamActiveChangeRef.current?.(active);
    };

    const connect = () => {
      if (cancelled) return;
      eventSource?.close();
      setActive(false);

      const params = new URLSearchParams({ chat_id: String(Math.trunc(chatId)) });
      if (groupCallId != null && groupCallId > 0) {
        params.set("group_call_id", String(Math.trunc(groupCallId)));
      }
      const sinceRevision = getSinceRevisionRef.current();
      if (sinceRevision != null && sinceRevision > 0) {
        params.set("since_revision", String(sinceRevision));
      }
      const url = buildApiUrl(
        `/api/telegram-messages-voice-participants-stream?${params.toString()}`,
      );

      eventSource = new EventSource(url);
      logPageDisplay("messages_voice_participants_stream_connect", {
        chatId,
        groupCallId,
        sinceRevision: sinceRevision ?? null,
      });

      const applyEvent = (event: Event) => {
        const snap = parseParticipantsPayload((event as MessageEvent).data);
        if (!snap) return;
        setActive(true);
        onParticipantsRef.current(snap);
      };

      eventSource.addEventListener("ready", (event) => {
        applyEvent(event);
        logPageDisplay("messages_voice_participants_stream_ready", {
          chatId,
          groupCallId,
          dataChars: String((event as MessageEvent).data ?? "").length,
        });
      });

      eventSource.addEventListener("participants", (event) => {
        const snap = parseParticipantsPayload((event as MessageEvent).data);
        if (!snap) return;
        setActive(true);
        const speakingCount = snap.participants.filter((p) => p.is_speaking).length;
        if (speakingCount > 0) {
          logPageDisplay("messages_voice_participants_speaking", {
            chatId,
            groupCallId: snap.group_call_id,
            speakingCount,
            revision: snap.revision,
          });
        }
        onParticipantsRef.current(snap);
      });

      eventSource.onerror = () => {
        eventSource?.close();
        eventSource = null;
        setActive(false);
        if (cancelled) return;
        if (reconnectTimer != null) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connect, STREAM_RECONNECT_MS);
      };
    };

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer != null) clearTimeout(reconnectTimer);
      eventSource?.close();
      setActive(false);
    };
  }, [enabled, chatId, groupCallId]);
}
