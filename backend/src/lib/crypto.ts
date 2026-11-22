import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const AES_ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const INVITE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

function parseEncryptionKey(keyHex: string): Buffer {
  const normalized = keyHex.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new Error("ENCRYPTION_KEY must be a 64-character hex string (32 bytes)");
  }
  return Buffer.from(normalized, "hex");
}

export function encryptApiKey(plaintext: string, keyHex: string): string {
  const key = parseEncryptionKey(keyHex);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(AES_ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

export function decryptApiKey(payload: string, keyHex: string): string {
  const key = parseEncryptionKey(keyHex);
  const parts = payload.split(":");
  if (parts.length !== 3) {
    throw new Error("Malformed encrypted API key payload");
  }
  const [ivHex, tagHex, ciphertextHex] = parts;
  const iv = Buffer.from(ivHex, "hex");
  const tag = Buffer.from(tagHex, "hex");
  const ciphertext = Buffer.from(ciphertextHex, "hex");
  if (iv.length !== IV_LENGTH || tag.length !== AUTH_TAG_LENGTH) {
    throw new Error("Invalid IV or auth tag length");
  }
  const decipher = createDecipheriv(AES_ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString("utf8");
}

export function normalizePanelUrl(panelUrl: string): string {
  const url = new URL(panelUrl.trim());
  return url.origin.toLowerCase();
}

export function computeServerHash(panelUrl: string, serverId: string): string {
  const normalized = `${normalizePanelUrl(panelUrl)}:${serverId.trim().toLowerCase()}`;
  return createHash("sha256").update(normalized).digest("hex");
}

export function generateNonce(): string {
  return randomBytes(20).toString("hex");
}

export function generateInviteCode(length = 5): string {
  const bytes = randomBytes(length);
  let suffix = "";
  for (let i = 0; i < length; i++) {
    suffix += INVITE_ALPHABET[bytes[i] % INVITE_ALPHABET.length];
  }
  return `SLM-${suffix}`;
}
