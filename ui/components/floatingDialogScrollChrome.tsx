import { createContext, useContext, type ReactNode } from "react";

export type FloatingDialogScrollChromeValue = {
  /** Sticky header block height (title row + gradient rule) for scroll-thumb extend. */
  headerExtendPx: number;
  /** Sticky footer block height (gradient rule + CTA) for scroll-thumb extend. */
  footerExtendPx: number;
};

const FloatingDialogScrollChromeContext = createContext<FloatingDialogScrollChromeValue | null>(
  null,
);

export function FloatingDialogScrollChromeProvider({
  headerExtendPx,
  footerExtendPx = 0,
  children,
}: {
  headerExtendPx: number;
  footerExtendPx?: number;
  children: ReactNode;
}) {
  return (
    <FloatingDialogScrollChromeContext.Provider value={{ headerExtendPx, footerExtendPx }}>
      {children}
    </FloatingDialogScrollChromeContext.Provider>
  );
}

export function useFloatingDialogScrollChrome(): FloatingDialogScrollChromeValue {
  return useContext(FloatingDialogScrollChromeContext) ?? {
    headerExtendPx: 0,
    footerExtendPx: 0,
  };
}
