import { createElement, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal, flushSync } from "react-dom";
import {
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  useWindowDimensions,
  View,
  type ViewStyle,
} from "react-native";
import { FONT_UI_SANS_REGULAR, WEB_UI_SANS_STACK } from "../../fonts";
import {
  layout,
  typographyRect15,
  type ThemeColors,
} from "../../theme";
import { useAppStrings } from "../../../locales/AppStringsContext";
import { LiquidGlassShaderUndercover } from "../LiquidGlassShaderUndercover";
import { useTelegram } from "../Telegram";
import { appModalSheetStyles } from "../AppModalSheet";
import { logPageDisplay } from "../../pageDisplayLog";
import type { TelegramChatVoiceParticipant } from "../../telegram/fetchTelegramChatVoiceParticipants";
import { MessageChatAvatarSlot } from "./MessageChatAvatarSlot";
import { extractChatAvatarInitials } from "./chatAvatarInitials";
import { resolveTelegramUserAvatarUrl } from "./resolveTelegramUserAvatarUrl";
import { SpecialTelegramUserName } from "./SpecialTelegramUserName";
import {
  MESSAGE_AVATAR_PX,
  MESSAGE_CHAT_VOICE_VIDEO_MAX_HEIGHT_PX,
  MESSAGE_FONT_SIZE_PX,
  MESSAGE_ICON_TEXT_GAP_PX,
  MESSAGE_LINE_HEIGHT_PX,
  MESSAGE_LIST_INLINE_EMOJI_SIZE_PX,
} from "./messageListLayout";
import {
  VoiceCameraIcon,
  VoiceDropIcon,
  VoiceMessagesIcon,
  VoiceMicControlIcon,
  VoiceMoreIcon,
  VoiceWindowCrossIcon,
  VoiceWindowSizeIcon,
  VoiceWindowTrayIcon,
} from "./MessageChatVoiceControlIcons";
import { VoiceParticipantStateMicIcon } from "./MessageChatVoiceParticipantMicIcon";
import {
  MessageChatVoiceMediaStage,
  type VoiceMediaStageSource,
} from "./MessageChatVoiceVideoPlane";
import {
  MessageChatVoiceMoreMenu,
  type VoiceMoreMenuAnchor,
} from "./MessageChatVoiceMoreMenu";

const WINDOW_ICON_SIZE_PX = 15;
const WINDOW_ICON_GAP_PX = 12;
/** Reserve top-right chrome so resize hit strips cannot steal close/minimize presses. */
const WINDOW_CONTROLS_RESERVE_PX = 168;

