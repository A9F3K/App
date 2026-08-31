import { createContext, useContext, type ReactNode } from "react";

/**
 * Live metrics from {@link AuthenticatedHomeSplitBody} for children in the first column (e.g. the
 * Feed/Messages nav strip). Prefer this over raw `useWindowDimensions().width` when reasoning about
 * alignment and wide-vs-compact chrome: the first column width and column count follow the split row.
 */
export type AuthenticatedHomeSplitLayoutMetrics = {
  /** Rounded width from the split row `onLayout`; matches `rowWidth` state when measured. */
  splitRowWidthPx: number;
  /** Width used for breakpoint checks: `rowWidth` after first layout, else window width. */
  effectiveSplitWidthPx: number;
  /** Width of the first column: `leftPanePx` when multi-column, else full effective row width. */
  firstColumnWidthPx: number;
  /** Flex middle column width when wide (0 on compact single-column layout). */
  middleColumnWidthPx: number;
  /** Third column width when triple layout (0 otherwise). */
  thirdColumnWidthPx: number;
  columnCount: 1 | 2 | 3;
};

const AuthenticatedHomeSplitLayoutMetricsContext =
  createContext<AuthenticatedHomeSplitLayoutMetrics | null>(null);

export function AuthenticatedHomeSplitLayoutMetricsProvider({
  value,
  children,
}: {
  value: AuthenticatedHomeSplitLayoutMetrics;
  children: ReactNode;
}) {
  return (
    <AuthenticatedHomeSplitLayoutMetricsContext.Provider value={value}>
      {children}
    </AuthenticatedHomeSplitLayoutMetricsContext.Provider>
  );
}

export function useAuthenticatedHomeSplitLayoutMetrics(): AuthenticatedHomeSplitLayoutMetrics | null {
  return useContext(AuthenticatedHomeSplitLayoutMetricsContext);
}
