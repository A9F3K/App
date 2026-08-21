import { Text, View } from "react-native";

import { layout, typographyFixedRow30Label, useColors } from "../../theme";
import { useGetActionSummary } from "./useGetActionSummary";

type Density = "compact" | "bar";

type Props = {
  density?: Density;
};

/** Centered Get transfer summary (no button — actions live in the panel body). */
export function GetActionSummaryRow({ density = "compact" }: Props) {
  const colors = useColors();
  const summary = useGetActionSummary();
  const height = layout.bottomBar.undercoverButtonHeightPx;

  return (
    <View
      style={{
        width: "100%",
        height,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text
        style={[typographyFixedRow30Label, { color: colors.primary, textAlign: "center" }]}
        numberOfLines={1}
      >
        {summary}
      </Text>
    </View>
  );
}
