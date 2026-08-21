import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentRef,
  type RefObject,
  type NativeSyntheticEvent,
  type TextInputScrollEventData,
} from "react";
import {
  Platform,
  StyleSheet,
  TextInput,
  View,
  type LayoutChangeEvent,
  type TextInputProps,
} from "react-native";

import {
  SCROLL_INDICATOR_SCROLL_EPS,
  hairlineBorderWidthPx,
  scrollIndicatorHairlineBorderWidthPx,
  scrollIndicatorThumbSpanAndOffset,
  snapScrollIndicatorCoordPx,
} from "../../scrollIndicatorPx";
import { undercoverHairlineRingStyle } from "../../undercoverHairlineRing";
import { layout, typographyRect15, useColors } from "../../theme";
import { ScrollIndicatorDragHandle } from "../ScrollIndicatorDragHandle";

export const SMART_UNDERCOVER_MULTILINE_HEIGHT_PX = 110;
const PADDING_VERTICAL_PX = 10;
const PADDING_HORIZONTAL_PX = 15;
const TEXT_FONT_SIZE_PX = 15;
const TEXT_LINE_HEIGHT_PX = 30;
const SCROLLBAR_RIGHT_INSET_PX = 0;
const THUMB_MIN_HEIGHT_PX = 20;
const THUMB_MAX_HEIGHT_PX = 60;

type Props = {
  value: string;
  onChangeText: (next: string) => void;
  nativeID?: string;
  placeholder?: string;
  placeholderTextColor?: string;
} & Pick<TextInputProps, "autoCapitalize" | "autoCorrect">;

function clampThumbHeight(span: number): number {
  return Math.max(THUMB_MIN_HEIGHT_PX, Math.min(THUMB_MAX_HEIGHT_PX, span));
}

function resolveMultilineScrollElement(
  inputRef: RefObject<ComponentRef<typeof TextInput> | null>,
  nativeID?: string,
): HTMLElement | null {
  let start: HTMLElement | null = null;
  if (Platform.OS === "web" && typeof document !== "undefined" && nativeID) {
    const byId = document.getElementById(nativeID);
    if (byId instanceof HTMLElement) start = byId;
  }
  if (!start) {
    const instance = inputRef.current as unknown as {
      getScrollableNode?: () => HTMLElement | null | undefined;
    } | null;
    const node = instance?.getScrollableNode?.();
    if (node instanceof HTMLTextAreaElement) start = node;
    else if (node) {
      const nested = node.querySelector("textarea");
      start = nested instanceof HTMLTextAreaElement ? nested : node;
    }
  }
  if (!start || Platform.OS !== "web" || typeof window === "undefined") return start;

  let cur: HTMLElement | null = start;
  let best = start;
  while (cur) {
    if (cur.scrollHeight > cur.clientHeight + 1) {
      best = cur;
      const oy = window.getComputedStyle(cur).overflowY;
      if (oy === "auto" || oy === "scroll" || oy === "overlay") return cur;
    }
    cur = cur.parentElement;
  }
  return best;
}

