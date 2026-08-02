import type http from "http";
import { logGateway } from "./gatewayLog.js";
import { onVoiceCallMessage } from "./voiceCallMessagesNotify.js";
import {
  getRecentVoiceCallMessages,
  getVoiceCallMessagesRevision,
} from "./voiceCallMessages.js";
import { resolveCachedGroupCallIdForChat } from "./voiceParticipants.js";

const STREAM_HEARTBEAT_MS = 25_000;
/** Direct browser SSE — no Vercel 60s cap; still recycle so clients remint cleanly. */
const STREAM_MAX_MS = 600_000;

function writeSse(res: http.ServerResponse, event: string, data: object): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * SSE stream for in-call group chat messages (TDLib updateNewGroupCallMessage).
 * There is no history API — recent buffered messages are replayed on connect.
 */
export function serveVoiceCallMessagesStream(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  telegramUsername: string,
  chatId: number,
  groupCallId: number | null,
  sinceRevision: number | null,
): void {
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
      messages: [],
    });
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
    logGateway("voice_call_messages_stream_open_pending", {
      telegramUsername,
      chatId,
    });
    return;
  }

  let lastSentRevision =
    sinceRevision != null && Number.isFinite(sinceRevision) ? sinceRevision : 0;
  let closed = false;

  const current = getVoiceCallMessagesRevision(callId);
  const recent = getRecentVoiceCallMessages(callId);
  writeSse(res, "ready", {
    revision: current,
    chat_id: chatId,
    group_call_id: callId,
    messages: recent,
  });
  lastSentRevision = current;

  const unsubscribe = onVoiceCallMessage(callId, (revision, message) => {
    if (closed || revision <= lastSentRevision) return;
    lastSentRevision = revision;
    writeSse(res, "call_message", {
      revision,
      chat_id: chatId,
      group_call_id: callId,
      message,
    });
  });

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
    logGateway("voice_call_messages_stream_closed", {
      telegramUsername,
      chatId,
      groupCallId: callId,
      lastRevision: lastSentRevision,
    });
  };

  req.on("close", cleanup);
  req.on("aborted", cleanup);
  res.on("close", cleanup);

  logGateway("voice_call_messages_stream_open", {
    telegramUsername,
    chatId,
    groupCallId: callId,
    revision: current,
  });
}
