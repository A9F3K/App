/**
 * Single Vercel serverless entry for **single-segment** `/api/:segment` routes (Hobby plan limit).
 * Concrete handlers live in api/_handlers/*.
 *
 * Vercel does not send multi-segment paths (e.g. `/api/auth/session`) to this file — only one
 * dynamic segment after `/api/`. Those URLs need real files such as `api/auth/session.ts` or a
 * `vercel.json` rewrite to a single segment (see `/api/kms/ping` → `/api/wallet-envelope-ping`).
 *
 * `vercel dev` on Windows may spawn extra workers for both this catch-all and explicit `api/auth/*`
 * files; if a worker crashes (exit 3221226505), use `npm run web` or WSL.
 *
 * Includes feed create_topup / mark_read actions (wallet notifications + unread badge).
 */

import aiHandler from './_handlers/ai.js';
import voiceDebugHandler from './_handlers/voice-debug.js';
import blockchainHandler from './_handlers/blockchain.js';
import botHandler from './_handlers/bot.js';
import feedHandler from './_handlers/feed.js';
import pingHandler from './_handlers/ping.js';
import releasesHandler from './_handlers/releases.js';
import swapCoffeeTokensHandler from './_handlers/swap-coffee-tokens.js';
import tonAccountHoldingsHandler from './_handlers/ton-account-holdings.js';
import telegramHandler from './_handlers/telegram.js';
import walletEnvelopePingHandler from './_handlers/wallet-envelope-ping.js';
import walletEnvelopeProbeHandler from './_handlers/wallet-envelope-probe.js';
import walletEnvelopeRoundtripHandler from './_handlers/wallet-envelope-roundtrip.js';
import walletActivateHandler from './_handlers/wallet-activate.js';
import {
  telegramMessagesChatsHandler,
  telegramMessagesChatsLoadMoreHandler,
  telegramMessagesChatsStreamHandler,
  telegramMessagesConnectHandler,
  telegramMessagesDisconnectHandler,
  telegramMessagesAvatarHandler,
  telegramMessagesHistoryHandler,
  telegramMessagesHistoryStreamHandler,
  telegramMessagesMediaHandler,
  telegramMessagesCustomEmojiHandler,
  telegramMessagesSendHandler,
  telegramMessagesSendPhotoHandler,
  telegramMessagesEditHandler,
  telegramMessagesDeleteHandler,
  telegramMessagesProfileHandler,
  telegramMessagesProfileAudioHandler,
  telegramMessagesProfileAudioCoverHandler,
  telegramMessagesBlockHandler,
  telegramMessagesUnblockHandler,
  telegramMessagesLinksHandler,
  telegramMessagesProfileMediaHandler,
  telegramMessagesCallCreateHandler,
  telegramMessagesCallStatusHandler,
  telegramMessagesCallDiscardHandler,
  telegramMessagesVoiceJoinHandler,
  telegramMessagesVoiceMuteHandler,
  telegramMessagesVoiceParticipantVolumeHandler,
  telegramMessagesVoiceSpeakingHandler,
  telegramMessagesVoiceStartHandler,
  telegramMessagesVoiceLeaveHandler,
  telegramMessagesVoiceScreenShareStartHandler,
  telegramMessagesVoiceScreenShareEndHandler,
  telegramMessagesVoiceCallMessageSendHandler,
  telegramMessagesVoiceCallMessagesStreamHandler,
  telegramMessagesVoiceParticipantsHandler,
  telegramMessagesVoiceParticipantsStreamHandler,
  telegramMessagesResolveChatHandler,
  telegramMessagesResyncHandler,
  telegramMessagesStatusHandler,
  telegramMessagesWarmupHandler,
  telegramMessagesViewInboxHandler,
  telegramMessagesPinChatHandler,
  telegramMessagesPinnedChatsOrderHandler,
  telegramMessagesSearchHandler,
  telegramMessagesStreamTicketHandler,
  telegramMessagesContactsHandler,
  telegramMessagesCreateGroupHandler,
  telegramMessagesCreateChannelHandler,
  telegramMessagesCallsHandler,
} from './_handlers/telegram-messages.js';
import {
  telegramMtprotoConnectCodeHandler,
  telegramMtprotoConnectPasswordHandler,
  telegramMtprotoConnectPhoneHandler,
  telegramMtprotoConnectResendCodeHandler,
  telegramMtprotoConnectStartHandler,
  telegramMtprotoConnectStatusHandler,
} from './_handlers/telegram-mtproto.js';

