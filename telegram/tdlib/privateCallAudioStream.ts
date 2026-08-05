import type http from "http";
import { URL } from "url";
import { WebSocketServer } from "ws";
import { attachPrivateCallAudioClient } from "./privateCallAudioBridge.js";
import { logGateway } from "./gatewayLog.js";
import { verifyStreamTicket } from "./streamTicket.js";

export function attachPrivateCallAudioWebSocket(server: http.Server): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    try {
      if (!req.url) {
        socket.destroy();
        return;
      }
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname !== "/v1/call/audio/stream") {
        socket.destroy();
        return;
      }
      const token = (url.searchParams.get("streamTicket") || "").trim();
      const callIdRaw = Number(url.searchParams.get("callId"));
      const callId =
        Number.isFinite(callIdRaw) && callIdRaw > 0 ? Math.trunc(callIdRaw) : null;
      if (!token || callId == null) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      const ticket = verifyStreamTicket(token, {
        stream: "private_call_audio",
        callId,
      });
      if (!ticket) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        attachPrivateCallAudioClient(ws, ticket.sub, callId);
        logGateway("private_call_audio_ws_open", {
          telegramUsername: ticket.sub,
          callId,
        });
      });
    } catch {
      socket.destroy();
    }
  });
}