function VoiceWindowChromeButton({
  label,
  onPress,
  children,
  hitExtraPx = 8,
  testId,
}: {
  label: string;
  onPress: () => void;
  children: ReactNode;
  hitExtraPx?: number;
  testId?: string;
}) {
  // Prefer a ≥44px target so Close stays hittable under resize strips / DPR.
  const sizePx = Math.max(44, WINDOW_ICON_SIZE_PX + hitExtraPx * 2);
  if (Platform.OS === "web") {
    // Native <button> — RN Pressable often misses clicks under absolute resize
    // handles / SVG children, and closing can click-through to the voice strip.
    return createElement(
      "button",
      {
        type: "button",
        "aria-label": label,
        title: label,
        "data-voice-chrome": testId ?? "button",
        onPointerDown: (e: {
          stopPropagation?: () => void;
          preventDefault?: () => void;
          button?: number;
        }) => {
          e.stopPropagation?.();
          // Do not preventDefault — that broke RN's touch bank ("touch end without
          // start") and could drop the Close gesture under main-thread pressure.
          if (e.button == null || e.button === 0) {
            onPress();
          }
        },
        onClick: (e: { stopPropagation?: () => void; preventDefault?: () => void }) => {
          // Backup if pointerdown was swallowed by an overlay / frozen frame.
          e.stopPropagation?.();
          e.preventDefault?.();
          onPress();
        },
        style: {
          width: sizePx,
          height: sizePx,
          margin: 0,
          padding: 0,
          border: "none",
          background: "transparent",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          cursor: "pointer",
          position: "relative",
          zIndex: 10000,
          flexShrink: 0,
          WebkitAppearance: "none",
          appearance: "none",
          touchAction: "manipulation",
        },
      },
      createElement("span", { style: { pointerEvents: "none", display: "flex" } }, children),
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={12}
      style={({ pressed }) => ({
        width: sizePx,
        height: sizePx,
        alignItems: "center",
        justifyContent: "center",
        opacity: pressed ? 0.7 : 1,
        zIndex: 30,
      })}
    >
      {children}
    </Pressable>
  );
}

const CONTROL_CHIP_PX = 50;
const CONTROL_ICON_PX = 20;
const CONTROL_CHIP_GAP_PX = 15;
const DIVIDER_INSET_PX = 20;
const DEFAULT_SHEET_WIDTH_PX = 380;
const DEFAULT_SHEET_HEIGHT_PX = 560;
const MIN_SHEET_WIDTH_PX = 300;
const MIN_SHEET_HEIGHT_PX = 280;
/** Header + divider + control row + vertical padding — keeps the roster from covering chips. */
const SHEET_CHROME_HEIGHT_PX = 196;
const VOICE_SIZE_STORAGE_KEY = "hsp.voiceChatDialog.size.v1";
const VOICE_SPEAKING_MIC_COLOR = "#34C759";

const AH = layout.authenticatedHome;
const HIT = AH.splitPaneDividerHitWidthPx;
const STROKE = AH.splitPaneDividerStrokePx;

type Edge = "n" | "s" | "e" | "w";
type ResizeHandle = Edge | "ne" | "nw" | "se" | "sw";

type Props = {
  /** Bumps when the sheet reopens so the portal remounts cleanly. */
  mountKey?: number;
  /**
   * Increments on every open request from the parent. Clears a stuck
   * forceClosed latch when Close mid-join left React `visible` true in the DOM.
   */
  openSeq?: number;
  visible: boolean;
  onClose: () => void;
  title: string;
  /** TDLib/call total when larger than the loaded `participants` list. */
  participantCount?: number;
  participants: TelegramChatVoiceParticipant[];
  /** Merged speaking map + row flag (green mic / avatar ring). */
  isParticipantSpeaking?: (participant: TelegramChatVoiceParticipant) => boolean;
  colors: ThemeColors;
  micActive: boolean;
  micJoining: boolean;
  onMicPress: () => void;
  cameraActive: boolean;
  onCameraPress: () => void;
  screenSharing: boolean;
  onStartScreenShare: () => void;
  onStopScreenShare: () => void;
  onDropPress: () => void;
  dropLeaving: boolean;
  /** Remote camera / screenshare for the in-dialog video plane. */
  remoteVideoStream?: MediaStream | null;
  localCameraStream?: MediaStream | null;
  localScreenStream?: MediaStream | null;
  videoActive?: boolean;
};

type SheetSize = { width: number; height: number };

function readStoredSize(): SheetSize | null {
  if (Platform.OS !== "web" || typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(VOICE_SIZE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { width?: unknown; height?: unknown };
    const width = Number(parsed.width);
    const height = Number(parsed.height);
    if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
    return { width: Math.round(width), height: Math.round(height) };
  } catch {
    return null;
  }
}

function writeStoredSize(size: SheetSize): void {
  if (Platform.OS !== "web" || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(VOICE_SIZE_STORAGE_KEY, JSON.stringify(size));
  } catch {
    // ignore quota / private mode
  }
}

function edgesForHandle(handle: ResizeHandle): Edge[] {
  if (handle === "n" || handle === "s" || handle === "e" || handle === "w") return [handle];
  if (handle === "ne") return ["n", "e"];
  if (handle === "nw") return ["n", "w"];
  if (handle === "se") return ["s", "e"];
  return ["s", "w"];
}

function cursorForHandle(handle: ResizeHandle): string {
  switch (handle) {
    case "n":
    case "s":
      return "row-resize";
    case "e":
    case "w":
      return "col-resize";
    case "ne":
    case "sw":
      return "nesw-resize";
    default:
      return "nwse-resize";
  }
}

const VoiceParticipantRow = memo(function VoiceParticipantRow({
  participant,
  isLast,
  colors,
  isSpeaking,
}: {
  participant: TelegramChatVoiceParticipant;
  isLast: boolean;
  colors: ThemeColors;
  isSpeaking: boolean;
}) {
  const { colorScheme } = useTelegram();
  const title =
    participant.title.trim() ||
    (participant.user_id != null ? `User ${participant.user_id}` : "") ||
    (participant.chat_id != null ? `Chat ${Math.abs(participant.chat_id)}` : "") ||
    "?";
  const description = participant.description.trim();
  const avatarUrl = resolveTelegramUserAvatarUrl(participant);
  const speaking = isSpeaking;
  const textBase = {
    fontFamily: Platform.OS === "web" ? WEB_UI_SANS_STACK : FONT_UI_SANS_REGULAR,
    fontSize: MESSAGE_FONT_SIZE_PX,
    lineHeight: MESSAGE_LINE_HEIGHT_PX,
    includeFontPadding: false,
    paddingVertical: 0,
  } as const;

  return (
    <View
      {...(Platform.OS === "web"
        ? ({ "data-voice-participant-row": title } as object)
        : {})}
      testID="voice-participant-row"
      style={{
        flexDirection: "row",
        alignItems: "center",
        minHeight: description ? 48 : 40,
        width: "100%",
        marginBottom: isLast ? 0 : 10,
      }}
    >
      <View
        style={{
          width: MESSAGE_AVATAR_PX,
          height: MESSAGE_AVATAR_PX,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: MESSAGE_AVATAR_PX / 2,
          borderWidth: speaking ? 2 : 0,
          borderColor: VOICE_SPEAKING_MIC_COLOR,
          backgroundColor: colors.background,
          overflow: "hidden",
          flexShrink: 0,
        }}
      >
        <MessageChatAvatarSlot
          iconUrl={avatarUrl}
          initials={extractChatAvatarInitials(title)}
          sizePx={MESSAGE_AVATAR_PX}
          colors={colors}
          scheme={colorScheme}
          fetchPriority="normal"
        />
      </View>
      <View style={{ width: MESSAGE_ICON_TEXT_GAP_PX }} />
      <View style={{ flex: 1, minWidth: 0, justifyContent: "center" }}>
        <SpecialTelegramUserName
          name={title}
          telegramUserId={participant.user_id}
          telegramChatId={participant.chat_id}
          emojiStatusCustomEmojiId={participant.emoji_status_custom_emoji_id}
          emojiStatusPriority={false}
          // Lottie/TGS fetch+animate per row stalls the main thread in a long call.
          inlineEmojiFetchEnabled={false}
          inlineEmojiFetchPriority={false}
          inlineEmojiSizePx={MESSAGE_LIST_INLINE_EMOJI_SIZE_PX}
          textAlign="left"
          numberOfLines={1}
          textStyle={{
            ...textBase,
            color: colors.primary,
          }}
        />
        {description ? (
          <Text
            numberOfLines={1}
            ellipsizeMode="tail"
            style={{
              ...textBase,
              color: colors.secondary,
              maxWidth: "100%",
            }}
          >
            {description}
          </Text>
        ) : null}
      </View>
      <View
        accessibilityRole="image"
        style={{
          width: 28,
          height: 28,
          alignItems: "center",
          justifyContent: "center",
          marginLeft: 8,
          flexShrink: 0,
        }}
      >
        <VoiceParticipantStateMicIcon
          speaking={speaking}
          muted={Boolean(participant.is_muted) && !speaking}
          color={colors.primary}
          size={20}
        />
      </View>
    </View>
  );
});

function VoiceControlChip({
  label,
  onPress,
  disabled,
  children,
  undercoverColor,
  phaseOffset,
  isLightTheme,
  variant,
  testId,
}: {
  label: string;
  onPress?: () => void;
  disabled?: boolean;
  children: ReactNode;
  undercoverColor?: string;
  phaseOffset?: number;
  isLightTheme?: boolean;
  variant: "simple" | "liquid";
  /** Stable id for capture-phase pointer handlers while React is busy. */
  testId?: string;
}) {
  const chipBody =
    variant === "liquid" ? (
      <LiquidGlassShaderUndercover
        size={CONTROL_CHIP_PX}
        phaseOffset={phaseOffset ?? 0.38}
        isLightTheme={isLightTheme ?? false}
      >
        {children}
      </LiquidGlassShaderUndercover>
    ) : (
      <View
        style={{
          width: CONTROL_CHIP_PX,
          height: CONTROL_CHIP_PX,
          borderRadius: CONTROL_CHIP_PX / 2,
          backgroundColor: undercoverColor ?? "#323232",
          alignItems: "center",
          justifyContent: "center",
          // Icons must not steal hits from the native <button> wrapper.
          ...(Platform.OS === "web" ? ({ pointerEvents: "none" } as object) : {}),
        }}
      >
        {children}
      </View>
    );

  if (Platform.OS === "web") {
    // Native <button> — RN Pressable misses clicks while roster/WebRTC work
    // stalls the main thread (same fix as window chrome close).
    return createElement(
      "button",
      {
        type: "button",
        "aria-label": label,
        title: label,
        "data-voice-control": testId ?? "chip",
        disabled: Boolean(disabled),
        onPointerDown: (e: {
          stopPropagation?: () => void;
          preventDefault?: () => void;
          button?: number;
        }) => {
          e.stopPropagation?.();
          if (disabled) return;
          if (e.button == null || e.button === 0) {
            e.preventDefault?.();
            onPress?.();
          }
        },
        onClick: (e: { stopPropagation?: () => void; preventDefault?: () => void }) => {
          e.stopPropagation?.();
          e.preventDefault?.();
        },
        style: {
          width: CONTROL_CHIP_PX,
          height: CONTROL_CHIP_PX,
          margin: 0,
          padding: 0,
          border: "none",
          background: "transparent",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          cursor: disabled ? "default" : "pointer",
          opacity: disabled ? 0.5 : 1,
          position: "relative",
          zIndex: 30,
          WebkitAppearance: "none",
          appearance: "none",
          touchAction: "manipulation",
        },
      },
      createElement("span", { style: { pointerEvents: "none", display: "flex" } }, chipBody),
    );
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: Boolean(disabled) }}
      onPress={onPress}
      disabled={disabled}
      hitSlop={4}
      style={({ pressed }) => ({
        opacity: disabled ? 0.5 : pressed ? 0.75 : 1,
        zIndex: 30,
      })}
    >
      {chipBody}
    </Pressable>
  );
}