/** Multiline undercover field (110px) with in-field vertical scroll thumb when content overflows. */
export function SmartUndercoverMultilineField({
  value,
  onChangeText,
  nativeID,
  placeholder,
  placeholderTextColor,
  autoCapitalize = "sentences",
  autoCorrect = true,
}: Props) {
  const colors = useColors();
  const borderWidth = hairlineBorderWidthPx();
  const inputRef = useRef<ComponentRef<typeof TextInput>>(null);
  const mirrorRef = useRef<HTMLDivElement | null>(null);
  const [scroll, setScroll] = useState({ layoutH: SMART_UNDERCOVER_MULTILINE_HEIGHT_PX, contentH: 0, scrollY: 0 });

  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const lh = e.nativeEvent.layout.height;
    if (lh > 0) {
      setScroll((prev) => ({ ...prev, layoutH: lh }));
    }
  }, []);

  const syncScrollMetricsFromDom = useCallback(() => {
    const el = resolveMultilineScrollElement(inputRef, nativeID);
    if (!el) return;
    const layoutH = el.clientHeight;
    if (layoutH <= 0) return;

    // Prefer live scrollHeight so bottom padding is part of the scroll range (thumb can pin to max).
    let contentH = el.scrollHeight;
    if (
      Platform.OS === "web" &&
      typeof window !== "undefined" &&
      value.length > 0
    ) {
      let mirror = mirrorRef.current;
      if (!mirror && typeof document !== "undefined") {
        mirror = document.createElement("div");
        mirrorRef.current = mirror;
        mirror.style.position = "absolute";
        mirror.style.visibility = "hidden";
        mirror.style.pointerEvents = "none";
        mirror.style.whiteSpace = "pre-wrap";
        mirror.style.wordBreak = "break-word";
        mirror.style.left = "-9999px";
        mirror.style.top = "-9999px";
        document.body.appendChild(mirror);
      }
      if (mirror) {
        const cs = window.getComputedStyle(el);
        mirror.style.width = `${el.clientWidth}px`;
        mirror.style.boxSizing = cs.boxSizing;
        mirror.style.paddingTop = cs.paddingTop;
        mirror.style.paddingBottom = cs.paddingBottom;
        mirror.style.paddingLeft = cs.paddingLeft;
        mirror.style.paddingRight = cs.paddingRight;
        mirror.style.fontFamily = cs.fontFamily;
        mirror.style.fontSize = cs.fontSize;
        mirror.style.fontWeight = cs.fontWeight;
        mirror.style.lineHeight = cs.lineHeight;
        mirror.style.letterSpacing = cs.letterSpacing;
        // Trailing newline collapses in a div unless preserved — keep end padding in the measure.
        mirror.textContent = value.endsWith("\n") ? `${value}\u200b` : value;
        const mirrored = Math.ceil(mirror.getBoundingClientRect().height);
        if (mirrored > contentH) contentH = mirrored;
      }
    }

    const maxScroll = Math.max(0, contentH - layoutH);
    const scrollYRaw = el.scrollTop;
    const scrollY =
      maxScroll > 0 && scrollYRaw >= maxScroll - SCROLL_INDICATOR_SCROLL_EPS
        ? maxScroll
        : scrollYRaw <= SCROLL_INDICATOR_SCROLL_EPS
          ? 0
          : scrollYRaw;

    setScroll((prev) => ({
      ...prev,
      layoutH,
      contentH: contentH > 0 ? contentH : prev.contentH,
      scrollY,
    }));
  }, [nativeID, value]);

  /** When overflow appears while editing at the end, reveal bottom inset and pin the thumb. */
  const scrollToRevealBottomInsetIfNeeded = useCallback(() => {
    const el = resolveMultilineScrollElement(inputRef, nativeID);
    if (!el) return;
    const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight);
    if (maxScroll <= 0.5) return;
    const caretAtEnd =
      typeof el === "object" &&
      "selectionStart" in el &&
      "value" in el &&
      (el as HTMLTextAreaElement).selectionStart === (el as HTMLTextAreaElement).value.length &&
      (el as HTMLTextAreaElement).selectionEnd === (el as HTMLTextAreaElement).value.length;
    const nearBottom = el.scrollTop >= maxScroll - Math.max(30, PADDING_VERTICAL_PX);
    if (!caretAtEnd && !nearBottom) return;
    el.scrollTop = maxScroll;
    setScroll((prev) => ({
      ...prev,
      layoutH: el.clientHeight,
      contentH: Math.max(prev.contentH, el.scrollHeight),
      scrollY: maxScroll,
    }));
  }, [nativeID]);

  const onContentSizeChange = useCallback(
    (_w: number, h: number) => {
      setScroll((prev) => {
        const layoutH = prev.layoutH > 0 ? prev.layoutH : SMART_UNDERCOVER_MULTILINE_HEIGHT_PX;
        const contentH = Platform.OS === "web" ? prev.contentH : h > 0 ? h : prev.contentH;
        return {
          ...prev,
          ...(Platform.OS !== "web" && h > 0 ? { contentH: h } : {}),
          layoutH,
        };
      });
      requestAnimationFrame(syncScrollMetricsFromDom);
    },
    [syncScrollMetricsFromDom],
  );

  const onScroll = useCallback(
    (e: NativeSyntheticEvent<TextInputScrollEventData>) => {
      const yRaw = e.nativeEvent.contentOffset.y;
      const y = yRaw <= SCROLL_INDICATOR_SCROLL_EPS ? 0 : yRaw;
      setScroll((prev) => ({ ...prev, scrollY: y }));
      requestAnimationFrame(syncScrollMetricsFromDom);
    },
    [syncScrollMetricsFromDom],
  );

  const scrollToY = useCallback(
    (y: number) => {
      const clamped = Math.max(0, y);
      const el = resolveMultilineScrollElement(inputRef, nativeID);
      if (el) el.scrollTop = clamped;
      inputRef.current?.scrollTo?.({ y: clamped, animated: false });
      setScroll((prev) => ({ ...prev, scrollY: clamped }));
    },
    [nativeID],
  );

  const handleChangeText = useCallback(
    (next: string) => {
      onChangeText(next);
      requestAnimationFrame(() => {
        syncScrollMetricsFromDom();
        scrollToRevealBottomInsetIfNeeded();
        requestAnimationFrame(() => {
          syncScrollMetricsFromDom();
          scrollToRevealBottomInsetIfNeeded();
        });
      });
    },
    [onChangeText, syncScrollMetricsFromDom, scrollToRevealBottomInsetIfNeeded],
  );

  useLayoutEffect(() => {
    if (Platform.OS !== "web") return;
    const run = () => {
      const el = resolveMultilineScrollElement(inputRef, nativeID);
      if (!el?.style) return;
      el.classList.add("hsp-main-scroll-hide-native-scrollbar", "smart-undercover-multiline-input");
      el.style.setProperty("scrollbar-width", "none");
      el.style.setProperty("-ms-overflow-style", "none");
    };
    const id = requestAnimationFrame(() => {
      run();
      requestAnimationFrame(run);
    });
    return () => cancelAnimationFrame(id);
  }, [nativeID]);

  useEffect(() => {
    return () => {
      mirrorRef.current?.remove();
      mirrorRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (Platform.OS !== "web" || typeof ResizeObserver === "undefined") return;
    let ro: ResizeObserver | null = null;
    let scrollEl: HTMLElement | null = null;
    const onDomScroll = () => syncScrollMetricsFromDom();

    const wire = () => {
      const el = resolveMultilineScrollElement(inputRef, nativeID);
      if (!el) return;
      if (el === scrollEl) {
        syncScrollMetricsFromDom();
        return;
      }
      scrollEl?.removeEventListener("scroll", onDomScroll);
      ro?.disconnect();
      scrollEl = el;
      ro = new ResizeObserver(() => syncScrollMetricsFromDom());
      ro.observe(el);
      el.addEventListener("scroll", onDomScroll, { passive: true });
      syncScrollMetricsFromDom();
    };

    wire();
    const retryId = requestAnimationFrame(wire);
    return () => {
      cancelAnimationFrame(retryId);
      scrollEl?.removeEventListener("scroll", onDomScroll);
      ro?.disconnect();
    };
  }, [nativeID, syncScrollMetricsFromDom]);

  useEffect(() => {
    syncScrollMetricsFromDom();
    const id = requestAnimationFrame(syncScrollMetricsFromDom);
    return () => cancelAnimationFrame(id);
  }, [value, nativeID, placeholder, syncScrollMetricsFromDom]);

  const indicator = useMemo(() => {
    const viewH = scroll.layoutH;
    const contentH = scroll.contentH;
    const y = scroll.scrollY;
    const maxScroll = Math.max(0, contentH - viewH);
    if (viewH <= 0 || maxScroll <= 0.5) {
      return { show: false as const, thumbH: 0, thumbTop: 0, maxScroll: 0 };
    }
    const { thumbSpan, thumbOffset } = scrollIndicatorThumbSpanAndOffset(
      viewH,
      viewH,
      contentH,
      y,
      maxScroll,
    );
    const hairline = scrollIndicatorHairlineBorderWidthPx();
    const thumbH = Math.max(hairline, clampThumbHeight(thumbSpan));
    const maxTravel = Math.max(0, viewH - thumbH);
    let thumbTop = y <= SCROLL_INDICATOR_SCROLL_EPS ? 0 : thumbOffset;
    if (y >= maxScroll - SCROLL_INDICATOR_SCROLL_EPS) {
      thumbTop = maxTravel;
    }
    thumbTop = Math.max(0, Math.min(thumbTop, maxTravel));
    return { show: true as const, thumbH, thumbTop, maxScroll };
  }, [scroll]);

  return (
    <View
      {...(Platform.OS === "web"
        ? ({ className: "smart-undercover-multiline-field" } as Record<string, string>)
        : {})}
      style={[
        styles.shell,
        {
          backgroundColor: colors.undercover,
          ...undercoverHairlineRingStyle(colors.accent, borderWidth),
          ...(Platform.OS === "web"
            ? ({
                "--smart-field-autofill-bg": colors.undercover,
                "--smart-field-autofill-fg": colors.primary,
              } as Record<string, string>)
            : {}),
        },
      ]}
      onLayout={onLayout}
    >
      <TextInput
        ref={inputRef}
        {...(Platform.OS === "web" && nativeID ? { id: nativeID } : {})}
        nativeID={nativeID}
        multiline
        scrollEnabled
        textAlignVertical="top"
        style={[styles.input, { color: colors.primary }]}
        placeholder={placeholder}
        placeholderTextColor={placeholderTextColor ?? colors.secondary}
        autoCapitalize={autoCapitalize}
        autoCorrect={autoCorrect}
        value={value}
        onChangeText={handleChangeText}
        onScroll={onScroll}
        onContentSizeChange={onContentSizeChange}
        scrollEventThrottle={16}
        {...(Platform.OS === "web"
          ? ({ className: "smart-undercover-multiline-input" } as Record<string, string>)
          : {})}
      />
      {indicator.show ? (
        <View
          style={[
            styles.scrollIndicatorWrap,
            { right: snapScrollIndicatorCoordPx(SCROLLBAR_RIGHT_INSET_PX) },
          ]}
          pointerEvents="box-none"
        >
          <ScrollIndicatorDragHandle
            axis="vertical"
            trackSpan={scroll.layoutH}
            thumbSpan={indicator.thumbH}
            thumbOffset={indicator.thumbTop}
            scrollRange={indicator.maxScroll}
            onScrollTo={scrollToY}
            crossAxisVisualSpan={scrollIndicatorHairlineBorderWidthPx()}
          >
            <View
              {...(Platform.OS === "web"
                ? ({ className: "hsp-scroll-indicator-thumb" } as Record<string, string>)
                : {})}
              style={[
                styles.scrollIndicatorThumb,
                {
                  height: indicator.thumbH,
                  width: 0,
                  borderLeftWidth: scrollIndicatorHairlineBorderWidthPx(),
                  borderLeftColor: colors.primary,
                  borderStyle: "solid",
                },
              ]}
            />
          </ScrollIndicatorDragHandle>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  shell: {
    width: "100%",
    alignSelf: "stretch",
    height: SMART_UNDERCOVER_MULTILINE_HEIGHT_PX,
    overflow: "hidden",
    position: "relative",
    zIndex: 0,
    ...Platform.select({
      web: {
        boxSizing: "border-box",
        minHeight: SMART_UNDERCOVER_MULTILINE_HEIGHT_PX,
        maxHeight: SMART_UNDERCOVER_MULTILINE_HEIGHT_PX,
      },
      default: {},
    }),
  },
  input: {
    ...typographyRect15,
    flex: 1,
    alignSelf: "stretch",
    width: "100%",
    height: SMART_UNDERCOVER_MULTILINE_HEIGHT_PX,
    fontSize: TEXT_FONT_SIZE_PX,
    lineHeight: TEXT_LINE_HEIGHT_PX,
    borderWidth: 0,
    backgroundColor: "transparent",
    paddingTop: PADDING_VERTICAL_PX,
    paddingBottom: PADDING_VERTICAL_PX,
    paddingLeft: PADDING_HORIZONTAL_PX,
    paddingRight: PADDING_HORIZONTAL_PX,
    margin: 0,
    ...Platform.select({
      web: {
        outlineWidth: 0,
        boxSizing: "border-box",
        resize: "none",
        overflow: "auto",
      },
      default: {},
    }),
  },
  scrollIndicatorWrap: {
    position: "absolute",
    top: 0,
    bottom: 0,
    width: 0,
    overflow: "visible",
    zIndex: layout.authenticatedHome.scrollIndicatorOverlayZIndex,
    pointerEvents: "box-none",
  },
  scrollIndicatorThumb: {
    position: "absolute",
    right: 0,
    top: 0,
  },
});
