import { useEffect, useRef, type CSSProperties } from "react";
import { DotLottie } from "@lottiefiles/dotlottie-web";
import { telegramEmojiDebug } from "./telegramEmojiDebug";
import { useElementVisible } from "./useElementVisible.web";
import { MESSAGE_INLINE_EMOJI_VERTICAL_ALIGN_CSS } from "./messageChatLayout";

type Props = {
  animationData: object;
  widthPx: number;
  heightPx?: number;
  loop?: boolean;
  /** Smaller canvas + lower DPR for chat-list inline emoji (telegram-tt low-priority quality). */
  lowPriority?: boolean;
  /** Status badges: always play and skip the global active-player cap. */
  priority?: boolean;
  className?: string;
  style?: React.CSSProperties;
};

const MAX_ACTIVE_PLAYERS = 24;
let activePlayerCount = 0;

function acquirePlaySlot(): boolean {
  if (activePlayerCount >= MAX_ACTIVE_PLAYERS) return false;
  activePlayerCount += 1;
  return true;
}

function releasePlaySlot(): void {
  activePlayerCount = Math.max(0, activePlayerCount - 1);
}

function sizeCanvas(canvas: HTMLCanvasElement, widthPx: number, heightPx: number, lowPriority: boolean): void {
  const dpr = lowPriority
    ? 1
    : Math.min(typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1, 2);
  canvas.width = Math.max(1, Math.round(widthPx * dpr));
  canvas.height = Math.max(1, Math.round(heightPx * dpr));
  canvas.style.width = `${widthPx}px`;
  canvas.style.height = `${heightPx}px`;
  canvas.style.display = "block";
  canvas.style.verticalAlign = MESSAGE_INLINE_EMOJI_VERTICAL_ALIGN_CSS;
}

/**
 * Telegram `.tgs` is gzipped Lottie. Official clients play it with rlottie/ThorVG,
 * not lottie-web. DotLottie (ThorVG WASM) actually loops TGS; lottie-web canvas
 * often freezes on frame 0 after `goToAndStop`.
 */
export function TgsCanvasPlayer({
  animationData,
  widthPx,
  heightPx,
  loop = true,
  lowPriority = false,
  priority = false,
  className,
  style,
}: Props) {
  const height = heightPx ?? widthPx;
  const hostRef = useRef<HTMLSpanElement>(null);
  const playerRef = useRef<DotLottie | null>(null);
  const slotHeldRef = useRef(false);
  const visibleRef = useRef(true);
  const visible = useElementVisible(hostRef, { enabled: !priority });
  visibleRef.current = priority || visible;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    host.replaceChildren();
    const canvas = document.createElement("canvas");
    canvas.setAttribute("aria-hidden", "true");
    sizeCanvas(canvas, widthPx, height, lowPriority);
    host.appendChild(canvas);

    let player: DotLottie | null = null;
    let localSlotHeld = false;
    let destroyed = false;

    const releaseLocalSlot = () => {
      if (!localSlotHeld) return;
      releasePlaySlot();
      localSlotHeld = false;
      slotHeldRef.current = false;
    };

    const applyPlayback = () => {
      if (destroyed || !player) return;
      const shouldPlay = priority || visibleRef.current;
      if (!shouldPlay) {
        player.pause();
        releaseLocalSlot();
        telegramEmojiDebug.playerAction("pause", { priority, visible: visibleRef.current });
        return;
      }
      if (!localSlotHeld && (priority || acquirePlaySlot())) {
        localSlotHeld = true;
        slotHeldRef.current = true;
      }
      if (localSlotHeld || priority) {
        player.play();
        telegramEmojiDebug.playerAction("play", {
          priority,
          visible: visibleRef.current,
          reason: "dotlottie",
        });
      }
    };

    try {
      player = new DotLottie({
        canvas,
        data: animationData as Record<string, unknown>,
        loop,
        autoplay: false,
        layout: { fit: "contain", align: [0.5, 0.5] },
        renderConfig: {
          autoResize: false,
          freezeOnOffscreen: false,
          devicePixelRatio: lowPriority
            ? 1
            : Math.min(typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1, 2),
        },
      });
    } catch (err) {
      telegramEmojiDebug.playerAction("dotlottie_construct_fail", {
        error: err instanceof Error ? err.message : String(err),
      });
      return () => {
        host.replaceChildren();
      };
    }

    playerRef.current = player;
    player.addEventListener("load", applyPlayback);
    player.addEventListener("ready", applyPlayback);
    player.addEventListener("loadError", () => {
      telegramEmojiDebug.playerAction("dotlottie_construct_fail", { reason: "loadError" });
    });
    applyPlayback();

    return () => {
      destroyed = true;
      releaseLocalSlot();
      try {
        player?.removeEventListener("load", applyPlayback);
        player?.removeEventListener("ready", applyPlayback);
        player?.destroy();
      } catch {
        /* WASM player can throw if the canvas is already gone */
      }
      playerRef.current = null;
      try {
        host.replaceChildren();
      } catch {
        /* host may already be detached */
      }
    };
  }, [animationData, widthPx, height, loop, lowPriority, priority]);

  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    const shouldPlay = priority || visible;
    if (shouldPlay) {
      if (!slotHeldRef.current && (priority || acquirePlaySlot())) {
        slotHeldRef.current = true;
      }
      if (slotHeldRef.current || priority) {
        player.play();
      }
      return;
    }
    player.pause();
    if (slotHeldRef.current) {
      releasePlaySlot();
      slotHeldRef.current = false;
    }
  }, [priority, visible]);

  return (
    <span
      ref={hostRef}
      className={className}
      style={{
        display: "inline-block",
        width: widthPx,
        height,
        verticalAlign: MESSAGE_INLINE_EMOJI_VERTICAL_ALIGN_CSS,
        lineHeight: 1,
        overflow: "visible",
        flexShrink: 0,
        ...style,
      }}
    />
  );
}
