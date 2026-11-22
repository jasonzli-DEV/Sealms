import { MongoClient, type Collection, type Db } from "mongodb";
import type {
  AuthNonceDoc,
  BlockedOwnerDoc,
  CounterDoc,
  InviteCodeDoc,
  SealmDoc,
} from "./types.js";

export interface SealmsCollections {
  sealms: Collection<SealmDoc>;
  authNonces: Collection<AuthNonceDoc>;
  invites: Collection<InviteCodeDoc>;
  blockedOwners: Collection<BlockedOwnerDoc>;
  counters: Collection<CounterDoc>;
}

let cachedClient: MongoClient | null = null;
let cachedDb: Db | null = null;
let indexesEnsured = false;

export async function getDb(uri: string, dbName: string): Promise<Db> {
  if (cachedDb) {
    return cachedDb;
  }
  if (!uri) {
    throw new Error("MONGODB_URI is not configured");
  }
  if (!cachedClient) {
    cachedClient = new MongoClient(uri, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5000,
    });
    await cachedClient.connect();
  }
  cachedDb = cachedClient.db(dbName);
  if (!indexesEnsured) {
    await ensureIndexes(cachedDb);
    indexesEnsured = true;
  }
  return cachedDb;
}

export function getCollections(db: Db): SealmsCollections {
  return {
    sealms: db.collection<SealmDoc>("sealms"),
    authNonces: db.collection<AuthNonceDoc>("auth_nonces"),
    invites: db.collection<InviteCodeDoc>("invites"),
    blockedOwners: db.collection<BlockedOwnerDoc>("blocked_owners"),
    counters: db.collection<CounterDoc>("counters"),
  };
}

export async function ensureIndexes(db: Db): Promise<void> {
  const { sealms, authNonces, invites, blockedOwners } = getCollections(db);

  await Promise.all([
    sealms.createIndex({ numericId: 1 }, { unique: true }),
    sealms.createIndex({ "ptero.serverHash": 1 }, { unique: true }),
    sealms.createIndex({ ownerUuid: 1 }),
    sealms.createIndex({ "members.uuid": 1 }),

    authNonces.createIndex({ nonce: 1 }, { unique: true }),
    authNonces.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),

    invites.createIndex({ code: 1 }, { unique: true }),
    invites.createIndex({ sealmId: 1 }),
    invites.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),

    blockedOwners.createIndex({ playerUuid: 1, blockedOwnerUuid: 1 }, { unique: true }),
  ]);
}

export async function getNextNumericId(counters: Collection<CounterDoc>): Promise<number> {
  const result = await counters.findOneAndUpdate(
    { _id: "sealm_numeric_id" },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: "after" }
  );
  return result?.seq ?? 1;
}

export async function closeDb(): Promise<void> {
  if (cachedClient) {
    await cachedClient.close();
    cachedClient = null;
    cachedDb = null;
    indexesEnsured = false;
  }
}
