import { buildApiUrl } from "../../api/_base";
import { unlockVoiceAutoplay } from "./unlockVoiceAutoplay";

const SAMPLE_RATE = 48_000;
/** Telegram / ntgcalls external PCM frame (10 ms @ 48 kHz). */
const FRAME_SAMPLES = 480;
/**
 * createScriptProcessor requires 0 or a power of two in [256, 16384].
 * 480 is invalid — use 512 and re-chunk to 480-sample network frames.
 */
const PROCESSOR_BUFFER_SIZE = 512;

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

function floatToInt16Sample(sample: number): number {
  const clamped = sample < -1 ? -1 : sample > 1 ? 1 : sample;
  return clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
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

  const micStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      sampleRate: SAMPLE_RATE,
      channelCount: 1,
    },
    video: false,
  });
  if (input.signal?.aborted) {
    micStream.getTracks().forEach((track) => track.stop());
    return null;
  }

  let micEnabled = input.micEnabled !== false;
  let stopped = false;

  // Dedicated 48 kHz context — Telegram frames are 10 ms @ 48 kHz.
  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
  if (ctx.state === "suspended") {
    await ctx.resume().catch(() => undefined);
  }

  const ws = new WebSocket(ticket.wsUrl);
  ws.binaryType = "arraybuffer";

  const captureNode = ctx.createScriptProcessor(PROCESSOR_BUFFER_SIZE, 1, 1);
  const playbackNode = ctx.createScriptProcessor(PROCESSOR_BUFFER_SIZE, 0, 1);
  const captureSource = ctx.createMediaStreamSource(micStream);
  // Keep ScriptProcessor in the graph without monitoring local mic.
  const silentGain = ctx.createGain();
  silentGain.gain.value = 0;

  const capturePending: number[] = [];
  const playbackPending: number[] = [];
  const MAX_PLAYBACK_SAMPLES = SAMPLE_RATE * 2; // ~2s cap

  captureNode.onaudioprocess = (event) => {
    if (stopped || !micEnabled || ws.readyState !== WebSocket.OPEN) return;
    const channel = event.inputBuffer.getChannelData(0);
    for (let i = 0; i < channel.length; i++) {
      capturePending.push(channel[i] ?? 0);
    }
    while (capturePending.length >= FRAME_SAMPLES) {
      const frame = new Int16Array(FRAME_SAMPLES);
      for (let i = 0; i < FRAME_SAMPLES; i++) {
        frame[i] = floatToInt16Sample(capturePending.shift() ?? 0);
      }
      try {
        ws.send(frame.buffer.slice(0));
      } catch {
        // drop on send failure
      }
    }
  };

  playbackNode.onaudioprocess = (event) => {
    const output = event.outputBuffer.getChannelData(0);
    for (let i = 0; i < output.length; i++) {
      const sample = playbackPending.shift();
      output[i] = sample == null ? 0 : sample / 32768;
    }
  };

  const enqueuePlaybackPcm = (buf: ArrayBuffer) => {
    if (buf.byteLength < 2) return;
    const usable = buf.byteLength - (buf.byteLength % 2);
    const samples = new Int16Array(buf.slice(0, usable));
    for (let i = 0; i < samples.length; i++) {
      playbackPending.push(samples[i] ?? 0);
    }
    // Bound latency if frames pile up.
    while (playbackPending.length > MAX_PLAYBACK_SAMPLES) {
      playbackPending.shift();
    }
  };

  ws.onmessage = (event) => {
    const data = event.data;
    if (data instanceof ArrayBuffer) {
      enqueuePlaybackPcm(data);
      return;
    }
    if (data instanceof Blob) {
      void data.arrayBuffer().then((buf) => {
        if (!stopped) enqueuePlaybackPcm(buf);
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
    void ctx.close().catch(() => undefined);
    return null;
  }

  if (stopped) return null;

  captureSource.connect(captureNode);
  captureNode.connect(silentGain);
  silentGain.connect(ctx.destination);
  playbackNode.connect(ctx.destination);

  function stopEverything(): void {
    if (stopped) return;
    stopped = true;
    try {
      ws.close();
    } catch {
      // ignore
    }
    try {
      captureNode.disconnect();
      playbackNode.disconnect();
      captureSource.disconnect();
      silentGain.disconnect();
    } catch {
      // ignore
    }
    micStream.getTracks().forEach((track) => track.stop());
    capturePending.length = 0;
    playbackPending.length = 0;
    void ctx.close().catch(() => undefined);
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
