import { kmsDecrypt } from "./envelope-crypto.js";
import { decryptWalletPayloadAesGcmV1 } from "./wallet-envelope-payload.js";
import type { WalletRow } from "../../database/wallets.js";

function safeB64ToBuffer(label: string, value: string): Buffer {
  const t = value.trim();
  if (!t) throw new Error(`missing_${label}`);
  try {
    return Buffer.from(t, "base64");
  } catch {
    throw new Error(`invalid_${label}_base64`);
  }
}

/** Unwrap KMS envelope from a wallets row → 24-word mnemonic. Never log the mnemonic. */
export async function unwrapMnemonicFromWalletRow(wallet: WalletRow): Promise<string[]> {
  const ctB64 = wallet.envelope_ciphertext?.trim() ?? "";
  const nonceB64 = wallet.envelope_nonce?.trim() ?? "";
  const wrappedB64 = wallet.wrapped_dek?.trim() ?? "";
  if (!ctB64 || !nonceB64 || !wrappedB64) {
    throw new Error("wallet_row_missing_envelope");
  }

  const nonce = safeB64ToBuffer("envelope_nonce", nonceB64);
  const ct = safeB64ToBuffer("envelope_ciphertext", ctB64);
  const wrapped = safeB64ToBuffer("wrapped_dek", wrappedB64);

  const dek = await kmsDecrypt(wrapped);
  if (dek.length !== 32) {
    throw new Error("kms_unwrap_bad_dek_len");
  }

  const plain = decryptWalletPayloadAesGcmV1(dek, nonce, ct);
  let parsed: { v?: number; m?: string };
  try {
    parsed = JSON.parse(plain.toString("utf8")) as { v?: number; m?: string };
  } catch {
    throw new Error("plaintext_not_json");
  }

  const mnemonic = typeof parsed.m === "string" ? parsed.m.trim() : "";
  const words = mnemonic.split(/\s+/).filter(Boolean);
  if (parsed.v !== 1 || words.length < 12) {
    throw new Error("invalid_mnemonic_payload");
  }
  return words;
}
