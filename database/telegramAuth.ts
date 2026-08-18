import { sql } from "./start.js";

export type AuthProvider = "telegram" | "google" | "github" | "apple" | "email";

export type LoginAttemptStatus = "created" | "consumed" | "expired" | "failed";

export type TelegramSessionRow = {
  telegram_username: string;
  expires_at: string;
};

export async function createLoginAttempt(input: {
  id: string;
  provider: AuthProvider;
  stateHash: string;
  nonceHash: string;
  pkceVerifier: string;
  redirectUri: string;
  expiresAtIso: string;
  ip: string | null;
  userAgent: string | null;
}): Promise<void> {
  await sql`
    INSERT INTO auth_login_attempts (
      id, provider, state_hash, nonce_hash, pkce_verifier, redirect_uri, status, ip, user_agent, expires_at
    )
    VALUES (
      ${input.id},
      ${input.provider},
      ${input.stateHash},
      ${input.nonceHash},
      ${input.pkceVerifier},
      ${input.redirectUri},
      'created',
      ${input.ip},
      ${input.userAgent},
      ${input.expiresAtIso}::timestamptz
    );
  `;
}

export async function getLoginAttemptById(id: string): Promise<
  | {
      id: string;
      nonce_hash: string;
      pkce_verifier: string;
      redirect_uri: string;
      status: LoginAttemptStatus;
      expires_at: string;
    }
  | null
> {
  type LoginAttemptRow = {
    id: string;
    nonce_hash: string;
    pkce_verifier: string;
    redirect_uri: string;
    status: LoginAttemptStatus;
    expires_at: string;
  };
  const rows = (await sql`
    SELECT id, nonce_hash, pkce_verifier, redirect_uri, status, expires_at
    FROM auth_login_attempts
    WHERE id = ${id}
    LIMIT 1;
  `) as LoginAttemptRow[];
  return rows[0] ?? null;
}

export async function countRecentEmailLoginStarts(input: {
  ip: string | null;
  email: string;
  windowMinutes: number;
}): Promise<number> {
  const windowMinutes = Math.max(1, Math.min(input.windowMinutes, 24 * 60));
  type CountRow = { count: string };
  const rows = (await sql`
    SELECT COUNT(*)::text AS count
    FROM auth_login_attempts
    WHERE provider = 'email'
      AND created_at > NOW() - (${windowMinutes}::int * INTERVAL '1 minute')
      AND (
        (${input.ip}::text IS NOT NULL AND ip = ${input.ip})
        OR pkce_verifier = ${input.email}
      );
  `) as CountRow[];
  return Number(rows[0]?.count ?? "0");
}

export async function getLoginAttemptByStateHash(stateHash: string): Promise<
  | {
      id: string;
      nonce_hash: string;
      pkce_verifier: string;
      redirect_uri: string;
      status: LoginAttemptStatus;
      expires_at: string;
    }
  | null
> {
  type LoginAttemptRow = {
    id: string;
    nonce_hash: string;
    pkce_verifier: string;
    redirect_uri: string;
    status: LoginAttemptStatus;
    expires_at: string;
  };
  const rows = (await sql`
    SELECT id, nonce_hash, pkce_verifier, redirect_uri, status, expires_at
    FROM auth_login_attempts
    WHERE state_hash = ${stateHash}
    LIMIT 1;
  `) as LoginAttemptRow[];
  return rows[0] ?? null;
}

export async function markLoginAttemptStatus(input: {
  id: string;
  status: LoginAttemptStatus;
  errorCode?: string | null;
}): Promise<void> {
  const consumedAt = input.status === "consumed" ? new Date().toISOString() : null;
  await sql`
    UPDATE auth_login_attempts
    SET status = ${input.status},
        error_code = ${input.errorCode ?? null},
        consumed_at = ${consumedAt}::timestamptz
    WHERE id = ${input.id};
  `;
}

export async function logLoginEvent(input: {
  attemptId: string | null;
  provider: AuthProvider;
  eventType: string;
  telegramUsername?: string | null;
  providerSubject?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  metaJson?: Record<string, unknown> | null;
}): Promise<void> {
  await sql`
    INSERT INTO auth_login_events (
      attempt_id, provider, event_type, telegram_username, provider_subject, ip, user_agent, meta_json
    )
    VALUES (
      ${input.attemptId},
      ${input.provider},
      ${input.eventType},
      ${input.telegramUsername ?? null},
      ${input.providerSubject ?? null},
      ${input.ip ?? null},
      ${input.userAgent ?? null},
      ${input.metaJson ? JSON.stringify(input.metaJson) : null}::jsonb
    );
  `;
}

