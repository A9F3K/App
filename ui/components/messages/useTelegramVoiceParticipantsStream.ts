import type { TelegramChatVoiceParticipant } from "../../telegram/fetchTelegramChatVoiceParticipants";

export type VoiceParticipantsStreamSnapshot = {
  revision: number;
  participant_count: number;
  participants: TelegramChatVoiceParticipant[];
  group_call_id: number | null;
};

type Options = {
  enabled: boolean;
  chatId: number;
  groupCallId: number | null;
  getSinceRevision: () => number | null;
  onParticipants: (snapshot: VoiceParticipantsStreamSnapshot) => void;
  onStreamActiveChange?: (active: boolean) => void;
};

/** Native / non-web: voice roster uses HTTP polling only. */
export function useTelegramVoiceParticipantsStream(_options: Options): void {
  /* polling only */
}
