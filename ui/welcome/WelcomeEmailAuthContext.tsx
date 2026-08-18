import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { Alert } from "react-native";
import { useRouter } from "expo-router";
import { useAuth } from "../../auth/AuthContext";
import { buildApiUrl } from "../../api/_base";
import { useAppStrings } from "../../locales/AppStringsContext";
import { logPageDisplay } from "../pageDisplayLog";
import { appError } from "../../shared/appLog";
import { WelcomeEmailCodeSheet } from "../components/WelcomeEmailCodeSheet";
import { useTelegram } from "../components/Telegram";

type WelcomeEmailAuthContextValue = {
  openEmailCodeSheet: (input: { email: string; attemptId: string }) => void;
  closeEmailCodeSheet: () => void;
};

const WelcomeEmailAuthContext = createContext<WelcomeEmailAuthContextValue | null>(null);

function isValidEmailOtp(value: string): boolean {
  return /^\d{6}$/.test(value.trim().replace(/\s+/g, ""));
}

export function WelcomeEmailAuthProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { signIn } = useAuth();
  const { t } = useAppStrings();
  const { hydrateBrowserSessionFromCookie } = useTelegram();
  const [visible, setVisible] = useState(false);
  const [email, setEmail] = useState("");
  const [attemptId, setAttemptId] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [codeInvalid, setCodeInvalid] = useState(false);
  const [codeWrong, setCodeWrong] = useState(false);
  const [codeWrongPulseKey, setCodeWrongPulseKey] = useState(0);
  const [submitting, setSubmitting] = useState(false);

  const closeEmailCodeSheet = useCallback(() => {
    setVisible(false);
    setAttemptId(null);
    setCode("");
    setCodeInvalid(false);
    setCodeWrong(false);
    setCodeWrongPulseKey(0);
    setSubmitting(false);
  }, []);

  const openEmailCodeSheet = useCallback((input: { email: string; attemptId: string }) => {
    setEmail(input.email);
    setAttemptId(input.attemptId);
    setCode("");
    setCodeInvalid(false);
    setCodeWrong(false);
    setCodeWrongPulseKey(0);
    setSubmitting(false);
    setVisible(true);
  }, []);

  const verifyEmailSignIn = useCallback(async () => {
    if (!attemptId) return;
    if (!isValidEmailOtp(code)) {
      setCodeWrong(false);
      setCodeInvalid(true);
      return;
    }
    setCodeInvalid(false);
    setSubmitting(true);
    const startedAt = Date.now();
    const verifyUrl = buildApiUrl("/api/auth/email/verify");
    try {
      logPageDisplay("welcome_email_verify", {
        verifyUrl,
        attemptId,
      });
      const response = await fetch(verifyUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          attemptId,
          code: code.trim().replace(/\s+/g, ""),
        }),
      });
      const json = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        authenticated?: boolean;
        error?: string;
      };
      logPageDisplay("welcome_email_verify_response", {
        status: response.status,
        ok: response.ok,
        bodyOk: json?.ok,
        authenticated: json?.authenticated,
        error: json?.error ?? null,
        elapsedMs: Date.now() - startedAt,
      });
      if (!response.ok || !json?.ok || json.authenticated !== true) {
        const errorCode = json?.error || `HTTP_${response.status}`;
        if (errorCode === "invalid_code") {
          setCodeWrong(true);
          setCodeWrongPulseKey((key) => key + 1);
          return;
        }
        throw new Error(errorCode);
      }
      closeEmailCodeSheet();
      await hydrateBrowserSessionFromCookie();
      logPageDisplay("welcome_email_sign_in", {
        elapsedMs: Date.now() - startedAt,
      });
      signIn();
      router.replace("/");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appError("[welcome]", "email_auth_verify_failed", { message }, error);
      logPageDisplay("welcome_email_verify_error", {
        message,
        verifyUrl,
        elapsedMs: Date.now() - startedAt,
      });
      Alert.alert(t("welcome.auth.emailBrowserAlertTitle"), t("welcome.auth.emailVerifyError"));
    } finally {
      setSubmitting(false);
    }
  }, [
    attemptId,
    closeEmailCodeSheet,
    code,
    hydrateBrowserSessionFromCookie,
    router,
    signIn,
    t,
  ]);

  const value = useMemo(
    () => ({
      openEmailCodeSheet,
      closeEmailCodeSheet,
    }),
    [openEmailCodeSheet, closeEmailCodeSheet],
  );

  return (
    <WelcomeEmailAuthContext.Provider value={value}>
      {children}
      <WelcomeEmailCodeSheet
        visible={visible}
        email={email}
        code={code}
        codeInvalid={codeInvalid}
        codeWrong={codeWrong}
        codeWrongPulseKey={codeWrongPulseKey}
        submitting={submitting}
        onChangeCode={(next) => {
          setCode(next);
          if (codeInvalid) setCodeInvalid(false);
          if (codeWrong) setCodeWrong(false);
        }}
        onClose={closeEmailCodeSheet}
        onSubmit={verifyEmailSignIn}
      />
    </WelcomeEmailAuthContext.Provider>
  );
}

export function useWelcomeEmailAuth(): WelcomeEmailAuthContextValue {
  const ctx = useContext(WelcomeEmailAuthContext);
  if (!ctx) {
    throw new Error("useWelcomeEmailAuth must be used within WelcomeEmailAuthProvider");
  }
  return ctx;
}
