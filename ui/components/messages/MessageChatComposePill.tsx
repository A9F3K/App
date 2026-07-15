import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Platform, ScrollView, StyleSheet, Text, TextInput, View, type NativeScrollEvent, type NativeSyntheticEvent, type TextInputContentSizeChangeEventData } from "react-native";
import { WEB_UI_SANS_STACK } from "../../fonts";
import { layout, typographyRect15, uiTextVerticalCompensationY, useColors } from "../../theme";
import { BottomBarSendCircleButton } from "../BottomBarSendCircleButton";
import { getBottomBarMetrics } from "../bottomBarMetrics";
import {
  MESSAGE_CHAT_COMPOSE_PILL_HEIGHT_PX,
  MESSAGE_CHAT_COMPOSE_PILL_PADDING_LEFT_PX,
  MESSAGE_CHAT_COMPOSE_PILL_PADDING_RIGHT_PX,
  MESSAGE_CHAT_COMPOSE_PILL_RADIUS_PX,
} from "./messageChatLayout";

type Props = {
  placeholder: string;
  value: string;
  onChangeText: (next: string) => void;
  onSubmit: (text: string) => void;
  sendAccessibilityLabel: string;
  canSend: boolean;
  onHeightChange?: (heightPx: number) => void;
};

const {
  lineHeight: LINE_HEIGHT,
  maxLinesBeforeScroll: MAX_LINES_BEFORE_SCROLL,
  maxBarHeight: MAX_PILL_HEIGHT,
  applyIconBottom: APPLY_ICON_BOTTOM,
  textToSendIconGapPx: TEXT_TO_SEND_ICON_GAP_PX,
} = layout.bottomBar;

const FONT_SIZE = 15;
const INNER_PADDING = 20;
const MIN_PILL_HEIGHT = MESSAGE_CHAT_COMPOSE_PILL_HEIGHT_PX;
const AUTO_SCROLL_THRESHOLD = 30;

/** Pill compose field — expands vertically on multiline input like {@link GlobalBottomBar}. */
export function MessageChatComposePill({
  placeholder,
  value,
  onChangeText,
  onSubmit,
  sendAccessibilityLabel,
  canSend,
  onHeightChange,
}: Props) {
  const colors = useColors();

  if (Platform.OS === "web") {
    return (
      <WebComposePill
        placeholder={placeholder}
        value={value}
        onChangeText={onChangeText}
        onSubmit={onSubmit}
        sendAccessibilityLabel={sendAccessibilityLabel}
        canSend={canSend}
        onHeightChange={onHeightChange}
        colors={colors}
      />
    );
  }

  return (
    <NativeComposePill
      placeholder={placeholder}
      value={value}
      onChangeText={onChangeText}
      onSubmit={onSubmit}
      sendAccessibilityLabel={sendAccessibilityLabel}
      canSend={canSend}
      onHeightChange={onHeightChange}
      colors={colors}
    />
  );
}

type SharedProps = Props & {
  colors: ReturnType<typeof useColors>;
};

