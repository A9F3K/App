import type { WebSocket } from "ws";
import { logGateway } from "./gatewayLog.js";

export const PRIVATE_CALL_AUDIO_SAMPLE_RATE = 48_000;
export const PRIVATE_CALL_AUDIO_FRAME_SAMPLES = 480;
export const PRIVATE_CALL_AUDIO_FRAME_BYTES = PRIVATE_CALL_AUDIO_FRAME_SAMPLES * 2;

type AudioClient = {
  ws: WebSocket;
};

const clientsByCallKey = new Map<string, AudioClient[]>();

function callKey(telegramUsername: string, callId: number): string {
  return `${telegramUsername}:${Math.trunc(callId)}`;
}

export function attachPrivateCallAudioClient(
  ws: WebSocket,
  telegramUsername: string,
  callId: number,
): void {
  const key = callKey(telegramUsername, callId);
  const client: AudioClient = { ws };
  const list = clientsByCallKey.get(key) ?? [];
  list.push(client);
  clientsByCallKey.set(key, list);

  ws.on("message", (data, isBinary) => {
    if (!isBinary) return;
    const pcm = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
    void import("./privateCallMedia.js").then(({ pushInboundPrivateCallAudio }) =>
      pushInboundPrivateCallAudio(telegramUsername, callId, pcm),
    );
  });

  ws.on("close", () => {
    const remaining = (clientsByCallKey.get(key) ?? []).filter((c) => c.ws !== ws);
    if (remaining.length > 0) clientsByCallKey.set(key, remaining);
    else clientsByCallKey.delete(key);
    logGateway("private_call_audio_ws_close", { telegramUsername, callId });
  });

  ws.on("error", () => {
    ws.close();
  });
}

export function pushRemoteAudioToBrowsers(
  telegramUsername: string,
  callId: number,
  pcm: Buffer,
): void {
  if (pcm.length === 0) return;
  const key = callKey(telegramUsername, callId);
  for (const client of clientsByCallKey.get(key) ?? []) {
    if (client.ws.readyState !== 1) continue;
    try {
      client.ws.send(pcm, { binary: true });
    } catch {
      // drop frame on backpressure / closed socket
    }
  }
}

export function hasPrivateCallAudioClients(
  telegramUsername: string,
  callId: number,
): boolean {
  return (clientsByCallKey.get(callKey(telegramUsername, callId))?.length ?? 0) > 0;
}

export function detachPrivateCallAudioClients(
  telegramUsername: string,
  callId: number,
): void {
  const key = callKey(telegramUsername, callId);
  for (const client of clientsByCallKey.get(key) ?? []) {
    try {
      client.ws.close();
    } catch {
      // ignore
    }
  }
  clientsByCallKey.delete(key);
}
