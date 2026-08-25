import { createElement, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal, flushSync } from "react-dom";
import {
  Modal,
  Platform,
  Pressable,
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
  type ThemeName,
} from "../../theme";
import { useAppStrings } from "../../../locales/AppStringsContext";
import { appLocaleToBcp47 } from "../../../locales/appStrings";
import { LiquidGlassShaderUndercover } from "../LiquidGlassShaderUndercover";
import { HspScrollColumn } from "../HspScrollColumn";
import { SCROLL_INDICATOR_OVERLAY_CHROME_BORDER_INSET_PX } from "../../scrollIndicatorPx";
import { useTelegram } from "../Telegram";
import { appModalSheetStyles } from "../AppModalSheet";
import { FloatingDialogCloseButton } from "../FloatingDialogCloseButton";
import { applyIndependentEdgeResize } from "../floatingDialogGeometry";
import { logPageDisplay } from "../../pageDisplayLog";
import type { TelegramChatVoiceParticipant } from "../../telegram/fetchTelegramChatVoiceParticipants";
import {
  resolveTelegramDisplayName,
  stripInvisibleDisplayNameChars,
} from "../../../shared/telegramDisplayName";
import {
  MessageChatAvatarSlot,
  MESSAGE_CHAT_JOINED_VOICE_RING_COLOR,
} from "./MessageChatAvatarSlot";
import { extractChatAvatarInitials } from "./chatAvatarInitials";
import { resolveTelegramUserAvatarUrl } from "./resolveTelegramUserAvatarUrl";
import { SpecialTelegramUserName } from "./SpecialTelegramUserName";
import { ProfileOpenHitTarget } from "./ProfileOpenHitTarget";
import { useProfileSheet } from "../../profile/ProfileContext";
import { openAuthenticatedHomeChatHistory } from "../../authenticatedHomeSelectedChat";
import {
  MESSAGE_AVATAR_PX,
  MESSAGE_CHAT_VOICE_VIDEO_MAX_HEIGHT_PX,
  MESSAGE_CHAT_VOICE_SIDE_BY_SIDE_ROSTER_MIN_PX,
  MESSAGE_CHAT_VOICE_SIDE_BY_SIDE_VIDEO_MIN_PX,
  MESSAGE_CHAT_VOICE_SIDE_BY_SIDE_VIDEO_PANE_PADDING_X_PX,
  MESSAGE_FONT_SIZE_PX,
  MESSAGE_ICON_TEXT_GAP_PX,
  MESSAGE_LINE_HEIGHT_PX,
  MESSAGE_LIST_INLINE_EMOJI_SIZE_PX,
  messageChatVoiceSideBySideBreakpointPx,
} from "./messageListLayout";
import {
  VoiceCameraIcon,
  VoiceDropIcon,
  VoiceMessagesIcon,
  VoiceMicControlIcon,
  VoiceMoreIcon,
  VoiceScreenShareIcon,
  VoiceWindowSizeIcon,
  VoiceWindowTrayIcon,
} from "./MessageChatVoiceControlIcons";
import { VoiceParticipantStateMicIcon } from "./MessageChatVoiceParticipantMicIcon";
import {
  MessageChatVoiceMediaPipColumn,
  MessageChatVoiceMediaStage,
  streamLooksLikePlaceholderVideo,
  type VoiceMediaStageSource,
} from "./MessageChatVoiceVideoPlane";
import type { TelegramRemoteVideoSource } from "../../telegram/telegramGroupCallWebSession";
import { MessageChatComposePill } from "./MessageChatComposePill";
import {
  MessageChatVoiceMoreMenu,
  type VoiceMoreMenuAnchor,
} from "./MessageChatVoiceMoreMenu";
import {
  MessageChatVoiceParticipantMenu,
  type VoiceParticipantMenuAnchor,
} from "./MessageChatVoiceParticipantMenu";

export function voiceParticipantPrefsKey(
  participant: Pick<TelegramChatVoiceParticipant, "user_id" | "chat_id">,
): string {
  if (participant.user_id != null && Number.isFinite(participant.user_id)) {
    return `u:${Math.trunc(participant.user_id)}`;
  }
  if (participant.chat_id != null && Number.isFinite(participant.chat_id)) {
    return `c:${Math.trunc(participant.chat_id)}`;
  }
  return "unknown";
}

/** Visible roster / menu label — never "?" for a warming empty TDLib title. */
export function formatVoiceParticipantTitle(
  participant: Pick<
    TelegramChatVoiceParticipant,
    "title" | "user_id" | "chat_id" | "is_self"
  >,
  selfLabel = "You",
): string {
  if (participant.is_self) {
    const visible = stripInvisibleDisplayNameChars(participant.title ?? "").trim();
    return visible || selfLabel;
  }
  const resolved = resolveTelegramDisplayName({
    name: participant.title,
    userId: participant.user_id,
  });
  if (resolved !== "User") return resolved;
  if (participant.chat_id != null && Number.isFinite(participant.chat_id) && participant.chat_id !== 0) {
    return `Chat ${Math.abs(Math.trunc(participant.chat_id))}`;
  }
  return "Participant";
}

/** Channel / anonymous-chat roster row (messageSenderChat) vs user. */
export function isVoiceParticipantChannelDisplay(
  participant: Pick<TelegramChatVoiceParticipant, "user_id" | "chat_id">,
): boolean {
  const userId = participant.user_id;
  const hasUser =
    userId != null && Number.isFinite(userId) && Math.trunc(userId) !== 0;
  if (hasUser) return false;
  const chatId = participant.chat_id;
  return chatId != null && Number.isFinite(chatId) && Math.trunc(chatId) !== 0;
}

/**
 * True when we are not subscribed to their screencast (or mix-protect paused it).
 * Default muteScreen=true without an explicit opt-in must read as off — otherwise
 * the menu shows "Mute screen" / green share while Colibri never gets video SDP.
 */
export function isVoiceParticipantScreenLocallyOff(params: {
  participant: Pick<TelegramChatVoiceParticipant, "user_id" | "chat_id" | "screen_sharing_video_info">;
  prefs?: { muteScreen?: boolean } | null;
  wantedScreenKeys: ReadonlySet<string> | Iterable<string>;
  deniedScreenKeys: ReadonlySet<string> | Iterable<string>;
  mixPausedScreenEndpoints: readonly string[];
}): boolean {
  const key = voiceParticipantPrefsKey(params.participant);
  const screenEndpoint =
    params.participant.screen_sharing_video_info?.endpoint_id?.trim() || "";
  if (screenEndpoint && params.mixPausedScreenEndpoints.includes(screenEndpoint)) {
    // Mix-protect temporary pause must not paint mute chrome when the user
    // still wants the share (auto-show / unmute). Session restores SDP; chrome
    // mute follows prefs only (Сева glance→auto-muted was this path).
    const wanted =
      params.wantedScreenKeys instanceof Set
        ? params.wantedScreenKeys
        : new Set(params.wantedScreenKeys);
    if (!wanted.has(key) || params.prefs?.muteScreen !== false) {
      return true;
    }
  }
  const denied =
    params.deniedScreenKeys instanceof Set
      ? params.deniedScreenKeys
      : new Set(params.deniedScreenKeys);
  if (denied.has(key)) return true;
  const wanted =
    params.wantedScreenKeys instanceof Set
      ? params.wantedScreenKeys
      : new Set(params.wantedScreenKeys);
  if (!wanted.has(key)) return true;
  return params.prefs?.muteScreen !== false;
}

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
/** Min width reserved for the share stage when docking left of the roster. */
const SIDE_BY_SIDE_VIDEO_MIN_PX = MESSAGE_CHAT_VOICE_SIDE_BY_SIDE_VIDEO_MIN_PX;
const SIDE_BY_SIDE_VIDEO_PANE_PADDING_X_PX =
  MESSAGE_CHAT_VOICE_SIDE_BY_SIDE_VIDEO_PANE_PADDING_X_PX;
const SIDE_BY_SIDE_ROSTER_MIN_PX = MESSAGE_CHAT_VOICE_SIDE_BY_SIDE_ROSTER_MIN_PX;
/**
 * Smart breakpoint: roster min + video pane padding + usable video column.
 * Crossing this while video is live docks share to the left of participants.
 */
