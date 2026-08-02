import type http from "http";
import { logGateway } from "./gatewayLog.js";
import {
  getLiveChatMessageRevision,
  onLiveChatMessageRevision,
} from "./liveChatMessageRevisionNotify.js";

const STREAM_HEARTBEAT_MS = 25_000;
/** Direct browser SSE — no Vercel 60s cap; still recycle so clients remint cleanly. */
const STREAM_MAX_MS = 600_000;

function writeSse(res: http.ServerResponse, event: string, data: object): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** SSE stream: pushes `{ revision }` when open-chat message history advances. */
export function serveLiveChatMessageRevisionStream(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  telegramUsername: string,
  chatId: number,
  sinceRevision: number | null,
): void {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  let lastSentRevision =
    sinceRevision != null && Number.isFinite(sinceRevision) ? sinceRevision : 0;
  let closed = false;

  const pushIfNewer = (revision: number): void => {
    if (closed || revision <= lastSentRevision) return;
    lastSentRevision = revision;
    writeSse(res, "revision", { revision, chat_id: chatId });
  };

  const current = getLiveChatMessageRevision(telegramUsername, chatId);
  if (current > lastSentRevision) {
    pushIfNewer(current);
  } else {
    writeSse(res, "ready", { revision: lastSentRevision, chat_id: chatId });
  }

  const unsubscribe = onLiveChatMessageRevision(telegramUsername, chatId, pushIfNewer);
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
    logGateway("chat_messages_stream_closed", {
      telegramUsername,
      chatId,
      lastRevision: lastSentRevision,
    });
  };

  req.on("close", cleanup);
  req.on("aborted", cleanup);
  res.on("close", cleanup);

  logGateway("chat_messages_stream_open", {
    telegramUsername,
    chatId,
    sinceRevision: lastSentRevision,
    currentRevision: current,
  });
}
