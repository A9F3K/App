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
  /** Chat list row: no extra left margin before the time label. */
  compact?: boolean;
};

const SINGLE_CHECK_PATH = "M1 7.5 L4.5 11 L10 2";
const READ_CHECK_OFFSET = 4;
/** One tick glyph width in the shared 14px-tall viewBox (path spans x≈1…10). */
const SINGLE_CHECK_VIEW_WIDTH = 10;
/** Wide enough for two checks + round stroke caps (path reaches x≈14 at strokeWidth 1.75). */
const READ_VIEW_WIDTH = 16;

function singleCheckSvgWidthPx(size = MESSAGE_CHAT_CHECKMARK_SIZE_PX): number {
  return (size * SINGLE_CHECK_VIEW_WIDTH) / 14;
}

function outgoingChecksSvgWidthPx(size = MESSAGE_CHAT_CHECKMARK_SIZE_PX): number {
  return (size * READ_VIEW_WIDTH) / 14;
}

function SingleCheckSvg({
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
  const widthPx = singleCheckSvgWidthPx(size);

  return (
    <Svg
      width={widthPx}
      height={size}
      viewBox={`0 0 ${SINGLE_CHECK_VIEW_WIDTH} 14`}
      style={{ overflow: "visible" }}
    >
      <Path d={SINGLE_CHECK_PATH} {...stroke} />
    </Svg>
  );
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
  colors: _colors,
  size = MESSAGE_CHAT_CHECKMARK_SIZE_PX,
  compact = false,
}: Props) {
  if (status !== "delivered" && status !== "read") return null;

  const checkColor = MESSAGE_CHAT_READ_CHECK_COLOR;
  const marginLeft = compact ? 0 : MESSAGE_CHAT_CHECKMARK_GAP_PX;

  if (status === "read") {
    const reserveWidthPx = outgoingChecksSvgWidthPx(size);
    return (
      <View
        style={{
          marginLeft,
          width: reserveWidthPx,
          alignItems: "center",
          justifyContent: "center",
          overflow: "visible",
        }}
      >
        <DoubleCheckSvg color={checkColor} size={size} />
      </View>
    );
  }

  const reserveWidthPx = singleCheckSvgWidthPx(size);
  return (
    <View
      style={{
        marginLeft,
        width: reserveWidthPx,
        alignItems: "center",
        justifyContent: "center",
        overflow: "visible",
      }}
    >
      <SingleCheckSvg color={checkColor} size={size} />
    </View>
  );
}

export function messageChatOutgoingChecksWidthPx(
  status: MessageOutgoingStatus | null | undefined,
): number {
  if (status !== "delivered" && status !== "read") return 0;
  if (status === "read") {
    return outgoingChecksSvgWidthPx() + MESSAGE_CHAT_CHECKMARK_GAP_PX;
  }
  return singleCheckSvgWidthPx() + MESSAGE_CHAT_CHECKMARK_GAP_PX;
}
