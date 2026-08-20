type Props = {
  onPowerPress?: () => void;
  onSettingsPress?: () => void;
};

/**
 * Formerly floated shield/settings above the narrow messages footer.
 * Those chips now live inside {@link MessagesColumnFooter} — keep this null.
 */
export function TelegramConnectFooterStrip(_props: Props) {
  return null;
}
