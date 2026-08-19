import { useSyncExternalStore } from "react";
import { Image, Platform, Pressable, Text, View } from "react-native";
import { useAppStrings } from "../../../locales/AppStringsContext";
import { FONT_UI_SANS_REGULAR, WEB_UI_SANS_STACK } from "../../fonts";
import type { ThemeColors } from "../../theme";
import { unlockMusicAutoplay } from "../../music/musicAudioElement";
import { formatMusicClock, formatMusicSize } from "../../music/musicFormat";
import {
  getMusicPlayer,
  startMusicPlaylist,
  subscribeMusicPlayer,
  toggleMusicPlay,
} from "../../music/musicPlayerStore";
import { MusicPauseIcon, MusicPlayIcon } from "../music/MusicControlIcons";
import {
  musicTrackPlaybackKey,
  type TelegramProfileAudioTrack,
} from "../../telegram/fetchTelegramUserProfile";
import {
  messageChatAudioDisplayLabel,
  type MessageChatHistoryItem,
} from "./messageChatHistoryTypes";
import {
  MESSAGE_BUBBLE_FONT_SIZE_PX,
  MESSAGE_BUBBLE_LINE_HEIGHT_PX,
} from "./messageChatLayout";

const COVER_PX = 40;
const AUDIO_MIN_INNER_WIDTH_PX = 220;

export function messageChatAudioInnerWidthPx(): number {
  return AUDIO_MIN_INNER_WIDTH_PX;
}

function chatAudioTrack(
  chatId: number,
  item: MessageChatHistoryItem,
): TelegramProfileAudioTrack | null {
  const audio = item.audio;
  if (!audio) return null;
  return {
    user_id: item.sender_user_id ?? 0,
    file_id: 0,
    artist: audio.artist,
    title: audio.title,
    duration_sec: audio.duration_sec,
    size_bytes: audio.size_bytes,
    cover_data_url: audio.cover_data_url,
    cover_file_id: null,
    chat_id: chatId,
    message_id: item.telegram_message_id,
  };
}

export function MessageChatAudioContent({
  chatId,
  item,
  colors,
}: {
  chatId: number;
  item: MessageChatHistoryItem;
  colors: ThemeColors;
}) {
  const { t } = useAppStrings();
  const player = useSyncExternalStore(subscribeMusicPlayer, getMusicPlayer, getMusicPlayer);
  const audio = item.audio;
  if (!audio) return null;

  const track = chatAudioTrack(chatId, item);
  const key = track ? musicTrackPlaybackKey(track) : "";
  const activeTrack = player.tracks[player.index] ?? null;
  const active = Boolean(
    player.visible && activeTrack && musicTrackPlaybackKey(activeTrack) === key,
  );
  const playing = active && player.playing;
  const label = messageChatAudioDisplayLabel(audio);
  const durationLabel = formatMusicClock(audio.duration_sec);
  const sizeLabel = formatMusicSize(audio.size_bytes);
  const meta = playing
    ? `${formatMusicClock(player.currentTime)} / ${formatMusicClock(
        player.duration || audio.duration_sec,
      )}`
    : [durationLabel, sizeLabel].filter(Boolean).join(", ");

  const handlePress = () => {
    unlockMusicAutoplay();
    if (!track) return;
    if (active) {
      toggleMusicPlay();
      return;
    }
    startMusicPlaylist([track], 0);
  };

  const textFont = Platform.OS === "web" ? WEB_UI_SANS_STACK : FONT_UI_SANS_REGULAR;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={playing ? t("messages.music.pause") : t("messages.music.play")}
      onPress={handlePress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        minWidth: AUDIO_MIN_INNER_WIDTH_PX,
        opacity: pressed ? 0.85 : 1,
      })}
    >
      <View
        style={{
          width: COVER_PX,
          height: COVER_PX,
          borderRadius: COVER_PX / 2,
          overflow: "hidden",
          backgroundColor: colors.undercover,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {audio.cover_data_url ? (
          <Image
            source={{ uri: audio.cover_data_url }}
            style={{ width: COVER_PX, height: COVER_PX, position: "absolute" }}
          />
        ) : null}
        {playing ? (
          <MusicPauseIcon color={colors.primary} size={14} />
        ) : (
          <MusicPlayIcon color={colors.primary} size={14} />
        )}
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text
          numberOfLines={1}
          style={{
            color: colors.primary,
            fontSize: MESSAGE_BUBBLE_FONT_SIZE_PX,
            lineHeight: MESSAGE_BUBBLE_LINE_HEIGHT_PX,
            fontWeight: "600",
            fontFamily: textFont,
          }}
        >
          {label}
        </Text>
        {meta ? (
          <Text
            numberOfLines={1}
            style={{
              color: colors.secondary,
              fontSize: 12,
              lineHeight: 15,
              marginTop: 2,
              fontFamily: textFont,
            }}
          >
            {meta}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}
