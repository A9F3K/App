import { useEffect, useRef, type CSSProperties } from "react";
import type { AnimationConfig, AnimationItem } from "lottie-web";
import lottie from "lottie-web/build/player/lottie_canvas";
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
  /** Status badges: always paint frame 0 and skip the global active-player cap. */
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

function safeAnimCall(anim: AnimationItem | null, fn: (item: AnimationItem) => void): void {
  if (!anim) return;
  try {
    fn(anim);
  } catch {
    /* lottie can throw when the canvas was torn down during chat switches */
  }
}

function forcePaintFrame(anim: AnimationItem): void {
  safeAnimCall(anim, (item) => {
    item.goToAndStop(0, true);
    const renderer = item.renderer as { renderFrame?: (frame: number) => void } | undefined;
    if (renderer?.renderFrame) {
      renderer.renderFrame(item.currentFrame);
    }
  });
}

function styleLottieCanvas(host: HTMLElement, widthPx: number, heightPx: number): void {
  const canvas = host.querySelector("canvas");
  if (!canvas) return;
  canvas.style.width = `${widthPx}px`;
  canvas.style.height = `${heightPx}px`;
  canvas.style.display = "block";
  canvas.style.verticalAlign = MESSAGE_INLINE_EMOJI_VERTICAL_ALIGN_CSS;
}

/** Canvas-based TGS loop — avoids lottie-react SVG DOM churn. */
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
  const animRef = useRef<AnimationItem | null>(null);
  const slotHeldRef = useRef(false);
  const visibleRef = useRef(true);
  const mountGenRef = useRef(0);
  const visible = useElementVisible(hostRef, { enabled: !priority });
  visibleRef.current = visible;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const mountGen = mountGenRef.current + 1;
    mountGenRef.current = mountGen;
    const isStale = () => mountGenRef.current !== mountGen;

    let anim: AnimationItem | null = null;
    let localSlotHeld = false;

    const releaseLocalSlot = () => {
      if (!localSlotHeld) return;
      releasePlaySlot();
      localSlotHeld = false;
      if (slotHeldRef.current) slotHeldRef.current = false;
    };

    try {
      host.replaceChildren();
      anim = lottie.loadAnimation({
        container: host,
        renderer: "canvas",
        loop,
        autoplay: false,
        animationData,
        rendererSettings: {
          clearCanvas: true,
          progressiveLoad: false,
          hideOnTransparent: false,
        },
      } as AnimationConfig);
    } catch {
      return;
    }

    if (isStale()) {
      safeAnimCall(anim, (item) => item.destroy());
      return;
    }

    animRef.current = anim;

    const onReady = () => {
      if (isStale() || !animRef.current) return;
      const currentAnim = animRef.current;
      const currentHost = hostRef.current;
      if (!currentHost) return;

      styleLottieCanvas(currentHost, widthPx, height);
      forcePaintFrame(currentAnim);

      const shouldPlay = priority || visibleRef.current;
      telegramEmojiDebug.playerAction("ready", {
        priority,
        visible: visibleRef.current,
        shouldPlay,
        hasCanvas: Boolean(currentHost.querySelector("canvas")),
      });

      if (!shouldPlay) return;

      if (!localSlotHeld && (priority || acquirePlaySlot())) {
        localSlotHeld = true;
        slotHeldRef.current = true;
      }
      if (localSlotHeld || priority) {
        safeAnimCall(currentAnim, (item) => item.play());
        telegramEmojiDebug.playerAction("play", {
          priority,
          visible: visibleRef.current,
          reason: "ready",
        });
      }
    };

    anim.addEventListener("DOMLoaded", onReady);
    anim.addEventListener("data_ready", onReady);
    requestAnimationFrame(() => {
      if (!isStale()) onReady();
    });

    return () => {
      mountGenRef.current += 1;
      releaseLocalSlot();
      safeAnimCall(anim, (item) => {
        item.removeEventListener("DOMLoaded", onReady);
        item.removeEventListener("data_ready", onReady);
        item.destroy();
      });
      animRef.current = null;
      try {
        host.replaceChildren();
      } catch {
        /* host may already be detached */
      }
    };
  }, [animationData, widthPx, height, loop, lowPriority, priority]);

  useEffect(() => {
    const anim = animRef.current;
    if (!anim) return;

    const shouldPlay = priority || visible;

    if (shouldPlay) {
      if (!slotHeldRef.current && (priority || acquirePlaySlot())) {
        slotHeldRef.current = true;
        safeAnimCall(anim, (item) => item.play());
        telegramEmojiDebug.playerAction("play", { priority, visible, reason: "slot_acquired" });
      } else if (slotHeldRef.current) {
        safeAnimCall(anim, (item) => item.play());
        telegramEmojiDebug.playerAction("play", { priority, visible, reason: "slot_held" });
      } else {
        forcePaintFrame(anim);
        telegramEmojiDebug.playerAction("paint_only", { priority, visible, reason: "player_cap" });
      }
      return;
    }

    safeAnimCall(anim, (item) => item.pause());
    if (slotHeldRef.current) {
      releasePlaySlot();
      slotHeldRef.current = false;
    }
    forcePaintFrame(anim);
    telegramEmojiDebug.playerAction("pause", { priority, visible });
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
