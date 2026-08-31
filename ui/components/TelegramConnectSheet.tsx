import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { getApiBaseUrl } from "../../api/_base";
import { useAppStrings } from "../../locales/AppStringsContext";
import { typographyFixedRow40Label, useColors } from "../theme";
import { openTelegramDeepLink } from "../telegram/openTelegramDeepLink";
import { useTelegramMessagesConnection } from "../telegram/TelegramMessagesConnectionContext";
import { formatConnectCodeDeliveryHint } from "../telegram/formatConnectCodeDelivery";
import { logTelegramConnect } from "../telegram/telegramConnectDebug";
import { isActuallyInTelegram } from "./telegramWebApp";
import { AppModalSheet, appModalSheetStyles } from "./AppModalSheet";
import { WelcomeAuthFormField } from "./WelcomeAuthFormField";
import { TelegramConnectQrImage } from "./TelegramConnectQrImage";

function isLocalDevApiBase(): boolean {
  try {
    const base = getApiBaseUrl();
    return /localhost|127\.0\.1|192\.168\.|10\./.test(base);
  } catch {
    return false;
  }
}

function connectErrorMessage(error: string | null, t: (key: string) => string): string {
  if (!error) return t("messages.connectError");
  if (error === "tdlib_gateway_url_missing") {
    return t("messages.connectErrorGatewayUrlMissing");
  }
  if (error === "tdlib_gateway_unreachable") {
    return isLocalDevApiBase()
      ? t("messages.connectErrorGatewayLocal")
      : t("messages.connectErrorGatewayProduction");
  }
  if (error === "tdlib_gateway_not_configured" || error === "telegram_api_credentials_missing") {
    return t("messages.connectErrorNotConfigured");
  }
  if (error === "telegram_network_unreachable") {
    return t("messages.connectErrorTelegramNetwork");
  }
  if (error === "invalid_phone_number") {
    return t("messages.connectErrorInvalidPhone");
  }
  if (error === "code_rejected" || /PHONE_CODE_INVALID|code/i.test(error)) {
    return t("messages.connectErrorCodeRejected");
  }
  if (error === "password_rejected" || /PASSWORD_HASH_INVALID|password/i.test(error)) {
    return t("messages.connectErrorPasswordRejected");
  }
  if (error === "gateway_timeout_retry" || error === "HTTP_504") {
    return t("messages.connectErrorGatewayTimeout");
  }
  if (error === "network_error" || error === "Failed to fetch") {
    return t("messages.connectErrorNetwork");
  }
  if (
    error === "session_expired_restart" ||
    error === "authorization_closed" ||
    error === "Not Found" ||
    error === "attempt_not_found" ||
    error === "gateway_attempt_lost"
  ) {
    return t("messages.connectErrorSessionExpired");
  }
  if (error === "attempt_id_and_password_required") {
    return t("messages.connectErrorPasswordRequest");
  }
  if (error === "not_found" || error === "session_not_ready") {
    return t("messages.connectErrorGatewayPhoneEndpoint");
  }
  return error;
}

function ConnectMethodSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  const colors = useColors();
  return (
    <View style={{ width: "100%", marginBottom: 22 }}>
      <Text style={[appModalSheetStyles.subtitle, { color: colors.primary }]}>{title}</Text>
      {children}
    </View>
  );
}

