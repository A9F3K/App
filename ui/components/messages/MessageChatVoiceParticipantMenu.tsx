import { useCallback, useEffect, useId, useMemo, useState, createElement, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type LayoutChangeEvent,
} from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { useAppStrings } from "../../../locales/AppStringsContext";
import { FONT_UI_SANS_REGULAR, WEB_UI_SANS_STACK } from "../../fonts";
import { typographyRect15, type ThemeColors } from "../../theme";
import {
  ChatMenuGroupInfoIcon,
  ChatMenuProfileIcon,
} from "./MessageChatListContextMenuIcons";
import {
  VoiceCameraIcon,
  VoiceMicControlIcon,
  VoiceScreenShareIcon,
} from "./MessageChatVoiceControlIcons";
import { ProfileMessagesIcon } from "./MessageChatProfileIcons";

export type VoiceParticipantMenuAnchor = {
  x: number;
  y: number;
};

const MENU_PADDING_PX = 15;
const MENU_ITEM_HEIGHT_PX = 15;
const MENU_ITEM_GAP_PX = 20;
const MENU_MIN_WIDTH_PX = 200;
const MENU_VIEWPORT_MARGIN_PX = 8;
const VOLUME_ROW_HEIGHT_PX = 28;
const STATUS_ON = "#1AAA11";
const STATUS_OFF = "#FF1111";

type Props = {
  visible: boolean;
  anchor: VoiceParticipantMenuAnchor | null;
  colors: ThemeColors;
  volumePercent: number;
  voiceOn: boolean;
  videoOn: boolean;
  screenOn: boolean;
  /** Peer currently publishing camera — when false, mute is a preemptive preference. */
  videoAvailable?: boolean;
  /** Peer currently publishing screencast. */
  screenAvailable?: boolean;
  /**
   * Channel/anonymous-chat display mode → "View channel"; otherwise "View profile".
   */
  peerIsChannel?: boolean;
  onClose: () => void;
  onViewProfile: () => void;
  onSendMessage: () => void;
  onVolumeChange: (percent: number) => void;
  onToggleVoice: () => void;
  onToggleVideo: () => void;
  onToggleScreen: () => void;
};

function menuHeightPx(): number {
  // view + send + volume + 3 media actions + dividers between all 6 blocks
  return (
    MENU_PADDING_PX * 2 +
    VOLUME_ROW_HEIGHT_PX +
    MENU_ITEM_HEIGHT_PX * 5 +
    MENU_ITEM_GAP_PX * 5
  );
}

function clampMenuPosition(
  anchor: VoiceParticipantMenuAnchor,
  menuWidth: number,
  menuHeight: number,
  windowWidth: number,
  windowHeight: number,
): { left: number; top: number } {
  let left = anchor.x;
  let top = anchor.y;
  if (left + menuWidth > windowWidth - MENU_VIEWPORT_MARGIN_PX) {
    left = Math.max(MENU_VIEWPORT_MARGIN_PX, windowWidth - menuWidth - MENU_VIEWPORT_MARGIN_PX);
  }
  if (top + menuHeight > windowHeight - MENU_VIEWPORT_MARGIN_PX) {
    top = Math.max(MENU_VIEWPORT_MARGIN_PX, windowHeight - menuHeight - MENU_VIEWPORT_MARGIN_PX);
  }
  return {
    left: Math.max(MENU_VIEWPORT_MARGIN_PX, left),
    top: Math.max(MENU_VIEWPORT_MARGIN_PX, top),
  };
}

function ContextMenuDivider({ color }: { color: string }) {
  const gradientId = useId();
  const [width, setWidth] = useState(0);
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    setWidth(event.nativeEvent.layout.width);
  }, []);

  return (
    <View
      style={{
        height: MENU_ITEM_GAP_PX,
        justifyContent: "center",
        alignSelf: "stretch",
      }}
      onLayout={onLayout}
    >
      {width > 0 ? (
        <Svg width={width} height={1} viewBox={`0 0 ${width} 1`}>
          <Defs>
            <LinearGradient id={gradientId} x1="0%" y1="0" x2="100%" y2="0">
              <Stop offset="0%" stopColor={color} stopOpacity={0} />
              <Stop offset="50%" stopColor={color} stopOpacity={1} />
              <Stop offset="100%" stopColor={color} stopOpacity={0} />
            </LinearGradient>
          </Defs>
          <Rect x={0} y={0} width={width} height={1} fill={`url(#${gradientId})`} />
        </Svg>
      ) : null}
    </View>
  );
}

