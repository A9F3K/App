import { randomInt, timingSafeEqual } from "crypto";
import { normalizeUsername } from "../../database/users.js";
import { appLogEvent, appWarn } from "../../shared/appLog.js";
import { randomUrlSafe, sha256Hex } from "./telegram-oidc.js";

export const EMAIL_OTP_TTL_MS = 15 * 60 * 1000;
export const EMAIL_OTP_REDIRECT_URI = "email-otp";
const EMAIL_OTP_LENGTH = 6;

export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

export function generateEmailOtp(): string {
  return String(randomInt(10 ** (EMAIL_OTP_LENGTH - 1), 10 ** EMAIL_OTP_LENGTH));
}

export function hashEmailOtp(code: string): string {
  return sha256Hex(code.trim());
}

export function verifyEmailOtpHash(storedHash: string, code: string): boolean {
  const computed = hashEmailOtp(code);
  if (storedHash.length !== computed.length) return false;
  return timingSafeEqual(Buffer.from(storedHash), Buffer.from(computed));
}

export function resolveEmailUsername(email: string): string {
  return normalizeUsername(`email_${sha256Hex(email).slice(0, 24)}`);
}

export function createEmailAttemptId(): string {
  return `${Date.now()}-${randomUrlSafe(12)}`;
}

export function emailDisplayNameFromAddress(email: string): string {
  const local = email.split("@")[0]?.trim() ?? email;
  return local.length > 0 ? local : email;
}

export async function sendEmailOtp(input: {
  to: string;
  code: string;
  expiresMinutes: number;
}): Promise<{ delivered: boolean; devLogged?: boolean }> {
  const apiKey = process.env.RESEND_API_KEY?.trim() ?? "";
  const from = process.env.AUTH_EMAIL_FROM?.trim() ?? "";
  const appName = process.env.AUTH_EMAIL_APP_NAME?.trim() || "Hyperlinks Space Program";

  if (!apiKey || !from) {
    appWarn("[email-auth]", "delivery_skipped_missing_config", {
      hasApiKey: Boolean(apiKey),
      hasFrom: Boolean(from),
      toDomain: input.to.split("@")[1] ?? null,
    });
    appLogEvent("[email-auth]", {
      event: "dev_otp",
      to: input.to,
      code: input.code,
      expiresMinutes: input.expiresMinutes,
    });
    return { delivered: false, devLogged: true };
  }

  const subject = `${appName} sign-in code`;
  const text = [
    `Your ${appName} sign-in code is: ${input.code}`,
    "",
    `It expires in ${input.expiresMinutes} minutes.`,
    "",
    "If you did not request this, you can ignore this email.",
  ].join("\n");

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [input.to],
      subject,
      text,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`resend_http_${response.status}:${body.slice(0, 200)}`);
  }

  return { delivered: true };
}