const SIDE_BY_SIDE_BREAKPOINT_PX = messageChatVoiceSideBySideBreakpointPx();
const VOICE_SIZE_STORAGE_KEY = "hsp.voiceChatDialog.size.v1";
const VOICE_OFFSET_STORAGE_KEY = "hsp.voiceChatDialog.offset.v1";
const VOICE_SPEAKING_MIC_COLOR = "#34C759";
const VOICE_MUTED_STATUS_COLOR = "#FF1111";
/** Soft pastel red flash on mic undercover while ICE/media reconnects. */
const VOICE_RECONNECT_MIC_UNDERCOVER = "#F5A8A8";
/** How long an ephemeral chat message stays visible before fading out (ms). */
const CHAT_MSG_TTL_MS = 6_000;

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
  /**
   * True while voice ICE / presentation transport is recovering — video
   * reconnect overlay on screen/camera tiles.
   */
  mediaReconnecting?: boolean;
  /**
   * True while voice PC / ICE is recovering — pastel mic undercover flash and
   * soft reconnect ticks instead of broken remote audio.
   */
  voiceReconnecting?: boolean;
  /** Localized screen-share / session failure shown above the controls. */
  sessionError?: string | null;
  onDropPress: () => void;
  dropLeaving: boolean;
  /** Remote camera / screenshare for the in-dialog video plane. */
  remoteVideoStream?: MediaStream | null;
  /** Per-endpoint remote camera / screen streams (preferred over merged stream). */
  remoteVideoSources?: TelegramRemoteVideoSource[];
  localCameraStream?: MediaStream | null;
  localScreenStream?: MediaStream | null;
  videoActive?: boolean;
  /** Adapt outbound screen-share encode to the in-dialog stage size. */
  onScreenShareDisplaySize?: (width: number, height: number) => void;
  /** Ephemeral chat messages to show above the controls (newest first). */
  chatMessages?: VoiceChatMessage[];
  /** Submit an in-call group message (TDLib sendGroupCallMessage). */
  onSendChatMessage?: (text: string) => void | Promise<void>;
  /**
   * Private 1:1 call layout — same header/controls as group voice, peer avatar
   * in place of the participants roster.
   */
  privateCall?: {
    avatarUrl: string | null;
    initials: string[];
    scheme: ThemeName;
    statusText?: string;
  } | null;
  /** Per-participant listen prefs (volume 0–200%, hide video/screen for me). */
  participantMediaPrefs?: Record<
    string,
    { volumePercent: number; muteVideo: boolean; muteScreen: boolean }
  >;
  onParticipantVolumeChange?: (
    participant: TelegramChatVoiceParticipant,
    volumePercent: number,
  ) => void;
  onParticipantToggleMuteVoice?: (participant: TelegramChatVoiceParticipant) => void;
  onParticipantToggleMuteVideo?: (participant: TelegramChatVoiceParticipant) => void;
  onParticipantToggleMuteScreen?: (participant: TelegramChatVoiceParticipant) => void;
  /**
   * Screencast endpoints paused after mix-protect drop — show as screen-muted
   * until the user unmutes (or local share re-arms).
   */
  mixPausedScreenEndpoints?: string[];
  /**
   * Peers the user muted-screen this join (or auto-show skipped). Default
   * subscribe-mute must not paint as "you muted them".
   */
  deniedScreenPeerKeys?: string[];
  /** Peers opted into for screen this join (auto-show or menu unmute). */
  wantedScreenPeerKeys?: string[];
};

export type VoiceChatMessage = {
  id: string;
  text: string;
  senderName: string;
  /** Unix ms timestamp for display / auto-dismiss. */
  sentAt: number;
};

type SheetSize = { width: number; height: number };
type SheetOffset = { x: number; y: number };

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

