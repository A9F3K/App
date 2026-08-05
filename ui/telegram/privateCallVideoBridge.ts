import { buildApiUrl } from "../../api/_base";
import type { TelegramRemoteVideoSource } from "./telegramGroupCallWebSession";

const VIDEO_MAX_WIDTH = 640;
const VIDEO_MAX_HEIGHT = 360;
const VIDEO_FPS = 12;
const FRAME_INTERVAL_MS = Math.round(1000 / VIDEO_FPS);

export type PrivateCallVideoBridge = {
  setLocalCameraStream: (stream: MediaStream | null) => void;
  setLocalScreenStream: (stream: MediaStream | null) => void;
  stop: () => void;
};

type VideoDevice = "camera" | "screen";

async function mintPrivateCallVideoWsUrl(
  callId: number,
  signal?: AbortSignal,
): Promise<{ ok: true; wsUrl: string } | { ok: false; error: string }> {
  const params = new URLSearchParams({
    stream: "private_call_video",
    call_id: String(Math.trunc(callId)),
  });
  try {
    const response = await fetch(
      buildApiUrl(`/api/telegram-messages-stream-ticket?${params.toString()}`),
      { method: "GET", credentials: "include", signal },
    );
    const json = (await response.json().catch(() => null)) as
      | { ok?: boolean; wsUrl?: string; url?: string; error?: string }
      | null;
    const wsUrl =
      typeof json?.wsUrl === "string" && json.wsUrl.trim()
        ? json.wsUrl.trim()
        : typeof json?.url === "string" && json.url.trim()
          ? json.url.replace(/^http/i, "ws")
          : "";
    if (!response.ok || !json?.ok || !wsUrl) {
      return { ok: false, error: json?.error ?? "stream_ticket_unavailable" };
    }
    return { ok: true, wsUrl };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ok: false, error: "aborted" };
    }
    return {
      ok: false,
      error: err instanceof Error ? err.message : "stream_ticket_failed",
    };
  }
}

function even(n: number): number {
  const v = Math.max(2, Math.trunc(n));
  return v & 1 ? v - 1 : v;
}

function fitSize(srcW: number, srcH: number): { width: number; height: number } {
  if (srcW <= 0 || srcH <= 0) return { width: 320, height: 180 };
  const scale = Math.min(1, VIDEO_MAX_WIDTH / srcW, VIDEO_MAX_HEIGHT / srcH);
  return {
    width: even(srcW * scale),
    height: even(srcH * scale),
  };
}

function rgbaToI420(rgba: Uint8ClampedArray, width: number, height: number): Uint8Array {
  const ySize = width * height;
  const uvSize = (width * height) / 4;
  const out = new Uint8Array(ySize + uvSize * 2);
  let yOff = 0;
  let uOff = ySize;
  let vOff = ySize + uvSize;
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const i = (row * width + col) * 4;
      const r = rgba[i] ?? 0;
      const g = rgba[i + 1] ?? 0;
      const b = rgba[i + 2] ?? 0;
      out[yOff++] = ((66 * r + 129 * g + 25 * b + 128) >> 8) + 16;
      if ((row & 1) === 0 && (col & 1) === 0) {
        out[uOff++] = ((-38 * r - 74 * g + 112 * b + 128) >> 8) + 128;
        out[vOff++] = ((112 * r - 94 * g - 18 * b + 128) >> 8) + 128;
      }
    }
  }
  return out;
}