export function TelegramConnectSheet() {
  const colors = useColors();
  const { t, tf } = useAppStrings();
  const {
    connectSheetVisible,
    closeConnectSheet,
    connectPending,
    connectSuccessSyncing,
    connectAuthState,
    connectQrLink,
    connectError,
    connectCodeDelivery,
    beginMtprotoConnect,
    submitMtprotoPhone,
    submitMtprotoCode,
    resendMtprotoCode,
    submitMtprotoPassword,
  } = useTelegramMessagesConnection();
  const inTelegramApp = isActuallyInTelegram();
  const [password, setPassword] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [loginCode, setLoginCode] = useState("");
  const [phoneInvalid, setPhoneInvalid] = useState(false);
  const sheetBootstrapRef = useRef(false);

  useEffect(() => {
    logTelegramConnect("sheet_visible", { visible: connectSheetVisible, connectAuthState, connectPending });
  }, [connectSheetVisible, connectAuthState, connectPending]);

  useEffect(() => {
    if (!connectSheetVisible) {
      setPassword("");
      setPhoneNumber("");
      setLoginCode("");
      setPhoneInvalid(false);
      sheetBootstrapRef.current = false;
      return;
    }
    if (connectSuccessSyncing || connectAuthState === "ready") {
      sheetBootstrapRef.current = true;
      return;
    }
    if (sheetBootstrapRef.current) return;
    if (connectAuthState === "wait_code" || connectAuthState === "wait_password") {
      sheetBootstrapRef.current = true;
      return;
    }
    sheetBootstrapRef.current = true;

    if (connectAuthState === "idle") {
      void beginMtprotoConnect({ authMethod: "qr" });
      return;
    }
    if (connectAuthState === "failed") {
      void beginMtprotoConnect({ fresh: true, authMethod: "qr" });
    }
  }, [connectSheetVisible, connectAuthState, connectSuccessSyncing, beginMtprotoConnect]);

  const onRetry = useCallback(() => {
    setPassword("");
    setPhoneNumber("");
    setLoginCode("");
    setPhoneInvalid(false);
    void beginMtprotoConnect({ fresh: true, authMethod: "qr" });
  }, [beginMtprotoConnect]);

  const onSubmitPassword = useCallback(() => {
    void submitMtprotoPassword(password);
  }, [password, submitMtprotoPassword]);

  const onSubmitPhone = useCallback(() => {
    const trimmed = phoneNumber.trim();
    if (!trimmed || trimmed.replace(/[^\d+]/g, "").length < 8) {
      setPhoneInvalid(true);
      return;
    }
    setPhoneInvalid(false);
    void submitMtprotoPhone(trimmed);
  }, [phoneNumber, submitMtprotoPhone]);

  const onResendCode = useCallback(() => {
    void resendMtprotoCode();
  }, [resendMtprotoCode]);

  const onSubmitCode = useCallback(() => {
    void submitMtprotoCode(loginCode);
  }, [loginCode, submitMtprotoCode]);

  const onOpenInTelegram = useCallback(() => {
    if (connectQrLink) openTelegramDeepLink(connectQrLink);
  }, [connectQrLink]);

  const onClose = useCallback(() => {
    logTelegramConnect("sheet_close");
    setPassword("");
    setPhoneNumber("");
    setLoginCode("");
    setPhoneInvalid(false);
    closeConnectSheet();
  }, [closeConnectSheet]);

  const showSuccess = connectSuccessSyncing;
  const showCode = !showSuccess && connectAuthState === "wait_code";
  const showPassword = !showSuccess && connectAuthState === "wait_password";
  const showMethods = !showCode && !showPassword && !showSuccess && connectAuthState !== "failed";
  const compactStep = showCode || showPassword || showSuccess;

  const phoneErrorText =
    phoneInvalid || connectError === "invalid_phone_number"
      ? t("messages.connectErrorInvalidPhone")
      : null;

  const codeDeliveryHint =
    formatConnectCodeDeliveryHint(connectCodeDelivery, tf) ??
    (inTelegramApp ? t("messages.connectSheetCodeBody") : t("messages.connectSheetCodeBodyDesktop"));

  const canResendCode =
    connectCodeDelivery?.type !== "authenticationCodeTypeTelegramMessage" ||
    Boolean(connectCodeDelivery?.nextType);

  const sheetTitle = showSuccess
    ? t("messages.connectSheetSuccessTitle")
    : showPassword
      ? t("messages.connectSheetPasswordTitle")
      : showCode
        ? t("messages.connectSheetCodeTitle")
        : t("messages.connectSheetTitle");

  return (
    <AppModalSheet
      visible={connectSheetVisible}
      onClose={onClose}
      title={sheetTitle}
      sizeKind="connect"
      fitContentHeight={compactStep}
      minSize={compactStep ? { width: 300, height: 180 } : { width: 300, height: 480 }}
      sizeStorageKey={
        compactStep ? "hsp.telegramConnectSheet.compact.size.v1" : "hsp.telegramConnectSheet.size.v2"
      }
      offsetStorageKey={
        compactStep ? "hsp.telegramConnectSheet.compact.offset.v1" : "hsp.telegramConnectSheet.offset.v2"
      }
    >
      {showSuccess ? (
        <View style={[appModalSheetStyles.centerBlock, { marginTop: 4, marginBottom: 4 }]}>
          <Text
            accessibilityLabel={t("messages.connectSheetSuccessTitle")}
            style={{
              fontSize: 44,
              lineHeight: 48,
              color: colors.primary,
              marginBottom: 12,
            }}
          >
            ✓
          </Text>
          <ActivityIndicator size="small" color={colors.primary} style={{ marginBottom: 12 }} />
          <Text style={[appModalSheetStyles.bodySupporting, { color: colors.secondary, marginBottom: 0 }]}>
            {t("messages.connectSheetSuccessBody")}
          </Text>
        </View>
      ) : null}

      {showMethods ? (
        <>
          <Text style={[appModalSheetStyles.body, { color: colors.secondary }]}>
            {t("messages.connectSheetBody")}
          </Text>

          <Text style={[appModalSheetStyles.section, { color: colors.primary, marginTop: 14 }]}>
            {t("messages.connectSheetMethodsTitle")}
          </Text>

          <ConnectMethodSection title={t("messages.connectSheetScanQr")}>
            <Text style={[appModalSheetStyles.body, { color: colors.secondary, marginBottom: 12 }]}>
              {t("messages.connectSheetQrBody")}
            </Text>
            <View style={{ alignItems: "center", width: "100%" }}>
              <TelegramConnectQrImage
                link={connectQrLink}
                loadingLabel={t("messages.connectSheetLoading")}
                qrAlt={t("messages.connectSheetQrAlt")}
              />
            </View>
          </ConnectMethodSection>

          <ConnectMethodSection title={t("messages.connectSheetEnterNumber")}>
            <Text style={[appModalSheetStyles.body, { color: colors.secondary, marginBottom: 12 }]}>
              {t("messages.connectSheetPhoneCloudWarning")}
            </Text>
            <WelcomeAuthFormField
              value={phoneNumber}
              onChangeText={(next) => {
                setPhoneNumber(next);
                if (phoneInvalid) setPhoneInvalid(false);
              }}
              placeholder={t("messages.connectSheetPhonePlaceholder")}
              keyboardType="phone-pad"
              textContentType="telephoneNumber"
              inputId="telegram-connect-phone-input"
              errorText={phoneErrorText}
              submitLabel={t("messages.connectSheetPhoneSubmit")}
              onSubmit={onSubmitPhone}
              submitDisabled={!phoneNumber.trim()}
              submitting={connectPending}
              layout="fill"
            />
          </ConnectMethodSection>

          <ConnectMethodSection title={t("messages.connectSheetOneTouchConnect")}>
            <Pressable
              accessibilityRole="button"
              onPress={onOpenInTelegram}
              disabled={!connectQrLink || connectPending}
              style={[
                appModalSheetStyles.button,
                appModalSheetStyles.primaryButton,
                {
                  backgroundColor: colors.undercover,
                  alignSelf: "stretch",
                  opacity: connectQrLink ? 1 : 0.5,
                },
              ]}
            >
              <Text style={[typographyFixedRow40Label, { color: colors.primary }]}>
                {t("messages.connectSheetPassToTelegramApp")}
              </Text>
            </Pressable>
            <Text style={[appModalSheetStyles.body, { color: colors.secondary, marginTop: 12 }]}>
              {t("messages.connectSheetOneTouchBody")}
            </Text>
          </ConnectMethodSection>
        </>
      ) : null}

      {showCode ? (
        <View style={appModalSheetStyles.passwordBlock}>
          <Text style={[appModalSheetStyles.bodySupporting, { color: colors.secondary }]}>
            {codeDeliveryHint}
          </Text>
          <WelcomeAuthFormField
            value={loginCode}
            onChangeText={setLoginCode}
            placeholder={t("messages.connectSheetCodePlaceholder")}
            keyboardType="number-pad"
            secureTextEntry
            inputId="telegram-connect-code-input"
            errorText={
              connectError && /code|PHONE_CODE/i.test(connectError)
                ? connectErrorMessage(connectError, t)
                : null
            }
            submitLabel={t("messages.connectSheetCodeSubmit")}
            onSubmit={onSubmitCode}
            submitDisabled={!loginCode.trim()}
            submitting={connectPending}
            layout="fill"
          />
          {canResendCode ? (
            <Pressable
              accessibilityRole="button"
              onPress={onResendCode}
              style={[appModalSheetStyles.button, { marginTop: 8, alignSelf: "flex-start" }]}
              disabled={connectPending}
            >
              <Text style={[typographyFixedRow40Label, { color: colors.primary }]}>
                {t("messages.connectSheetCodeResend")}
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {showPassword ? (
        <View style={appModalSheetStyles.passwordBlock}>
          <Text style={[appModalSheetStyles.bodySupporting, { color: colors.secondary }]}>
            {t("messages.connectSheetPasswordBody")}
          </Text>
          <WelcomeAuthFormField
            value={password}
            onChangeText={setPassword}
            placeholder={t("messages.connectSheetPasswordPlaceholder")}
            secureTextEntry
            inputId="telegram-connect-password-input"
            errorText={
              connectError && /password|PASSWORD/i.test(connectError)
                ? connectErrorMessage(connectError, t)
                : null
            }
            submitLabel={t("messages.connectSheetPasswordSubmit")}
            onSubmit={onSubmitPassword}
            submitDisabled={!password.trim()}
            submitting={connectPending}
            layout="fill"
          />
        </View>
      ) : null}

      {connectAuthState === "failed" ? (
        <View style={appModalSheetStyles.centerBlock}>
          <Text style={[appModalSheetStyles.error, { color: "#b00020" }]}>
            {connectErrorMessage(connectError, t)}
          </Text>
          {connectPending ? (
            <ActivityIndicator size="small" color={colors.primary} style={{ marginTop: 8 }} />
          ) : (
            <Pressable
              accessibilityRole="button"
              onPress={onRetry}
              style={[
                appModalSheetStyles.button,
                appModalSheetStyles.primaryButton,
                { backgroundColor: colors.undercover, alignSelf: "stretch" },
              ]}
            >
              <Text style={[typographyFixedRow40Label, { color: colors.primary }]}>
                {t("messages.connectRetry")}
              </Text>
            </Pressable>
          )}
        </View>
      ) : null}

      {showMethods && connectError && connectError !== "invalid_phone_number" ? (
        <Text style={[appModalSheetStyles.error, { color: "#b00020" }]}>
          {connectErrorMessage(connectError, t)}
        </Text>
      ) : null}
    </AppModalSheet>
  );
}