function ResizeEdgeHandle({
  handle,
  onHoverChange,
  onPointerDown,
}: {
  handle: ResizeHandle;
  onHoverChange: (hovered: boolean) => void;
  onPointerDown: (e: {
    nativeEvent: { clientX: number; clientY: number; pointerId: number; preventDefault?: () => void };
    currentTarget?: unknown;
  }) => void;
}) {
  const half = HIT / 2;
  const webPointerProps =
    Platform.OS === "web"
      ? ({
          onPointerDown,
          onPointerEnter: () => onHoverChange(true),
          onPointerLeave: () => onHoverChange(false),
        } as object)
      : {};
  const base: ViewStyle = {
    position: "absolute",
    zIndex: 2,
    ...(Platform.OS === "web"
      ? ({
          cursor: cursorForHandle(handle),
          touchAction: "none",
          userSelect: "none",
        } as object)
      : {}),
  };

  // South edge: two side strips so the bottom control chips stay clickable.
  if (handle === "s") {
    const sideWidth = Math.max(HIT * 2, 48);
    return (
      <>
        <View
          style={[
            base,
            {
              bottom: -half,
              left: HIT,
              width: sideWidth,
              height: HIT,
            },
          ]}
          {...webPointerProps}
        />
        <View
          style={[
            base,
            {
              bottom: -half,
              right: HIT,
              width: sideWidth,
              height: HIT,
            },
          ]}
          {...webPointerProps}
        />
      </>
    );
  }

  let geometry: ViewStyle;
  switch (handle) {
    case "n":
      // Leave the top-right window controls (close / size / tray) clickable.
      geometry = {
        top: -half,
        left: HIT,
        right: HIT + WINDOW_CONTROLS_RESERVE_PX,
        height: HIT,
      };
      break;
    case "e":
      // Start below the header row so east-edge drag does not cover close.
      geometry = {
        top: HIT + 52,
        bottom: HIT + CONTROL_CHIP_PX,
        right: -half,
        width: HIT,
      };
      break;
    case "w":
      geometry = {
        top: HIT,
        bottom: HIT + CONTROL_CHIP_PX,
        left: -half,
        width: HIT,
      };
      break;
    case "ne":
      // Keep NE away from the close cluster — NW still covers the true corner.
      geometry = {
        top: -half,
        right: -half,
        width: HIT,
        height: HIT,
        // Invisible and non-interactive; N + E edges still resize this corner.
        pointerEvents: "none",
        opacity: 0,
      };
      break;
    case "nw":
      geometry = { top: -half, left: -half, width: HIT, height: HIT };
      break;
    case "se":
      geometry = { bottom: -half, right: -half, width: HIT, height: HIT };
      break;
    default:
      geometry = { bottom: -half, left: -half, width: HIT, height: HIT };
      break;
  }

  return <View style={[base, geometry]} {...webPointerProps} />;
}