function i420ToRgba(i420: Uint8Array, width: number, height: number): Uint8ClampedArray {
  const ySize = width * height;
  const uvSize = ySize / 4;
  const rgba = new Uint8ClampedArray(width * height * 4);
  const uBase = ySize;
  const vBase = ySize + uvSize;
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const y = (i420[row * width + col] ?? 16) - 16;
      const uvIndex = Math.floor(row / 2) * Math.floor(width / 2) + Math.floor(col / 2);
      const u = (i420[uBase + uvIndex] ?? 128) - 128;
      const v = (i420[vBase + uvIndex] ?? 128) - 128;
      const r = Math.max(0, Math.min(255, (298 * y + 409 * v + 128) >> 8));
      const g = Math.max(0, Math.min(255, (298 * y - 100 * u - 208 * v + 128) >> 8));
      const b = Math.max(0, Math.min(255, (298 * y + 516 * u + 128) >> 8));
      const o = (row * width + col) * 4;
      rgba[o] = r;
      rgba[o + 1] = g;
      rgba[o + 2] = b;
      rgba[o + 3] = 255;
    }
  }
  return rgba;
}

function packFrame(
  device: VideoDevice,
  width: number,
  height: number,
  i420: Uint8Array,
): ArrayBuffer {
  const header = new Uint8Array(6);
  header[0] = 0x01;
  header[1] = device === "camera" ? 1 : 2;
  header[2] = (width >> 8) & 0xff;
  header[3] = width & 0xff;
  header[4] = (height >> 8) & 0xff;
  header[5] = height & 0xff;
  const out = new Uint8Array(6 + i420.length);
  out.set(header, 0);
  out.set(i420, 6);
  return out.buffer;
}

function unpackFrame(
  buf: ArrayBuffer,
): { device: VideoDevice; width: number; height: number; i420: Uint8Array } | null {
  if (buf.byteLength < 6) return null;
  const view = new DataView(buf);
  if (view.getUint8(0) !== 0x01) return null;
  const code = view.getUint8(1);
  const device: VideoDevice | null = code === 1 ? "camera" : code === 2 ? "screen" : null;
  if (!device) return null;
  const width = view.getUint16(2);
  const height = view.getUint16(4);
  if (width < 2 || height < 2 || (width & 1) || (height & 1)) return null;
  const expected = (width * height * 3) / 2;
  if (buf.byteLength < 6 + expected) return null;
  return {
    device,
    width,
    height,
    i420: new Uint8Array(buf, 6, expected),
  };
}

type CaptureSlot = {
  stream: MediaStream | null;
  video: HTMLVideoElement | null;
  canvas: HTMLCanvasElement | null;
  timer: ReturnType<typeof setInterval> | null;
};

function createRemotePlayback(): {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  stream: MediaStream;
} {
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 180;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("canvas_2d_unavailable");
  const stream = canvas.captureStream(VIDEO_FPS);
  return { canvas, ctx, stream };
}

/**
 * Browser ↔ gateway I420 video bridge for private-call camera/screencast.
 */
