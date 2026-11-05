import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { getEnv } from "./env";

const PREFIX = "v1:";

function resolveKey(key?: Buffer): Buffer {
  const k = key ?? Buffer.from(getEnv().ENCRYPTION_KEY, "base64");
  if (k.length !== 32) throw new Error("Encryption key must be 32 bytes");
  return k;
}

export function encrypt(plain: string, key?: Buffer): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", resolveKey(key), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return PREFIX + Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
}

export function decrypt(enc: string, key?: Buffer): string {
  if (!enc.startsWith(PREFIX)) throw new Error("Unsupported ciphertext version");
  const k = resolveKey(key);
  const buf = Buffer.from(enc.slice(PREFIX.length), "base64");
  if (buf.length < 28) throw new Error("Ciphertext too short");
  const d = createDecipheriv("aes-256-gcm", k, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8");
}

export function reencrypt(enc: string, oldKey: Buffer, newKey: Buffer): string {
  return encrypt(decrypt(enc, oldKey), newKey);
}

/** Rotation step: null = already on the new key (skip); throws if neither key decrypts it. */
export function skipOrReencrypt(enc: string, oldKey: Buffer, newKey: Buffer): string | null {
  try {
    decrypt(enc, newKey);
    return null;
  } catch {
    return reencrypt(enc, oldKey, newKey);
  }
}

// Later tasks append { model, field } for every encrypted DB column; rotate-key.ts walks this.
export const ENCRYPTED_COLUMNS: Array<{ model: string; field: string }> = [
  { model: "EmailAccount", field: "credentialsEnc" },
  { model: "OAuthSession", field: "codeVerifierEnc" },
  { model: "Workspace", field: "verifierConfigEnc" },
  { model: "Webhook", field: "secretEnc" },
  { model: "Webhook", field: "headersEnc" },
  { model: "Webhook", field: "urlEnc" },
  { model: "Workspace", field: "aiConfigEnc" },
  { model: "Workspace", field: "apolloConfigEnc" },
];
