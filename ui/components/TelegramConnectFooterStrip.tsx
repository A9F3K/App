type Props = {
  onPowerPress?: () => void;
  onSettingsPress?: () => void;
};

/**
 * Formerly floated shield/settings above the narrow messages footer.
 * Narrow home uses {@link FloatingShield}; wide home places them in {@link MessagesColumnFooter}.
 */
export function TelegramConnectFooterStrip(_props: Props) {
  return null;
}
