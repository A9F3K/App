/**
 * Shared Grammy bot.
 * Used by app/bot/webhook (Vercel) and scripts/run-bot-local.ts (polling).
 */
import { Bot, type Context } from 'grammy';
import {
  displayNameFromNameParts,
  normalizeUsername,
  upsertUserFromBot,
} from '../database/users.js';
import { handleBotAiResponse } from './responder.js';
import { appError } from '../shared/appLog.js';

export function createBot(token: string): Bot {
  const bot = new Bot(token);

  async function handleUserUpsert(ctx: Context): Promise<void> {
    try {
      const from = ctx.from;
      if (!from) return;

      const telegramUsername = normalizeUsername(from.username);
      if (!telegramUsername) return;

      const locale =
        typeof from.language_code === 'string' ? from.language_code : null;

      await upsertUserFromBot({
        telegramUsername,
        locale,
        displayName: displayNameFromNameParts(from.first_name, from.last_name),
        authProvider: 'telegram',
        loginSubject: String(from.id),
        telegramUsernameActual: telegramUsername,
        providerUsername: telegramUsername,
        telegramUserId: from.id,
      });
    } catch (err) {
      appError('[bot]', 'upsert_user_failed', undefined, err);
    }
  }

  bot.command('start', async (ctx: Context) => {
    await handleUserUpsert(ctx);
    await ctx.reply("That's @HyperlinksSpaceBot, you can use AI in bot and explore the app for more features");
  });

  bot.on('message:text', async (ctx: Context) => {
    await handleUserUpsert(ctx);
    await handleBotAiResponse(ctx);
  });

  bot.on('message:caption', async (ctx: Context) => {
    await handleUserUpsert(ctx);
    await handleBotAiResponse(ctx);
  });

  bot.catch((err) => {
    appError('[bot]', 'unhandled_error', undefined, err);
  });

  return bot;
}
