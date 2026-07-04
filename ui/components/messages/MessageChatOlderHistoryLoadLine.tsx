import { useEffect, useRef, useState } from "react";
import { Animated, Easing, View } from "react-native";
import { scrollIndicatorHairlineBorderWidthPx } from "../../scrollIndicatorPx";
import { layout } from "../../theme";

type Props = {
  active: boolean;
  color: string;
  /** `top` = below chat header; `bottom` = above input / FAB seam. */
  edge?: "top" | "bottom";
};

/** 1px accent line while history pages load (native). */
export function MessageChatOlderHistoryLoadLine({ active, color, edge = "top" }: Props) {
  const lineH = scrollIndicatorHairlineBorderWidthPx();
  const widthAnim = useRef(new Animated.Value(0)).current;
  const opacityAnim = useRef(new Animated.Value(0)).current;
  const loopRef = useRef<Animated.CompositeAnimation | null>(null);
  const wasActiveRef = useRef(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    if (active) {
      wasActiveRef.current = true;
      setMounted(true);
      widthAnim.setValue(0);
      opacityAnim.setValue(1);
      loopRef.current?.stop();
      loopRef.current = Animated.loop(
        Animated.timing(widthAnim, {
          toValue: 1,
          duration: 1300,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: false,
        }),
        { resetBeforeIteration: true },
      );
      loopRef.current.start();
      return () => {
        loopRef.current?.stop();
      };
    }

    if (!wasActiveRef.current) return;
    wasActiveRef.current = false;
    loopRef.current?.stop();
    Animated.parallel([
      Animated.timing(widthAnim, {
        toValue: 1,
        duration: 100,
        useNativeDriver: false,
      }),
      Animated.timing(opacityAnim, {
        toValue: 0,
        duration: 180,
        delay: 60,
        useNativeDriver: false,
      }),
    ]).start(({ finished }) => {
      if (finished) {
        widthAnim.setValue(0);
        setMounted(false);
      }
    });
  }, [active, opacityAnim, widthAnim]);

  if (!mounted) return null;

  const seamStyle =
    edge === "bottom"
      ? { bottom: -lineH as const }
      : { top: -lineH as const };

  return (
    <View
      pointerEvents="none"
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        height: lineH,
        zIndex: layout.authenticatedHome.scrollIndicatorOverlayZIndex + 1,
        overflow: "hidden",
        ...seamStyle,
      }}
    >
      <Animated.View
        style={{
          height: lineH,
          backgroundColor: color,
          opacity: opacityAnim,
          width: widthAnim.interpolate({
            inputRange: [0, 1],
            outputRange: ["0%", "100%"],
          }),
        }}
      />
    </View>
  );
}