type NodeRes = {
  setHeader(name: string, value: string): void;
  status(code: number): void;
  end(body?: string): void;
};

type ApiHandler = (
  request: Request,
  res?: NodeRes,
) => Promise<Response | void>;

const ROUTES: Record<string, ApiHandler> = {
  ping: pingHandler as ApiHandler,
  'voice-debug': voiceDebugHandler as ApiHandler,
  bot: botHandler as ApiHandler,
  feed: feedHandler as ApiHandler,
  ai: aiHandler as ApiHandler,
  blockchain: blockchainHandler as ApiHandler,
  telegram: telegramHandler as ApiHandler,
  releases: releasesHandler as ApiHandler,
  'swap-coffee-tokens': swapCoffeeTokensHandler as ApiHandler,
  'ton-account-holdings': tonAccountHoldingsHandler as ApiHandler,
  'wallet-envelope-ping': walletEnvelopePingHandler as ApiHandler,
  'wallet-envelope-probe': walletEnvelopeProbeHandler as ApiHandler,
  'wallet-envelope-roundtrip': walletEnvelopeRoundtripHandler as ApiHandler,
  'wallet-activate': walletActivateHandler as ApiHandler,
  /** Public short paths from vercel.json rewrites (request URL may still show these segments). */
  kmsping: walletEnvelopePingHandler as ApiHandler,
  kmsprobe: walletEnvelopeProbeHandler as ApiHandler,
  'kms-roundtrip': walletEnvelopeRoundtripHandler as ApiHandler,
  'kms/ping': walletEnvelopePingHandler as ApiHandler,
  'kms-ping': walletEnvelopePingHandler as ApiHandler,
  /** Telegram message sync (single-segment; see vercel.json rewrites from /api/telegram/messages/*). */
  'telegram-messages-status': telegramMessagesStatusHandler as ApiHandler,
  'telegram-messages-connect': telegramMessagesConnectHandler as ApiHandler,
  'telegram-messages-disconnect': telegramMessagesDisconnectHandler as ApiHandler,
  'telegram-messages-chats': telegramMessagesChatsHandler as ApiHandler,
  'telegram-messages-chats-load-more': telegramMessagesChatsLoadMoreHandler as ApiHandler,
  'telegram-messages-chats-stream': telegramMessagesChatsStreamHandler as ApiHandler,
  'telegram-messages-avatar': telegramMessagesAvatarHandler as ApiHandler,
  'telegram-messages-profile': telegramMessagesProfileHandler as ApiHandler,
  'telegram-messages-profile-audio': telegramMessagesProfileAudioHandler as ApiHandler,
  'telegram-messages-profile-audio-cover': telegramMessagesProfileAudioCoverHandler as ApiHandler,
  'telegram-messages-block': telegramMessagesBlockHandler as ApiHandler,
  'telegram-messages-unblock': telegramMessagesUnblockHandler as ApiHandler,
  'telegram-messages-links': telegramMessagesLinksHandler as ApiHandler,
  'telegram-messages-profile-media': telegramMessagesProfileMediaHandler as ApiHandler,
  'telegram-messages-call-create': telegramMessagesCallCreateHandler as ApiHandler,
  'telegram-messages-call-status': telegramMessagesCallStatusHandler as ApiHandler,
  'telegram-messages-call-discard': telegramMessagesCallDiscardHandler as ApiHandler,
  'telegram-messages-history': telegramMessagesHistoryHandler as ApiHandler,
  'telegram-messages-history-stream': telegramMessagesHistoryStreamHandler as ApiHandler,
  'telegram-messages-media': telegramMessagesMediaHandler as ApiHandler,
  'telegram-messages-custom-emoji': telegramMessagesCustomEmojiHandler as ApiHandler,
  'telegram-messages-send': telegramMessagesSendHandler as ApiHandler,
  'telegram-messages-send-photo': telegramMessagesSendPhotoHandler as ApiHandler,
  'telegram-messages-edit': telegramMessagesEditHandler as ApiHandler,
  'telegram-messages-delete': telegramMessagesDeleteHandler as ApiHandler,
  'telegram-messages-voice-join': telegramMessagesVoiceJoinHandler as ApiHandler,
  'telegram-messages-voice-mute': telegramMessagesVoiceMuteHandler as ApiHandler,
  'telegram-messages-voice-participant-volume': telegramMessagesVoiceParticipantVolumeHandler as ApiHandler,
  'telegram-messages-voice-speaking': telegramMessagesVoiceSpeakingHandler as ApiHandler,
  'telegram-messages-voice-start': telegramMessagesVoiceStartHandler as ApiHandler,
  'telegram-messages-voice-leave': telegramMessagesVoiceLeaveHandler as ApiHandler,
  'telegram-messages-voice-screen-share-start': telegramMessagesVoiceScreenShareStartHandler as ApiHandler,
  'telegram-messages-voice-screen-share-end': telegramMessagesVoiceScreenShareEndHandler as ApiHandler,
  'telegram-messages-voice-call-message-send': telegramMessagesVoiceCallMessageSendHandler as ApiHandler,
  'telegram-messages-voice-call-messages-stream': telegramMessagesVoiceCallMessagesStreamHandler as ApiHandler,
  'telegram-messages-voice-participants': telegramMessagesVoiceParticipantsHandler as ApiHandler,
  'telegram-messages-voice-participants-stream': telegramMessagesVoiceParticipantsStreamHandler as ApiHandler,
  'telegram-messages-resolve-chat': telegramMessagesResolveChatHandler as ApiHandler,
  'telegram-messages-search': telegramMessagesSearchHandler as ApiHandler,
  'telegram-messages-contacts': telegramMessagesContactsHandler as ApiHandler,
  'telegram-messages-create-group': telegramMessagesCreateGroupHandler as ApiHandler,
  'telegram-messages-create-channel': telegramMessagesCreateChannelHandler as ApiHandler,
  'telegram-messages-calls': telegramMessagesCallsHandler as ApiHandler,
  'telegram-messages-stream-ticket': telegramMessagesStreamTicketHandler as ApiHandler,
  'telegram-messages-resync': telegramMessagesResyncHandler as ApiHandler,
  'telegram-messages-warmup': telegramMessagesWarmupHandler as ApiHandler,
  'telegram-messages-view-inbox': telegramMessagesViewInboxHandler as ApiHandler,
  'telegram-messages-pin-chat': telegramMessagesPinChatHandler as ApiHandler,
  'telegram-messages-pinned-chats-order': telegramMessagesPinnedChatsOrderHandler as ApiHandler,
  /** TDLib QR connect (proxies to local/remote gateway). */
  'telegram-mtproto-connect-start': telegramMtprotoConnectStartHandler as ApiHandler,
  'telegram-mtproto-connect-status': telegramMtprotoConnectStatusHandler as ApiHandler,
  'telegram-mtproto-connect-password': telegramMtprotoConnectPasswordHandler as ApiHandler,
  'telegram-mtproto-connect-phone': telegramMtprotoConnectPhoneHandler as ApiHandler,
  'telegram-mtproto-connect-code': telegramMtprotoConnectCodeHandler as ApiHandler,
  'telegram-mtproto-connect-resend-code': telegramMtprotoConnectResendCodeHandler as ApiHandler,
};

function routeKeyFromUrl(request: Request): string {
  const raw = request.url;
  if (!raw) return '';
  let pathname: string;
  try {
    pathname = new URL(raw).pathname;
  } catch {
    pathname = raw.split('?')[0] ?? '';
  }
  const segments = pathname
    .replace(/^\/api\/?/i, '')
    .split('/')
    .filter(Boolean);
  return segments.join('/');
}

async function router(
  request: Request,
  res?: NodeRes,
): Promise<Response | void> {
  const key = routeKeyFromUrl(request);
  const handler = ROUTES[key];
  if (!handler) {
    const body = JSON.stringify({
      ok: false,
      error: 'not_found',
      path: key || '(empty)',
      hint: 'See api/[...path].ts (single-segment routes) and api/**/*.ts for multi-segment paths; handlers in api/_handlers/',
    });
    if (res) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.status(404);
      res.end(body);
      return;
    }
    return new Response(body, {
      status: 404,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  }
  return handler(request, res);
}

export default router;
export const GET = router;
export const POST = router;
export const OPTIONS = router;
export const PUT = router;
export const PATCH = router;
export const DELETE = router;
