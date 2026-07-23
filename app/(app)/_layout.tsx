import { Stack } from "expo-router";
import { dark } from "../../ui/theme";

export default function AppGroupLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        // Match app shell — RN DefaultTheme card is #f2f2f2 and flashes on hard-reload.
        contentStyle: { flex: 1, minHeight: 0, backgroundColor: dark.background },
      }}
    />
  );
}
