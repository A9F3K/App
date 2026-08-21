import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Keyboard,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type TextInputContentSizeChangeEventData,
  type TextInputSubmitEditingEventData,
} from "react-native";
import { useRouter, usePathname } from "expo-router";
import { WEB_UI_SANS_STACK } from "../fonts";
import { layout, uiTextVerticalCompensationY, useColors } from "../theme";
import { scrollIndicatorHairlineBorderWidthPx, snapScrollIndicatorCoordPx } from "../scrollIndicatorPx";
import { ScrollIndicatorDragHandle } from "./ScrollIndicatorDragHandle";
import { BottomBarSendCircleButton } from "./BottomBarSendCircleButton";
import { useTelegram } from "./Telegram";
import { BottomBarHeightReporter, useBottomBarLayout } from "./BottomBarLayoutContext";
import { getBottomBarMetrics } from "./bottomBarMetrics";
import { getPrimaryTextColorFromLaunch } from "./telegramWebApp";
import { useAppStrings } from "../../locales/AppStringsContext";

const {
  lineHeight: LINE_HEIGHT,
  horizontalPadding: HORIZONTAL_PADDING,
  scrollbarRightInsetPx: SCROLLBAR_RIGHT_INSET,
  maxLinesBeforeScroll: MAX_LINES_BEFORE_SCROLL,
  maxBarHeight: MAX_BAR_HEIGHT,
  barMinHeight: BAR_MIN_HEIGHT,
  applyIconBottom: APPLY_ICON_BOTTOM,
  textToSendIconGapPx: TEXT_TO_SEND_ICON_GAP_PX,
} = layout.bottomBar;

const FONT_SIZE = 15;
const INNER_PADDING = 20;
const AUTO_SCROLL_THRESHOLD = 30;

function Scrollbar({
  show,
  height,
  indicatorHeight,
  topPosition,
  color,
  scrollRange,
  onScrollTo,
}: {
  show: boolean;
  height: number;
  indicatorHeight: number;
  topPosition: number;
  color: string;
  scrollRange: number;
  onScrollTo: (offset: number) => void;
}) {
  if (!show || indicatorHeight <= 0) return null;
  const hairline = scrollIndicatorHairlineBorderWidthPx();
  const h = Math.max(hairline, indicatorHeight);
  const effectiveRange = Math.max(0, scrollRange);
  return (
    <View
      style={[
        styles.scrollbarContainer,
        { height, right: snapScrollIndicatorCoordPx(SCROLLBAR_RIGHT_INSET) },
      ]}
    >
      <ScrollIndicatorDragHandle
        axis="vertical"
        trackSpan={height}
        thumbSpan={h}
        thumbOffset={topPosition}
        scrollRange={effectiveRange}
        onScrollTo={onScrollTo}
        crossAxisVisualSpan={hairline}
      >
        <View
          {...(Platform.OS === "web"
            ? ({ className: "hsp-scroll-indicator-thumb" } as Record<string, string>)
            : {})}
          style={{
            position: "absolute",
            right: 0,
            top: 0,
            width: 0,
            height: h,
            borderLeftWidth: hairline,
            borderLeftColor: color,
            borderStyle: "solid",
          }}
        />
      </ScrollIndicatorDragHandle>
    </View>
  );
}

// Shared entry point: chooses platform-specific implementation and shared colors.
export type GlobalBottomBarOptions = {
  placeholderText?: string;
  iconRotationDeg?: number;
  sendAccessibilityLabel?: string;
  /** When true, draft is local to this bar (chat compose) instead of shared AI draft. */
  useLocalDraft?: boolean;
  /** When set, replaces default AI navigation on send. */
  onSubmit?: (text: string) => void;
  /** Controlled draft for local compose bars (e.g. chat reply/edit). */
  draft?: string;
  onDraftChange?: (next: string) => void;
  /** Clipboard image paste (Ctrl/Cmd+V). Return true when an image was consumed. */
  onPasteImage?: (event: { clipboardData?: DataTransfer | null }) => boolean | Promise<boolean>;
  /** When true, Enter/send works with empty text (e.g. photo attached). */
  allowEmptySubmit?: boolean;
};

