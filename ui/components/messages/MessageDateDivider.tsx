import { PixelRatio, Text, View } from "react-native";
import type { ThemeColors } from "../../theme";

const DATE_DIVIDER_CURRENT_YEAR_FORMATTER = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "long",
});
const DATE_DIVIDER_OTHER_YEAR_FORMATTER = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "long",
  year: "numeric",
});
const DATE_DIVIDER_LINE_PX = 1 / Math.max(1, PixelRatio.get());

function startOfLocalDayMs(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

export function formatMessageDateDividerLabel(sentAt: string, now: Date): string {
  const sentDate = new Date(sentAt);
  if (!Number.isFinite(sentDate.getTime())) return "";
  const dayDiff = Math.floor(
    (startOfLocalDayMs(now) - startOfLocalDayMs(sentDate)) / 86_400_000,
  );
  if (dayDiff === 0) return "Today";
  if (dayDiff === 1) return "Yesterday";
  if (dayDiff === 2) return "The Day Before Yesterday";
  if (sentDate.getFullYear() === now.getFullYear()) {
    return DATE_DIVIDER_CURRENT_YEAR_FORMATTER.format(sentDate);
  }
  return DATE_DIVIDER_OTHER_YEAR_FORMATTER.format(sentDate);
}

export function messageDayKey(sentAt: string): string {
  const sentDate = new Date(sentAt);
  if (!Number.isFinite(sentDate.getTime())) return sentAt;
  return `${sentDate.getFullYear()}-${sentDate.getMonth()}-${sentDate.getDate()}`;
}

export function todayDayKey(now: Date = new Date()): string {
  return `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
}

/** Hide a date divider when older loaded history still has messages on the same day. */
export function shouldShowMessageDateDivider(
  item: { sent_at: string; telegram_message_id: number },
  previousInDisplay: { sent_at: string } | null,
  loadedMessages: readonly { sent_at: string; telegram_message_id: number }[],
  allLoadedMessagesAreFromToday: boolean,
): boolean {
  if (allLoadedMessagesAreFromToday) return false;
  const itemDay = messageDayKey(item.sent_at);
  if (previousInDisplay != null && messageDayKey(previousInDisplay.sent_at) === itemDay) {
    return false;
  }
  const loadedIndex = loadedMessages.findIndex(
    (row) => row.telegram_message_id === item.telegram_message_id,
  );
  if (loadedIndex > 0) {
    const olderNeighbor = loadedMessages[loadedIndex - 1]!;
    if (messageDayKey(olderNeighbor.sent_at) === itemDay) {
      return false;
    }
  }
  return true;
}

export function MessageDateDivider({
  label,
  colors,
}: {
  label: string;
  colors: ThemeColors;
}) {
  return (
    <View
      style={{
        alignSelf: "stretch",
        flexDirection: "row",
        alignItems: "center",
        paddingVertical: 6,
        gap: 8,
      }}
      accessibilityRole="text"
    >
      <View
        style={{
          flex: 1,
          height: DATE_DIVIDER_LINE_PX,
          minHeight: DATE_DIVIDER_LINE_PX,
          maxHeight: DATE_DIVIDER_LINE_PX,
          backgroundColor: colors.highlight,
        }}
      />
      <Text
        style={{
          color: colors.secondary,
          fontSize: 13,
          lineHeight: 16,
          fontWeight: "400",
        }}
      >
        {label}
      </Text>
      <View
        style={{
          flex: 1,
          height: DATE_DIVIDER_LINE_PX,
          minHeight: DATE_DIVIDER_LINE_PX,
          maxHeight: DATE_DIVIDER_LINE_PX,
          backgroundColor: colors.highlight,
        }}
      />
    </View>
  );
}