export async function upsertTelegramIdentity(input: {
  providerSubject: string;
  telegramUsername: string;
  telegramId: string | null;
  username: string | null;
  displayName: string | null;
  pictureUrl: string | null;
  phoneNumber: string | null;
  claimsVersion: string | null;
  email?: string | null;
}): Promise<void> {
  await sql`
    INSERT INTO auth_identities (
      provider,
      provider_subject,
      telegram_username,
      telegram_id,
      username,
      email,
      display_name,
      picture_url,
      phone_number,
      claims_version,
      created_at,
      updated_at,
      last_login_at
    )
    VALUES (
      'telegram',
      ${input.providerSubject},
      ${input.telegramUsername},
      ${input.telegramId},
      ${input.username},
      ${input.email ?? null},
      ${input.displayName},
      ${input.pictureUrl},
      ${input.phoneNumber},
      ${input.claimsVersion},
      NOW(),
      NOW(),
      NOW()
    )
    ON CONFLICT (provider, provider_subject) DO UPDATE
      SET telegram_username = EXCLUDED.telegram_username,
          telegram_id = COALESCE(EXCLUDED.telegram_id, auth_identities.telegram_id),
          username = COALESCE(EXCLUDED.username, auth_identities.username),
          email = COALESCE(auth_identities.email, EXCLUDED.email),
          display_name = COALESCE(EXCLUDED.display_name, auth_identities.display_name),
          picture_url = COALESCE(EXCLUDED.picture_url, auth_identities.picture_url),
          phone_number = COALESCE(EXCLUDED.phone_number, auth_identities.phone_number),
          claims_version = EXCLUDED.claims_version,
          updated_at = NOW(),
          last_login_at = NOW();
  `;
}

export async function upsertGoogleIdentity(input: {
  providerSubject: string;
  telegramUsername: string;
  email: string | null;
  displayName: string | null;
  pictureUrl: string | null;
  claimsVersion: string | null;
}): Promise<void> {
  await sql`
    INSERT INTO auth_identities (
      provider,
      provider_subject,
      telegram_username,
      telegram_id,
      username,
      email,
      display_name,
      picture_url,
      phone_number,
      claims_version,
      created_at,
      updated_at,
      last_login_at
    )
    VALUES (
      'google',
      ${input.providerSubject},
      ${input.telegramUsername},
      NULL,
      ${input.email},
      ${input.email},
      ${input.displayName},
      ${input.pictureUrl},
      NULL,
      ${input.claimsVersion},
      NOW(),
      NOW(),
      NOW()
    )
    ON CONFLICT (provider, provider_subject) DO UPDATE
      SET telegram_username = EXCLUDED.telegram_username,
          username = COALESCE(auth_identities.username, EXCLUDED.username),
          email = COALESCE(auth_identities.email, EXCLUDED.email),
          display_name = COALESCE(EXCLUDED.display_name, auth_identities.display_name),
          picture_url = COALESCE(EXCLUDED.picture_url, auth_identities.picture_url),
          claims_version = EXCLUDED.claims_version,
          updated_at = NOW(),
          last_login_at = NOW();
  `;
}

export async function upsertGithubIdentity(input: {
  providerSubject: string;
  telegramUsername: string;
  login: string;
  email: string | null;
  displayName: string | null;
  pictureUrl: string | null;
  claimsVersion: string | null;
}): Promise<void> {
  await sql`
    INSERT INTO auth_identities (
      provider,
      provider_subject,
      telegram_username,
      telegram_id,
      username,
      email,
      display_name,
      picture_url,
      phone_number,
      claims_version,
      created_at,
      updated_at,
      last_login_at
    )
    VALUES (
      'github',
      ${input.providerSubject},
      ${input.telegramUsername},
      NULL,
      ${input.login},
      ${input.email},
      ${input.displayName},
      ${input.pictureUrl},
      NULL,
      ${input.claimsVersion},
      NOW(),
      NOW(),
      NOW()
    )
    ON CONFLICT (provider, provider_subject) DO UPDATE
      SET telegram_username = EXCLUDED.telegram_username,
          username = COALESCE(auth_identities.username, EXCLUDED.username),
          email = COALESCE(auth_identities.email, EXCLUDED.email),
          display_name = COALESCE(EXCLUDED.display_name, auth_identities.display_name),
          picture_url = COALESCE(EXCLUDED.picture_url, auth_identities.picture_url),
          claims_version = EXCLUDED.claims_version,
          updated_at = NOW(),
          last_login_at = NOW();
  `;
}

