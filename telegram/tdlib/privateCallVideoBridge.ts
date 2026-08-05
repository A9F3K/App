import type { WebSocket } from "ws";
import { logGateway } from "./gatewayLog.js";

export const PRIVATE_CALL_VIDEO_MAX_WIDTH = 640;
export const PRIVATE_CALL_VIDEO_MAX_HEIGHT = 360;
export const PRIVATE_CALL_VIDEO_FPS = 12;

export type PrivateCallVideoDevice = "camera" | "screen";

type VideoClient = {
  ws: WebSocket;
};

const clientsByCallKey = new Map<string, VideoClient[]>();

function callKey(telegramUsername: string, callId: number): string {
  return `${telegramUsername}:${Math.trunc(callId)}`;
}

export function wireDeviceCode(device: PrivateCallVideoDevice): number {
  return device === "camera" ? 1 : 2;
}

export function parseDeviceCode(code: number): PrivateCallVideoDevice | null {
  if (code === 1) return "camera";
  if (code === 2) return "screen";
  return null;
}

/** Binary frame: magic(1) device(1) width(u16be) height(u16be) + I420 payload. */
export function packPrivateCallVideoFrame(
  device: PrivateCallVideoDevice,
  width: number,
  height: number,
  i420: Buffer,
): Buffer {
  const header = Buffer.alloc(6);
  header[0] = 0x01;
  header[1] = wireDeviceCode(device);
  header.writeUInt16BE(width, 2);
  header.writeUInt16BE(height, 4);
  return Buffer.concat([header, i420]);
}

export function unpackPrivateCallVideoFrame(
  packet: Buffer,
): { device: PrivateCallVideoDevice; width: number; height: number; i420: Buffer } | null {
  if (packet.length < 6) return null;
  if (packet[0] !== 0x01) return null;
  const device = parseDeviceCode(packet[1] ?? 0);
  if (!device) return null;
  const width = packet.readUInt16BE(2);
  const height = packet.readUInt16BE(4);
  if (width < 2 || height < 2 || width > 1920 || height > 1080) return null;
  if ((width & 1) !== 0 || (height & 1) !== 0) return null;
  const expected = (width * height * 3) / 2;
  const i420 = packet.subarray(6);
  if (i420.length < expected) return null;
  return { device, width, height, i420: i420.subarray(0, expected) };
}

export function attachPrivateCallVideoClient(
  ws: WebSocket,
  telegramUsername: string,
  callId: number,
): void {
  const key = callKey(telegramUsername, callId);
  const client: VideoClient = { ws };
  const list = clientsByCallKey.get(key) ?? [];
  list.push(client);
  clientsByCallKey.set(key, list);

  ws.on("message", (data, isBinary) => {
    if (!isBinary) return;
    const packet = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
    const frame = unpackPrivateCallVideoFrame(packet);
    if (!frame) return;
    void import("./privateCallMedia.js").then(({ pushInboundPrivateCallVideo }) =>
      pushInboundPrivateCallVideo(
        telegramUsername,
        callId,
        frame.device,
        frame.width,
        frame.height,
        frame.i420,
      ),
    );
  });

  ws.on("close", () => {
    const remaining = (clientsByCallKey.get(key) ?? []).filter((c) => c.ws !== ws);
    if (remaining.length > 0) clientsByCallKey.set(key, remaining);
    else clientsByCallKey.delete(key);
    logGateway("private_call_video_ws_close", { telegramUsername, callId });
  });

  ws.on("error", () => {
    ws.close();
  });
}

export function pushRemoteVideoToBrowsers(
  telegramUsername: string,
  callId: number,
  device: PrivateCallVideoDevice,
  width: number,
  height: number,
  i420: Buffer,
): void {
  if (i420.length === 0 || width < 2 || height < 2) return;
  const packet = packPrivateCallVideoFrame(device, width, height, i420);
  const key = callKey(telegramUsername, callId);
  for (const client of clientsByCallKey.get(key) ?? []) {
    if (client.ws.readyState !== 1) continue;
    try {
      client.ws.send(packet, { binary: true });
    } catch {
      // drop on backpressure
    }
  }
}

export function hasPrivateCallVideoClients(
  telegramUsername: string,
  callId: number,
): boolean {
  return (clientsByCallKey.get(callKey(telegramUsername, callId))?.length ?? 0) > 0;
}

export function detachPrivateCallVideoClients(
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
