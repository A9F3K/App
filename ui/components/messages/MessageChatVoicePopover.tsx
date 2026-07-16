import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
import { HspScrollColumn } from "../HspScrollColumn";
import { LiquidGlassShaderUndercover } from "../LiquidGlassShaderUndercover";
import { useTelegram } from "../Telegram";
import { appModalSheetStyles } from "../AppModalSheet";
import type { TelegramChatVoiceParticipant } from "../../telegram/fetchTelegramChatVoiceParticipants";
import { MessageChatAvatarSlot } from "./MessageChatAvatarSlot";
import { extractChatAvatarInitials } from "./chatAvatarInitials";
import { resolveTelegramUserAvatarUrl } from "./resolveTelegramUserAvatarUrl";
import { SpecialTelegramUserName } from "./SpecialTelegramUserName";
import {
  MESSAGE_AVATAR_PX,
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

const WINDOW_ICON_SIZE_PX = 15;
const WINDOW_ICON_GAP_PX = 12;
const CONTROL_CHIP_PX = 50;
const CONTROL_ICON_PX = 20;
const CONTROL_CHIP_GAP_PX = 15;
const DIVIDER_INSET_PX = 20;
const DEFAULT_SHEET_WIDTH_PX = 380;
const DEFAULT_SHEET_HEIGHT_PX = 560;
const MIN_SHEET_WIDTH_PX = 300;
const MIN_SHEET_HEIGHT_PX = 280;
const SHEET_CHROME_HEIGHT_PX = 148;
const VOICE_SIZE_STORAGE_KEY = "hsp.voiceChatDialog.size.v1";
const VOICE_SPEAKING_MIC_COLOR = "#34C759";
const AH = layout.authenticatedHome;
const HIT = AH.splitPaneDividerHitWidthPx;
const STROKE = AH.splitPaneDividerStrokePx;

type Edge = "n" | "s" | "e" | "w";
type ResizeHandle = Edge | "ne" | "nw" | "se" | "sw";

type Props = {
  visible: boolean;
  onClose: () => void;
  title: string;
  /** TDLib/call total when larger than the loaded `participants` list. */
  participantCount?: number;
  participants: TelegramChatVoiceParticipant[];
  colors: ThemeColors;
  micActive: boolean;
  micJoining: boolean;
  onMicPress: () => void;
  onDropPress: () => void;
  dropLeaving: boolean;
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

function VoiceParticipantRow({
  participant,
  isLast,
  colors,
}: {
  participant: TelegramChatVoiceParticipant;
  isLast: boolean;
  colors: ThemeColors;
}) {
  const { colorScheme } = useTelegram();
  const title = participant.title.trim() || "?";
  const description = participant.description.trim();
  const avatarUrl = resolveTelegramUserAvatarUrl(participant);
  const textBase = {
    fontFamily: Platform.OS === "web" ? WEB_UI_SANS_STACK : FONT_UI_SANS_REGULAR,
    fontSize: MESSAGE_FONT_SIZE_PX,
    lineHeight: MESSAGE_LINE_HEIGHT_PX,
    includeFontPadding: false,
    paddingVertical: 0,
  } as const;

  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        minHeight: description ? 48 : 40,
        width: "100%",
        marginBottom: isLast ? 0 : 10,
      }}
    >
      <View
        accessibilityRole="image"
        style={{
          width: 28,
          height: 28,
          alignItems: "center",
          justifyContent: "center",
          marginRight: 8,
          flexShrink: 0,
        }}
      >
        <VoiceParticipantStateMicIcon
          speaking={participant.is_speaking}
          color={participant.is_speaking ? VOICE_SPEAKING_MIC_COLOR : colors.primary}
          size={20}
        />
      </View>
      <View
        style={{
          width: MESSAGE_AVATAR_PX,
          height: MESSAGE_AVATAR_PX,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <MessageChatAvatarSlot
          iconUrl={avatarUrl}
          initials={extractChatAvatarInitials(title)}
          sizePx={MESSAGE_AVATAR_PX}
          colors={colors}
          scheme={colorScheme}
          fetchPriority="high"
        />
      </View>
      <View style={{ width: MESSAGE_ICON_TEXT_GAP_PX }} />
      <View style={{ flex: 1, minWidth: 0, justifyContent: "center" }}>
        <SpecialTelegramUserName
          name={title}
          telegramUserId={participant.user_id}
          telegramChatId={participant.chat_id}
          emojiStatusCustomEmojiId={participant.emoji_status_custom_emoji_id}
          emojiStatusPriority
          inlineEmojiFetchEnabled
          inlineEmojiFetchPriority
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
    </View>
  );
}

function VoiceControlChip({
  label,
  onPress,
  disabled,
  children,
  undercoverColor,
  phaseOffset,
  isLightTheme,
  variant,
}: {
  label: string;
  onPress?: () => void;
  disabled?: boolean;
  children: ReactNode;
  undercoverColor?: string;
  phaseOffset?: number;
  isLightTheme?: boolean;
  variant: "simple" | "liquid";
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
        }}
      >
        {children}
      </View>
    );

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
  const base: ViewStyle = {
    position: "absolute",
    zIndex: 4,
    ...(Platform.OS === "web"
      ? ({
          cursor: cursorForHandle(handle),
          touchAction: "none",
          userSelect: "none",
        } as object)
      : {}),
  };

  let geometry: ViewStyle;
  switch (handle) {
    case "n":
      geometry = { top: -half, left: HIT, right: HIT, height: HIT };
      break;
    case "s":
      geometry = { bottom: -half, left: HIT, right: HIT, height: HIT };
      break;
    case "e":
      geometry = { top: HIT, bottom: HIT, right: -half, width: HIT };
      break;
    case "w":
      geometry = { top: HIT, bottom: HIT, left: -half, width: HIT };
      break;
    case "ne":
      geometry = { top: -half, right: -half, width: HIT, height: HIT };
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

  return (
    <View
      style={[base, geometry]}
      {...(Platform.OS === "web"
        ? ({
            onPointerDown,
            onPointerEnter: () => onHoverChange(true),
            onPointerLeave: () => onHoverChange(false),
          } as object)
        : {})}
    />
  );
}