function VolumeSlider({
  colors,
  value,
  onChange,
}: {
  colors: ThemeColors;
  value: number;
  onChange: (percent: number) => void;
}) {
  const { t } = useAppStrings();
  const clamped = Math.min(200, Math.max(0, Math.round(value)));

  if (Platform.OS === "web") {
    return (
      <View
        style={{
          height: VOLUME_ROW_HEIGHT_PX,
          justifyContent: "center",
          minWidth: MENU_MIN_WIDTH_PX - MENU_PADDING_PX * 2,
        }}
        // Keep slider drags from hitting the dismiss backdrop.
        onStartShouldSetResponder={() => true}
        onMoveShouldSetResponder={() => true}
      >
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 10,
          }}
        >
          {createElement("input", {
            type: "range",
            min: 0,
            max: 200,
            step: 1,
            value: clamped,
            "aria-label": t("messages.voiceChat.participant.volume"),
            onInput: (event: { target: { value: string } }) => {
              onChange(Number(event.target.value));
            },
            onChange: (event: { target: { value: string } }) => {
              onChange(Number(event.target.value));
            },
            onClick: (event: { stopPropagation?: () => void }) => {
              event.stopPropagation?.();
            },
            onPointerDown: (event: { stopPropagation?: () => void }) => {
              event.stopPropagation?.();
            },
            style: {
              flex: 1,
              minWidth: 110,
              accentColor: colors.primary,
              cursor: "pointer",
            },
          })}
          <Text
            style={{
              color: colors.primary,
              fontFamily: WEB_UI_SANS_STACK,
              fontSize: 13,
              lineHeight: 15,
              minWidth: 40,
              textAlign: "right",
            }}
          >
            {clamped}%
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={{ height: VOLUME_ROW_HEIGHT_PX, justifyContent: "center" }}>
      <Text
        style={{
          color: colors.primary,
          fontFamily: FONT_UI_SANS_REGULAR,
          fontSize: 13,
          lineHeight: 15,
        }}
      >
        {t("messages.voiceChat.participant.volume")}: {clamped}%
      </Text>
      <View style={{ flexDirection: "row", gap: 8, marginTop: 4 }}>
        {[0, 50, 100, 150, 200].map((preset) => (
          <Pressable key={preset} onPress={() => onChange(preset)}>
            <Text
              style={{
                color: clamped === preset ? colors.primary : colors.secondary,
                fontFamily: FONT_UI_SANS_REGULAR,
                fontSize: 12,
              }}
            >
              {preset}%
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

function ActionRow({
  label,
  icon,
  onPress,
  colors,
  inactive = false,
}: {
  label: string;
  icon: ReactNode;
  onPress: () => void;
  colors: ThemeColors;
  /** Dimmed — e.g. preemptive mute while peer is not publishing. Still pressable. */
  inactive?: boolean;
}) {
  const textStyle = useMemo(
    () => [
      typographyRect15,
      {
        color: inactive ? colors.secondary : colors.primary,
        height: MENU_ITEM_HEIGHT_PX,
        lineHeight: MENU_ITEM_HEIGHT_PX,
        fontFamily: Platform.OS === "web" ? WEB_UI_SANS_STACK : FONT_UI_SANS_REGULAR,
        includeFontPadding: false,
        textAlign: "left" as const,
        flexShrink: 1,
      },
    ],
    [colors.primary, colors.secondary, inactive],
  );

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        height: MENU_ITEM_HEIGHT_PX,
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        opacity: pressed ? 0.7 : inactive ? 0.55 : 1,
      })}
    >
      <View style={{ width: 18, height: 18, alignItems: "center", justifyContent: "center" }}>
        {icon}
      </View>
      <Text style={textStyle} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

function streamActionVisual(opts: {
  listening: boolean;
  available: boolean;
  colors: ThemeColors;
}): { statusColor: string; inactive: boolean } {
  // Muted preference always reads as active red (blocks future streams too).
  if (!opts.listening) {
    return { statusColor: STATUS_OFF, inactive: false };
  }
  // Will show when they publish — dim green so it does not look already "live".
  if (!opts.available) {
    return { statusColor: opts.colors.secondary, inactive: true };
  }
  return { statusColor: STATUS_ON, inactive: false };
}

function ParticipantMenuPanel({
  colors,
  volumePercent,
  voiceOn,
  videoOn,
  screenOn,
  videoAvailable,
  screenAvailable,
  peerIsChannel,
  onLayout,
  onViewProfile,
  onSendMessage,
  onVolumeChange,
  onToggleVoice,
  onToggleVideo,
  onToggleScreen,
}: {
  colors: ThemeColors;
  volumePercent: number;
  voiceOn: boolean;
  videoOn: boolean;
  screenOn: boolean;
  videoAvailable: boolean;
  screenAvailable: boolean;
  peerIsChannel: boolean;
  onLayout?: (event: LayoutChangeEvent) => void;
  onViewProfile: () => void;
  onSendMessage: () => void;
  onVolumeChange: (percent: number) => void;
  onToggleVoice: () => void;
  onToggleVideo: () => void;
  onToggleScreen: () => void;
}) {
  const { t } = useAppStrings();
  const screenVisual = streamActionVisual({
    listening: screenOn,
    available: screenAvailable,
    colors,
  });
  const videoVisual = streamActionVisual({
    listening: videoOn,
    available: videoAvailable,
    colors,
  });

  return (
    <View
      onLayout={onLayout}
      style={{
        minWidth: MENU_MIN_WIDTH_PX,
        padding: MENU_PADDING_PX,
        backgroundColor: colors.undercover,
        borderWidth: 1,
        borderColor: colors.highlight,
        alignSelf: "flex-start",
        ...Platform.select({
          web: { boxSizing: "border-box" as const },
          default: {},
        }),
      }}
    >
      <ActionRow
        colors={colors}
        label={
          peerIsChannel
            ? t("messages.voiceChat.participant.viewChannel")
            : t("messages.voiceChat.participant.viewProfile")
        }
        onPress={onViewProfile}
        icon={
          peerIsChannel ? (
            <ChatMenuGroupInfoIcon color={colors.primary} size={16} />
          ) : (
            <ChatMenuProfileIcon color={colors.primary} size={16} />
          )
        }
      />
      <ContextMenuDivider color={colors.highlight} />
      <ActionRow
        colors={colors}
        label={t("messages.voiceChat.participant.sendMessage")}
        onPress={onSendMessage}
        icon={<ProfileMessagesIcon color={colors.primary} size={16} />}
      />
      <ContextMenuDivider color={colors.highlight} />
      <VolumeSlider colors={colors} value={volumePercent} onChange={onVolumeChange} />
      <ContextMenuDivider color={colors.highlight} />
      <ActionRow
        colors={colors}
        label={
          voiceOn
            ? t("messages.voiceChat.participant.muteVoice")
            : t("messages.voiceChat.participant.unmuteVoice")
        }
        onPress={onToggleVoice}
        icon={
          <VoiceMicControlIcon
            color={voiceOn ? STATUS_ON : STATUS_OFF}
            size={16}
            muted={!voiceOn}
          />
        }
      />
      <ContextMenuDivider color={colors.highlight} />
      <ActionRow
        colors={colors}
        inactive={screenVisual.inactive}
        label={
          screenOn
            ? t("messages.voiceChat.participant.muteScreen")
            : t("messages.voiceChat.participant.unmuteScreen")
        }
        onPress={onToggleScreen}
        icon={
          <VoiceScreenShareIcon
            color={screenVisual.statusColor}
            size={16}
            active={screenOn}
          />
        }
      />
      <ContextMenuDivider color={colors.highlight} />
      <ActionRow
        colors={colors}
        inactive={videoVisual.inactive}
        label={
          videoOn
            ? t("messages.voiceChat.participant.muteVideo")
            : t("messages.voiceChat.participant.unmuteVideo")
        }
        onPress={onToggleVideo}
        icon={
          <VoiceCameraIcon
            color={videoVisual.statusColor}
            size={16}
            muted={!videoOn}
          />
        }
      />
    </View>
  );
}

function MessageChatVoiceParticipantMenuNative(props: Props) {
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const [menuWidth, setMenuWidth] = useState(MENU_MIN_WIDTH_PX);
  const menuHeight = menuHeightPx();
  const position =
    props.anchor != null
      ? clampMenuPosition(props.anchor, menuWidth, menuHeight, windowWidth, windowHeight)
      : { left: MENU_VIEWPORT_MARGIN_PX, top: MENU_VIEWPORT_MARGIN_PX };

  return (
    <Modal
      visible={props.visible}
      transparent
      animationType="none"
      onRequestClose={props.onClose}
    >
      <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
        <Pressable style={StyleSheet.absoluteFill} onPress={props.onClose} />
        <View
          pointerEvents="box-none"
          style={{
            position: "absolute",
            left: position.left,
            top: position.top,
          }}
        >
          <ParticipantMenuPanel
            colors={props.colors}
            volumePercent={props.volumePercent}
            voiceOn={props.voiceOn}
            videoOn={props.videoOn}
            screenOn={props.screenOn}
            videoAvailable={props.videoAvailable !== false}
            screenAvailable={props.screenAvailable !== false}
            peerIsChannel={Boolean(props.peerIsChannel)}
            onViewProfile={props.onViewProfile}
            onSendMessage={props.onSendMessage}
            onVolumeChange={props.onVolumeChange}
            onToggleVoice={props.onToggleVoice}
            onToggleVideo={props.onToggleVideo}
            onToggleScreen={props.onToggleScreen}
            onLayout={(event) => {
              const next = Math.ceil(event.nativeEvent.layout.width);
              if (next > 0) setMenuWidth(next);
            }}
          />
        </View>
      </View>
    </Modal>
  );
}

function MessageChatVoiceParticipantMenuWeb(props: Props) {
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const [menuWidth, setMenuWidth] = useState(MENU_MIN_WIDTH_PX);
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const menuHeight = menuHeightPx();

  useEffect(() => {
    if (typeof document !== "undefined") {
      setPortalTarget(document.body);
    }
  }, []);

  useEffect(() => {
    if (!props.visible || Platform.OS !== "web") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [props]);

  if (!props.visible || !props.anchor || !portalTarget) return null;

  const position = clampMenuPosition(
    props.anchor,
    menuWidth,
    menuHeight,
    windowWidth,
    windowHeight,
  );

  return createPortal(
    <View
      style={{
        position: "fixed",
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
        zIndex: 10050,
      }}
      pointerEvents="box-none"
    >
      <Pressable style={StyleSheet.absoluteFill} onPress={props.onClose} />
      <View
        pointerEvents="auto"
        style={{
          position: "fixed",
          left: position.left,
          top: position.top,
        }}
      >
        <ParticipantMenuPanel
          colors={props.colors}
          volumePercent={props.volumePercent}
          voiceOn={props.voiceOn}
          videoOn={props.videoOn}
          screenOn={props.screenOn}
          videoAvailable={props.videoAvailable !== false}
          screenAvailable={props.screenAvailable !== false}
          peerIsChannel={Boolean(props.peerIsChannel)}
          onViewProfile={props.onViewProfile}
          onSendMessage={props.onSendMessage}
          onVolumeChange={props.onVolumeChange}
          onToggleVoice={props.onToggleVoice}
          onToggleVideo={props.onToggleVideo}
          onToggleScreen={props.onToggleScreen}
          onLayout={(event) => {
            const next = Math.ceil(event.nativeEvent.layout.width);
            if (next > 0) setMenuWidth(next);
          }}
        />
      </View>
    </View>,
    portalTarget,
  );
}

/** Same chrome as the message right-click menu — per-participant volume + mute. */
export function MessageChatVoiceParticipantMenu(props: Props) {
  if (Platform.OS === "web") {
    return <MessageChatVoiceParticipantMenuWeb {...props} />;
  }
  return <MessageChatVoiceParticipantMenuNative {...props} />;
}
