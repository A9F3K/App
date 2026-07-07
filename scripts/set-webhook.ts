/**
 * Set Telegram webhook on deploy. Run during Vercel build.
 * Requires BOT_TOKEN and a base URL. Base URL is VERCEL_PROJECT_PRODUCTION_URL
 * (Vercel's production alias, e.g. hsbexpo.vercel.app) or VERCEL_URL (deployment-specific).
 */

const BOT_TOKEN = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const VERCEL_PROJECT_PRODUCTION_URL = process.env.VERCEL_PROJECT_PRODUCTION_URL;
const VERCEL_URL = process.env.VERCEL_URL;
const baseUrl =
  VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${VERCEL_PROJECT_PRODUCTION_URL}`
    : VERCEL_URL
      ? `https://${VERCEL_URL}`
      : '';

const WEBHOOK_PATH = '/api/bot';
const FETCH_TIMEOUT_MS = 15_000;
const SET_WEBHOOK_MAX_ATTEMPTS = 3;
const SET_WEBHOOK_RETRY_DELAY_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatFetchError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = err.cause;
  if (cause instanceof Error) {
    return `${err.message} (${cause.name}: ${cause.message})`;
  }
  return err.message;
}

async function postSetWebhook(
  botToken: string,
  webhookUrl: string,
): Promise<{ ok: boolean; description?: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: webhookUrl }),
      signal: controller.signal,
    });
    return (await res.json()) as { ok?: boolean; description?: string };
  } finally {
    clearTimeout(timeout);
  }
}

async function setWebhook(): Promise<void> {
  console.log(
    '[set-webhook] env: VERCEL_ENV=%s VERCEL_URL=%s VERCEL_PROJECT_PRODUCTION_URL=%s',
    process.env.VERCEL_ENV ?? '',
    VERCEL_URL ?? '(none)',
    VERCEL_PROJECT_PRODUCTION_URL ?? '(none)',
  );

  if (!BOT_TOKEN) {
    console.log('[set-webhook] Skip: BOT_TOKEN not set. Add BOT_TOKEN in Vercel → Settings → Environment Variables (Production, include in Build).');
    return;
  }

  if (!baseUrl) {
    console.log('[set-webhook] Skip: no webhook URL (VERCEL_URL / VERCEL_PROJECT_PRODUCTION_URL).');
    return;
  }

  const url = `${baseUrl}${WEBHOOK_PATH}`;
  console.log('[set-webhook] Setting webhook to:', url);

  let lastNetworkError: string | null = null;
  for (let attempt = 1; attempt <= SET_WEBHOOK_MAX_ATTEMPTS; attempt += 1) {
    try {
      const data = await postSetWebhook(BOT_TOKEN, url);
      if (data.ok) {
        console.log('[set-webhook] OK:', url);
        return;
      }

      console.error('[set-webhook] Telegram setWebhook failed:', data.description ?? data);
      process.exit(1);
    } catch (err: unknown) {
      lastNetworkError = formatFetchError(err);
      const retrying = attempt < SET_WEBHOOK_MAX_ATTEMPTS;
      console.error(
        '[set-webhook] Network error (attempt %d/%d): %s%s',
        attempt,
        SET_WEBHOOK_MAX_ATTEMPTS,
        lastNetworkError,
        retrying ? ` — retrying in ${SET_WEBHOOK_RETRY_DELAY_MS}ms` : '',
      );
      if (retrying) {
        await sleep(SET_WEBHOOK_RETRY_DELAY_MS);
      }
    }
  }

  console.warn(
    '[set-webhook] Could not reach api.telegram.org after %d attempts. Deploy will continue; re-run `npm run set-webhook` or redeploy when Telegram API is reachable.',
    SET_WEBHOOK_MAX_ATTEMPTS,
  );
  if (lastNetworkError) {
    console.warn('[set-webhook] Last error:', lastNetworkError);
  }
}

setWebhook()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error('[set-webhook] Unexpected error:', formatFetchError(err));
    process.exit(1);
  });
