import { appWarn } from "../../shared/appLog";
import {
  buildGroupCallJoinPayloadJson,
  groupCallAnswerSdpFromTransport,
  parseGroupCallJoinTransport,
  parseGroupCallOfferSdp,
} from "../../shared/telegramGroupCallSdp";
import { joinTelegramChatVoice } from "./joinTelegramChatVoice";
import { setTelegramChatVoiceMicMuted } from "./setTelegramChatVoiceMicMuted";
import { setTelegramChatVoiceSpeaking } from "./setTelegramChatVoiceSpeaking";

type SessionInput = {
  chatId: number;
  groupCallId: number | null;
};

function createSilentVideoTrack(): MediaStreamTrack {
  const canvas = document.createElement("canvas");
  canvas.width = 2;
  canvas.height = 2;
  const stream = canvas.captureStream(1);
  const track = stream.getVideoTracks()[0];
  if (!track) {
    throw new Error("silent_video_track_failed");
  }
  return track;
}

/**
 * Local audio for listen-only joins — no mic permission / user gesture.
 * Real mic is swapped in later via setMicEnabled().
 */
function createSilentAudioTrack(): MediaStreamTrack {
  if (typeof AudioContext === "undefined") {
    throw new Error("silent_audio_unavailable");
  }
  const ctx = new AudioContext();
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  gain.gain.value = 0;
  oscillator.connect(gain);
  const dest = ctx.createMediaStreamDestination();
  gain.connect(dest);
  oscillator.start();
  const track = dest.stream.getAudioTracks()[0];
  if (!track) {
    oscillator.stop();
    void ctx.close().catch(() => undefined);
    throw new Error("silent_audio_track_failed");
  }
  // Keep ctx alive for the track lifetime; stop() closes it.
  const stopTrack = track.stop.bind(track);
  track.stop = () => {
    try {
      oscillator.stop();
    } catch {
      // already stopped
    }
    void ctx.close().catch(() => undefined);
    stopTrack();
  };
  // Keep enabled so the transceiver stays live and the SFU can deliver remote audio.
  // Telegram mute is signaled separately via is_muted / muteGroupCallParticipant.
  track.enabled = true;
  return track;
}

/** Browser WebRTC session for a Telegram group voice call. */
export class TelegramGroupCallWebSession {
  private connection: RTCPeerConnection | null = null;
  private localStream: MediaStream | null = null;
  private audioTrack: MediaStreamTrack | null = null;
  /** True when `audioTrack` is a placeholder (no real mic yet). */
  private usingSilentAudio = false;
  private remoteAudio: HTMLAudioElement | null = null;
  private remoteStream: MediaStream | null = null;
  private audioSourceId: number | null = null;
  /** One-shot document gesture listener to unmute after auto-join. */
  private gestureUnmuteCleanup: (() => void) | null = null;
  private joined = false;
  private joining: Promise<void> | null = null;
  private micEnabled = false;
  private localSpeaking = false;
  private speakingListeners = new Set<(speaking: boolean) => void>();
  private analyserCtx: AudioContext | null = null;
  private analyserRaf: number | null = null;
  private lastSpeakingSyncAt = 0;
  private lastSpeakingSynced: boolean | null = null;
  /** After GROUPCALL_JOIN_MISSING, stop hammering speaking until we rejoin. */
  private speakingSyncBlockedUntil = 0;
  private joinLostListeners = new Set<() => void>();

  constructor(private input: SessionInput) {
    // Pre-create the element so unlockRemoteAudio during Join hits the real sink.
    if (typeof document !== "undefined") {
      this.ensureRemoteAudioElement();
    }
  }

  /** Update call id without tearing down WebRTC (chat list refreshes often). */
  updateGroupCallId(groupCallId: number | null): void {
    this.input = { ...this.input, groupCallId };
  }

  get isJoined(): boolean {
    return this.joined;
  }

  /** Fired when TDLib reports we are no longer joined (roster/speaking broken). */
  onJoinLost(listener: () => void): () => void {
    this.joinLostListeners.add(listener);
    return () => {
      this.joinLostListeners.delete(listener);
    };
  }

