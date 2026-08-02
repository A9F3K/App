import { useEffect, useRef } from "react";
import { logPageDisplay } from "../../pageDisplayLog";
import type { TelegramChatVoiceParticipant } from "../../telegram/fetchTelegramChatVoiceParticipants";
import { resolveTelegramLiveStreamUrl } from "../../telegram/resolveTelegramLiveStreamUrl";
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

function parseStreamVideoInfo(
  raw: unknown,
): TelegramChatVoiceParticipant["video_info"] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;
  const endpoint =
    typeof item.endpoint_id === "string" ? item.endpoint_id.trim() : "";
  const groups = Array.isArray(item.source_groups) ? item.source_groups : [];
  const sourceGroups = groups
    .map((group) => {
      if (!group || typeof group !== "object" || Array.isArray(group)) return null;
      const g = group as Record<string, unknown>;
      const semantics =
        typeof g.semantics === "string" && g.semantics.trim() ? g.semantics.trim() : "";
      const sourceIds = Array.isArray(g.source_ids)
        ? g.source_ids
            .map((id) => Number(id))
            .filter((id) => Number.isFinite(id) && id !== 0)
            .map((id) => Math.trunc(id))
        : [];
      if (!semantics || sourceIds.length === 0) return null;
      return { semantics, source_ids: sourceIds };
    })
    .filter((group): group is { semantics: string; source_ids: number[] } => group != null);
  if (!endpoint && sourceGroups.length === 0) return null;
  return { endpoint_id: endpoint, source_groups: sourceGroups };
}

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
          .map((row): TelegramChatVoiceParticipant | null => {
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
              is_muted: Boolean(item.is_muted),
              can_unmute_self:
                item.can_unmute_self == null ? true : Boolean(item.can_unmute_self),
              is_self: Boolean(item.is_self),
              order: typeof item.order === "string" ? item.order : "",
              volume_percent: (() => {
                const n = Number(item.volume_percent);
                if (!Number.isFinite(n)) return undefined;
                return Math.min(200, Math.max(0, Math.round(n)));
              })(),
              video_info: parseStreamVideoInfo(item.video_info),
              screen_sharing_video_info: parseStreamVideoInfo(item.screen_sharing_video_info),
            };
          })
          .filter((row): row is TelegramChatVoiceParticipant => row != null)
      : [];
    const groupCallId = Number(data.group_call_id);
    return {
      revision: Math.trunc(revision),
      participant_count: Number.isFinite(Number(data.participant_count))
        ? Math.max(Math.trunc(Number(data.participant_count)), participants.length)
        : participants.length,
      participants,
      group_call_id:
        Number.isFinite(groupCallId) && groupCallId > 0 ? Math.trunc(groupCallId) : null,
    };
  } catch {
    return null;
  }
}

/** SSE push — prefers direct gateway; falls back to Vercel proxy. */
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
    let mintAbort: AbortController | null = null;
    let streamActive = false;

    const setActive = (active: boolean) => {
      if (streamActive === active) return;
      streamActive = active;
      onStreamActiveChangeRef.current?.(active);
    };

    const connect = () => {
      if (cancelled) return;
      eventSource?.close();
      mintAbort?.abort();
      mintAbort = new AbortController();
      setActive(false);

      const proxyParams = new URLSearchParams({ chat_id: String(Math.trunc(chatId)) });
      if (groupCallId != null && groupCallId > 0) {
        proxyParams.set("group_call_id", String(Math.trunc(groupCallId)));
      }
      const sinceRevision = getSinceRevisionRef.current();
      if (sinceRevision != null && sinceRevision > 0) {
        proxyParams.set("since_revision", String(sinceRevision));
      }
      const proxyPath = `/api/telegram-messages-voice-participants-stream?${proxyParams.toString()}`;

      void resolveTelegramLiveStreamUrl({
        stream: "voice_participants",
        proxyPath,
        chatId,
        groupCallId,
        sinceRevision,
        signal: mintAbort.signal,
      }).then(({ url, mode }) => {
        if (cancelled) return;
        eventSource = new EventSource(url);
        logPageDisplay("messages_voice_participants_stream_connect", {
          chatId,
          groupCallId,
          sinceRevision: sinceRevision ?? null,
          mode,
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
            mode,
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
      });
    };

    connect();

    return () => {
      cancelled = true;
      mintAbort?.abort();
      if (reconnectTimer != null) clearTimeout(reconnectTimer);
      eventSource?.close();
      setActive(false);
    };
  }, [enabled, chatId, groupCallId]);
}
