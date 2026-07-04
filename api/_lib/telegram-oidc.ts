import crypto from "crypto";

const TELEGRAM_ISSUER = "https://oauth.telegram.org";
const DISCOVERY_URL = "https://oauth.telegram.org/.well-known/openid-configuration";
const JWKS_URL = "https://oauth.telegram.org/.well-known/jwks.json";
const TOKEN_URL = "https://oauth.telegram.org/token";
const AUTH_URL = "https://oauth.telegram.org/auth";

type Jwk = {
  kid?: string;
  kty?: string;
  alg?: string;
  n?: string;
  e?: string;
  x?: string;
  y?: string;
  crv?: string;
};

type JwksResponse = { keys?: Jwk[] };

type TelegramIdTokenClaims = {
  iss: string;
  aud: string | string[];
  sub: string;
  exp: number;
  iat: number;
  nonce?: string;
  id?: number | string;
  name?: string;
  preferred_username?: string;
  picture?: string;
  phone_number?: string;
};

let jwksCache: { keys: Jwk[]; fetchedAtMs: number } | null = null;
const JWKS_CACHE_TTL_MS = 5 * 60 * 1000;

function base64UrlEncode(input: Buffer): string {
  return input
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlDecode(input: string): Buffer {
  const s = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  return Buffer.from(s + pad, "base64");
}

export function randomUrlSafe(size = 32): string {
  return base64UrlEncode(crypto.randomBytes(size));
}

export function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function sha256Base64Url(input: string): string {
  return base64UrlEncode(crypto.createHash("sha256").update(input).digest());
}

export function resolveTelegramBotId(): string {
  const fromEnv = process.env.TELEGRAM_CLIENT_ID?.trim() ?? "";
  if (/^\d+$/.test(fromEnv)) return fromEnv;
  const fromToken = process.env.BOT_TOKEN?.split(":")[0]?.trim() ?? "";
  if (/^\d+$/.test(fromToken)) return fromToken;
  return fromEnv || fromToken;
}

export function buildTelegramAuthorizeUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  codeChallenge: string;
}): string {
  const botId = input.clientId.trim();
  const url = new URL(AUTH_URL);
  // OIDC spec uses client_id; Telegram's authorize UI also requires bot_id (numeric bot id).
  url.searchParams.set("client_id", botId);
  url.searchParams.set("bot_id", botId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid profile phone");
  url.searchParams.set("state", input.state);
  url.searchParams.set("nonce", input.nonce);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

async function fetchJwks(): Promise<Jwk[]> {
  const now = Date.now();
  if (jwksCache && now - jwksCache.fetchedAtMs < JWKS_CACHE_TTL_MS) {
    return jwksCache.keys;
  }
  const res = await fetch(JWKS_URL, { method: "GET" });
  if (!res.ok) {
    throw new Error(`jwks_fetch_failed_${res.status}`);
  }
  const data = (await res.json()) as JwksResponse;
  const keys = Array.isArray(data.keys) ? data.keys : [];
  if (keys.length === 0) {
    throw new Error("jwks_empty");
  }
  jwksCache = { keys, fetchedAtMs: now };
  return keys;
}

function parseJwt(token: string): {
  header: Record<string, unknown>;
  payload: TelegramIdTokenClaims;
  signingInput: Buffer;
  signature: Buffer;
} {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("jwt_format_invalid");
  }
  const [h, p, s] = parts;
  const header = JSON.parse(base64UrlDecode(h).toString("utf8")) as Record<string, unknown>;
  const payload = JSON.parse(base64UrlDecode(p).toString("utf8")) as TelegramIdTokenClaims;
  return {
    header,
    payload,
    signingInput: Buffer.from(`${h}.${p}`, "utf8"),
    signature: base64UrlDecode(s),
  };
}

function verifyJwtSignature(input: {
  alg: string;
  signingInput: Buffer;
  signature: Buffer;
  jwk: Jwk;
}): boolean {
  const keyObject = crypto.createPublicKey({ key: input.jwk as any, format: "jwk" });
  if (input.alg === "RS256") {
    return crypto.verify("RSA-SHA256", input.signingInput, keyObject, input.signature);
  }
  if (input.alg === "ES256") {
    return crypto.verify("sha256", input.signingInput, keyObject, input.signature);
  }
  throw new Error(`unsupported_alg_${input.alg}`);
}

function assertTokenClaims(input: {
  claims: TelegramIdTokenClaims;
  clientId: string;
  expectedNonce?: string;
}): void {
  const { claims, clientId, expectedNonce } = input;
  if (claims.iss !== TELEGRAM_ISSUER) throw new Error("invalid_iss");
  const audRaw = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  const aud = audRaw.map((v) => String(v));
  if (!aud.includes(String(clientId))) throw new Error("invalid_aud");
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(claims.exp) || claims.exp < now - 120) throw new Error("token_expired");
  if (!Number.isFinite(claims.iat) || claims.iat > now + 120) throw new Error("invalid_iat");
  if (expectedNonce != null && expectedNonce.length > 0) {
    if (!claims.nonce || claims.nonce !== expectedNonce) throw new Error("invalid_nonce");
  }
  if (!claims.sub || typeof claims.sub !== "string") throw new Error("missing_sub");
}

