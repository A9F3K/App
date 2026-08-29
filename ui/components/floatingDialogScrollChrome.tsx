import { createContext, useContext, type ReactNode } from "react";

export type FloatingDialogScrollChromeValue = {
  /** Sticky header block height (title row + gradient rule) for scroll-thumb extend. */
  headerExtendPx: number;
};

const FloatingDialogScrollChromeContext = createContext<FloatingDialogScrollChromeValue | null>(
  null,
);

export function FloatingDialogScrollChromeProvider({
  headerExtendPx,
  children,
}: {
  headerExtendPx: number;
  children: ReactNode;
}) {
  return (
    <FloatingDialogScrollChromeContext.Provider value={{ headerExtendPx }}>
      {children}
    </FloatingDialogScrollChromeContext.Provider>
  );
}

export function useFloatingDialogScrollChrome(): FloatingDialogScrollChromeValue {
  return useContext(FloatingDialogScrollChromeContext) ?? { headerExtendPx: 0 };
}
