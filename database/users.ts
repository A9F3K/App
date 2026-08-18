/**
 * User helpers for the users table. Shared by API routes and bot.
 * Import from ../database/users.js (e.g. from api/, telegram/, bot/).
 */
import { randomInt } from "crypto";
import { sql } from "./start.js";

const DISPLAY_FIRST_NAMES = [
  "Avery",
  "Blake",
  "Casey",
  "Drew",
  "Ellis",
  "Finley",
  "Gray",
  "Harper",
  "Jordan",
  "Kai",
  "Logan",
  "Morgan",
  "Noel",
  "Parker",
  "Quinn",
  "Reese",
  "Rowan",
  "Sage",
  "Taylor",
  "Vale",
] as const;

const DISPLAY_LAST_NAMES = [
  "Ashford",
  "Bennett",
  "Caldwell",
  "Donovan",
  "Ellison",
  "Fairchild",
  "Grayson",
  "Holloway",
  "Iverson",
  "Jennings",
  "Kensington",
  "Langford",
  "Mercer",
  "Northcott",
  "Oakley",
  "Prescott",
  "Redfield",
  "Sterling",
  "Thornton",
  "Whitmore",
  "Yardley",
  "Zimmerman",
] as const;

export function normalizeUsername(raw: unknown): string {
  if (typeof raw !== "string") return "";
  let s = raw.trim();
  if (s.startsWith("@")) s = s.slice(1);
  return s.toLowerCase();
}

/** Human-readable profile label shown in the app header (not the Telegram handle). */
export function generateRandomDisplayName(): string {
  const first = DISPLAY_FIRST_NAMES[randomInt(DISPLAY_FIRST_NAMES.length)]!;
  const last = DISPLAY_LAST_NAMES[randomInt(DISPLAY_LAST_NAMES.length)]!;
  return `${first} ${last}`;
}

type UserUpsertRow = { display_name: string | null };

export type UserAuthProfileInput = {
  telegramUsername: string;
  locale?: string | null;
  email?: string | null;
  displayName?: string | null;
  pictureUrl?: string | null;
  phoneNumber?: string | null;
  authProvider?: string | null;
  loginSubject?: string | null;
  telegramUsernameActual?: string | null;
  providerUsername?: string | null;
  telegramUserId?: string | number | null;
  /** TMA visits update last_tma_seen_at; other sign-ins update last_login_at. */
  seenVia?: "tma" | "login";
};

function optionalText(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function displayNameFromNameParts(
  firstName?: string | null,
  lastName?: string | null,
): string | null {
  const parts = [optionalText(firstName), optionalText(lastName)].filter(
    (part): part is string => Boolean(part),
  );
  return parts.length > 0 ? parts.join(" ") : null;
}

async function readDisplayNameRow(telegramUsername: string): Promise<string | null> {
  const rows = (await sql`
    SELECT display_name FROM users WHERE telegram_username = ${telegramUsername} LIMIT 1;
  `) as UserUpsertRow[];
  const name = rows[0]?.display_name;
  return typeof name === "string" && name.trim().length > 0 ? name.trim() : null;
}

/** Ensures a display name exists; backfills legacy rows that predate the column. */
export async function getDisplayNameForUsername(telegramUsername: string): Promise<string> {
  const existing = await readDisplayNameRow(telegramUsername);
  if (existing) return existing;

  const generated = generateRandomDisplayName();
  await sql`
    UPDATE users
    SET display_name = ${generated}, updated_at = NOW()
    WHERE telegram_username = ${telegramUsername}
      AND (display_name IS NULL OR TRIM(display_name) = '');
  `;
  return (await readDisplayNameRow(telegramUsername)) ?? generated;
}

async function upsertUserProfile(opts: UserAuthProfileInput): Promise<{ displayName: string } | null> {
  const telegramUsername = optionalText(opts.telegramUsername);
  if (!telegramUsername) return null;

  const locale = optionalText(opts.locale);
  const email = optionalText(opts.email)?.toLowerCase() ?? null;
  const providedDisplayName = optionalText(opts.displayName);
  const pictureUrl = optionalText(opts.pictureUrl);
  const phoneNumber = optionalText(opts.phoneNumber);
  const authProvider = optionalText(opts.authProvider);
  const loginSubject = optionalText(opts.loginSubject);
  const telegramUsernameActual = optionalText(opts.telegramUsernameActual);
  const providerUsername = optionalText(opts.providerUsername);
  const telegramUserId =
    opts.telegramUserId == null || opts.telegramUserId === ""
      ? null
      : String(opts.telegramUserId);
  const insertDisplayName = providedDisplayName ?? generateRandomDisplayName();
  const touchTma = opts.seenVia !== "login";
  const touchLogin = opts.seenVia === "login";
  const tmaSeenAt = touchTma ? new Date().toISOString() : null;
  const loginAt = touchLogin ? new Date().toISOString() : null;

  const rows = (await sql`
    INSERT INTO users (
      telegram_username,
      user_key,
      display_name,
      locale,
      email,
      picture_url,
      phone_number,
      auth_provider,
      login_subject,
      telegram_username_actual,
      provider_username,
      telegram_user_id,
      created_at,
      updated_at,
      last_tma_seen_at,
      last_login_at
    )
    VALUES (
      ${telegramUsername},
      ${telegramUsername},
      ${insertDisplayName},
      ${locale},
      ${email},
      ${pictureUrl},
      ${phoneNumber},
      ${authProvider},
      ${loginSubject},
      ${telegramUsernameActual},
      ${providerUsername},
      ${telegramUserId},
      NOW(),
      NOW(),
      ${tmaSeenAt}::timestamptz,
      ${loginAt}::timestamptz
    )
    ON CONFLICT (telegram_username) DO UPDATE
      SET user_key = COALESCE(users.user_key, EXCLUDED.user_key),
          locale = COALESCE(EXCLUDED.locale, users.locale),
          email = COALESCE(users.email, EXCLUDED.email),
          picture_url = COALESCE(users.picture_url, EXCLUDED.picture_url),
          phone_number = COALESCE(users.phone_number, EXCLUDED.phone_number),
          auth_provider = COALESCE(users.auth_provider, EXCLUDED.auth_provider),
          login_subject = COALESCE(users.login_subject, EXCLUDED.login_subject),
          telegram_username_actual = COALESCE(users.telegram_username_actual, EXCLUDED.telegram_username_actual),
          provider_username = COALESCE(users.provider_username, EXCLUDED.provider_username),
          telegram_user_id = COALESCE(users.telegram_user_id, EXCLUDED.telegram_user_id),
          last_tma_seen_at = COALESCE(${tmaSeenAt}::timestamptz, users.last_tma_seen_at),
          last_login_at = COALESCE(${loginAt}::timestamptz, users.last_login_at),
          updated_at = NOW()
    RETURNING display_name;
  `) as UserUpsertRow[];

  const displayName = rows[0]?.display_name;
  if (typeof displayName === "string" && displayName.trim().length > 0) {
    return { displayName: displayName.trim() };
  }
  return { displayName: await getDisplayNameForUsername(telegramUsername) };
}

export async function upsertUserFromTma(
  opts: UserAuthProfileInput & { locale: string | null },
): Promise<{ displayName: string } | null> {
  return upsertUserProfile({
    ...opts,
    seenVia: opts.seenVia ?? "tma",
  });
}

export async function upsertUserFromBot(
  opts: UserAuthProfileInput & { locale: string | null },
): Promise<{ displayName: string } | null> {
  return upsertUserProfile({
    ...opts,
    authProvider: opts.authProvider ?? "telegram",
    seenVia: "login",
  });
}
