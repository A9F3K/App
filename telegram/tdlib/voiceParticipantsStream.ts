import type http from "http";
import { logGateway } from "./gatewayLog.js";
import { onVoiceParticipantsRevision } from "./voiceParticipantsNotify.js";
import {
  getVoiceParticipantsRevision,
  getVoiceParticipantsStreamSnapshot,
  resolveCachedGroupCallIdForChat,
} from "./voiceParticipants.js";

const STREAM_HEARTBEAT_MS = 25_000;
const STREAM_MAX_MS = 55_000;

function writeSse(res: http.ServerResponse, event: string, data: object): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * SSE stream: pushes participant snapshots (incl. speaking) when the call roster
 * revision advances. Clients apply the payload immediately — no extra GET.
 */
export function serveVoiceParticipantsStream(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  telegramUsername: string,
  chatId: number,
  groupCallId: number | null,
  sinceRevision: number | null,
): void {
  // Only stream a call id verified by a live participants fetch. Client-preferred
  // ids are often stale after a call ends or when switching chats.
  const callId = resolveCachedGroupCallIdForChat(chatId, groupCallId);

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  if (callId == null) {
    writeSse(res, "ready", {
      revision: 0,
      chat_id: chatId,
      group_call_id: null,
      participant_count: 0,
      participants: [],
    });
    // Keep the connection briefly so the client can reconnect after join resolves
    // the call id (first participants GET maps chat → call).
    const reopen = setTimeout(() => {
      writeSse(res, "reconnect", { reason: "no_group_call_yet" });
      res.end();
    }, 8_000);
    const cleanupEarly = (): void => {
      clearTimeout(reopen);
    };
    req.on("close", cleanupEarly);
    req.on("aborted", cleanupEarly);
    res.on("close", cleanupEarly);
    logGateway("voice_participants_stream_open_pending", {
      telegramUsername,
      chatId,
    });
    return;
  }

  let lastSentRevision =
    sinceRevision != null && Number.isFinite(sinceRevision) ? sinceRevision : 0;
  let closed = false;

  const pushSnapshot = (revision: number): void => {
    if (closed || revision <= lastSentRevision) return;
    lastSentRevision = revision;
    const snap = getVoiceParticipantsStreamSnapshot(callId);
    writeSse(res, "participants", {
      revision: snap.revision,
      chat_id: chatId,
      group_call_id: callId,
      participant_count: snap.participant_count,
      participants: snap.participants,
    });
  };

  const current = getVoiceParticipantsRevision(callId);
  if (current > lastSentRevision) {
    pushSnapshot(current);
  } else {
    const snap = getVoiceParticipantsStreamSnapshot(callId);
    writeSse(res, "ready", {
      revision: snap.revision,
      chat_id: chatId,
      group_call_id: callId,
      participant_count: snap.participant_count,
      participants: snap.participants,
    });
    lastSentRevision = snap.revision;
  }

  const unsubscribe = onVoiceParticipantsRevision(callId, pushSnapshot);
  const heartbeat = setInterval(() => {
    if (closed) return;
    writeSse(res, "ping", { t: Date.now() });
  }, STREAM_HEARTBEAT_MS);
  const maxLifetime = setTimeout(() => {
    if (closed) return;
    writeSse(res, "reconnect", { reason: "max_duration" });
    res.end();
  }, STREAM_MAX_MS);

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    clearTimeout(maxLifetime);
    unsubscribe();
    logGateway("voice_participants_stream_closed", {
      telegramUsername,
      chatId,
      groupCallId: callId,
      lastRevision: lastSentRevision,
    });
  };

  req.on("close", cleanup);
  req.on("aborted", cleanup);
  res.on("close", cleanup);

  logGateway("voice_participants_stream_open", {
    telegramUsername,
    chatId,
    groupCallId: callId,
    sinceRevision: lastSentRevision,
    currentRevision: current,
  });
}