function readStoredOffset(): SheetOffset | null {
  if (Platform.OS !== "web" || typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(VOICE_OFFSET_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { x?: unknown; y?: unknown };
    const x = Number(parsed.x);
    const y = Number(parsed.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x: Math.round(x), y: Math.round(y) };
  } catch {
    return null;
  }
}

function writeStoredOffset(offset: SheetOffset): void {
  if (Platform.OS !== "web" || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(VOICE_OFFSET_STORAGE_KEY, JSON.stringify(offset));
  } catch {
    // ignore quota / private mode
  }
}

function clampSheetOffset(
  offset: SheetOffset,
  size: SheetSize,
  winW: number,
  winH: number,
): SheetOffset {
  const minVisible = 48;
  const centerX = winW / 2;
  const centerY = winH / 2;
  let x = Math.round(offset.x);
  let y = Math.round(offset.y);
  const left = centerX - size.width / 2 + x;
  const top = centerY - size.height / 2 + y;
  if (left + size.width < minVisible) x += minVisible - (left + size.width);
  if (left > winW - minVisible) x -= left - (winW - minVisible);
  if (top + size.height < minVisible) y += minVisible - (top + size.height);
  if (top > winH - minVisible) y -= top - (winH - minVisible);
  return { x: Math.round(x), y: Math.round(y) };
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
  liteName,
  localScreenSharing,
  voiceLocallyOff,
  screenLocallyOff,
  videoLocallyOff,
  onOpenMenu,
  onSelfMicPress,
}: {
  participant: TelegramChatVoiceParticipant;
  isLast: boolean;
  colors: ThemeColors;
  isSpeaking: boolean;
  /** Skip emoji-status WebGL/fetch on first paint (open longtask). */
  liteName?: boolean;
  /** Local getDisplayMedia session — authoritative for self row icon. */
  localScreenSharing?: boolean;
  /** Volume 0% / muted for you — crossed red (same as call mute). */
  voiceLocallyOff?: boolean;
  /** Local hide of their screencast — red crossed share icon. */
  screenLocallyOff?: boolean;
  /** Local hide of their camera — red crossed camera icon. */
  videoLocallyOff?: boolean;
  onOpenMenu?: (anchor: VoiceParticipantMenuAnchor) => void;
  /** Self row has no peer menu — tap toggles the local mic instead. */
  onSelfMicPress?: () => void;
}) {
  const { colorScheme } = useTelegram();
  const { t } = useAppStrings();
  const { openProfileSheet } = useProfileSheet();
  const title = formatVoiceParticipantTitle(participant);
  const description = participant.description.trim();
  const avatarUrl = resolveTelegramUserAvatarUrl(participant);
  // Admin mute → red. Local volume 0% (muted for you) → red. User turned their
  // own mic off (can_unmute_self) → secondary. Open mic → primary.
  const micAdminMuted =
    Boolean(participant.is_muted) && participant.can_unmute_self === false;
  const micLocallyMuted = Boolean(voiceLocallyOff);
  const micUserOff = Boolean(participant.is_muted) && !micAdminMuted;
  // Soft stubs often stay is_muted until an ordered load. tdesktop still shows
  // an open green mic on the live speaker — don't require !is_muted for that.
  const speaking =
    isSpeaking && !micAdminMuted && !micLocallyMuted;
  const micOff = speaking
    ? false
    : micAdminMuted || micLocallyMuted || micUserOff;
  const micChromeRed = micAdminMuted || micLocallyMuted;
  const openParticipantProfile = () => {
    if (participant.is_self) return;
    const title = formatVoiceParticipantTitle(participant);
    if (isVoiceParticipantChannelDisplay(participant)) {
      const chatId = Math.trunc(participant.chat_id!);
      openProfileSheet({
        telegram_chat_id: chatId,
        title,
        peer_user_id: null,
        chat_kind: "channel",
      });
      return;
    }
    const userId = participant.user_id;
    if (userId == null || !Number.isFinite(userId) || userId === 0) return;
    openProfileSheet({
      telegram_chat_id:
        participant.chat_id != null && Number.isFinite(participant.chat_id)
          ? Math.trunc(participant.chat_id)
          : Math.trunc(userId),
      title,
      peer_user_id: Math.trunc(userId),
      peer_emoji_status_custom_emoji_id: participant.emoji_status_custom_emoji_id,
      chat_kind: "private",
    });
  };
  const openMenuFromEvent = (event: {
    nativeEvent?: { pageX?: number; pageY?: number; clientX?: number; clientY?: number };
  }) => {
    if (participant.is_self) {
      onSelfMicPress?.();
      return;
    }
    if (!onOpenMenu) return;
    const ne = event.nativeEvent ?? {};
    const x = Number(ne.pageX ?? ne.clientX ?? 0);
    const y = Number(ne.pageY ?? ne.clientY ?? 0);
    onOpenMenu({
      x: Number.isFinite(x) ? x : 0,
      y: Number.isFinite(y) ? y : 0,
    });
  };
  const peerScreenSharing = Boolean(
    participant.screen_sharing_video_info?.endpoint_id?.trim() ||
      (participant.screen_sharing_video_info?.source_groups?.length ?? 0) > 0,
  );
  const peerCameraSharing = Boolean(
    participant.video_info?.endpoint_id?.trim() ||
      (participant.video_info?.source_groups?.length ?? 0) > 0,
  );
  const showScreenShareActive =
    participant.is_self
      ? Boolean(localScreenSharing)
      : !screenLocallyOff && peerScreenSharing;
  // Roster: red crossed share only while they publish AND we muted them.
  const showScreenShareMuted =
    !participant.is_self && Boolean(screenLocallyOff) && peerScreenSharing;
  const showVideoMuted =
    !participant.is_self && Boolean(videoLocallyOff) && peerCameraSharing;
  const textBase = {
    fontFamily: Platform.OS === "web" ? WEB_UI_SANS_STACK : FONT_UI_SANS_REGULAR,
    fontSize: MESSAGE_FONT_SIZE_PX,
    lineHeight: MESSAGE_LINE_HEIGHT_PX,
    includeFontPadding: false,
    paddingVertical: 0,
  } as const;

  return (
    <Pressable
      {...(Platform.OS === "web"
        ? ({ "data-voice-participant-row": title } as object)
        : {})}
      testID="voice-participant-row"
      accessibilityRole={participant.is_self ? "button" : undefined}
      accessibilityLabel={
        participant.is_self
          ? micOff
            ? "Unmute microphone"
            : "Mute microphone"
          : micLocallyMuted
            ? `${title}, muted for you — open menu to unmute`
            : undefined
      }
      disabled={participant.is_self ? !onSelfMicPress : !onOpenMenu}
      onPress={(event) => openMenuFromEvent(event)}
      style={{
        flexDirection: "row",
        alignItems: "center",
        // Fixed row height — description fill / title resolve used to change
        // minHeight 40↔48 and bounce the list while speaking rings fired.
        minHeight: 48,
        width: "100%",
        marginBottom: isLast ? 0 : 10,
      }}
    >
      <ProfileOpenHitTarget
        label={t("messages.profile.openA11y")}
        onPress={openParticipantProfile}
        disabled={participant.is_self}
        style={{
          width: MESSAGE_AVATAR_PX,
          height: MESSAGE_AVATAR_PX,
          alignItems: "center",
          justifyContent: "center",
          // Match chat list: square face + 1px highlight; speaking ring outside.
          overflow: "visible",
          flexShrink: 0,
        }}
      >
        <MessageChatAvatarSlot
          iconUrl={avatarUrl}
          initials={extractChatAvatarInitials(title)}
          sizePx={MESSAGE_AVATAR_PX}
          colors={colors}
          scheme={colorScheme}
          // Must be high/critical — normal is paused while the voice UI gate is
          // open (see MessageChatAvatarImage), which left letter fallbacks forever.
          fetchPriority="high"
          borderColor={
            speaking ? MESSAGE_CHAT_JOINED_VOICE_RING_COLOR : undefined
          }
          activeVoiceRing={speaking}
          joinedVoiceRing={speaking}
        />
      </ProfileOpenHitTarget>
      <View style={{ width: MESSAGE_ICON_TEXT_GAP_PX }} />
      <View style={{ flex: 1, minWidth: 0, justifyContent: "center" }}>
        <SpecialTelegramUserName
          name={title}
          telegramUserId={participant.user_id}
          telegramChatId={participant.chat_id}
          emojiStatusCustomEmojiId={
            liteName ? null : participant.emoji_status_custom_emoji_id
          }
          emojiStatusPriority={false}
          // Lottie/TGS fetch+animate per row stalls the main thread in a long call.
          inlineEmojiFetchEnabled={!liteName}
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
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 4,
          marginLeft: 8,
          flexShrink: 0,
        }}
      >
        {showScreenShareMuted ? (
          <View
            accessibilityRole="image"
            accessibilityLabel="Screen sharing muted"
            style={{
              width: 28,
              height: 28,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <VoiceScreenShareIcon
              color={VOICE_MUTED_STATUS_COLOR}
              size={18}
              muted
            />
          </View>
        ) : showScreenShareActive ? (
          <View
            accessibilityRole="image"
            accessibilityLabel="Screen sharing"
            style={{
              width: 28,
              height: 28,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <VoiceScreenShareIcon
              color={VOICE_SPEAKING_MIC_COLOR}
              size={18}
              active
            />
          </View>
        ) : null}
        {showVideoMuted ? (
          <View
            accessibilityRole="image"
            accessibilityLabel="Video muted"
            style={{
              width: 28,
              height: 28,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <VoiceCameraIcon color={VOICE_MUTED_STATUS_COLOR} size={18} muted />
          </View>
        ) : null}
        <View
          accessibilityRole="image"
          accessibilityLabel={
            micLocallyMuted
              ? "Microphone muted for you"
              : micAdminMuted
                ? "Microphone muted"
                : micUserOff
                  ? "Microphone turned off"
                  : speaking
                    ? "Speaking"
                    : "Microphone"
          }
          style={{
            width: 28,
            height: 28,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <VoiceParticipantStateMicIcon
            speaking={speaking && !micOff}
            muted={micOff}
            color={
              micChromeRed
                ? VOICE_MUTED_STATUS_COLOR
                : micUserOff
                  ? colors.secondary
                  : speaking
                    ? VOICE_SPEAKING_MIC_COLOR
                    : colors.primary
            }
            size={20}
          />
        </View>
      </View>
    </Pressable>
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
  // Dedupe pointerdown + click so a freeze-recovery click does not double-toggle mic.
  const lastFireAtRef = useRef(0);
  const firePress = () => {
    if (disabled || !onPress) return;
    const now = Date.now();
    if (now - lastFireAtRef.current < 450) return;
    lastFireAtRef.current = now;
    onPress();
  };

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
          // Do not preventDefault — that broke RN's touch bank and dropped the
          // follow-up click backup under main-thread pressure (mic stayed muted).
          if (e.button == null || e.button === 0) {
            firePress();
          }
        },
        onClick: (e: { stopPropagation?: () => void; preventDefault?: () => void }) => {
          // Backup if pointerdown was swallowed by an overlay / frozen frame.
          e.stopPropagation?.();
          e.preventDefault?.();
          firePress();
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
  mediaReconnecting = false,
  voiceReconnecting = false,
  sessionError = null,
  onDropPress,
  dropLeaving,
  remoteVideoStream = null,
  remoteVideoSources = [],
  localCameraStream = null,
  localScreenStream = null,
  videoActive = false,
  onScreenShareDisplaySize,
  chatMessages = [],
  onSendChatMessage,
  privateCall = null,
  participantMediaPrefs = {},
  onParticipantVolumeChange,
  onParticipantToggleMuteVoice,
  onParticipantToggleMuteVideo,
  onParticipantToggleMuteScreen,
  mixPausedScreenEndpoints = [],
  deniedScreenPeerKeys = [],
  wantedScreenPeerKeys = [],
}: Props) {
  const { t, tf, locale } = useAppStrings();
  const { openProfileSheet } = useProfileSheet();
  const deniedScreenKeySet = useMemo(
    () => new Set(deniedScreenPeerKeys),
    [deniedScreenPeerKeys],
  );
  const wantedScreenKeySet = useMemo(
    () => new Set(wantedScreenPeerKeys),
    [wantedScreenPeerKeys],
  );
  const isScreenLocallyOff = useCallback(
    (participant: TelegramChatVoiceParticipant) => {
      const key = voiceParticipantPrefsKey(participant);
      return isVoiceParticipantScreenLocallyOff({
        participant,
        prefs: participantMediaPrefs[key],
        wantedScreenKeys: wantedScreenKeySet,
        deniedScreenKeys: deniedScreenKeySet,
        mixPausedScreenEndpoints,
      });
    },
    [
      deniedScreenKeySet,
      wantedScreenKeySet,
      mixPausedScreenEndpoints,
      participantMediaPrefs,
    ],
  );
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const isLightTheme = colors.primary === "#000000";
  const iconColor = colors.primary;
  const [micReconnectFlashOn, setMicReconnectFlashOn] = useState(false);

  // Mic undercover flash only — no-connection ticks live in useTelegramVoiceSession
  // so they keep looping when the sheet is minimized.
  useEffect(() => {
    if (!voiceReconnecting || Platform.OS !== "web") {
      setMicReconnectFlashOn(false);
      return;
    }
    setMicReconnectFlashOn(true);
    const id = window.setInterval(() => {
      setMicReconnectFlashOn((prev) => !prev);
    }, 420);
    return () => {
      window.clearInterval(id);
      setMicReconnectFlashOn(false);
    };
  }, [voiceReconnecting]);

  const micUndercoverColor =
    voiceReconnecting && micReconnectFlashOn
      ? VOICE_RECONNECT_MIC_UNDERCOVER
      : colors.undercover;
  const connectionInterruptedLabel = t("messages.voiceChat.connectionEstablishing");
  const chatTitle = title.trim() || t("messages.voiceChat.active");
  const isPrivateCall = privateCall != null;
  // VoiceBar passes resolveVoiceBarParticipantPreview's displayTotal (TDLib
  // floor). Do not re-max with participants.length — soft-merge ghosts used to
  // raise "5 participants" → "11" / "12" in the open dialog.
  const totalParticipantCount =
    Number.isFinite(participantCount) && (participantCount as number) > 0
      ? Math.max(0, Math.trunc(participantCount as number))
      : participants.length;
  const participantCountLabel = isPrivateCall
    ? privateCall.statusText?.trim() || t("messages.privateCall.calling")
    : totalParticipantCount > 0
      ? tf("messages.chatMemberCount.participants", {
          count: totalParticipantCount.toLocaleString(appLocaleToBcp47(locale)),
        })
      : "";
  const [moreMenuAnchor, setMoreMenuAnchor] = useState<VoiceMoreMenuAnchor | null>(null);
  const [participantMenuAnchor, setParticipantMenuAnchor] =
    useState<VoiceParticipantMenuAnchor | null>(null);
  const [participantMenuTarget, setParticipantMenuTarget] =
    useState<TelegramChatVoiceParticipant | null>(null);
  /** Wide-stage expand: null = mosaic gallery (pic 2); set = focused tile (pic 3). */
  const [focusedMediaId, setFocusedMediaId] = useState<string | null>(null);
  const lastMediaStageSigRef = useRef("");
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(() =>
    Platform.OS === "web" && typeof document !== "undefined" ? document.body : null,
  );
  const moreChipRef = useRef<View | null>(null);
  /** Keep portal mounted briefly after close so roster unmount cannot freeze reopen. */
  const [portalMounted, setPortalMounted] = useState(visible);
  /** Drop roster/media on hide immediately — empty shell teardown is cheap. */
  const [suspendHeavy, setSuspendHeavy] = useState(false);
  /** First open frame: chrome only — roster rows/emoji caused 400ms+ open longtasks. */
  const [rosterPaintReady, setRosterPaintReady] = useState(false);
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
      // Hits come from backdrop/sheet children (pointer-events: auto), not the root.
      node.style.pointerEvents = "none";
      node.style.cursor = "default";
    } else {
      node.setAttribute("aria-hidden", "true");
      node.setAttribute("inert", "");
      // display:none — opacity alone still lets WebGL/LiquidGlass composite on screen.
      node.style.display = "none";
      node.style.visibility = "hidden";
      node.style.opacity = "0";
      node.style.pointerEvents = "none";
      node.style.cursor = "default";
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
    if (!visible || forceClosedRef.current) {
      setRosterPaintReady(false);
      return;
    }
    let cancelled = false;
    // Paint chrome + Close first; roster + emoji-status badges caused open
    // longtasks (507–643ms in live browser) before controls could bind.
    // Keep defer short — 280ms stacked with thin-roster wait left the sheet
    // looking empty while the call felt stuck.
    const arm = () => {
      if (typeof window === "undefined") {
        if (!cancelled) setRosterPaintReady(true);
        return;
      }
      window.requestAnimationFrame(() => {
        window.setTimeout(() => {
          if (!cancelled) setRosterPaintReady(true);
        }, 80);
      });
    };
    arm();
    return () => {
      cancelled = true;
    };
  }, [visible, openSeq]);

  useEffect(() => {
    if (!visible) setMoreMenuAnchor(null);
  }, [visible]);

  // Escape / Alt+F4-style close that does not depend on the chrome button being
  // able to receive pointer events while React is busy painting the roster.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const onDropPressRef = useRef(onDropPress);
  onDropPressRef.current = onDropPress;
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
        // Capture wins over the chrome <button> — leave the call here too,
        // otherwise stopPropagation would hide the sheet without hanging up.
        e.stopPropagation();
        e.preventDefault();
        closeNow("chrome_x_capture");
        try {
          onDropPressRef.current();
        } catch {
          /* best-effort leave */
        }
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
  const [sheetOffset, setSheetOffset] = useState<SheetOffset>(() => {
    const stored = readStoredOffset();
    return stored ?? { x: 0, y: 0 };
  });
  const [hoveredHandle, setHoveredHandle] = useState<ResizeHandle | null>(null);
  const [draggingHandle, setDraggingHandle] = useState<ResizeHandle | null>(null);
  const [movingSheet, setMovingSheet] = useState(false);
  const dragRef = useRef<{
    handle: ResizeHandle;
    startX: number;
    startY: number;
    startWidth: number;
    startHeight: number;
    startOffsetX: number;
    startOffsetY: number;
    pointerId: number;
    host: { setPointerCapture?: (id: number) => void; releasePointerCapture?: (id: number) => void } | null;
  } | null>(null);
  const moveDragRef = useRef<{
    startX: number;
    startY: number;
    startOffsetX: number;
    startOffsetY: number;
    pointerId: number;
    host: { setPointerCapture?: (id: number) => void; releasePointerCapture?: (id: number) => void } | null;
  } | null>(null);
  const sheetSizeRef = useRef(sheetSize);
  sheetSizeRef.current = sheetSize;
  const sheetOffsetRef = useRef(sheetOffset);
  sheetOffsetRef.current = sheetOffset;

  useEffect(() => {
    const stored = readStoredSize();
    if (stored) setSheetSize(clampSize(stored));
    const storedOffset = readStoredOffset();
    if (storedOffset) {
      setSheetOffset(
        clampSheetOffset(storedOffset, sheetSizeRef.current, windowWidth, windowHeight),
      );
    }
  }, [clampSize, windowHeight, windowWidth]);

  useEffect(() => {
    setSheetSize((prev) => clampSize(prev));
    setSheetOffset((prev) =>
      clampSheetOffset(prev, sheetSizeRef.current, windowWidth, windowHeight),
    );
  }, [clampSize, windowHeight, windowWidth]);

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

  const endMoveDrag = useCallback(() => {
    const move = moveDragRef.current;
    if (move?.host && typeof move.host.releasePointerCapture === "function") {
      try {
        move.host.releasePointerCapture(move.pointerId);
      } catch {
        // ignore
      }
    }
    moveDragRef.current = null;
    setMovingSheet(false);
    writeStoredOffset(sheetOffsetRef.current);
  }, []);

  useEffect(() => {
    if (visible) return;
    endDrag();
    endMoveDrag();
  }, [visible, endDrag, endMoveDrag]);

  useEffect(() => {
    if (Platform.OS !== "web" || typeof window === "undefined") return;
    const onMove = (e: PointerEvent) => {
      const move = moveDragRef.current;
      if (move) {
        const next = clampSheetOffset(
          {
            x: move.startOffsetX + (e.clientX - move.startX),
            y: move.startOffsetY + (e.clientY - move.startY),
          },
          sheetSizeRef.current,
          window.innerWidth,
          window.innerHeight,
        );
        setSheetOffset(next);
        return;
      }
      const drag = dragRef.current;
      if (!drag) return;
      const applied = applyIndependentEdgeResize({
        handle: drag.handle,
        startSize: { width: drag.startWidth, height: drag.startHeight },
        startOffset: { x: drag.startOffsetX, y: drag.startOffsetY },
        dx: e.clientX - drag.startX,
        dy: e.clientY - drag.startY,
        clampSize,
      });
      const offset = clampSheetOffset(
        applied.offset,
        applied.size,
        window.innerWidth,
        window.innerHeight,
      );
      setSheetSize(applied.size);
      setSheetOffset(offset);
    };
    const onUp = () => {
      if (moveDragRef.current) endMoveDrag();
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
  }, [clampSize, endDrag, endMoveDrag]);

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
      moveDragRef.current = null;
      setMovingSheet(false);
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
        startOffsetX: sheetOffsetRef.current.x,
        startOffsetY: sheetOffsetRef.current.y,
        pointerId: e.nativeEvent.pointerId,
        host,
      };
      setDraggingHandle(handle);
    },
    [],
  );

  const beginMoveDrag = useCallback(
    (e: {
      nativeEvent: {
        clientX: number;
        clientY: number;
        pointerId: number;
        button?: number;
        target?: EventTarget | null;
        preventDefault?: () => void;
        stopPropagation?: () => void;
      };
      currentTarget?: unknown;
    }) => {
      if (e.nativeEvent.button != null && e.nativeEvent.button !== 0) return;
      // Chrome buttons stopPropagation, but also ignore if a control was hit.
      const target = e.nativeEvent.target as Element | null;
      if (
        target &&
        typeof target.closest === "function" &&
        target.closest(
          '[data-voice-chrome]:not([data-voice-chrome="drag-handle"])',
        )
      ) {
        return;
      }
      e.nativeEvent.preventDefault?.();
      e.nativeEvent.stopPropagation?.();
      dragRef.current = null;
      setDraggingHandle(null);
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
      moveDragRef.current = {
        startX: e.nativeEvent.clientX,
        startY: e.nativeEvent.clientY,
        startOffsetX: sheetOffsetRef.current.x,
        startOffsetY: sheetOffsetRef.current.y,
        pointerId: e.nativeEvent.pointerId,
        host,
      };
      setMovingSheet(true);
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
    const self = participants.find((row) => row.is_self);
    // Local tiles must not show a Hyperlinks / wrong-account display name.
    // Prefer a TDLib-backed title (real user_id); otherwise plain "You".
    const selfName =
      self?.user_id != null && self.user_id > 0 && self.title.trim()
        ? self.title.trim()
        : "You";

    const tileChromeFor = (participant: TelegramChatVoiceParticipant | undefined) => {
      if (!participant) {
        return { muted: false, muteChrome: undefined as "red" | "grey" | undefined, speaking: false };
      }
      const prefs = participantMediaPrefs[voiceParticipantPrefsKey(participant)];
      const volumePercent =
        prefs?.volumePercent ??
        (typeof participant.volume_percent === "number"
          ? participant.volume_percent
          : 100);
      const adminMuted =
        Boolean(participant.is_muted) && participant.can_unmute_self === false;
      const userOff = Boolean(participant.is_muted) && !adminMuted;
      const locallyOff = !participant.is_self && volumePercent <= 0;
      const speakingRaw = isParticipantSpeaking
        ? isParticipantSpeaking(participant)
        : Boolean(participant.is_speaking);
      // Live speaking opens mic chrome (soft stubs may still report is_muted).
      const speaking = speakingRaw && !adminMuted && !locallyOff;
      // Red only for admin mute / muted-for-you. User mic-off → grey on tiles.
      const muteChrome: "red" | "grey" | undefined = speaking
        ? undefined
        : adminMuted || locallyOff
          ? "red"
          : userOff
            ? "grey"
            : undefined;
      const muted = Boolean(muteChrome);
      return { muted, muteChrome, speaking };
    };

    const pushIfLive = (row: VoiceMediaStageSource) => {
      if (streamLooksLikePlaceholderVideo(row.stream)) return;
      const tracks = row.stream
        .getVideoTracks()
        .filter((t) => t.readyState === "live" && t.enabled);
      if (tracks.length === 0) return;
      // Remote WebRTC tracks stay muted until the first RTP packet. Promoting them
      // early locks the media stage on a black main tile and hides local share.
      if (row.id.startsWith("remote:") && tracks.every((t) => t.muted)) return;
      if (rows.some((existing) => existing.id === row.id)) return;
      rows.push(row);
    };

    // Local screencast first while presenting.
    if (localScreenStream) {
      const chrome = tileChromeFor(self);
      pushIfLive({
        id: "local-screen",
        stream: localScreenStream,
        label: selfName,
        kind: "screen",
        muted: chrome.muted,
        muteChrome: chrome.muteChrome,
        speaking: chrome.speaking,
      });
    }
    if (localCameraStream) {
      const chrome = tileChromeFor(self);
      pushIfLive({
        id: "local-camera",
        stream: localCameraStream,
        label: selfName,
        kind: "camera",
        muted: chrome.muted,
        muteChrome: chrome.muteChrome,
        speaking: chrome.speaking,
      });
    }

    const resolveRemoteParticipant = (
      endpointId: string,
      kind: "camera" | "screen",
    ): TelegramChatVoiceParticipant | undefined => {
      for (const row of participants) {
        if (row.is_self) continue;
        const screenEp = row.screen_sharing_video_info?.endpoint_id;
        const camEp = row.video_info?.endpoint_id;
        if (kind === "screen" && screenEp && screenEp === endpointId) return row;
        if (kind === "camera" && camEp && camEp === endpointId) return row;
        if (
          kind === "screen" &&
          row.screen_sharing_video_info?.source_groups?.length &&
          (endpointId === `screen-${row.user_id ?? row.chat_id ?? "x"}` ||
            endpointId.includes(String(row.user_id ?? "")))
        ) {
          return row;
        }
        if (
          kind === "camera" &&
          row.video_info?.source_groups?.length &&
          (endpointId === `cam-${row.user_id ?? row.chat_id ?? "x"}` ||
            endpointId.includes(String(row.user_id ?? "")))
        ) {
          return row;
        }
      }
      return undefined;
    };

    if (remoteVideoSources.length > 0) {
      // Screens first, then cameras — stable browsing order for mosaic / pips.
      const ordered = [...remoteVideoSources].sort((a, b) => {
        if (a.kind === b.kind) return 0;
        return a.kind === "screen" ? -1 : 1;
      });
      for (const source of ordered) {
        const participant = resolveRemoteParticipant(source.endpointId, source.kind);
        const chrome = tileChromeFor(participant);
        pushIfLive({
          id: `remote:${source.kind}:${source.endpointId}`,
          stream: source.stream,
          label: (participant?.title || "").trim() || (source.kind === "screen" ? "Screen share" : "Camera"),
          kind: source.kind,
          muted: chrome.muted,
          muteChrome: chrome.muteChrome,
          speaking: chrome.speaking,
        });
      }
    } else if (remoteVideoStream) {
      // Legacy merged stream fallback.
      const tracks = remoteVideoStream
        .getVideoTracks()
        .filter((track) => track.readyState === "live" && track.enabled);
      if (tracks.length <= 1) {
        pushIfLive({
          id: "remote",
          stream: remoteVideoStream,
          label: "Participant",
          kind: "screen",
        });
      } else {
        for (const [index, track] of tracks.entries()) {
          pushIfLive({
            id: `remote:${track.id || index}`,
            stream: new MediaStream([track]),
            label: "Participant",
            kind: "screen",
          });
        }
      }
    }
    return rows;
  }, [
    isParticipantSpeaking,
    localCameraStream,
    localScreenStream,
    participantMediaPrefs,
    participants,
    remoteVideoSources,
    remoteVideoStream,
  ]);

  useEffect(() => {
    if (!visible || mediaSources.length === 0) return;
    const sig = mediaSources.map((row) => `${row.id}:${row.kind ?? "?"}`).join("|");
    if (sig === lastMediaStageSigRef.current) return;
    lastMediaStageSigRef.current = sig;
    logPageDisplay("messages_voice_media_stage_sources", {
      count: mediaSources.length,
      ids: mediaSources.map((row) => row.id),
      kinds: mediaSources.map((row) => row.kind ?? "unknown"),
      level: "info",
    });
  }, [mediaSources, visible]);

  const videoStageActive = Boolean(
    visible && !suspendHeavy && mediaSources.length > 0,
  );
  const sideBySide =
    Platform.OS === "web" &&
    videoStageActive &&
    sheetSize.width >= SIDE_BY_SIDE_BREAKPOINT_PX;
  const rosterPaneWidth = sideBySide
    ? Math.min(
        DEFAULT_SHEET_WIDTH_PX,
        Math.max(
          SIDE_BY_SIDE_ROSTER_MIN_PX,
          sheetSize.width -
            SIDE_BY_SIDE_VIDEO_MIN_PX -
            SIDE_BY_SIDE_VIDEO_PANE_PADDING_X_PX,
        ),
      )
    : sheetSize.width;
  const videoPaneWidth = sideBySide
    ? Math.max(SIDE_BY_SIDE_VIDEO_MIN_PX, sheetSize.width - rosterPaneWidth)
    : sheetSize.width;
  const hasScreenShareStage = mediaSources.some((row) => row.kind === "screen");
  // Thin mosaic needs room for 1+2 (or 1+1) tiles — old 280px cap crushed shares.
  const stackedVideoMaxHeight = Math.min(
    Math.max(
      hasScreenShareStage || remoteVideoStream || remoteVideoSources.length > 0
        ? Math.round(sheetSize.height * 0.48)
        : 220,
      hasScreenShareStage || mediaSources.length >= 2 ? 320 : 220,
    ),
    Math.max(MESSAGE_CHAT_VOICE_VIDEO_MAX_HEIGHT_PX, 480),
    Math.max(200, sheetSize.height - 220),
  );
  const handles: ResizeHandle[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

  const focusedLiveSource =
    focusedMediaId != null
      ? mediaSources.find((row) => row.id === focusedMediaId) ?? null
      : null;
  const sidebarPipSources =
    sideBySide && focusedLiveSource
      ? mediaSources.filter((row) => row.id !== focusedLiveSource.id)
      : [];

  useEffect(() => {
    if (!videoStageActive) {
      setFocusedMediaId(null);
      return;
    }
    if (!sideBySide) {
      // Thin layout is always mosaic — drop expand when the sheet narrows.
      setFocusedMediaId(null);
      return;
    }
    if (focusedMediaId && !mediaSources.some((row) => row.id === focusedMediaId)) {
      setFocusedMediaId(null);
    }
  }, [focusedMediaId, mediaSources, sideBySide, videoStageActive]);

  useEffect(() => {
    if (!onScreenShareDisplaySize || !screenSharing) return;
    const width = Math.max(
      160,
      sideBySide ? videoPaneWidth - 16 : sheetSize.width - 40,
    );
    const height = Math.max(
      90,
      sideBySide
        ? Math.max(120, sheetSize.height - 40)
        : stackedVideoMaxHeight,
    );
    onScreenShareDisplaySize(width, height);
  }, [
    onScreenShareDisplaySize,
    screenSharing,
    sideBySide,
    videoPaneWidth,
    sheetSize.width,
    sheetSize.height,
    stackedVideoMaxHeight,
  ]);

  const displayParticipants = useMemo(() => {
    // Never clear rows while the sheet is open — suspendHeavy racing reopen
    // left the dialog with only the count label and no participant rows.
    // Defer first paint of rows until chrome is interactive (open longtask fix).
    if (!rosterPaintReady || (suspendHeavy && !visible)) return [];
    const rows = participants.slice(0, 256);
    const speakingOf = (row: TelegramChatVoiceParticipant) =>
      isParticipantSpeaking
        ? isParticipantSpeaking(row)
        : Boolean(row.is_speaking);
    // Speakers float to the top (stable within each group).
    return [...rows].sort((a, b) => {
      const aSpeak = speakingOf(a) ? 1 : 0;
      const bSpeak = speakingOf(b) ? 1 : 0;
      if (aSpeak !== bSpeak) return bSpeak - aSpeak;
      return 0;
    });
  }, [
    isParticipantSpeaking,
    participants,
    rosterPaintReady,
    suspendHeavy,
    visible,
  ]);

  const moreMenuItems = useMemo(
    () => [
      {
        key: "share",
        label: screenSharing
          ? t("messages.voiceChat.controls.stopSharing")
          : t("messages.voiceChat.controls.startSharing"),
        onPress: () => {
          // Start share before closing the menu so getDisplayMedia still has
          // the click's transient user activation.
          if (screenSharing) {
            onStopScreenShare();
            setMoreMenuAnchor(null);
            return;
          }
          onStartScreenShare();
          setMoreMenuAnchor(null);
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

  const renderHeader = () => (
    <View
      // Must be hittable on web so title/empty header space can drag the sheet
      // (box-none let events fall through to content behind the header).
      pointerEvents="auto"
      style={{
        flexDirection: "row",
        alignItems: "center",
        paddingHorizontal: 20,
        paddingBottom: 16,
        gap: 12,
        zIndex: 10000,
        flexShrink: 0,
        ...(Platform.OS === "web"
          ? ({
              position: "relative",
              cursor: movingSheet ? "grabbing" : "grab",
              userSelect: "none",
              touchAction: "none",
            } as object)
          : {}),
      }}
      {...(Platform.OS === "web"
        ? ({
            onPointerDown: beginMoveDrag,
            "data-voice-chrome": "drag-handle",
          } as object)
        : {})}
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
        {...(Platform.OS === "web"
          ? ({
              onPointerDown: (e: { stopPropagation?: () => void }) =>
                e.stopPropagation?.(),
            } as object)
          : {})}
      >
        <VoiceWindowChromeButton
          label={t("messages.voiceChat.minimize")}
          hitExtraPx={4}
          testId="minimize"
          onPress={() => {
            // Minimize docks to the strip / global preview and keeps audio.
            requestClose("chrome_minimize");
          }}
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
        <FloatingDialogCloseButton
          label={t("messages.voiceChat.controls.drop")}
          color={iconColor}
          onPress={() => {
            // Close leaves the call entirely (stop hearing).
            logPageDisplay("messages_voice_dialog_control_click", { action: "close_leave" });
            requestClose("chrome_x_leave");
            onDropPress();
          }}
        />
      </View>
    </View>
  );

  const renderParticipantRows = () => {
    if (isPrivateCall && privateCall) {
      // Live camera/screencast tiles replace the large avatar.
      if (mediaSources.length > 0) {
        return null;
      }
      return (
        <View
          style={{
            alignItems: "center",
            justifyContent: "center",
            paddingHorizontal: 20,
            paddingVertical: 24,
            minHeight: 200,
          }}
          pointerEvents="auto"
        >
          <MessageChatAvatarSlot
            iconUrl={privateCall.avatarUrl}
            initials={privateCall.initials}
            sizePx={140}
            colors={colors}
            scheme={privateCall.scheme}
            loadEnabled
            fetchPriority="high"
          />
        </View>
      );
    }
    if (displayParticipants.length === 0) {
      return (
        <Text style={[typographyRect15, { color: colors.secondary }]}>
          {participantCountLabel || t("messages.voiceChat.participants")}
        </Text>
      );
    }
    return displayParticipants.map((participant, index) => {
      const prefsKey = voiceParticipantPrefsKey(participant);
      const prefs = participantMediaPrefs[prefsKey];
      const volumePercent =
        prefs?.volumePercent ??
        (typeof participant.volume_percent === "number"
          ? participant.volume_percent
          : 100);
      return (
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
          liteName={!rosterPaintReady}
          localScreenSharing={screenSharing}
          voiceLocallyOff={volumePercent <= 0}
          screenLocallyOff={isScreenLocallyOff(participant)}
          videoLocallyOff={Boolean(prefs?.muteVideo)}
          onOpenMenu={
            participant.is_self || !onParticipantVolumeChange
              ? undefined
              : (anchor) => {
                  setParticipantMenuTarget(participant);
                  setParticipantMenuAnchor(anchor);
                }
          }
          onSelfMicPress={participant.is_self ? () => onMicPress() : undefined}
        />
      );
    });
  };

  /** Media + roster between the two dividers share one scroll. */
  const renderMiddleScroll = (opts?: {
    includeStackedMedia?: boolean;
    includeSidebarPips?: boolean;
  }) => {
    const includeStackedMedia = Boolean(opts?.includeStackedMedia);
    const includeSidebarPips = Boolean(opts?.includeSidebarPips);
    const mediaCount = includeStackedMedia ? mediaSources.length : 0;
    const singleMedia = mediaCount === 1;
    return (
      <View
        style={{
          flex: 1,
          minHeight: 0,
          zIndex: 1,
          // Visible so the scroll thumb can paint onto the 1px chrome border.
          overflow: "visible",
        }}
        pointerEvents="auto"
      >
        <HspScrollColumn
          style={{ flex: 1, minHeight: 0 }}
          contentContainerStyle={{
            paddingHorizontal: 20,
            paddingTop:
              includeStackedMedia && mediaCount > 0
                ? singleMedia
                  ? 0
                  : 8
                : 16,
            paddingBottom: 16,
            flexGrow: 1,
          }}
          scrollbarRightInsetPx={SCROLL_INDICATOR_OVERLAY_CHROME_BORDER_INSET_PX}
          scrollIndicatorOverlaySeam={false}
          containOverscroll
        >
          {includeStackedMedia && mediaCount > 0 ? (
            <MessageChatVoiceMediaStage
              sources={suspendHeavy ? [] : mediaSources}
              active={videoStageActive}
              maxHeightPx={stackedVideoMaxHeight}
              wideLayout={false}
              fitSingleToContent={singleMedia}
              horizontalInsetPx={0}
              marginBottomPx={singleMedia ? 8 : 12}
              connectionInterrupted={mediaReconnecting}
              connectionInterruptedLabel={connectionInterruptedLabel}
              connectionInterruptedBg={colors.secondary}
              connectionInterruptedFg={colors.primary}
            />
          ) : null}
          {includeSidebarPips && sidebarPipSources.length > 0 ? (
            <MessageChatVoiceMediaPipColumn
              sources={sidebarPipSources}
              active={videoStageActive}
              onSelect={setFocusedMediaId}
              connectionInterrupted={mediaReconnecting}
              connectionInterruptedLabel={connectionInterruptedLabel}
              connectionInterruptedBg={colors.secondary}
              connectionInterruptedFg={colors.primary}
            />
          ) : null}
          {renderParticipantRows()}
        </HspScrollColumn>
      </View>
    );
  };

  const [visibleMsgIds, setVisibleMsgIds] = useState<Set<string>>(new Set());
  const msgTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const timers = msgTimersRef.current;
    for (const msg of chatMessages) {
      if (timers.has(msg.id)) continue;
      setVisibleMsgIds((prev) => {
        const next = new Set(prev);
        next.add(msg.id);
        return next;
      });
      const remaining = Math.max(0, msg.sentAt + CHAT_MSG_TTL_MS - Date.now());
      timers.set(
        msg.id,
        setTimeout(() => {
          timers.delete(msg.id);
          setVisibleMsgIds((prev) => {
            const next = new Set(prev);
            next.delete(msg.id);
            return next;
          });
        }, remaining),
      );
    }
    return () => {
      for (const [id, timer] of timers) {
        clearTimeout(timer);
        timers.delete(id);
      }
    };
  }, [chatMessages]);

  const visibleChatMessages = useMemo(
    () => chatMessages.filter((m) => visibleMsgIds.has(m.id)),
    [chatMessages, visibleMsgIds],
  );
  const hasChatMessages = visibleChatMessages.length > 0;

  const [composeOpen, setComposeOpen] = useState(false);
  const [composeDraft, setComposeDraft] = useState("");
  const [composeSending, setComposeSending] = useState(false);
  const composeSendingRef = useRef(false);

  useEffect(() => {
    if (!visible) {
      setComposeOpen(false);
      setComposeDraft("");
      setComposeSending(false);
      composeSendingRef.current = false;
    }
  }, [visible]);

  const submitCompose = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || !onSendChatMessage || composeSendingRef.current) return;
      composeSendingRef.current = true;
      setComposeSending(true);
      try {
        await onSendChatMessage(trimmed);
        setComposeDraft("");
        setComposeOpen(false);
      } finally {
        composeSendingRef.current = false;
        setComposeSending(false);
      }
    },
    [onSendChatMessage],
  );

  const renderChatOverlay = () => {
    if (!hasChatMessages) return null;
    return (
      <View
        pointerEvents="none"
        style={{
          paddingHorizontal: 20,
          flexShrink: 0,
          zIndex: 30,
        }}
      >
        {visibleChatMessages.slice(-4).map((msg) => (
          <View
            key={msg.id}
            style={{
              flexDirection: "row",
              marginBottom: 4,
              ...(Platform.OS === "web"
                ? ({ animation: "voiceChatMsgFadeIn 0.25s ease-out" } as object)
                : {}),
            }}
          >
            <Text
              numberOfLines={2}
              style={{
                fontFamily:
                  Platform.OS === "web" ? WEB_UI_SANS_STACK : FONT_UI_SANS_REGULAR,
                fontSize: 13,
                lineHeight: 17,
                color: colors.primary,
                includeFontPadding: false,
              }}
            >
              <Text style={{ fontWeight: "600" }}>{msg.senderName}: </Text>
              {msg.text}
            </Text>
          </View>
        ))}
      </View>
    );
  };

  const renderControlsShadow = () => {
    if (!hasChatMessages) return null;
    return (
      <View
        pointerEvents="none"
        style={{
          height: 24,
          flexShrink: 0,
          zIndex: 29,
          ...(Platform.OS === "web"
            ? ({
                background: `linear-gradient(to bottom, transparent, ${colors.background})`,
              } as object)
            : {}),
        }}
      />
    );
  };

  const renderChatComposer = () => {
    if (!composeOpen || !onSendChatMessage) return null;
    return (
      <View
        style={{
          flexShrink: 0,
          zIndex: 40,
          marginTop: 8,
          paddingHorizontal: 12,
          ...(Platform.OS === "web"
            ? ({ position: "relative" } as object)
            : {}),
        }}
        pointerEvents="auto"
        {...(Platform.OS === "web"
          ? ({
              onPointerDown: (e: { stopPropagation?: () => void }) =>
                e.stopPropagation?.(),
            } as object)
          : {})}
      >
        <MessageChatComposePill
          placeholder={t("messages.chatWrite.placeholderPill")}
          value={composeDraft}
          onChangeText={setComposeDraft}
          onSubmit={(text) => {
            void submitCompose(text);
          }}
          sendAccessibilityLabel={t("messages.chatWrite.send")}
          canSend={Boolean(composeDraft.trim()) && !composeSending}
        />
      </View>
    );
  };

  const renderDivider = () => (
    <View
      style={{
        height: 1,
        marginHorizontal: DIVIDER_INSET_PX,
        backgroundColor: colors.highlight,
        flexShrink: 0,
      }}
    />
  );

  const renderSessionError = () => {
    if (!sessionError) return null;
    return (
      <Text
        numberOfLines={3}
        style={[
          typographyRect15,
          {
            color: colors.secondary,
            textAlign: "center",
            paddingHorizontal: 20,
            paddingTop: 10,
            paddingBottom: 0,
            flexShrink: 0,
          },
        ]}
      >
        {sessionError}
      </Text>
    );
  };

  const renderControls = () => (
    <View
      pointerEvents="auto"
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: CONTROL_CHIP_GAP_PX,
        paddingHorizontal: 20,
        paddingTop: 16,
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
        undercoverColor={micUndercoverColor}
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
          logPageDisplay("messages_voice_dialog_control_click", {
            action: composeOpen ? "hide_compose" : "show_compose",
          });
          setComposeOpen((prev) => !prev);
        }}
      >
        <VoiceMessagesIcon
          color={composeOpen ? VOICE_SPEAKING_MIC_COLOR : iconColor}
          size={CONTROL_ICON_PX}
        />
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
  );

  const sheetBody = (
    <View
      pointerEvents="box-none"
      style={[
        appModalSheetStyles.overlayBlock,
        {
          minHeight: windowHeight,
          zIndex: 2,
          // No full-viewport hit target — underlay stays interactive.
          pointerEvents: "box-none",
        },
      ]}
    >
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
                  transform: `translate(${sheetOffset.x}px, ${sheetOffset.y}px)`,
                  cursor: movingSheet ? "grabbing" : undefined,
                  overscrollBehavior: "contain",
                } as object)
              : {
                  flexDirection: "column",
                  transform: [
                    { translateX: sheetOffset.x },
                    { translateY: sheetOffset.y },
                  ],
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

        {sideBySide ? (
          <View
            style={{
              flex: 1,
              minHeight: 0,
              flexDirection: "row",
              alignItems: "stretch",
            }}
          >
            <View
              style={{
                width: videoPaneWidth,
                flexShrink: 0,
                minHeight: 0,
                paddingLeft: 12,
                paddingRight: 8,
                paddingTop: 12,
                paddingBottom: 12,
              }}
            >
              <MessageChatVoiceMediaStage
                sources={suspendHeavy ? [] : mediaSources}
                active={videoStageActive}
                fillHeight
                wideLayout
                focusedId={focusedMediaId}
                onFocusedIdChange={setFocusedMediaId}
                externalPips
                horizontalInsetPx={0}
                marginBottomPx={0}
                connectionInterrupted={mediaReconnecting}
                connectionInterruptedLabel={connectionInterruptedLabel}
                connectionInterruptedBg={colors.secondary}
                connectionInterruptedFg={colors.primary}
              />
            </View>
            <View
              style={{
                width: rosterPaneWidth,
                flexShrink: 0,
                minHeight: 0,
                flexDirection: "column",
              }}
            >
              {renderHeader()}
              {renderDivider()}
              {renderMiddleScroll({ includeSidebarPips: true })}
              {renderChatOverlay()}
              {renderControlsShadow()}
              {renderDivider()}
              {renderSessionError()}
              {renderControls()}
              {renderChatComposer()}
            </View>
          </View>
        ) : (
          <>
            {renderHeader()}
            {renderDivider()}
            {renderMiddleScroll({ includeStackedMedia: true })}
            {renderChatOverlay()}
            {renderControlsShadow()}
            {renderDivider()}
            {renderSessionError()}
            {renderControls()}
            {renderChatComposer()}
          </>
        )}
      </View>
      <MessageChatVoiceMoreMenu
        visible={moreMenuAnchor != null}
        anchor={moreMenuAnchor}
        colors={colors}
        items={moreMenuItems}
        onClose={() => setMoreMenuAnchor(null)}
      />
      {(() => {
        if (!participantMenuTarget) return null;
        const prefsKey = voiceParticipantPrefsKey(participantMenuTarget);
        const prefs = participantMediaPrefs[prefsKey];
        const volumePercent =
          prefs?.volumePercent ??
          (typeof participantMenuTarget.volume_percent === "number"
            ? participantMenuTarget.volume_percent
            : 100);
        const hasVideo = Boolean(
          participantMenuTarget.video_info?.endpoint_id?.trim() ||
            (participantMenuTarget.video_info?.source_groups?.length ?? 0) > 0,
        );
        const hasScreen = Boolean(
          participantMenuTarget.screen_sharing_video_info?.endpoint_id?.trim() ||
            (participantMenuTarget.screen_sharing_video_info?.source_groups?.length ?? 0) >
              0,
        );
        const muteVideo = Boolean(prefs?.muteVideo);
        // Default unmuted for active shares — only true when user muted in menu
        // or session paused the screen after mix-protect drop.
        const muteScreen = isScreenLocallyOff(participantMenuTarget);
        // Listen preference — mute is allowed before they publish (preemptive).
        const voiceOn = volumePercent > 0;
        const videoOn = !muteVideo;
        const screenOn = !muteScreen;
        const peerIsChannel = isVoiceParticipantChannelDisplay(participantMenuTarget);
        const closeParticipantMenu = () => {
          setParticipantMenuAnchor(null);
          setParticipantMenuTarget(null);
        };
        const openMenuPeerProfile = () => {
          const peer = participantMenuTarget;
          closeParticipantMenu();
          const peerTitle = formatVoiceParticipantTitle(peer);
          if (isVoiceParticipantChannelDisplay(peer)) {
            const chatId = Math.trunc(peer.chat_id!);
            openProfileSheet({
              telegram_chat_id: chatId,
              title: peerTitle,
              peer_user_id: null,
              chat_kind: "channel",
            });
            return;
          }
          const userId = peer.user_id;
          if (userId == null || !Number.isFinite(userId) || userId === 0) return;
          openProfileSheet({
            telegram_chat_id:
              peer.chat_id != null && Number.isFinite(peer.chat_id)
                ? Math.trunc(peer.chat_id)
                : Math.trunc(userId),
            title: peerTitle,
            peer_user_id: Math.trunc(userId),
            peer_emoji_status_custom_emoji_id: peer.emoji_status_custom_emoji_id,
            chat_kind: "private",
          });
        };
        const openMenuPeerChat = () => {
          const peer = participantMenuTarget;
          closeParticipantMenu();
          const peerTitle = formatVoiceParticipantTitle(peer);
          if (isVoiceParticipantChannelDisplay(peer)) {
            const chatId = Math.trunc(peer.chat_id!);
            openAuthenticatedHomeChatHistory({
              id: 0,
              telegram_chat_id: chatId,
              title: peerTitle,
              subtitle: "",
              avatar_url: resolveTelegramUserAvatarUrl(peer),
              last_message_at: null,
              unread_count: 0,
              peer_user_id: null,
              chat_kind: "channel",
            });
            return;
          }
          const userId = peer.user_id;
          if (userId == null || !Number.isFinite(userId) || userId === 0) return;
          const truncUser = Math.trunc(userId);
          openAuthenticatedHomeChatHistory({
            id: 0,
            telegram_chat_id:
              peer.chat_id != null && Number.isFinite(peer.chat_id) && peer.chat_id !== 0
                ? Math.trunc(peer.chat_id)
                : truncUser,
            title: peerTitle,
            subtitle: "",
            avatar_url: resolveTelegramUserAvatarUrl(peer),
            last_message_at: null,
            unread_count: 0,
            peer_user_id: truncUser,
            chat_kind: "private",
          });
        };
        return (
          <MessageChatVoiceParticipantMenu
            visible={participantMenuAnchor != null}
            anchor={participantMenuAnchor}
            colors={colors}
            volumePercent={volumePercent}
            voiceOn={voiceOn}
            videoOn={videoOn}
            screenOn={screenOn}
            videoAvailable={hasVideo}
            screenAvailable={hasScreen}
            peerIsChannel={peerIsChannel}
            onClose={closeParticipantMenu}
            onViewProfile={openMenuPeerProfile}
            onSendMessage={openMenuPeerChat}
            onVolumeChange={(percent) => {
              onParticipantVolumeChange?.(participantMenuTarget, percent);
            }}
            onToggleVoice={() => {
              onParticipantToggleMuteVoice?.(participantMenuTarget);
            }}
            onToggleVideo={() => {
              onParticipantToggleMuteVideo?.(participantMenuTarget);
            }}
            onToggleScreen={() => {
              onParticipantToggleMuteScreen?.(participantMenuTarget);
            }}
          />
        );
      })()}
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
            // Root stays none so only backdrop/sheet children capture hits.
            // A full-viewport pointer-events:auto + cursor:pointer backdrop made
            // the entire website look clickable while Join froze the sheet.
            pointerEvents: "none",
            cursor: "default",
          },
        },
        // Hide via opacity/pointer-events only. Never drop sheetBody while the
        // dialog is open — suspendHeavy racing a reopen painted an empty sheet
        // ("participants" label only, no rows) and felt like a UI freeze.
        dialogOpen || !suspendHeavy ? sheetBody : null,
      ),
      portalTarget,
    );
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={() => {
        onDropPress();
      }}
    >
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
