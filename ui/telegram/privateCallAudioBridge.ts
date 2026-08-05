import { buildApiUrl } from "../../api/_base";
import { getVoiceAutoplayAudioContext, unlockVoiceAutoplay } from "./unlockVoiceAutoplay";

const SAMPLE_RATE = 48_000;
const FRAME_SAMPLES = 480;
const FRAME_BYTES = FRAME_SAMPLES * 2;

export type PrivateCallAudioBridge = {
  setMicEnabled: (enabled: boolean) => void;
  stop: () => void;
};

async function mintPrivateCallAudioWsUrl(
  callId: number,
  signal?: AbortSignal,
): Promise<{ ok: true; wsUrl: string } | { ok: false; error: string }> {
  const params = new URLSearchParams({
    stream: "private_call_audio",
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

function floatToInt16(input: Float32Array, output: Int16Array): void {
  for (let i = 0; i < output.length; i++) {
    const sample = input[i] ?? 0;
    const clamped = sample < -1 ? -1 : sample > 1 ? 1 : sample;
    output[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
}

/**
 * Bidirectional PCM bridge: browser mic/speaker ↔ gateway ntgcalls external frames.
 */
export async function startPrivateCallAudioBridge(input: {
  callId: number;
  micEnabled?: boolean;
  signal?: AbortSignal;
}): Promise<PrivateCallAudioBridge | null> {
  if (typeof window === "undefined") return null;
  if (typeof WebSocket === "undefined") return null;
  if (typeof AudioContext === "undefined") return null;
  if (!navigator.mediaDevices?.getUserMedia) return null;

  unlockVoiceAutoplay();

  const ticket = await mintPrivateCallAudioWsUrl(input.callId, input.signal);
  if (!ticket.ok) return null;

  const micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  if (input.signal?.aborted) {
    micStream.getTracks().forEach((track) => track.stop());
    return null;
  }

  let micEnabled = input.micEnabled !== false;
  let stopped = false;
  const playbackQueue: Int16Array[] = [];

  const ctx =
    getVoiceAutoplayAudioContext() ??
    new AudioContext({ sampleRate: SAMPLE_RATE });
  if (ctx.state === "suspended") {
    await ctx.resume().catch(() => undefined);
  }

  const ws = new WebSocket(ticket.wsUrl);
  ws.binaryType = "arraybuffer";

  const captureNode = ctx.createScriptProcessor(FRAME_SAMPLES, 1, 1);
  const playbackNode = ctx.createScriptProcessor(FRAME_SAMPLES, 0, 1);
  const captureSource = ctx.createMediaStreamSource(micStream);
  const int16Scratch = new Int16Array(FRAME_SAMPLES);

  captureNode.onaudioprocess = (event) => {
    if (stopped || !micEnabled || ws.readyState !== WebSocket.OPEN) return;
    const channel = event.inputBuffer.getChannelData(0);
    floatToInt16(channel, int16Scratch);
    ws.send(int16Scratch.buffer.slice(0));
  };

  playbackNode.onaudioprocess = (event) => {
    const output = event.outputBuffer.getChannelData(0);
    const frame = playbackQueue.shift();
    if (!frame) {
      output.fill(0);
      return;
    }
    const count = Math.min(frame.length, output.length);
    for (let i = 0; i < count; i++) {
      output[i] = frame[i] / 32768;
    }
    for (let i = count; i < output.length; i++) {
      output[i] = 0;
    }
  };

  ws.onmessage = (event) => {
    const data = event.data;
    if (data instanceof ArrayBuffer) {
      if (data.byteLength >= FRAME_BYTES) {
        playbackQueue.push(new Int16Array(data.slice(0, FRAME_BYTES)));
      }
      return;
    }
    if (data instanceof Blob) {
      void data.arrayBuffer().then((buf) => {
        if (buf.byteLength >= FRAME_BYTES) {
          playbackQueue.push(new Int16Array(buf.slice(0, FRAME_BYTES)));
        }
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
        reject(new Error("private_call_audio_ws_failed"));
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
    micStream.getTracks().forEach((track) => track.stop());
    try {
      ws.close();
    } catch {
      // ignore
    }
    return null;
  }

  if (stopped) return null;

  captureSource.connect(captureNode);
  captureNode.connect(ctx.destination);
  playbackNode.connect(ctx.destination);

  function stopEverything(): void {
    if (stopped) return;
    stopped = true;
    try {
      ws.close();
    } catch {
      // ignore
    }
    captureNode.disconnect();
    playbackNode.disconnect();
    captureSource.disconnect();
    micStream.getTracks().forEach((track) => track.stop());
    playbackQueue.length = 0;
  }

  input.signal?.addEventListener("abort", stopEverything, { once: true });

  return {
    setMicEnabled(enabled: boolean) {
      micEnabled = enabled;
      for (const track of micStream.getAudioTracks()) {
        track.enabled = enabled;
      }
    },
    stop: stopEverything,
  };
}