  private markJoinLost(reason: string): void {
    if (!this.joined && !this.connection) return;
    this.speakingSyncBlockedUntil = Date.now() + 4_000;
    this.lastSpeakingSynced = null;
    // Tear down media so ensureJoinedListenOnly can open a fresh PeerConnection.
    // Do not remove the remote <audio> shell — unlock gestures still need it.
    this.stopSpeakingMonitor();
    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => track.stop());
      this.localStream = null;
    }
    if (this.audioTrack) {
      this.audioTrack.stop();
      this.audioTrack = null;
    }
    this.usingSilentAudio = false;
    this.audioSourceId = null;
    if (this.connection) {
      this.connection.close();
      this.connection = null;
    }
    const wasJoined = this.joined;
    this.joined = false;
    this.micEnabled = false;
    appWarn("[voice-join-lost]", reason, {
      chatId: this.input.chatId,
      groupCallId: this.input.groupCallId,
      wasJoined,
    });
    for (const listener of this.joinLostListeners) {
      try {
        listener();
      } catch {
        // ignore
      }
    }
  }

  get isMicEnabled(): boolean {
    return this.micEnabled;
  }

  get isLocalSpeaking(): boolean {
    return this.localSpeaking;
  }

  onLocalSpeakingChange(listener: (speaking: boolean) => void): () => void {
    this.speakingListeners.add(listener);
    return () => {
      this.speakingListeners.delete(listener);
    };
  }

  async ensureJoinedListenOnly(): Promise<void> {
    if (this.joined) return;
    if (this.joining) {
      await this.joining;
      return;
    }
    this.joining = this.joinInternal(true);
    try {
      await this.joining;
    } finally {
      this.joining = null;
    }
  }

  /** Acquire a real mic (user gesture). Replaces silent placeholder if already joined. */
  async ensureLocalMic(): Promise<void> {
    if (this.audioTrack && !this.usingSilentAudio) return;
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      throw new Error("microphone_unavailable");
    }
    const micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
    const audioTrack = micStream.getAudioTracks()[0];
    if (!audioTrack) {
      micStream.getTracks().forEach((track) => track.stop());
      throw new Error("microphone_unavailable");
    }
    audioTrack.enabled = false;

    const previous = this.audioTrack;
    if (this.connection && previous) {
      const sender = this.connection
        .getSenders()
        .find((s) => s.track?.kind === "audio" || s.track === previous);
      if (sender) {
        await sender.replaceTrack(audioTrack);
      }
    }
    if (previous) {
      previous.stop();
    }

    this.audioTrack = audioTrack;
    this.usingSilentAudio = false;
    if (this.localStream) {
      for (const t of this.localStream.getAudioTracks()) {
        this.localStream.removeTrack(t);
      }
      this.localStream.addTrack(audioTrack);
    } else {
      this.localStream = new MediaStream([audioTrack]);
    }
    this.startSpeakingMonitor();
  }

  async setMicEnabled(enabled: boolean): Promise<void> {
    if (enabled || this.usingSilentAudio || !this.audioTrack) {
      await this.ensureLocalMic();
    }
    if (this.audioTrack) {
      this.audioTrack.enabled = enabled;
    }
    this.micEnabled = enabled;
    if (!enabled) {
      this.setLocalSpeaking(false);
    }

    // Best-effort: join + unmute on Telegram. Local UI/mic stay as set.
    try {
      if (!this.joined) {
        await this.ensureJoinedListenOnly();
        if (enabled) {
          await this.ensureLocalMic();
        }
        if (this.audioTrack) this.audioTrack.enabled = enabled;
        this.micEnabled = enabled;
      }
      this.resumeRemoteAudio();
      const muteResult = await setTelegramChatVoiceMicMuted({
        chatId: this.input.chatId,
        groupCallId: this.input.groupCallId,
        isMuted: !enabled,
      });
      if (!muteResult.ok) {
        appWarn("[voice-mic-sync]", muteResult.error, {
          chatId: this.input.chatId,
          groupCallId: this.input.groupCallId,
          enabled,
        });
        const err = muteResult.error;
        if (
          typeof err === "string" &&
          (err.includes("GROUPCALL_JOIN_MISSING") ||
            err.includes("GROUPCALL_FORBIDDEN") ||
            err.includes("GROUPCALL_INVALID"))
        ) {
          this.markJoinLost(err);
        }
      }
    } catch (err) {
      appWarn(
        "[voice-mic-sync]",
        err instanceof Error ? err.message : String(err),
        { chatId: this.input.chatId, groupCallId: this.input.groupCallId, enabled },
      );
    }
  }

  private setLocalSpeaking(speaking: boolean): void {
    if (this.localSpeaking === speaking) return;
    this.localSpeaking = speaking;
    for (const listener of this.speakingListeners) {
      try {
        listener(speaking);
      } catch {
        // ignore listener errors
      }
    }
    void this.syncSpeakingToTelegram(speaking);
  }

  private async syncSpeakingToTelegram(speaking: boolean): Promise<void> {
    if (!this.joined || this.audioSourceId == null) return;
    const now = Date.now();
    if (now < this.speakingSyncBlockedUntil) return;
    // Debounce Telegram updates; always flush "not speaking" promptly.
    if (
      speaking &&
      this.lastSpeakingSynced === true &&
      now - this.lastSpeakingSyncAt < 350
    ) {
      return;
    }
    this.lastSpeakingSyncAt = now;
    this.lastSpeakingSynced = speaking;
    try {
      const result = await setTelegramChatVoiceSpeaking({
        chatId: this.input.chatId,
        groupCallId: this.input.groupCallId,
        audioSourceId: this.audioSourceId,
        isSpeaking: speaking,
      });
      if (!result.ok) {
        const err = result.error;
        appWarn("[voice-speaking-sync]", err, {
          chatId: this.input.chatId,
          groupCallId: this.input.groupCallId,
        });
        if (
          typeof err === "string" &&
          (err.includes("GROUPCALL_JOIN_MISSING") ||
            err.includes("GROUPCALL_FORBIDDEN") ||
            err.includes("GROUPCALL_INVALID"))
        ) {
          this.markJoinLost(err);
        }
      }
    } catch (err) {
      appWarn(
        "[voice-speaking-sync]",
        err instanceof Error ? err.message : String(err),
        { chatId: this.input.chatId, groupCallId: this.input.groupCallId },
      );
    }
  }

  private startSpeakingMonitor(): void {
    if (this.analyserRaf != null || !this.audioTrack) return;
    if (typeof window === "undefined" || typeof AudioContext === "undefined") return;

    try {
      const ctx = new AudioContext();
      this.analyserCtx = ctx;
      const source = ctx.createMediaStreamSource(new MediaStream([this.audioTrack]));
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.4;
      source.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);

      const tick = () => {
        this.analyserRaf = window.requestAnimationFrame(tick);
        if (!this.micEnabled || !this.audioTrack?.enabled) {
          this.setLocalSpeaking(false);
          return;
        }
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i += 1) {
          const centered = (data[i]! - 128) / 128;
          sum += centered * centered;
        }
        const rms = Math.sqrt(sum / data.length);
        this.setLocalSpeaking(rms > 0.04);
      };
      this.analyserRaf = window.requestAnimationFrame(tick);
      void ctx.resume().catch(() => undefined);
    } catch (err) {
      appWarn(
        "[voice-speaking-analyser]",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  private stopSpeakingMonitor(): void {
    if (this.analyserRaf != null && typeof window !== "undefined") {
      window.cancelAnimationFrame(this.analyserRaf);
      this.analyserRaf = null;
    }
    if (this.analyserCtx) {
      void this.analyserCtx.close().catch(() => undefined);
      this.analyserCtx = null;
    }
    this.setLocalSpeaking(false);
  }

  private ensureRemoteAudioElement(): HTMLAudioElement {
    if (this.remoteAudio) return this.remoteAudio;
    const audio = document.createElement("audio");
    audio.autoplay = true;
    audio.setAttribute("playsinline", "true");
    audio.setAttribute("webkit-playsinline", "true");
    audio.muted = false;
    audio.volume = 1;
    // Keep off-screen but in the document — some browsers won't play detached elements.
    audio.style.position = "fixed";
    audio.style.width = "0";
    audio.style.height = "0";
    audio.style.opacity = "0";
    audio.style.pointerEvents = "none";
    audio.setAttribute("aria-hidden", "true");
    document.body.appendChild(audio);
    this.remoteAudio = audio;
    return audio;
  }

  private armGestureUnmute(): void {
    if (typeof document === "undefined" || this.gestureUnmuteCleanup) return;
    const onGesture = () => {
      this.resumeRemoteAudio();
      this.gestureUnmuteCleanup?.();
      this.gestureUnmuteCleanup = null;
    };
    document.addEventListener("pointerdown", onGesture, { capture: true, once: true });
    document.addEventListener("keydown", onGesture, { capture: true, once: true });
    this.gestureUnmuteCleanup = () => {
      document.removeEventListener("pointerdown", onGesture, true);
      document.removeEventListener("keydown", onGesture, true);
    };
  }

  private playRemoteHtml(reason: string): void {
    if (typeof document === "undefined") return;
    const audio = this.ensureRemoteAudioElement();
    if (!this.remoteStream) {
      this.remoteStream = new MediaStream();
    }
    if (audio.srcObject !== this.remoteStream) {
      audio.srcObject = this.remoteStream;
    }
    audio.volume = 1;
    void (async () => {
      try {
        // Muted play is allowed without a gesture; then unmute for audible output.
        audio.muted = true;
        await audio.play();
        audio.muted = false;
      } catch {
        try {
          audio.muted = false;
          await audio.play();
        } catch (err) {
          this.armGestureUnmute();
          appWarn("[voice-remote-audio]", err instanceof Error ? err.message : String(err), {
            reason,
            chatId: this.input.chatId,
            groupCallId: this.input.groupCallId,
            tracks: this.remoteStream?.getAudioTracks().length ?? 0,
          });
        }
      }
    })();
  }

  private attachRemoteAudioTrack(track: MediaStreamTrack): void {
    if (track.kind !== "audio") return;
    track.enabled = true;
    if (!this.remoteStream) {
      this.remoteStream = new MediaStream();
    }
    const already = this.remoteStream.getAudioTracks().some((t) => t.id === track.id);
    if (!already) {
      this.remoteStream.addTrack(track);
      appWarn("[voice-remote-track]", "attached", {
        chatId: this.input.chatId,
        groupCallId: this.input.groupCallId,
        trackId: track.id,
        muted: track.muted,
        readyState: track.readyState,
        trackCount: this.remoteStream.getAudioTracks().length,
      });
    }
    const audio = this.ensureRemoteAudioElement();
    // Only assign srcObject once. Re-assigning interrupts an in-flight play().
    if (audio.srcObject !== this.remoteStream) {
      audio.srcObject = this.remoteStream;
    }
    this.playRemoteHtml("track");
  }

  /**
   * Unlock autoplay during a user gesture (Join / open strip / mic).
   * Must run synchronously in the gesture stack so later remote tracks can play.
   */
  unlockRemoteAudio(): void {
    if (typeof document === "undefined") return;
    const audio = this.ensureRemoteAudioElement();
    if (!this.remoteStream) {
      this.remoteStream = new MediaStream();
    }
    if (audio.srcObject !== this.remoteStream) {
      audio.srcObject = this.remoteStream;
    }
    audio.muted = false;
    audio.volume = 1;
    void audio.play().catch(() => undefined);
    this.playRemoteHtml("unlock");
  }

  /** Retry autoplay after a user gesture (mic toggle / UI click). */
  resumeRemoteAudio(): void {
    if (typeof document === "undefined") return;
    const audio = this.ensureRemoteAudioElement();
    if (!this.remoteStream) {
      this.remoteStream = new MediaStream();
    }
    if (audio.srcObject !== this.remoteStream) {
      audio.srcObject = this.remoteStream;
    }
    audio.muted = false;
    audio.volume = 1;
    void audio.play().catch(() => undefined);
    this.playRemoteHtml("resume");
  }

  private async joinInternal(startMuted: boolean): Promise<void> {
    if (this.joined || typeof RTCPeerConnection === "undefined") {
      return;
    }

    // Listen-only: silent local audio (no mic prompt). Real mic on unmute.
    if (startMuted) {
      if (!this.audioTrack) {
        this.audioTrack = createSilentAudioTrack();
        this.usingSilentAudio = true;
      }
    } else {
      await this.ensureLocalMic();
    }
    const audioTrack = this.audioTrack;
    if (!audioTrack) {
      throw new Error("microphone_unavailable");
    }
    // Listen-only still keeps the local track enabled (silent / zero-gain) so RTP
    // receive stays negotiated. Mic privacy is Telegram is_muted + real mic swap.
    if (this.usingSilentAudio) {
      audioTrack.enabled = true;
    } else {
      audioTrack.enabled = !startMuted;
    }

    const videoTrack = createSilentVideoTrack();
    const localStream = new MediaStream([audioTrack, videoTrack]);

    const connection = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });
    connection.addTrack(audioTrack, localStream);
    connection.addTrack(videoTrack, localStream);

    connection.ontrack = (event) => {
      const track = event.track;
      if (!track) return;
      track.enabled = true;
      appWarn("[voice-ontrack]", track.kind, {
        chatId: this.input.chatId,
        groupCallId: this.input.groupCallId,
        streams: event.streams.length,
        muted: track.muted,
        readyState: track.readyState,
      });
      if (event.streams[0]) {
        for (const streamTrack of event.streams[0].getAudioTracks()) {
          streamTrack.enabled = true;
          this.attachRemoteAudioTrack(streamTrack);
        }
      } else if (track.kind === "audio") {
        this.attachRemoteAudioTrack(track);
      }
      this.resumeRemoteAudio();
    };

    connection.onconnectionstatechange = () => {
      const state = connection.connectionState;
      appWarn("[voice-pc-state]", state, {
        chatId: this.input.chatId,
        groupCallId: this.input.groupCallId,
        ice: connection.iceConnectionState,
        receivers: connection.getReceivers().map((r) => ({
          kind: r.track?.kind,
          muted: r.track?.muted,
          enabled: r.track?.enabled,
          readyState: r.track?.readyState,
        })),
      });
      if (state === "connected") {
        for (const receiver of connection.getReceivers()) {
          if (receiver.track?.kind === "audio") {
            this.attachRemoteAudioTrack(receiver.track);
          }
        }
        this.resumeRemoteAudio();
      }
    };

    const offer = await connection.createOffer({
      offerToReceiveAudio: true,
      offerToReceiveVideo: true,
    });
    await connection.setLocalDescription(offer);
    if (!offer.sdp) {
      connection.close();
      videoTrack.stop();
      throw new Error("offer_sdp_missing");
    }

    const parsed = parseGroupCallOfferSdp(offer.sdp);
    const joinPayloadJson = buildGroupCallJoinPayloadJson(parsed);
    if (!joinPayloadJson || parsed.source == null) {
      connection.close();
      videoTrack.stop();
      throw new Error("join_payload_build_failed");
    }

    const joinResult = await joinTelegramChatVoice({
      chatId: this.input.chatId,
      groupCallId: this.input.groupCallId,
      audioSourceId: parsed.source,
      payload: joinPayloadJson,
      isMuted: startMuted,
    });
    if (!joinResult.ok) {
      connection.close();
      videoTrack.stop();
      throw new Error(joinResult.error);
    }

    let transportRoot: { stream?: boolean } | null = null;
    try {
      transportRoot = JSON.parse(joinResult.join_payload) as { stream?: boolean };
    } catch {
      transportRoot = null;
    }
    if (transportRoot?.stream) {
      connection.close();
      videoTrack.stop();
      throw new Error("voice_stream_mode_unsupported");
    }

    const transport = parseGroupCallJoinTransport(joinResult.join_payload);
    if (!transport) {
      appWarn("[voice-join-transport]", "join_transport_invalid", {
        chatId: this.input.chatId,
        groupCallId: this.input.groupCallId,
        payloadBytes: joinResult.join_payload.length,
        payloadPrefix: joinResult.join_payload.slice(0, 80),
      });
      connection.close();
      videoTrack.stop();
      throw new Error("join_transport_invalid");
    }

    try {
      await connection.setRemoteDescription({
        type: "answer",
        sdp: groupCallAnswerSdpFromTransport(transport, offer.sdp),
      });
    } catch (err) {
      // Older Chrome / mismatched profile — retry with classic tgcalls RTP/SAVPF.
      appWarn(
        "[voice-sdp-answer]",
        err instanceof Error ? err.message : String(err),
        { chatId: this.input.chatId, groupCallId: this.input.groupCallId },
      );
      await connection.setRemoteDescription({
        type: "answer",
        sdp: groupCallAnswerSdpFromTransport(transport, "m=audio 1 RTP/SAVPF 111"),
      });
    }

    this.connection = connection;
    this.localStream = localStream;
    this.audioTrack = audioTrack;
    this.audioSourceId = parsed.source;
    this.joined = true;
    this.micEnabled = !startMuted;
    if (!this.usingSilentAudio) {
      this.startSpeakingMonitor();
    }
    // Tracks may already be present; unlock was done on the open-dialog click.
    this.resumeRemoteAudio();
    this.armGestureUnmute();
  }

  dispose(): void {
    this.stopSpeakingMonitor();
    this.gestureUnmuteCleanup?.();
    this.gestureUnmuteCleanup = null;
    if (this.remoteAudio) {
      this.remoteAudio.pause();
      this.remoteAudio.srcObject = null;
      this.remoteAudio.remove();
      this.remoteAudio = null;
    }
    this.remoteStream = null;
    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => track.stop());
      this.localStream = null;
    }
    if (this.audioTrack) {
      this.audioTrack.stop();
      this.audioTrack = null;
    }
    this.usingSilentAudio = false;
    this.audioSourceId = null;
    if (this.connection) {
      this.connection.close();
      this.connection = null;
    }
    this.joined = false;
    this.micEnabled = false;
    this.speakingListeners.clear();
  }
}
