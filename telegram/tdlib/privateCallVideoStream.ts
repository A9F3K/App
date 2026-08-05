import type http from "http";
import { URL } from "url";
import { WebSocketServer } from "ws";
import { attachPrivateCallVideoClient } from "./privateCallVideoBridge.js";
import { logGateway } from "./gatewayLog.js";
import { verifyStreamTicket } from "./streamTicket.js";

export function attachPrivateCallVideoWebSocket(server: http.Server): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    try {
      if (!req.url) {
        return;
      }
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname !== "/v1/call/video/stream") {
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
        stream: "private_call_video",
        callId,
      });
      if (!ticket) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        attachPrivateCallVideoClient(ws, ticket.sub, callId);
        logGateway("private_call_video_ws_open", {
          telegramUsername: ticket.sub,
          callId,
        });
      });
    } catch {
      socket.destroy();
    }
  });
}
