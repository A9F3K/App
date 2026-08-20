/** Local preference for optimistic UI (Home vs welcome) while session GET confirms. */
export const AUTH_HINT_STORAGE_KEY = "hs_auth_hint_v1";

/** Set only by app logout; cleared on sign-in. Survives Mini App reopen. */
export const AUTH_EXPLICIT_SIGN_OUT_KEY = "hs_auth_explicit_sign_out_v1";

export type AuthHint = "in" | "out";

export function writeAuthHint(value: AuthHint): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(AUTH_HINT_STORAGE_KEY, value);
  } catch {
    // ignore storage failures (private mode, strict browser settings)
  }
}

export function readAuthHint(): AuthHint | null {
  if (typeof window === "undefined") return null;
  try {
    const value = window.localStorage.getItem(AUTH_HINT_STORAGE_KEY);
    if (value === "in" || value === "out") return value;
  } catch {
    // ignore
  }
  return null;
}

export function markExplicitSignOut(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(AUTH_EXPLICIT_SIGN_OUT_KEY, "1");
  } catch {
    // ignore
  }
}

export function clearExplicitSignOut(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(AUTH_EXPLICIT_SIGN_OUT_KEY);
  } catch {
    // ignore
  }
}

export function hasExplicitSignOut(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(AUTH_EXPLICIT_SIGN_OUT_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * After explicit logout, Mini App initData registration must not mint a new
 * `hs_auth_session`. First visit and cookie expiry still auto-issue.
 */
export function shouldIssueAuthSessionFromHint(): boolean {
  return !hasExplicitSignOut();
}
