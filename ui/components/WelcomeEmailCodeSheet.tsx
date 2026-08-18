import { Text } from "react-native";
import { useAppStrings } from "../../locales/AppStringsContext";
import { typographyRect15, useColors } from "../theme";
import { AppModalSheet, AppModalSheetBackFooter, appModalSheetStyles } from "./AppModalSheet";
import { WelcomeAuthFormField } from "./WelcomeAuthFormField";

type Props = {
  visible: boolean;
  email: string;
  code: string;
  codeInvalid: boolean;
  codeWrong: boolean;
  codeWrongPulseKey: number;
  submitting: boolean;
  onChangeCode: (next: string) => void;
  onClose: () => void;
  onSubmit: () => void;
};

export function WelcomeEmailCodeSheet({
  visible,
  email,
  code,
  codeInvalid,
  codeWrong,
  codeWrongPulseKey,
  submitting,
  onChangeCode,
  onClose,
  onSubmit,
}: Props) {
  const colors = useColors();
  const { t, tf } = useAppStrings();

  return (
    <AppModalSheet
      visible={visible}
      onClose={onClose}
      title={t("welcome.auth.emailCodeTitle")}
      footer={<AppModalSheetBackFooter onClose={onClose} label={t("common.back")} />}
    >
      <Text style={[typographyRect15, appModalSheetStyles.body, { color: colors.secondary }]}>
        {tf("welcome.auth.emailCodeHint", { email })}
      </Text>
      <WelcomeAuthFormField
        value={code}
        onChangeText={onChangeCode}
        placeholder={t("welcome.auth.emailCodePlaceholder")}
        keyboardType="number-pad"
        textContentType="oneTimeCode"
        inputId="welcome-email-code-input"
        errorText={
          codeWrong
            ? t("welcome.auth.emailCodeWrong")
            : codeInvalid
              ? t("welcome.auth.emailCodeInvalid")
              : null
        }
        errorPulseKey={codeWrongPulseKey}
        submitLabel={t("welcome.auth.signInButton")}
        onSubmit={onSubmit}
        submitting={submitting}
        submitDisabled={submitting}
      />
    </AppModalSheet>
  );
}