export function GlobalBottomBar(options?: GlobalBottomBarOptions) {
  const colors = useColors();
  const { t } = useAppStrings();
  const [localDraft, setLocalDraft] = useState("");
  const premadePrompts = React.useMemo(
    () =>
      [
        t("global.bottomBar.premade1"),
        t("global.bottomBar.premade2"),
        t("global.bottomBar.premade3"),
      ] as const,
    [t],
  );
  const placeholderWeb = options?.placeholderText ?? t("global.bottomBar.placeholderWeb");
  const placeholderNative = options?.placeholderText ?? t("global.bottomBar.placeholderNative");
  const { themeBgReady, isInTelegram, layoutStartup } = useTelegram();
  const { footerDockedToScreenEdge, draftText, setDraftText } = useBottomBarLayout();
  const useLocalDraft = options?.useLocalDraft ?? false;
  const controlledDraft = options?.onDraftChange != null;
  const value = controlledDraft
    ? (options?.draft ?? "")
    : useLocalDraft
      ? localDraft
      : draftText;
  const setValue = controlledDraft
    ? options!.onDraftChange!
    : useLocalDraft
      ? setLocalDraft
      : setDraftText;
  const iconRotationDeg = options?.iconRotationDeg ?? 0;
  const sendAccessibilityLabel = options?.sendAccessibilityLabel;
  const onSubmitOverride = options?.onSubmit;
  const onPasteImage = options?.onPasteImage;
  const allowEmptySubmit = options?.allowEmptySubmit ?? false;
  const { width: windowWidth } = useWindowDimensions();
  const backgroundColor = themeBgReady ? colors.background : "transparent";
  const launchPrimary =
    Platform.OS === "web" && typeof window !== "undefined" ? getPrimaryTextColorFromLaunch() : null;
  const inputColor = themeBgReady ? colors.primary : launchPrimary ?? colors.primary;
  const topBorderColor = colors.highlight;
  const scrollbarThumbColor = colors.primary;
  /** TMA phone: omit bottom hairline. Wide authenticated home: bar sits in a split column past `firstBreakpoint`, not the screen footer — no bottom rule. */
  const hideBottomBorder =
    (isInTelegram && !layoutStartup.isTelegramMiniAppDesktop) || !footerDockedToScreenEdge;
  /** Below {@link layout.authenticatedHome.firstBreakpoint}, screen footer is full width with side insets only. */
  const contentMaxWidth =
    footerDockedToScreenEdge && windowWidth > layout.authenticatedHome.firstBreakpoint
      ? layout.maxContentWidth
      : undefined;

  if (Platform.OS === "web") {
    return (
      <WebBottomBar
        backgroundColor={backgroundColor}
        inputColor={inputColor}
        undercoverColor={colors.undercover}
        scrollbarColor={scrollbarThumbColor}
        topBorderColor={topBorderColor}
        hideBottomBorder={hideBottomBorder}
        contentMaxWidth={contentMaxWidth}
        value={value}
        setValue={setValue}
        premadePrompts={premadePrompts}
        placeholderText={placeholderWeb}
        iconRotationDeg={iconRotationDeg}
        sendAccessibilityLabel={sendAccessibilityLabel}
        onSubmitOverride={onSubmitOverride}
        onPasteImage={onPasteImage}
        allowEmptySubmit={allowEmptySubmit}
      />
    );
  }

  return (
    <NativeBottomBar
      backgroundColor={backgroundColor}
      inputColor={inputColor}
      undercoverColor={colors.undercover}
      scrollbarColor={scrollbarThumbColor}
      topBorderColor={topBorderColor}
      hideBottomBorder={hideBottomBorder}
      contentMaxWidth={contentMaxWidth}
      value={value}
      setValue={setValue}
      premadePrompts={premadePrompts}
      placeholderText={placeholderNative}
      iconRotationDeg={iconRotationDeg}
      sendAccessibilityLabel={sendAccessibilityLabel}
      onSubmitOverride={onSubmitOverride}
    />
  );
}

