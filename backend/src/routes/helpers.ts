import type { Context } from "hono";
import type { AppEnv } from "../context.js";
import type { SealmDoc } from "../db/types.js";
import { decryptApiKey } from "../lib/crypto.js";
import { PteroAuthError } from "../lib/ptero.js";

export type SealmRole = "owner" | "operator" | "member" | "none";

export function getUserRole(sealm: SealmDoc, userUuid: string): SealmRole {
  const norm = userUuid.toLowerCase();
  if (sealm.ownerUuid.toLowerCase() === norm) {
    return "owner";
  }
  const member = sealm.members.find((m) => m.uuid.toLowerCase() === norm && m.accepted);
  if (!member) return "none";
  return member.operator ? "operator" : "member";
}

export async function findSealmByNumericId(
  c: Context<AppEnv>,
  idParam: string
): Promise<SealmDoc | null> {
  const numericId = Number.parseInt(idParam, 10);
  if (!Number.isFinite(numericId) || numericId <= 0) {
    return null;
  }
  const { getCollections } = c.get("deps");
  const { sealms } = await getCollections();
  return sealms.findOne({ numericId });
}

export async function withPteroKey<T>(
  c: Context<AppEnv>,
  sealm: SealmDoc,
  fn: (apiKey: string) => Promise<T>
): Promise<T> {
  const { config, getCollections } = c.get("deps");
  const apiKey = decryptApiKey(sealm.ptero.encryptedApiKey, config.encryptionKey);
  try {
    const result = await fn(apiKey);
    if (sealm.ptero.credentialsInvalid) {
      const { sealms } = await getCollections();
      await sealms.updateOne(
        { numericId: sealm.numericId },
        { $set: { "ptero.credentialsInvalid": false } }
      );
    }
    return result;
  } catch (err) {
    if (err instanceof PteroAuthError) {
      const { sealms } = await getCollections();
      await sealms.updateOne(
        { numericId: sealm.numericId },
        { $set: { "ptero.credentialsInvalid": true } }
      );
    }
    throw err;
  }
}

export function extractInviteCode(input: string): string {
  const trimmed = input.trim();
  const urlMatch = trimmed.match(/\/invite\/([A-Za-z0-9-]+)(?:[/?#]|$)/i);
  if (urlMatch) {
    return urlMatch[1].toUpperCase();
  }
  return trimmed.toUpperCase();
}
