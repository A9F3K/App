import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { layout } from "../theme";

type BottomBarLayoutCtx = {
  barHeight: number;
  setBarHeight: (h: number) => void;
  /** When false, `GlobalBottomBar` is embedded in split columns — not stacked under the main scroll shell. */
  footerDockedToScreenEdge: boolean;
  setFooterDockedToScreenEdge: (v: boolean) => void;
  /** Draft text in the AI/search field; persisted across breakpoint re-docks (footer ↔ split column). */
  draftText: string;
  setDraftText: (t: string) => void;
  /**
   * When the AI & Search column is mounted, it registers a submit handler so Enter/send
   * applies the prompt in-column instead of navigating to `/ai`.
   */
  aiSearchSubmit: ((text: string) => void) | null;
  setAiSearchSubmit: (fn: ((text: string) => void) | null) => void;
  /** Override bottom-bar placeholder while a special AI column tab is active (e.g. Support). */
  aiSearchPlaceholder: string | null;
  setAiSearchPlaceholder: (text: string | null) => void;
};

const BottomBarLayoutContext = createContext<BottomBarLayoutCtx | null>(null);

export function BottomBarLayoutProvider({ children }: { children: ReactNode }) {
  const [barHeight, setBarHeightState] = useState(layout.bottomBar.barMinHeight);
  const setBarHeight = useCallback((h: number) => {
    setBarHeightState((prev) => (prev === h ? prev : h));
  }, []);
  const [footerDockedToScreenEdge, setFooterDockedToScreenEdgeState] = useState(true);
  const setFooterDockedToScreenEdge = useCallback((v: boolean) => {
    setFooterDockedToScreenEdgeState((prev) => (prev === v ? prev : v));
  }, []);
  const [draftText, setDraftTextState] = useState("");
  const setDraftText = useCallback((t: string) => {
    setDraftTextState((prev) => (prev === t ? prev : t));
  }, []);
  const [aiSearchSubmit, setAiSearchSubmitState] = useState<((text: string) => void) | null>(
    null,
  );
  const setAiSearchSubmit = useCallback((fn: ((text: string) => void) | null) => {
    setAiSearchSubmitState(() => fn);
  }, []);
  const [aiSearchPlaceholder, setAiSearchPlaceholderState] = useState<string | null>(null);
  const setAiSearchPlaceholder = useCallback((text: string | null) => {
    setAiSearchPlaceholderState((prev) => (prev === text ? prev : text));
  }, []);
  const value = useMemo(
    () => ({
      barHeight,
      setBarHeight,
      footerDockedToScreenEdge,
      setFooterDockedToScreenEdge,
      draftText,
      setDraftText,
      aiSearchSubmit,
      setAiSearchSubmit,
      aiSearchPlaceholder,
      setAiSearchPlaceholder,
    }),
    [
      barHeight,
      setBarHeight,
      footerDockedToScreenEdge,
      setFooterDockedToScreenEdge,
      draftText,
      setDraftText,
      aiSearchSubmit,
      setAiSearchSubmit,
      aiSearchPlaceholder,
      setAiSearchPlaceholder,
    ],
  );
  return <BottomBarLayoutContext.Provider value={value}>{children}</BottomBarLayoutContext.Provider>;
}

export function useBottomBarLayout(): BottomBarLayoutCtx {
  const ctx = useContext(BottomBarLayoutContext);
  if (!ctx) {
    throw new Error("useBottomBarLayout must be used within BottomBarLayoutProvider");
  }
  return ctx;
}

/** Syncs measured footer height so overlays (e.g. FloatingShield) can track the bar top. */
export function BottomBarHeightReporter({ height }: { height: number }) {
  const { setBarHeight } = useBottomBarLayout();
  useEffect(() => {
    setBarHeight(height);
  }, [height, setBarHeight]);
  return null;
}