export async function exchangeCodeForTokens(input: {
  code: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
  codeVerifier: string;
}): Promise<{ id_token: string; access_token?: string; expires_in?: number }> {
  const body = new URLSearchParams();
  body.set("grant_type", "authorization_code");
  body.set("code", input.code);
  body.set("redirect_uri", input.redirectUri);
  body.set("client_id", input.clientId);
  body.set("code_verifier", input.codeVerifier);

  const basic = Buffer.from(`${input.clientId}:${input.clientSecret}`, "utf8").toString("base64");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basic}`,
    },
    body: body.toString(),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const err = typeof json.error === "string" ? json.error : "";
    const errDesc = typeof json.error_description === "string" ? json.error_description : "";
    const detail = [err, errDesc].filter(Boolean).join(": ");
    throw new Error(detail || `token_exchange_failed_${res.status}`);
  }
  const idToken = typeof json.id_token === "string" ? json.id_token : "";
  if (!idToken) throw new Error("missing_id_token");
  return {
    id_token: idToken,
    access_token: typeof json.access_token === "string" ? json.access_token : undefined,
    expires_in: typeof json.expires_in === "number" ? json.expires_in : undefined,
  };
}

export async function validateTelegramIdToken(input: {
  idToken: string;
  clientId: string;
  expectedNonce?: string;
}): Promise<TelegramIdTokenClaims> {
  const parsed = parseJwt(input.idToken);
  const alg = typeof parsed.header.alg === "string" ? parsed.header.alg : "";
  const kid = typeof parsed.header.kid === "string" ? parsed.header.kid : "";
  if (!alg || !kid) throw new Error("jwt_header_invalid");

  const keys = await fetchJwks();
  const key = keys.find((k) => k.kid === kid);
  if (!key) {
    jwksCache = null;
    const fresh = await fetchJwks();
    const refreshed = fresh.find((k) => k.kid === kid);
    if (!refreshed) throw new Error("unknown_kid");
    if (!verifyJwtSignature({ alg, signingInput: parsed.signingInput, signature: parsed.signature, jwk: refreshed })) {
      throw new Error("invalid_signature");
    }
  } else if (
    !verifyJwtSignature({ alg, signingInput: parsed.signingInput, signature: parsed.signature, jwk: key })
  ) {
    throw new Error("invalid_signature");
  }

  assertTokenClaims({ claims: parsed.payload, clientId: input.clientId, expectedNonce: input.expectedNonce });
  return parsed.payload;
}

export async function fetchOidcDiscovery(): Promise<Record<string, unknown>> {
  const res = await fetch(DISCOVERY_URL);
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