/** Settings-style modal for an active chat voice call. */
export function MessageChatVoicePopover({
  mountKey = 0,
  openSeq = 0,
  visible,
  onClose,
  title,
  participantCount,
  participants,
  isParticipantSpeaking,
  colors,
  micActive,
  micJoining: _micJoining,
  onMicPress,
  cameraActive,
  onCameraPress,
  screenSharing,
  onStartScreenShare,
  onStopScreenShare,
  onDropPress,
  dropLeaving,
  remoteVideoStream = null,
  localCameraStream = null,
  localScreenStream = null,
  videoActive = false,
}: Props) {
  const { t, tf, locale } = useAppStrings();
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const isLightTheme = colors.primary === "#000000";
  const iconColor = colors.primary;
  const chatTitle = title.trim() || t("messages.voiceChat.active");
  const totalParticipantCount = Math.max(
    typeof participantCount === "number" ? participantCount : 0,
    participants.length,
  );
  const participantCountLabel =
    totalParticipantCount > 0
      ? tf("messages.chatMemberCount.participants", {
          count: totalParticipantCount.toLocaleString(locale === "ru" ? "ru-RU" : "en-US"),
        })
      : "";
  const [moreMenuAnchor, setMoreMenuAnchor] = useState<VoiceMoreMenuAnchor | null>(null);
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(() =>
    Platform.OS === "web" && typeof document !== "undefined" ? document.body : null,
  );
  const moreChipRef = useRef<View | null>(null);
  /** Keep portal mounted briefly after close so roster unmount cannot freeze reopen. */
  const [portalMounted, setPortalMounted] = useState(visible);
  /** Drop roster/media on hide immediately — empty shell teardown is cheap. */
  const [suspendHeavy, setSuspendHeavy] = useState(false);
  const portalRootRef = useRef<HTMLDivElement | null>(null);
  /** Set synchronously on Close/Escape so React re-renders cannot revive "open". */
  const forceClosedRef = useRef(false);
  /** Tracks last `visible` for false→true only — never clear forceClosed while still open. */
  const wasVisibleRef = useRef(visible);
  const [, bumpForceClosed] = useState(0);

  const applyPortalOpenAttr = useCallback((node: HTMLDivElement | null, open: boolean) => {
    if (!node) return;
    node.setAttribute("data-voice-dialog", open ? "open" : "closed");
    if (open) {
      node.removeAttribute("aria-hidden");
      node.removeAttribute("inert");
      node.style.display = "flex";
      node.style.visibility = "visible";
      node.style.opacity = "1";
      node.style.pointerEvents = "auto";
    } else {
      node.setAttribute("aria-hidden", "true");
      node.setAttribute("inert", "");
      // display:none — opacity alone still lets WebGL/LiquidGlass composite on screen.
      node.style.display = "none";
      node.style.visibility = "hidden";
      node.style.opacity = "0";
      node.style.pointerEvents = "none";
    }
  }, []);

  useEffect(() => {
    if (Platform.OS === "web" && typeof document !== "undefined") {
      setPortalTarget(document.body);
    }
  }, []);

  useLayoutEffect(() => {
    if (Platform.OS !== "web") return;
    const opening = visible && !wasVisibleRef.current;
    wasVisibleRef.current = visible;
    // Only clear force-closed on a real open transition. Clearing whenever
    // visible===true revived the sheet: Close set forceClosed, bumpForceClosed
    // re-rendered while parent visible was still true, layout effect cleared the
    // flag, and the dialog snapped back open before flushSync onClose ran.
    if (opening) {
      forceClosedRef.current = false;
    }
    applyPortalOpenAttr(portalRootRef.current, visible && !forceClosedRef.current);
  }, [visible, applyPortalOpenAttr]);

  // Parent bumps openSeq on every open request. That recovers when Close left
  // forceClosed latched and React `visible` never got a clean false→true edge
  // (close mid-join / reopen while portal still thought it was open).
  const lastAppliedOpenSeqRef = useRef(0);
  const pendingOpenSeqRef = useRef(0);
  useLayoutEffect(() => {
    if (Platform.OS !== "web") return;
    if (openSeq > pendingOpenSeqRef.current) {
      pendingOpenSeqRef.current = openSeq;
      forceClosedRef.current = false;
    }
    if (pendingOpenSeqRef.current <= lastAppliedOpenSeqRef.current) return;
    if (!visible) {
      logPageDisplay("messages_voice_dialog_open_seq", {
        openSeq: pendingOpenSeqRef.current,
        visible: false,
        note: "cleared forceClosed; waiting for visible",
      });
      return;
    }
    lastAppliedOpenSeqRef.current = pendingOpenSeqRef.current;
    setSuspendHeavy(false);
    setPortalMounted(true);
    applyPortalOpenAttr(portalRootRef.current, true);
    bumpForceClosed((n) => n + 1);
    logPageDisplay("messages_voice_dialog_open_seq", {
      openSeq: pendingOpenSeqRef.current,
      visible: true,
      note: "cleared forceClosed latch for reopen",
    });
  }, [openSeq, visible, applyPortalOpenAttr]);

  useEffect(() => {
    if (visible && !forceClosedRef.current) {
      setSuspendHeavy(false);
      setPortalMounted(true);
      return;
    }
    if (visible && forceClosedRef.current) {
      // Parent still reports open; keep DOM/heavy suppressed until visible flips
      // or openSeq clears the latch above.
      applyPortalOpenAttr(portalRootRef.current, false);
      return;
    }
    // Keep sheet children mounted briefly after Close — unmounting LiquidGlass /
    // video while WebRTC createOffer runs wedged the tab for 10–20s. Hide is
    // already display:none; tear down heavy UI after a short paint settle.
    const heavyTimer = setTimeout(() => setSuspendHeavy(true), 120);
    const timer = setTimeout(() => {
      setPortalMounted(false);
      forceClosedRef.current = false;
    }, 480);
    return () => {
      clearTimeout(heavyTimer);
      clearTimeout(timer);
    };
  }, [visible, applyPortalOpenAttr]);

  useEffect(() => {
    if (!visible) setMoreMenuAnchor(null);
  }, [visible]);

  // Escape / Alt+F4-style close that does not depend on the chrome button being
  // able to receive pointer events while React is busy painting the roster.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const requestClose = useCallback((source: string) => {
    // pointerdown + click both fire on the native Close button — only act once.
    if (forceClosedRef.current) {
      logPageDisplay("messages_voice_dialog_close_click", {
        source,
        ignored: "already_closing",
      });
      return;
    }
    logPageDisplay("messages_voice_dialog_close_click", { source });
    // Mark closed in the DOM immediately — React state from a native window
    // listener can lag under longtasks, which left data-voice-dialog="open".
    forceClosedRef.current = true;
    applyPortalOpenAttr(portalRootRef.current, false);
    // Drop sheet body on this render (ref alone would not re-render) and flush
    // parent open=false in the same turn so layout cannot revive "open".
    if (Platform.OS === "web") {
      try {
        flushSync(() => {
          bumpForceClosed((n) => n + 1);
          onCloseRef.current();
        });
      } catch {
        bumpForceClosed((n) => n + 1);
        onCloseRef.current();
      }
    } else {
      bumpForceClosed((n) => n + 1);
      onCloseRef.current();
    }
    // After the closed frame paints, drop WebGL/roster so close stays visible.
    if (typeof window !== "undefined") {
      window.requestAnimationFrame(() => {
        setSuspendHeavy(true);
      });
    } else {
      setSuspendHeavy(true);
    }
  }, [applyPortalOpenAttr]);
  useEffect(() => {
    if (!visible || Platform.OS !== "web" || typeof window === "undefined") return;
    const closeNow = (source: string) => {
      requestClose(source);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "Esc") {
        e.preventDefault();
        e.stopPropagation();
        closeNow("escape_key");
      }
    };
    // Capture-phase handlers — survive React re-render storms and RN Pressable
    // missing clicks (backdrop used to be RN-only and dropped Close/backdrop).
    const onPointer = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const target = e.target as Element | null;
      if (!target || typeof target.closest !== "function") return;
      if (target.closest('[data-voice-chrome="close"]')) {
        e.stopPropagation();
        closeNow("chrome_x_capture");
        return;
      }
      if (target.closest('[data-voice-chrome="backdrop"]')) {
        e.stopPropagation();
        closeNow("backdrop_capture");
      }
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onPointer, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onPointer, true);
    };
  }, [visible, requestClose]);

  const maxWidth = Math.max(
    MIN_SHEET_WIDTH_PX,
    windowWidth - 2 * layout.contentSideInsetPx,
  );
  const maxHeight = Math.max(
    MIN_SHEET_HEIGHT_PX,
    windowHeight - 2 * layout.contentSideInsetPx,
  );

  const clampSize = useCallback(
    (size: SheetSize): SheetSize => ({
      width: Math.min(maxWidth, Math.max(MIN_SHEET_WIDTH_PX, Math.round(size.width))),
      height: Math.min(maxHeight, Math.max(MIN_SHEET_HEIGHT_PX, Math.round(size.height))),
    }),
    [maxHeight, maxWidth],
  );

  const [sheetSize, setSheetSize] = useState<SheetSize>(() =>
    clampSize({
      width: Math.min(DEFAULT_SHEET_WIDTH_PX, maxWidth),
      height: Math.min(DEFAULT_SHEET_HEIGHT_PX, maxHeight),
    }),
  );
  const [hoveredHandle, setHoveredHandle] = useState<ResizeHandle | null>(null);
  const [draggingHandle, setDraggingHandle] = useState<ResizeHandle | null>(null);
  const dragRef = useRef<{
    handle: ResizeHandle;
    startX: number;
    startY: number;
    startWidth: number;
    startHeight: number;
    pointerId: number;
    host: { setPointerCapture?: (id: number) => void; releasePointerCapture?: (id: number) => void } | null;
  } | null>(null);
  const sheetSizeRef = useRef(sheetSize);
  sheetSizeRef.current = sheetSize;

  useEffect(() => {
    const stored = readStoredSize();
    if (stored) setSheetSize(clampSize(stored));
  }, [clampSize]);

  useEffect(() => {
    setSheetSize((prev) => clampSize(prev));
  }, [clampSize]);

  const activeEdges = useMemo(() => {
    const edges = new Set<Edge>();
    if (hoveredHandle) for (const edge of edgesForHandle(hoveredHandle)) edges.add(edge);
    if (draggingHandle) for (const edge of edgesForHandle(draggingHandle)) edges.add(edge);
    return edges;
  }, [draggingHandle, hoveredHandle]);

  const borderColors = {
    borderTopColor: activeEdges.has("n") ? colors.primary : colors.highlight,
    borderRightColor: activeEdges.has("e") ? colors.primary : colors.highlight,
    borderBottomColor: activeEdges.has("s") ? colors.primary : colors.highlight,
    borderLeftColor: activeEdges.has("w") ? colors.primary : colors.highlight,
  };

  const endDrag = useCallback(() => {
    const drag = dragRef.current;
    if (drag?.host && typeof drag.host.releasePointerCapture === "function") {
      try {
        drag.host.releasePointerCapture(drag.pointerId);
      } catch {
        // ignore
      }
    }
    dragRef.current = null;
    setDraggingHandle(null);
    writeStoredSize(sheetSizeRef.current);
  }, []);

  useEffect(() => {
    if (visible) return;
    endDrag();
  }, [visible, endDrag]);

  useEffect(() => {
    if (Platform.OS !== "web" || typeof window === "undefined") return;
    const onMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      let nextWidth = drag.startWidth;
      let nextHeight = drag.startHeight;
      const edges = edgesForHandle(drag.handle);
      if (edges.includes("e")) nextWidth = drag.startWidth + dx;
      if (edges.includes("w")) nextWidth = drag.startWidth - dx;
      if (edges.includes("s")) nextHeight = drag.startHeight + dy;
      if (edges.includes("n")) nextHeight = drag.startHeight - dy;
      setSheetSize(clampSize({ width: nextWidth, height: nextHeight }));
    };
    const onUp = () => {
      if (dragRef.current) endDrag();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [clampSize, endDrag]);

  const beginDrag = useCallback(
    (
      handle: ResizeHandle,
      e: {
        nativeEvent: {
          clientX: number;
          clientY: number;
          pointerId: number;
          preventDefault?: () => void;
        };
        currentTarget?: unknown;
      },
    ) => {
      e.nativeEvent.preventDefault?.();
      const host = e.currentTarget as {
        setPointerCapture?: (id: number) => void;
        releasePointerCapture?: (id: number) => void;
      } | null;
      if (host && typeof host.setPointerCapture === "function") {
        try {
          host.setPointerCapture(e.nativeEvent.pointerId);
        } catch {
          // ignore
        }
      }
      dragRef.current = {
        handle,
        startX: e.nativeEvent.clientX,
        startY: e.nativeEvent.clientY,
        startWidth: sheetSizeRef.current.width,
        startHeight: sheetSizeRef.current.height,
        pointerId: e.nativeEvent.pointerId,
        host,
      };
      setDraggingHandle(handle);
    },
    [],
  );

  const expandToDefault = useCallback(() => {
    const next = clampSize({
      width: Math.min(DEFAULT_SHEET_WIDTH_PX, maxWidth),
      height: Math.min(DEFAULT_SHEET_HEIGHT_PX, maxHeight),
    });
    setSheetSize(next);
    writeStoredSize(next);
  }, [clampSize, maxHeight, maxWidth]);

  const minimizeSheet = useCallback(() => {
    const next = clampSize({
      width: sheetSizeRef.current.width,
      height: SHEET_CHROME_HEIGHT_PX,
    });
    setSheetSize(next);
    writeStoredSize(next);
  }, [clampSize]);

  const openMoreMenu = useCallback(() => {
    const node = moreChipRef.current as unknown as {
      measureInWindow?: (cb: (x: number, y: number, width: number, height: number) => void) => void;
    } | null;
    if (node && typeof node.measureInWindow === "function") {
      node.measureInWindow((x, y, _width, height) => {
        setMoreMenuAnchor({
          x: Math.round(x),
          y: Math.round(y + height + 6),
        });
      });
      return;
    }
    setMoreMenuAnchor({
      x: Math.round(windowWidth / 2 - 60),
      y: Math.round(windowHeight / 2),
    });
  }, [windowHeight, windowWidth]);

  const mediaSources = useMemo((): VoiceMediaStageSource[] => {
    const rows: VoiceMediaStageSource[] = [];
    // Remote presentation first (tdesktop docks screencast above local previews).
    // Previously remote was skipped whenever any local camera/screen was active,
    // so an active participant screencast never appeared in the dialog.
    if (remoteVideoStream) {
      const tracks = remoteVideoStream
        .getVideoTracks()
        .filter((track) => track.readyState === "live");
      if (tracks.length <= 1) {
        rows.push({ id: "remote", stream: remoteVideoStream });
      } else {
        for (const [index, track] of tracks.entries()) {
          rows.push({
            id: `remote:${track.id || index}`,
            stream: new MediaStream([track]),
          });
        }
      }
    }
    if (localScreenStream) {
      rows.push({ id: "local-screen", stream: localScreenStream });
    }
    if (localCameraStream) {
      rows.push({ id: "local-camera", stream: localCameraStream });
    }
    return rows;
  }, [localCameraStream, localScreenStream, remoteVideoStream]);

  const listMaxHeight = Math.max(80, sheetSize.height - SHEET_CHROME_HEIGHT_PX);
  const handles: ResizeHandle[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];
  const displayParticipants = useMemo(
    // Preserve incoming order — do not re-sort by speaking (tdesktop parity).
    // While hiding, drop rows immediately so delayed portal unmount is cheap.
    () => (suspendHeavy ? [] : participants.slice(0, 64)),
    [participants, suspendHeavy],
  );

  const moreMenuItems = useMemo(
    () => [
      {
        key: "share",
        label: screenSharing
          ? t("messages.voiceChat.controls.stopSharing")
          : t("messages.voiceChat.controls.startSharing"),
        onPress: () => {
          setMoreMenuAnchor(null);
          if (screenSharing) onStopScreenShare();
          else onStartScreenShare();
        },
      },
      {
        key: "settings",
        label: t("messages.voiceChat.controls.settingsSoon"),
        disabled: true,
      },
    ],
    [onStartScreenShare, onStopScreenShare, screenSharing, t],
  );

  const sheetBody = (
    <View
      pointerEvents="box-none"
      style={[
        appModalSheetStyles.overlayBlock,
        {
          minHeight: windowHeight,
          zIndex: 2,
        },
      ]}
    >
      {Platform.OS === "web"
        ? createElement("button", {
            type: "button",
            "aria-label": t("common.back"),
            "data-voice-chrome": "backdrop",
            tabIndex: -1,
            onPointerDown: (e: {
              button?: number;
              stopPropagation?: () => void;
            }) => {
              if (e.button != null && e.button !== 0) return;
              e.stopPropagation?.();
              requestClose("backdrop");
            },
            style: {
              position: "absolute",
              left: 0,
              top: 0,
              right: 0,
              bottom: 0,
              margin: 0,
              padding: 0,
              border: "none",
              cursor: "pointer",
              background: "rgba(0,0,0,0.45)",
              zIndex: 0,
            },
          })
        : (
          <Pressable
            style={[appModalSheetStyles.backdropFill, { zIndex: 0 }]}
            onPress={() => {
              requestClose("backdrop");
            }}
            accessibilityRole="button"
            accessibilityLabel={t("common.back")}
          />
        )}
      <View
        pointerEvents="auto"
        style={[
          appModalSheetStyles.sheet,
          {
            width: sheetSize.width,
            maxWidth: sheetSize.width,
            height: sheetSize.height,
            maxHeight: sheetSize.height,
            backgroundColor: colors.background,
            borderColor: colors.highlight,
            borderWidth: STROKE,
            ...borderColors,
            paddingTop: 20,
            paddingBottom: 20,
            // Visible so edge resize hit strips outside the border still receive events.
            overflow: "visible",
            zIndex: 5,
            ...(Platform.OS === "web"
              ? ({
                  position: "relative",
                  isolation: "isolate",
                  display: "flex",
                  flexDirection: "column",
                } as object)
              : {
                  flexDirection: "column",
                }),
          },
        ]}
        {...(Platform.OS === "web"
          ? ({
              "data-voice-sheet": "1",
              onClick: (e: { stopPropagation?: () => void }) => e.stopPropagation?.(),
              onPointerDown: (e: { stopPropagation?: () => void }) => e.stopPropagation?.(),
            } as object)
          : {
              onStartShouldSetResponder: () => true,
            })}
      >
        {Platform.OS === "web"
          ? handles.map((handle) => (
              <ResizeEdgeHandle
                key={handle}
                handle={handle}
                onHoverChange={(hovered) =>
                  setHoveredHandle((prev) => {
                    if (hovered) return handle;
                    return prev === handle ? null : prev;
                  })
                }
                onPointerDown={(e) => beginDrag(handle, e)}
              />
            ))
          : null}

        <View
          pointerEvents="box-none"
          style={{
            flexDirection: "row",
            alignItems: "center",
            paddingHorizontal: 20,
            marginBottom: 16,
            gap: 12,
            zIndex: 10000,
            ...(Platform.OS === "web" ? ({ position: "relative" } as object) : {}),
          }}
        >
          <View style={{ flex: 1, minWidth: 0 }} pointerEvents="none">
            <Text
              numberOfLines={1}
              style={[
                typographyRect15,
                { color: colors.primary, marginBottom: 0 },
              ]}
            >
              {chatTitle}
            </Text>
            {participantCountLabel ? (
              <Text
                numberOfLines={1}
                style={[
                  typographyRect15,
                  {
                    color: colors.secondary,
                    marginBottom: 0,
                    marginTop: 2,
                    fontSize: 13,
                    lineHeight: 16,
                  },
                ]}
              >
                {participantCountLabel}
              </Text>
            ) : null}
          </View>
          <View
            pointerEvents="auto"
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: WINDOW_ICON_GAP_PX,
              flexShrink: 0,
              zIndex: 10000,
              ...(Platform.OS === "web" ? ({ position: "relative" } as object) : {}),
            }}
          >
            <VoiceWindowChromeButton
              label={t("messages.voiceChat.minimize")}
              hitExtraPx={4}
              onPress={minimizeSheet}
            >
              <VoiceWindowTrayIcon color={iconColor} size={WINDOW_ICON_SIZE_PX} />
            </VoiceWindowChromeButton>
            <VoiceWindowChromeButton
              label={t("messages.voiceChat.expand")}
              hitExtraPx={4}
              onPress={expandToDefault}
            >
              <VoiceWindowSizeIcon color={iconColor} size={WINDOW_ICON_SIZE_PX} />
            </VoiceWindowChromeButton>
            <VoiceWindowChromeButton
              label={t("common.back")}
              hitExtraPx={8}
              testId="close"
              onPress={() => {
                requestClose("chrome_x");
              }}
            >
              <VoiceWindowCrossIcon color={iconColor} size={WINDOW_ICON_SIZE_PX} />
            </VoiceWindowChromeButton>
          </View>
        </View>

        <MessageChatVoiceMediaStage
          sources={suspendHeavy ? [] : mediaSources}
          // Local previews (own screencast / camera) must not wait for the remote
          // `videoActive` join flag — sharing starts capturing immediately.
          active={Boolean(
            visible &&
              !suspendHeavy &&
              mediaSources.length > 0 &&
              (videoActive || localScreenStream != null || localCameraStream != null),
          )}
          maxHeightPx={Math.min(220, MESSAGE_CHAT_VOICE_VIDEO_MAX_HEIGHT_PX)}
          horizontalInsetPx={20}
          marginBottomPx={16}
        />

        <View
          style={{
            paddingHorizontal: 20,
            flex: 1,
            minHeight: 0,
            maxHeight: listMaxHeight,
            zIndex: 1,
            overflow: "hidden",
          }}
          pointerEvents="auto"
        >
          <ScrollView style={{ flex: 1, maxHeight: listMaxHeight }} nestedScrollEnabled>
            {displayParticipants.length > 0 ? (
              displayParticipants.map((participant, index) => (
                <VoiceParticipantRow
                  key={
                    participant.user_id != null
                      ? `u:${participant.user_id}`
                      : `c:${participant.chat_id}:${index}`
                  }
                  participant={participant}
                  isLast={index === displayParticipants.length - 1}
                  colors={colors}
                  isSpeaking={
                    isParticipantSpeaking
                      ? isParticipantSpeaking(participant)
                      : Boolean(participant.is_speaking)
                  }
                />
              ))
            ) : (
              <Text style={[typographyRect15, { color: colors.secondary }]}>
                {participantCountLabel || t("messages.voiceChat.participants")}
              </Text>
            )}
          </ScrollView>
        </View>

        <View
          style={{
            height: 1,
            marginTop: 16,
            marginBottom: 16,
            marginHorizontal: DIVIDER_INSET_PX,
            backgroundColor: colors.highlight,
            flexShrink: 0,
          }}
        />

        <View
          pointerEvents="auto"
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "center",
            gap: CONTROL_CHIP_GAP_PX,
            paddingHorizontal: 20,
            zIndex: 40,
            flexShrink: 0,
            ...(Platform.OS === "web"
              ? ({ direction: "ltr", position: "relative" } as object)
              : {}),
          }}
        >
          <View ref={moreChipRef} collapsable={false}>
            <VoiceControlChip
              key="more"
              testId="more"
              label={t("messages.voiceChat.controls.more")}
              variant="simple"
              undercoverColor={colors.undercover}
              onPress={() => {
                logPageDisplay("messages_voice_dialog_control_click", {
                  action: "more",
                });
                openMoreMenu();
              }}
            >
              <VoiceMoreIcon color={iconColor} size={CONTROL_ICON_PX} />
            </VoiceControlChip>
          </View>
          <VoiceControlChip
            key="video"
            testId="camera"
            label={t("messages.voiceChat.controls.camera")}
            variant="simple"
            undercoverColor={colors.undercover}
            onPress={() => {
              logPageDisplay("messages_voice_dialog_control_click", {
                action: "camera",
              });
              onCameraPress();
            }}
          >
            <VoiceCameraIcon
              color={iconColor}
              size={CONTROL_ICON_PX}
              muted={!cameraActive}
            />
          </VoiceControlChip>
          <VoiceControlChip
            key="mic"
            testId="mic"
            label={t("messages.voiceChat.controls.mic")}
            variant="simple"
            undercoverColor={colors.undercover}
            isLightTheme={isLightTheme}
            phaseOffset={0.38}
            onPress={() => {
              logPageDisplay("messages_voice_dialog_control_click", {
                action: "mic",
              });
              onMicPress();
            }}
          >
            <VoiceMicControlIcon
              color={iconColor}
              size={CONTROL_ICON_PX}
              muted={!micActive}
            />
          </VoiceControlChip>
          <VoiceControlChip
            key="chat"
            testId="messages"
            label={t("messages.voiceChat.controls.messages")}
            variant="simple"
            undercoverColor={colors.undercover}
            onPress={() => {
              requestClose("messages_chip");
            }}
          >
            <VoiceMessagesIcon color={iconColor} size={CONTROL_ICON_PX} />
          </VoiceControlChip>
          <VoiceControlChip
            key="phone"
            testId="drop"
            label={t("messages.voiceChat.controls.drop")}
            variant="simple"
            undercoverColor={colors.undercover}
            onPress={() => {
              logPageDisplay("messages_voice_dialog_control_click", {
                action: "drop",
              });
              onDropPress();
            }}
            disabled={dropLeaving}
          >
            <VoiceDropIcon color={iconColor} size={CONTROL_ICON_PX} />
          </VoiceControlChip>
        </View>
      </View>
      <MessageChatVoiceMoreMenu
        visible={moreMenuAnchor != null}
        anchor={moreMenuAnchor}
        colors={colors}
        items={moreMenuItems}
        onClose={() => setMoreMenuAnchor(null)}
      />
    </View>
  );

  if (!visible && !portalMounted) return null;

  if (Platform.OS === "web") {
    if (!portalTarget) return null;
    const dialogOpen = visible && !forceClosedRef.current;
    // Native div root — RN View no longer forwards data-* attrs to the DOM,
    // which broke open/close detection and click-through guards.
    return createPortal(
      createElement(
        "div",
        {
          key: `voice-dialog-${mountKey}`,
          ref: (node: HTMLDivElement | null) => {
            portalRootRef.current = node;
            applyPortalOpenAttr(node, visible && !forceClosedRef.current);
          },
          "data-voice-dialog": dialogOpen ? "open" : "closed",
          ...(dialogOpen ? {} : { "aria-hidden": true, inert: true }),
          style: {
            position: "fixed",
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
            zIndex: 9000,
            height: windowHeight,
            width: "100%",
            display: dialogOpen ? "flex" : "none",
            justifyContent: "center",
            alignItems: "center",
            visibility: dialogOpen ? "visible" : "hidden",
            opacity: dialogOpen ? 1 : 0,
            pointerEvents: dialogOpen ? "auto" : "none",
          },
        },
        // Hide via opacity/pointer-events only. Dropping sheetBody on Close while
        // WebRTC was mid-offer froze the renderer so reopen clicks could not run.
        suspendHeavy ? null : sheetBody,
      ),
      portalTarget,
    );
  }

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View
        style={{
          height: windowHeight,
          width: "100%",
          minHeight: windowHeight,
          justifyContent: "center",
          alignItems: "center",
        }}
        pointerEvents="box-none"
      >
        {sheetBody}
      </View>
    </Modal>
  );
}