const styles = StyleSheet.create({
  wrapper: {
    width: "100%",
    position: "relative",
  },
  bottomDivider: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    height: 1,
    pointerEvents: "none",
  },
  /**
   * Column insets: textarea starts `horizontalPadding` from the left edge; send icon ends `horizontalPadding` from the right.
   * Field↔send gap: `layout.bottomBar.textToSendIconGapPx`.
   */
  container: {
    width: "100%",
    alignSelf: "stretch",
    paddingHorizontal: HORIZONTAL_PADDING,
  },
  row: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: TEXT_TO_SEND_ICON_GAP_PX,
  },
  /** Keep send control pinned to the bar bottom; do not center in the row or it rides up when the field grows. */
  webFooterRow: {
    alignItems: "flex-end",
  },
  inputWrap: {
    flex: 1,
    position: "relative",
    justifyContent: "flex-start",
  },
  input: {
    flex: 1,
    fontSize: FONT_SIZE,
    fontWeight: "400",
    lineHeight: LINE_HEIGHT,
    paddingVertical: INNER_PADDING,
    paddingHorizontal: 0,
    borderWidth: 0,
    borderColor: "transparent",
    backgroundColor: "transparent",
    minHeight: 0,
    paddingRight: 0,
  },
  nativeInputHost: {
    flexGrow: 1,
    justifyContent: "flex-start",
    position: "relative",
  },
  sendWrap: {
    justifyContent: "center",
    alignItems: "center",
    paddingBottom: APPLY_ICON_BOTTOM,
  },
  /** Match native `sendWrap` bottom inset so the send chip stays a fixed distance above the bar edge when the field grows. */
  sendWrapWeb: {
    paddingBottom: APPLY_ICON_BOTTOM,
  },
  scrollbarContainer: {
    position: "absolute",
    top: 0,
    width: 0,
    overflow: "visible",
    alignItems: "flex-start",
    justifyContent: "flex-start",
    pointerEvents: "box-none",
  },
});