/** Settings-style modal for an active chat voice call. */
export function MessageChatVoicePopover({
  visible,
  onClose,
  title,
  participantCount,
  participants,
  colors,
  micActive,
  micJoining,
  onMicPress,
  onDropPress,
  dropLeaving,
}: Props) {
  const { t, tf, locale } = useAppStrings();
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const isLightTheme = colors.primary === "#000000";
  const iconColor = colors.primary;
  const chatTitle = title.trim() || t("messages.voiceChat.active");
  const totalParticipantCount = Math.max(participantCount ?? 0, participants.length);
  const participantCountLabel =
    totalParticipantCount > 0
      ? tf("messages.chatMemberCount.participants", {
          count: totalParticipantCount.toLocaleString(locale === "ru" ? "ru-RU" : "en-US"),
        })
      : "";

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

  useEffect(() => {
    if (!visible || Platform.OS !== "web" || typeof document === "undefined") return;
    const html = document.documentElement;
    const body = document.body;
    const prevHtmlOverflow = html.style.overflow;
    const prevBodyOverflow = body.style.overflow;
    html.style.overflow = "hidden";
    body.style.overflow = "hidden";
    return () => {
      html.style.overflow = prevHtmlOverflow;
      body.style.overflow = prevBodyOverflow;
    };
  }, [visible]);

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

  const listMaxHeight = Math.max(80, sheetSize.height - SHEET_CHROME_HEIGHT_PX);
  const handles: ResizeHandle[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <HspScrollColumn
        style={{ height: windowHeight, width: "100%", minHeight: 0 }}
        contentContainerStyle={{
          flexGrow: 1,
          minHeight: windowHeight,
          justifyContent: "center",
          alignItems: "center",
        }}
        containOverscroll
        scrollEnabled={!draggingHandle}
      >
        <View style={[appModalSheetStyles.overlayBlock, { minHeight: windowHeight }]}>
          <Pressable
            style={appModalSheetStyles.backdropFill}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel={t("common.back")}
          />
          <View
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
                overflow: "visible",
              },
            ]}
            {...(Platform.OS === "web"
              ? ({
                  onClick: (e: { stopPropagation?: () => void }) => e.stopPropagation?.(),
                } as object)
              : {})}
            onStartShouldSetResponder={() => true}
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
              style={{
                flexDirection: "row",
                alignItems: "center",
                paddingHorizontal: 20,
                marginBottom: 16,
                gap: 12,
              }}
            >
              <View style={{ flex: 1, minWidth: 0 }}>
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
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: WINDOW_ICON_GAP_PX,
                  flexShrink: 0,
                }}
              >
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t("common.back")}
                  onPress={onClose}
                  hitSlop={8}
                  style={({ pressed }) => ({
                    width: WINDOW_ICON_SIZE_PX + 4,
                    height: WINDOW_ICON_SIZE_PX + 4,
                    alignItems: "center",
                    justifyContent: "center",
                    opacity: pressed ? 0.7 : 1,
                  })}
                >
                  <VoiceWindowCrossIcon color={iconColor} size={WINDOW_ICON_SIZE_PX} />
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t("messages.voiceChat.expand")}
                  onPress={expandToDefault}
                  hitSlop={8}
                  style={({ pressed }) => ({
                    width: WINDOW_ICON_SIZE_PX + 4,
                    height: WINDOW_ICON_SIZE_PX + 4,
                    alignItems: "center",
                    justifyContent: "center",
                    opacity: pressed ? 0.7 : 1,
                  })}
                >
                  <VoiceWindowSizeIcon color={iconColor} size={WINDOW_ICON_SIZE_PX} />
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t("messages.voiceChat.minimize")}
                  onPress={minimizeSheet}
                  hitSlop={8}
                  style={({ pressed }) => ({
                    width: WINDOW_ICON_SIZE_PX + 4,
                    height: WINDOW_ICON_SIZE_PX + 4,
                    alignItems: "center",
                    justifyContent: "center",
                    opacity: pressed ? 0.7 : 1,
                  })}
                >
                  <VoiceWindowTrayIcon color={iconColor} size={WINDOW_ICON_SIZE_PX} />
                </Pressable>
              </View>
            </View>

            <View style={{ paddingHorizontal: 20, flex: 1, minHeight: 0, maxHeight: listMaxHeight }}>
              <ScrollView style={{ flex: 1, maxHeight: listMaxHeight }} nestedScrollEnabled>
                {participants.length > 0 ? (
                  participants.map((participant, index) => (
                    <VoiceParticipantRow
                      key={
                        participant.user_id != null
                          ? `u:${participant.user_id}`
                          : `c:${participant.chat_id}:${index}`
                      }
                      participant={participant}
                      isLast={index === participants.length - 1}
                      colors={colors}
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
              }}
            />

            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "center",
                gap: CONTROL_CHIP_GAP_PX,
                paddingHorizontal: 20,
                ...(Platform.OS === "web" ? ({ direction: "ltr" } as object) : {}),
              }}
            >
              <VoiceControlChip
                key="more"
                label={t("messages.voiceChat.controls.more")}
                variant="simple"
                undercoverColor={colors.undercover}
              >
                <VoiceMoreIcon color={iconColor} size={CONTROL_ICON_PX} />
              </VoiceControlChip>
              <VoiceControlChip
                key="video"
                label={t("messages.voiceChat.controls.camera")}
                variant="simple"
                undercoverColor={colors.undercover}
              >
                <VoiceCameraIcon color={iconColor} size={CONTROL_ICON_PX} />
              </VoiceControlChip>
              <VoiceControlChip
                key="mic"
                label={t("messages.voiceChat.controls.mic")}
                variant={micActive ? "liquid" : "simple"}
                undercoverColor={colors.undercover}
                isLightTheme={isLightTheme}
                phaseOffset={0.38}
                onPress={onMicPress}
                disabled={micJoining}
              >
                <VoiceMicControlIcon color={iconColor} size={CONTROL_ICON_PX} />
              </VoiceControlChip>
              <VoiceControlChip
                key="chat"
                label={t("messages.voiceChat.controls.messages")}
                variant="simple"
                undercoverColor={colors.undercover}
              >
                <VoiceMessagesIcon color={iconColor} size={CONTROL_ICON_PX} />
              </VoiceControlChip>
              <VoiceControlChip
                key="phone"
                label={t("messages.voiceChat.controls.drop")}
                variant="simple"
                undercoverColor={colors.undercover}
                onPress={onDropPress}
                disabled={dropLeaving}
              >
                <VoiceDropIcon color={iconColor} size={CONTROL_ICON_PX} />
              </VoiceControlChip>
            </View>
          </View>
        </View>
      </HspScrollColumn>
    </Modal>
  );
}
