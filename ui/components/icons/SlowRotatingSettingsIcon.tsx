import { useEffect, useRef } from "react";
import { Animated } from "react-native";
import { SettingsIcon } from "./SettingsIcon";

/** One full turn of the settings cog (linear), matching liquid-glass FloatingShield. */
const SETTINGS_ICON_SPIN_MS = 28000;

/**
 * Settings cog with continuous slow rotation — used for liquid-glass and undercover chips alike.
 */
export function SlowRotatingSettingsIcon({ color, size }: { color: string; size: number }) {
  const spin = useRef(new Animated.Value(0)).current;
  /**
   * Drive rotation from wall-clock time via rAF — no `Animated.loop` / completion callbacks, so it
   * cannot stall after N iterations (RN-web and native driver edge cases).
   */
  useEffect(() => {
    const startMs = Date.now();
    let rafId = 0;
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      const elapsed = Date.now() - startMs;
      const t = (elapsed % SETTINGS_ICON_SPIN_MS) / SETTINGS_ICON_SPIN_MS;
      spin.setValue(t);
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
    };
  }, [spin]);
  const rotate = spin.interpolate({
    inputRange: [0, 1],
    outputRange: ["0deg", "360deg"],
  });
  return (
    <Animated.View
      style={{
        width: size,
        height: size,
        alignItems: "center",
        justifyContent: "center",
        transform: [{ rotate }],
      }}
    >
      <SettingsIcon color={color} size={size} />
    </Animated.View>
  );
}