// Platform-specific section: web-only input implementation.
function WebBottomBar({
  backgroundColor,
  inputColor,
  undercoverColor,
  scrollbarColor,
  topBorderColor,
  hideBottomBorder,
  contentMaxWidth,
  value,
  setValue,
  premadePrompts,
  placeholderText,
  iconRotationDeg = 0,
  sendAccessibilityLabel,
  onSubmitOverride,
  onPasteImage,
  allowEmptySubmit = false,
}: {
  backgroundColor: string;
  inputColor: string;
  undercoverColor: string;
  scrollbarColor: string;
  topBorderColor: string;
  hideBottomBorder: boolean;
  contentMaxWidth?: number;
  value: string;
  setValue: (next: string) => void;
  premadePrompts: readonly [string, string, string];
  placeholderText: string;
  iconRotationDeg?: number;
  sendAccessibilityLabel?: string;
  onSubmitOverride?: (text: string) => void;
  onPasteImage?: (event: { clipboardData?: DataTransfer | null }) => boolean | Promise<boolean>;
  allowEmptySubmit?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [isFocused, setIsFocused] = useState(false);
  const [scrollY, setScrollY] = useState(0);
  const [domScrollRange, setDomScrollRange] = useState(0);
  const [contentHeight, setContentHeight] = useState(LINE_HEIGHT);
  const [domMirrorHeight, setDomMirrorHeight] = useState<number | null>(null);
  const [resizeNonce, setResizeNonce] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const domMirrorRef = useRef<HTMLDivElement | null>(null);
  const wasNearBottomBeforeInputRef = useRef(true);

  const measureAndResize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    setContentHeight(el.scrollHeight);
  }, []);

  // Width changes (screen resize, split-pane drag) change wrapping → scrollHeight. Re-measure immediately.
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
    (e: React.FormEvent<HTMLTextAreaElement>) => {
      const target = e.target as HTMLTextAreaElement;
      const range = Math.max(0, target.scrollHeight - target.clientHeight);
      /** Paste/typing at end leaves `scrollTop === 0` until layout catches up — still "near bottom". */
      const caretAtEnd =
        target.selectionStart === target.value.length && target.selectionEnd === target.value.length;
      wasNearBottomBeforeInputRef.current =
        range <= 0 ||
        target.scrollTop >= range - AUTO_SCROLL_THRESHOLD ||
        caretAtEnd;
      setValue(target.value);
      requestAnimationFrame(measureAndResize);
    },
    [measureAndResize],
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
    maxBarHeight: MAX_BAR_HEIGHT,
    minBarHeight: BAR_MIN_HEIGHT,
  });

  useEffect(() => {
    if (typeof document === "undefined") return;
    const el = textareaRef.current;
    if (!el) return;
    if (
      metrics.rawLines === 7 &&
      metrics.barHeight >= MAX_BAR_HEIGHT &&
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

  const handleSend = useCallback(() => {
    let text = value.trim();
    if (!text && !onSubmitOverride && premadePrompts.length > 0) {
      text = premadePrompts[Math.floor(Math.random() * premadePrompts.length)] ?? "";
      setValue(text);
    }
    if (!text && !(allowEmptySubmit && onSubmitOverride)) return;
    setValue("");
    if (onSubmitOverride) {
      onSubmitOverride(text);
      return;
    }
    router.push({
      pathname: "/ai" as any,
      params: { prompt: text, route: pathname ?? "/" },
    });
  }, [router, pathname, value, setValue, premadePrompts, onSubmitOverride, allowEmptySubmit]);

  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      if (!onPasteImage) return;
      void Promise.resolve(
        onPasteImage({ clipboardData: e.clipboardData as unknown as DataTransfer }),
      ).then((handled) => {
        if (handled) e.preventDefault();
      });
      const items = e.clipboardData?.items;
      if (!items) return;
      for (let i = 0; i < items.length; i += 1) {
        const item = items[i];
        if (item?.kind === "file" && item.type.startsWith("image/")) {
          e.preventDefault();
          return;
        }
      }
    },
    [onPasteImage],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
      e.preventDefault();
      handleSend();
    },
    [handleSend],
  );

  return (
    <View
      style={[
        styles.wrapper,
        {
          backgroundColor,
          borderTopWidth: 1,
          borderTopColor: topBorderColor,
          borderBottomWidth: hideBottomBorder ? 0 : 1,
          borderBottomColor: topBorderColor,
        },
      ]}
    >
      <BottomBarHeightReporter height={metrics.barHeight} />
      <View
        style={[
          styles.container,
          { backgroundColor },
          contentMaxWidth != null ? { maxWidth: contentMaxWidth, alignSelf: "center" as const } : null,
        ]}
      >
        <View style={[styles.row, styles.webFooterRow, { height: metrics.barHeight }]}>
          <View style={styles.inputWrap}>
            <textarea
              ref={textareaRef}
              data-global-bottom-bar-web
              value={value}
              onInput={handleInput}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              onFocus={() => setIsFocused(true)}
              onBlur={() => setIsFocused(false)}
              rows={1}
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
                color: inputColor,
                backgroundColor: "transparent",
                caretColor: inputColor,
                ["--ai-placeholder-color" as string]: inputColor,
                fontFamily: WEB_UI_SANS_STACK,
                fontWeight: 400,
                transform: `translateY(${uiTextVerticalCompensationY}px)`,
                overflow:
                  metrics.contentHeightWithGaps > metrics.viewportHeight ? "auto" : "hidden",
              }}
              placeholder={isFocused ? "" : placeholderText}
            />
          </View>
          <BottomBarSendCircleButton
            iconColor={inputColor}
            undercoverColor={undercoverColor}
            onPress={handleSend}
            wrapStyle={[styles.sendWrap, styles.sendWrapWeb]}
            iconRotationDeg={iconRotationDeg}
            accessibilityLabel={sendAccessibilityLabel}
          />
        </View>
      </View>
      <Scrollbar
        show={metrics.showScrollbar}
        height={metrics.barHeight}
        indicatorHeight={metrics.scrollbar.indicatorHeight}
        topPosition={metrics.scrollbar.topPosition}
        color={scrollbarColor}
        scrollRange={
          domScrollRange > 0
            ? domScrollRange
            : Math.max(0, metrics.contentHeightWithGaps - metrics.viewportHeight)
        }
        onScrollTo={(y) => {
          const el = textareaRef.current;
          if (!el) return;
          el.scrollTop = y;
          setScrollY(y);
          setDomScrollRange(Math.max(0, el.scrollHeight - el.clientHeight));
        }}
      />
      {!hideBottomBorder ? (
        <View style={[styles.bottomDivider, { backgroundColor: topBorderColor }]} />
      ) : null}
    </View>
  );
}