export async function upsertEmailIdentity(input: {
  providerSubject: string;
  telegramUsername: string;
  email: string;
  displayName: string | null;
  claimsVersion: string | null;
}): Promise<void> {
  await sql`
    INSERT INTO auth_identities (
      provider,
      provider_subject,
      telegram_username,
      telegram_id,
      username,
      email,
      display_name,
      picture_url,
      phone_number,
      claims_version,
      created_at,
      updated_at,
      last_login_at
    )
    VALUES (
      'email',
      ${input.providerSubject},
      ${input.telegramUsername},
      NULL,
      ${input.email},
      ${input.email},
      ${input.displayName},
      NULL,
      NULL,
      ${input.claimsVersion},
      NOW(),
      NOW(),
      NOW()
    )
    ON CONFLICT (provider, provider_subject) DO UPDATE
      SET telegram_username = EXCLUDED.telegram_username,
          username = COALESCE(auth_identities.username, EXCLUDED.username),
          email = COALESCE(auth_identities.email, EXCLUDED.email),
          display_name = COALESCE(EXCLUDED.display_name, auth_identities.display_name),
          claims_version = EXCLUDED.claims_version,
          updated_at = NOW(),
          last_login_at = NOW();
  `;
}

export async function upsertAppleIdentity(input: {
  providerSubject: string;
  telegramUsername: string;
  email: string | null;
  displayName: string | null;
  claimsVersion: string | null;
}): Promise<void> {
  await sql`
    INSERT INTO auth_identities (
      provider,
      provider_subject,
      telegram_username,
      telegram_id,
      username,
      email,
      display_name,
      picture_url,
      phone_number,
      claims_version,
      created_at,
      updated_at,
      last_login_at
    )
    VALUES (
      'apple',
      ${input.providerSubject},
      ${input.telegramUsername},
      NULL,
      ${input.email},
      ${input.email},
      ${input.displayName},
      NULL,
      NULL,
      ${input.claimsVersion},
      NOW(),
      NOW(),
      NOW()
    )
    ON CONFLICT (provider, provider_subject) DO UPDATE
      SET telegram_username = EXCLUDED.telegram_username,
          username = COALESCE(EXCLUDED.username, auth_identities.username),
          email = COALESCE(auth_identities.email, EXCLUDED.email),
          display_name = COALESCE(EXCLUDED.display_name, auth_identities.display_name),
          claims_version = EXCLUDED.claims_version,
          updated_at = NOW(),
          last_login_at = NOW();
  `;
}

export async function createSession(input: {
  sessionHash: string;
  telegramUsername: string;
  expiresAtIso: string;
  ip: string | null;
  userAgent: string | null;
}): Promise<void> {
  await sql`
    INSERT INTO auth_sessions (
      session_hash, telegram_username, created_at, expires_at, last_seen_at, ip, user_agent
    )
    VALUES (
      ${input.sessionHash},
      ${input.telegramUsername},
      NOW(),
      ${input.expiresAtIso}::timestamptz,
      NOW(),
      ${input.ip},
      ${input.userAgent}
    )
    ON CONFLICT (session_hash) DO UPDATE
      SET telegram_username = EXCLUDED.telegram_username,
          expires_at = EXCLUDED.expires_at,
          last_seen_at = NOW(),
          ip = EXCLUDED.ip,
          user_agent = EXCLUDED.user_agent;
  `;
}

export async function getSessionByHash(sessionHash: string): Promise<TelegramSessionRow | null> {
  const rows = (await sql`
    SELECT telegram_username, expires_at
    FROM auth_sessions
    WHERE session_hash = ${sessionHash}
    LIMIT 1;
  `) as TelegramSessionRow[];
  return rows[0] ?? null;
}

export async function touchSession(sessionHash: string): Promise<void> {
  await sql`
    UPDATE auth_sessions
    SET last_seen_at = NOW()
    WHERE session_hash = ${sessionHash};
  `;
}

export async function deleteSession(sessionHash: string): Promise<void> {
  await sql`
    DELETE FROM auth_sessions
    WHERE session_hash = ${sessionHash};
  `;
}