function WebComposePill({
  placeholder,
  value,
  onChangeText,
  onSubmit,
  sendAccessibilityLabel,
  canSend,
  onHeightChange,
  colors,
}: SharedProps) {
  const [isFocused, setIsFocused] = useState(false);
  const [scrollY, setScrollY] = useState(0);
  const [domScrollRange, setDomScrollRange] = useState(0);
  const [contentHeight, setContentHeight] = useState(LINE_HEIGHT);
  const [domMirrorHeight, setDomMirrorHeight] = useState<number | null>(null);
  const [resizeNonce, setResizeNonce] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const domMirrorRef = useRef<HTMLDivElement | null>(null);
  const wasNearBottomBeforeInputRef = useRef(true);

  const submit = useCallback(() => {
    const text = value.trim();
    if (!text || !canSend) return;
    onSubmit(text);
  }, [canSend, onSubmit, value]);

  const measureAndResize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    setContentHeight(el.scrollHeight);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onResize = () => {
      setResizeNonce((n) => n + 1);
      requestAnimationFrame(() => measureAndResize());
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [measureAndResize]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const el = textareaRef.current;
    if (!el || typeof (window as any).ResizeObserver === "undefined") return;
    const ro = new (window as any).ResizeObserver(() => {
      setResizeNonce((n) => n + 1);
      requestAnimationFrame(() => measureAndResize());
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [measureAndResize]);

  const handleInput = useCallback(
    (e: FormEvent<HTMLTextAreaElement>) => {
      const target = e.target as HTMLTextAreaElement;
      const range = Math.max(0, target.scrollHeight - target.clientHeight);
      const caretAtEnd =
        target.selectionStart === target.value.length && target.selectionEnd === target.value.length;
      wasNearBottomBeforeInputRef.current =
        range <= 0 ||
        target.scrollTop >= range - AUTO_SCROLL_THRESHOLD ||
        caretAtEnd;
      onChangeText(target.value);
      requestAnimationFrame(measureAndResize);
    },
    [measureAndResize, onChangeText],
  );

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    const onScroll = () => {
      const range = Math.max(0, el.scrollHeight - el.clientHeight);
      wasNearBottomBeforeInputRef.current =
        range <= 0 || el.scrollTop >= range - AUTO_SCROLL_THRESHOLD;
      setScrollY(el.scrollTop);
      setDomScrollRange(range);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [value]);

  useEffect(() => {
    const id = requestAnimationFrame(() => measureAndResize());
    return () => cancelAnimationFrame(id);
  }, [measureAndResize, resizeNonce]);

  useEffect(() => {
    if (typeof document === "undefined") return;

    let mirror = domMirrorRef.current;
    if (!mirror) {
      mirror = document.createElement("div");
      domMirrorRef.current = mirror;
      mirror.style.position = "absolute";
      mirror.style.visibility = "hidden";
      mirror.style.pointerEvents = "none";
      mirror.style.whiteSpace = "pre-wrap";
      mirror.style.wordBreak = "break-word";
      mirror.style.left = "-9999px";
      mirror.style.top = "-9999px";
      document.body.appendChild(mirror);
    }

    const host = textareaRef.current;
    if (host) {
      const rect = host.getBoundingClientRect();
      const cs = window.getComputedStyle(host);
      mirror.style.width = `${rect.width}px`;
      mirror.style.boxSizing = cs.boxSizing;
      mirror.style.paddingTop = cs.paddingTop;
      mirror.style.paddingBottom = cs.paddingBottom;
      mirror.style.paddingLeft = cs.paddingLeft;
      mirror.style.paddingRight = cs.paddingRight;
      mirror.style.border = cs.border;
      mirror.style.outline = cs.outline;
      mirror.style.fontFamily = cs.fontFamily;
      mirror.style.fontSize = cs.fontSize;
      mirror.style.fontWeight = cs.fontWeight as string;
      mirror.style.lineHeight = cs.lineHeight;
      mirror.style.letterSpacing = cs.letterSpacing;
      mirror.style.textTransform = cs.textTransform;
      mirror.style.direction = cs.direction;
      mirror.style.textAlign = cs.textAlign;
    }

    mirror.textContent = value || " ";
    const h = mirror.getBoundingClientRect().height;
    setDomMirrorHeight(Number.isFinite(h) && h > 0 ? h : null);
  }, [value, resizeNonce]);

  const baseHeight = domMirrorHeight ?? contentHeight;
  const metrics = getBottomBarMetrics({
    baseHeight,
    scrollY,
    scrollRangeOverride: domScrollRange,
    lineHeight: LINE_HEIGHT,
    innerPadding: INNER_PADDING,
    maxLinesBeforeScroll: MAX_LINES_BEFORE_SCROLL,
    maxBarHeight: MAX_PILL_HEIGHT,
    minBarHeight: MIN_PILL_HEIGHT,
  });

  useEffect(() => {
    onHeightChange?.(metrics.barHeight);
  }, [metrics.barHeight, onHeightChange]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const el = textareaRef.current;
    if (!el) return;
    if (
      metrics.rawLines === 7 &&
      metrics.barHeight >= MAX_PILL_HEIGHT &&
      el.scrollTop === 0 &&
      wasNearBottomBeforeInputRef.current
    ) {
      el.scrollTop = INNER_PADDING;
    }
  }, [metrics.rawLines, metrics.barHeight]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const el = textareaRef.current;
    if (!el || !metrics.showScrollbar || !wasNearBottomBeforeInputRef.current) return;
    const range = el.scrollHeight - el.clientHeight;
    if (range <= 0) return;
    const id = requestAnimationFrame(() => {
      el.scrollTop = range;
      setScrollY(range);
      setDomScrollRange(range);
    });
    return () => cancelAnimationFrame(id);
  }, [value, metrics.showScrollbar]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
      e.preventDefault();
      submit();
    },
    [submit],
  );

  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "flex-end",
        gap: TEXT_TO_SEND_ICON_GAP_PX,
        height: metrics.barHeight,
        borderRadius: MESSAGE_CHAT_COMPOSE_PILL_RADIUS_PX,
        borderWidth: 1,
        borderColor: colors.highlight,
        backgroundColor: colors.background,
        paddingLeft: MESSAGE_CHAT_COMPOSE_PILL_PADDING_LEFT_PX,
        paddingRight: MESSAGE_CHAT_COMPOSE_PILL_PADDING_RIGHT_PX,
      }}
    >
      <View style={styles.inputWrap}>
        <textarea
          ref={textareaRef}
          value={value}
          onInput={handleInput}
          onKeyDown={handleKeyDown}
          onFocus={() => setIsFocused(true)}
          onBlur={() => setIsFocused(false)}
          rows={1}
          placeholder={isFocused ? "" : placeholder}
          style={{
            width: "100%",
            minHeight: metrics.barHeight,
            height: metrics.barHeight,
            maxHeight: metrics.barHeight,
            fontSize: FONT_SIZE,
            lineHeight: `${LINE_HEIGHT}px`,
            paddingTop: INNER_PADDING,
            paddingBottom: INNER_PADDING,
            paddingLeft: 0,
            paddingRight: 0,
            boxSizing: "border-box",
            resize: "none",
            border: "none",
            outline: "none",
            margin: 0,
            color: colors.primary,
            backgroundColor: "transparent",
            caretColor: colors.primary,
            fontFamily: WEB_UI_SANS_STACK,
            fontWeight: 400,
            transform: `translateY(${uiTextVerticalCompensationY}px)`,
            overflow:
              metrics.contentHeightWithGaps > metrics.viewportHeight ? "auto" : "hidden",
          }}
        />
      </View>
      <BottomBarSendCircleButton
        iconColor={colors.primary}
        undercoverColor={colors.undercover}
        onPress={submit}
        wrapStyle={styles.sendWrapWeb}
        iconRotationDeg={-45}
        accessibilityLabel={sendAccessibilityLabel}
      />
    </View>
  );
}