// Platform-specific section: native (iOS/Android) input implementation.
function NativeBottomBar({
  backgroundColor,
  inputColor,
  undercoverColor,
  scrollbarColor,
  topBorderColor,
  hideBottomBorder,
  contentMaxWidth,
  value,
  setValue,
  premadePrompts,
  placeholderText,
  iconRotationDeg = 0,
  sendAccessibilityLabel,
  onSubmitOverride,
}: {
  backgroundColor: string;
  inputColor: string;
  undercoverColor: string;
  scrollbarColor: string;
  topBorderColor: string;
  hideBottomBorder: boolean;
  contentMaxWidth?: number;
  value: string;
  setValue: (next: string) => void;
  premadePrompts: readonly [string, string, string];
  placeholderText: string;
  iconRotationDeg?: number;
  sendAccessibilityLabel?: string;
  onSubmitOverride?: (text: string) => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const { triggerHaptic } = useTelegram();
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
    if (Platform.OS !== "web") {
      triggerHaptic("heavy");
    }
    let text = value.trim();
    if (!text && !onSubmitOverride && premadePrompts.length > 0) {
      text = premadePrompts[Math.floor(Math.random() * premadePrompts.length)] ?? "";
      setValue(text);
    }
    if (!text) return;
    Keyboard.dismiss();
    setValue("");
    if (onSubmitOverride) {
      onSubmitOverride(text);
      return;
    }
    router.push({
      pathname: "/ai" as any,
      params: { prompt: text, route: pathname ?? "/" },
    });
  }, [router, pathname, triggerHaptic, value, setValue, premadePrompts, onSubmitOverride]);

  const onContentSizeChange = useCallback(
    (e: NativeSyntheticEvent<TextInputContentSizeChangeEventData>) => {
      const h = e.nativeEvent.contentSize.height;
      if (Number.isFinite(h)) setContentHeight(h);
    },
    [],
  );

  const onSubmitEditing = useCallback(
    (_e: NativeSyntheticEvent<TextInputSubmitEditingEventData>) => {
      submit();
    },
    [submit],
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
    maxBarHeight: MAX_BAR_HEIGHT,
    minBarHeight: BAR_MIN_HEIGHT,
  });

  useEffect(() => {
    if (
      metrics.rawLines === 7 &&
      metrics.barHeight >= MAX_BAR_HEIGHT &&
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
      style={[
        styles.wrapper,
        {
          height: metrics.barHeight,
          backgroundColor,
          borderTopWidth: 1,
          borderTopColor: topBorderColor,
          borderBottomWidth: hideBottomBorder ? 0 : 1,
          borderBottomColor: topBorderColor,
        },
      ]}
    >
      <BottomBarHeightReporter height={metrics.barHeight} />
      <View
        style={[
          styles.container,
          { height: metrics.barHeight, backgroundColor },
          contentMaxWidth != null ? { maxWidth: contentMaxWidth, alignSelf: "center" as const } : null,
        ]}
      >
        <View style={styles.row}>
          <View style={{ flex: 1 }}>
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
                    style={[styles.input, { color: inputColor }]}
                    placeholder={isFocused ? "" : placeholderText}
                    placeholderTextColor={inputColor}
                    value={value}
                    onChangeText={setValue}
                    onSubmitEditing={onSubmitEditing}
                    submitBehavior="submit"
                    returnKeyType="send"
                    blurOnSubmit={false}
                    multiline
                    maxLength={4096}
                    onContentSizeChange={onContentSizeChange}
                    scrollEnabled={false}
                    onFocus={() => setIsFocused(true)}
                    onBlur={() => setIsFocused(false)}
                  />
                  <Text
                    style={[
                      styles.input,
                      {
                        position: "absolute",
                        opacity: 0,
                        pointerEvents: "none",
                        left: 0,
                        right: 0,
                        paddingVertical: INNER_PADDING,
                        transform: [{ translateY: 0 }],
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
            iconColor={inputColor}
            undercoverColor={undercoverColor}
            onPress={submit}
            wrapStyle={styles.sendWrap}
            iconRotationDeg={iconRotationDeg}
            accessibilityLabel={sendAccessibilityLabel}
          />
        </View>
      </View>
      <Scrollbar
        show={metrics.showScrollbar}
        height={metrics.barHeight}
        indicatorHeight={metrics.scrollbar.indicatorHeight}
        topPosition={metrics.scrollbar.topPosition}
        color={scrollbarColor}
        scrollRange={Math.max(0, metrics.contentHeightWithGaps - metrics.viewportHeight)}
        onScrollTo={(y) => {
          scrollRef.current?.scrollTo({ y, animated: false });
          scrollYRef.current = y;
          setScrollY(y);
        }}
      />
      {!hideBottomBorder ? (
        <View style={[styles.bottomDivider, { backgroundColor: topBorderColor }]} />
      ) : null}
    </View>
  );
}

