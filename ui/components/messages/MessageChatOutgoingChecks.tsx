import { View } from "react-native";
import Svg, { Path } from "react-native-svg";
import type { ThemeColors } from "../../theme";
import type { MessageOutgoingStatus } from "./messageChatHistoryTypes";
import {
  MESSAGE_CHAT_CHECKMARK_GAP_PX,
  MESSAGE_CHAT_CHECKMARK_SIZE_PX,
  MESSAGE_CHAT_READ_CHECK_COLOR,
} from "./messageChatLayout";

type Props = {
  status: MessageOutgoingStatus;
  colors: ThemeColors;
  size?: number;
  /** Time sits on dark media — use light ticks. */
  onMedia?: boolean;
  /** Private chats: double grey ticks once delivered (Telegram-style). */
  doubleCheckDelivered?: boolean;
};

const SINGLE_CHECK_PATH = "M1 7.5 L4.5 11 L10 2";
const READ_CHECK_OFFSET = 4;
/** Wide enough for two checks + round stroke caps (path reaches x≈14 at strokeWidth 1.75). */
const READ_VIEW_WIDTH = 16;

function outgoingChecksSvgWidthPx(size = MESSAGE_CHAT_CHECKMARK_SIZE_PX): number {
  return (size * READ_VIEW_WIDTH) / 14;
}

function DoubleCheckSvg({
  color,
  size,
}: {
  color: string;
  size: number;
}) {
  const stroke = {
    stroke: color,
    strokeWidth: 1.75,
    fill: "none" as const,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  const reserveWidthPx = outgoingChecksSvgWidthPx(size);

  return (
    <Svg
      width={reserveWidthPx}
      height={size}
      viewBox={`0 0 ${READ_VIEW_WIDTH} 14`}
      style={{ overflow: "visible" }}
    >
      <Path d={SINGLE_CHECK_PATH} {...stroke} />
      <Path d={SINGLE_CHECK_PATH} transform={`translate(${READ_CHECK_OFFSET} 0)`} {...stroke} />
    </Svg>
  );
}

/** Telegram-style delivery ticks beside bubble time (outgoing only). */
export function MessageChatOutgoingChecks({
  status,
  colors,
  size = MESSAGE_CHAT_CHECKMARK_SIZE_PX,
  onMedia = false,
  doubleCheckDelivered = false,
}: Props) {
  if (status !== "delivered" && status !== "read") return null;

  const readColor = MESSAGE_CHAT_READ_CHECK_COLOR;
  const deliveredColor = onMedia ? "rgba(255,255,255,0.92)" : colors.secondary;
  const reserveWidthPx = outgoingChecksSvgWidthPx(size);

  if (status === "read") {
    return (
      <View
        style={{
          marginLeft: MESSAGE_CHAT_CHECKMARK_GAP_PX,
          width: reserveWidthPx,
          alignItems: "center",
          justifyContent: "center",
          overflow: "visible",
        }}
      >
        <DoubleCheckSvg color={readColor} size={size} />
      </View>
    );
  }

  if (doubleCheckDelivered) {
    return (
      <View
        style={{
          marginLeft: MESSAGE_CHAT_CHECKMARK_GAP_PX,
          width: reserveWidthPx,
          alignItems: "center",
          justifyContent: "center",
          overflow: "visible",
        }}
      >
        <DoubleCheckSvg color={deliveredColor} size={size} />
      </View>
    );
  }

  return (
    <View
      style={{
        marginLeft: MESSAGE_CHAT_CHECKMARK_GAP_PX,
        width: reserveWidthPx,
        alignItems: "center",
        justifyContent: "center",
        overflow: "visible",
      }}
    >
      <Svg width={size * 0.62} height={size} viewBox="0 0 11 14" style={{ overflow: "visible" }}>
        <Path
          d={SINGLE_CHECK_PATH}
          stroke={deliveredColor}
          strokeWidth={1.75}
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </Svg>
    </View>
  );
}

export function messageChatOutgoingChecksWidthPx(
  status: MessageOutgoingStatus | null | undefined,
  doubleCheckDelivered = false,
): number {
  if (status !== "delivered" && status !== "read") return 0;
  if (status === "read" || doubleCheckDelivered) {
    return outgoingChecksSvgWidthPx() + MESSAGE_CHAT_CHECKMARK_GAP_PX;
  }
  return Math.ceil(MESSAGE_CHAT_CHECKMARK_SIZE_PX * 0.62) + MESSAGE_CHAT_CHECKMARK_GAP_PX;
}