function NativeComposePill({
  placeholder,
  value,
  onChangeText,
  onSubmit,
  sendAccessibilityLabel,
  canSend,
  onHeightChange,
  colors,
}: SharedProps) {
  const [isFocused, setIsFocused] = useState(false);
  const [contentHeight, setContentHeight] = useState<number>(LINE_HEIGHT);
  const [mirrorHeight, setMirrorHeight] = useState<number | null>(null);
  const [inputAreaWidth, setInputAreaWidth] = useState<number | null>(null);
  const [scrollY, setScrollY] = useState(0);
  const scrollRef = useRef<ScrollView>(null);
  const scrollYRef = useRef(0);
  const contentHeightWithGapsRef = useRef(LINE_HEIGHT + INNER_PADDING * 2);
  const wasNearBottomBeforeResizeRef = useRef(true);

  const submit = useCallback(() => {
    const text = value.trim();
    if (!text || !canSend) return;
    onSubmit(text);
  }, [canSend, onSubmit, value]);

  const onContentSizeChange = useCallback(
    (e: NativeSyntheticEvent<TextInputContentSizeChangeEventData>) => {
      const h = e.nativeEvent.contentSize.height;
      if (Number.isFinite(h)) setContentHeight(h);
    },
    [],
  );

  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const y = e.nativeEvent.contentOffset.y;
    scrollYRef.current = y;
    setScrollY(y);
  }, []);

  const baseHeight = mirrorHeight != null ? mirrorHeight : contentHeight + INNER_PADDING * 2;
  const metrics = getBottomBarMetrics({
    baseHeight,
    scrollY,
    lineHeight: LINE_HEIGHT,
    innerPadding: INNER_PADDING,
    maxLinesBeforeScroll: MAX_LINES_BEFORE_SCROLL,
    maxBarHeight: MAX_PILL_HEIGHT,
    minBarHeight: MIN_PILL_HEIGHT,
  });

  useEffect(() => {
    onHeightChange?.(metrics.barHeight);
  }, [metrics.barHeight, onHeightChange]);

  useEffect(() => {
    if (
      metrics.rawLines === 7 &&
      metrics.barHeight >= MAX_PILL_HEIGHT &&
      scrollY === 0 &&
      wasNearBottomBeforeResizeRef.current
    ) {
      scrollRef.current?.scrollTo({ y: INNER_PADDING, animated: false });
    }
  }, [metrics.rawLines, metrics.barHeight, scrollY]);

  const onScrollViewContentSizeChange = useCallback(
    (_w: number, h: number) => {
      const previousRange = Math.max(contentHeightWithGapsRef.current - metrics.viewportHeight, 0);
      const nearBottom =
        previousRange <= 0 || scrollYRef.current >= previousRange - AUTO_SCROLL_THRESHOLD;
      wasNearBottomBeforeResizeRef.current = nearBottom;
      contentHeightWithGapsRef.current = h;

      if (h > metrics.viewportHeight && nearBottom) {
        scrollRef.current?.scrollToEnd({ animated: false });
      }
    },
    [metrics.viewportHeight],
  );

  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "flex-end",
        gap: TEXT_TO_SEND_ICON_GAP_PX,
        height: metrics.barHeight,
        borderRadius: MESSAGE_CHAT_COMPOSE_PILL_RADIUS_PX,
        borderWidth: 1,
        borderColor: colors.highlight,
        backgroundColor: colors.background,
        paddingLeft: MESSAGE_CHAT_COMPOSE_PILL_PADDING_LEFT_PX,
        paddingRight: MESSAGE_CHAT_COMPOSE_PILL_PADDING_RIGHT_PX,
      }}
    >
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={{ height: metrics.viewportHeight, justifyContent: "flex-start" }}>
          <ScrollView
            ref={scrollRef}
            style={{ flex: 1 }}
            contentContainerStyle={{ flexGrow: 1, justifyContent: "flex-start" }}
            onScroll={onScroll}
            onContentSizeChange={onScrollViewContentSizeChange}
            scrollEventThrottle={16}
            showsVerticalScrollIndicator={false}
          >
            <View
              style={styles.nativeInputHost}
              onLayout={(e) => {
                const w = e.nativeEvent.layout.width;
                if (Number.isFinite(w) && w > 0) setInputAreaWidth(w);
              }}
            >
              <TextInput
                value={value}
                onChangeText={onChangeText}
                onSubmitEditing={submit}
                returnKeyType="send"
                blurOnSubmit={false}
                onFocus={() => setIsFocused(true)}
                onBlur={() => setIsFocused(false)}
                placeholder={isFocused ? "" : placeholder}
                placeholderTextColor={colors.secondary}
                multiline
                maxLength={4096}
                onContentSizeChange={onContentSizeChange}
                scrollEnabled={false}
                style={[
                  typographyRect15,
                  styles.nativeInput,
                  { color: colors.primary },
                ]}
              />
              <Text
                style={[
                  typographyRect15,
                  styles.nativeInput,
                  {
                    position: "absolute",
                    opacity: 0,
                    pointerEvents: "none",
                    left: 0,
                    right: 0,
                    paddingVertical: INNER_PADDING,
                    ...(inputAreaWidth != null ? { width: inputAreaWidth } : {}),
                  },
                ]}
                numberOfLines={0}
                onLayout={(e) => {
                  const h = e.nativeEvent.layout.height;
                  if (Number.isFinite(h) && h > 0) setMirrorHeight(h);
                }}
              >
                {value || " "}
              </Text>
            </View>
          </ScrollView>
        </View>
      </View>
      <BottomBarSendCircleButton
        iconColor={colors.primary}
        undercoverColor={colors.undercover}
        onPress={submit}
        wrapStyle={styles.sendWrapNative}
        iconRotationDeg={-45}
        accessibilityLabel={sendAccessibilityLabel}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  inputWrap: {
    flex: 1,
    minWidth: 0,
    position: "relative",
    justifyContent: "flex-start",
  },
  sendWrapWeb: {
    paddingBottom: APPLY_ICON_BOTTOM,
  },
  sendWrapNative: {
    paddingBottom: APPLY_ICON_BOTTOM,
  },
  nativeInputHost: {
    flexGrow: 1,
    justifyContent: "flex-start",
    position: "relative",
  },
  nativeInput: {
    fontSize: FONT_SIZE,
    lineHeight: LINE_HEIGHT,
    paddingVertical: INNER_PADDING,
    paddingHorizontal: 0,
    minHeight: 0,
  },
});