export async function startPrivateCallVideoBridge(input: {
  callId: number;
  signal?: AbortSignal;
  onRemoteSources: (sources: TelegramRemoteVideoSource[]) => void;
}): Promise<PrivateCallVideoBridge | null> {
  if (typeof window === "undefined") return null;
  if (typeof WebSocket === "undefined") return null;
  if (typeof document === "undefined") return null;

  const ticket = await mintPrivateCallVideoWsUrl(input.callId, input.signal);
  if (!ticket.ok) return null;

  let stopped = false;
  const ws = new WebSocket(ticket.wsUrl);
  ws.binaryType = "arraybuffer";

  const cameraSlot: CaptureSlot = { stream: null, video: null, canvas: null, timer: null };
  const screenSlot: CaptureSlot = { stream: null, video: null, canvas: null, timer: null };

  const remoteCamera = createRemotePlayback();
  const remoteScreen = createRemotePlayback();
  let hasRemoteCamera = false;
  let hasRemoteScreen = false;

  const emitRemote = () => {
    const sources: TelegramRemoteVideoSource[] = [];
    if (hasRemoteCamera) {
      sources.push({
        endpointId: "remote-camera",
        kind: "camera",
        stream: remoteCamera.stream,
      });
    }
    if (hasRemoteScreen) {
      sources.push({
        endpointId: "remote-screen",
        kind: "screen",
        stream: remoteScreen.stream,
      });
    }
    input.onRemoteSources(sources);
  };

  const stopSlot = (slot: CaptureSlot) => {
    if (slot.timer) {
      clearInterval(slot.timer);
      slot.timer = null;
    }
    if (slot.video) {
      slot.video.srcObject = null;
      slot.video = null;
    }
    slot.canvas = null;
    slot.stream = null;
  };

  const startCapture = (slot: CaptureSlot, device: VideoDevice, stream: MediaStream) => {
    stopSlot(slot);
    slot.stream = stream;
    const track = stream.getVideoTracks()[0];
    if (!track) return;

    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    void video.play().catch(() => undefined);
    slot.video = video;

    const canvas = document.createElement("canvas");
    slot.canvas = canvas;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;

    slot.timer = setInterval(() => {
      if (stopped || ws.readyState !== WebSocket.OPEN) return;
      const srcW = video.videoWidth || 0;
      const srcH = video.videoHeight || 0;
      if (srcW < 2 || srcH < 2) return;
      const { width, height } = fitSize(srcW, srcH);
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      ctx.drawImage(video, 0, 0, width, height);
      const image = ctx.getImageData(0, 0, width, height);
      const i420 = rgbaToI420(image.data, width, height);
      try {
        ws.send(packFrame(device, width, height, i420));
      } catch {
        // drop
      }
    }, FRAME_INTERVAL_MS);
  };

  ws.onmessage = (event) => {
    const data = event.data;
    const handle = (buf: ArrayBuffer) => {
      const frame = unpackFrame(buf);
      if (!frame) return;
      const target = frame.device === "camera" ? remoteCamera : remoteScreen;
      if (target.canvas.width !== frame.width || target.canvas.height !== frame.height) {
        target.canvas.width = frame.width;
        target.canvas.height = frame.height;
      }
      const rgba = i420ToRgba(frame.i420, frame.width, frame.height);
      const image = new ImageData(rgba, frame.width, frame.height);
      target.ctx.putImageData(image, 0, 0);
      if (frame.device === "camera" && !hasRemoteCamera) {
        hasRemoteCamera = true;
        emitRemote();
      }
      if (frame.device === "screen" && !hasRemoteScreen) {
        hasRemoteScreen = true;
        emitRemote();
      }
    };
    if (data instanceof ArrayBuffer) {
      handle(data);
      return;
    }
    if (data instanceof Blob) {
      void data.arrayBuffer().then((buf) => {
        if (!stopped) handle(buf);
      });
    }
  };

  try {
    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error("private_call_video_ws_failed"));
      };
      const onAbort = () => {
        cleanup();
        reject(new Error("aborted"));
      };
      const cleanup = () => {
        ws.removeEventListener("open", onOpen);
        ws.removeEventListener("error", onError);
        input.signal?.removeEventListener("abort", onAbort);
      };
      ws.addEventListener("open", onOpen);
      ws.addEventListener("error", onError);
      input.signal?.addEventListener("abort", onAbort);
      if (input.signal?.aborted) onAbort();
    });
  } catch {
    try {
      ws.close();
    } catch {
      // ignore
    }
    return null;
  }

  if (stopped) return null;

  function stopEverything(): void {
    if (stopped) return;
    stopped = true;
    stopSlot(cameraSlot);
    stopSlot(screenSlot);
    try {
      ws.close();
    } catch {
      // ignore
    }
    for (const track of remoteCamera.stream.getTracks()) track.stop();
    for (const track of remoteScreen.stream.getTracks()) track.stop();
    input.onRemoteSources([]);
  }

  input.signal?.addEventListener("abort", stopEverything, { once: true });

  return {
    setLocalCameraStream(stream) {
      if (stopped) return;
      if (!stream) {
        stopSlot(cameraSlot);
        return;
      }
      startCapture(cameraSlot, "camera", stream);
    },
    setLocalScreenStream(stream) {
      if (stopped) return;
      if (!stream) {
        stopSlot(screenSlot);
        return;
      }
      startCapture(screenSlot, "screen", stream);
    },
    stop: stopEverything,
  };
}
