export interface AppConfig {
  mongodbUri: string;
  mongodbDbName: string;
  jwtSecret: string;
  encryptionKey: string;
  upstashRedisRestUrl?: string;
  upstashRedisRestToken?: string;
  publicBaseUrl: string;
  port: number;
  maxSealmsPerOwner: number;
  maxActiveInviteCodesPerSealm: number;
  maxWhitelistImport: number;
  maxDailyPendingInvites: number;
  allowInsecureLocalPanelUrls: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const encryptionKey = env.ENCRYPTION_KEY ?? "";
  const jwtSecret = env.JWT_SECRET ?? "";
  return {
    mongodbUri: env.MONGODB_URI ?? "",
    mongodbDbName: env.MONGODB_DB_NAME || "sealms",
    jwtSecret,
    encryptionKey,
    upstashRedisRestUrl:
      env.UPSTASH_REDIS_REST_URL ||
      env.UPSTASH_REDIS_REST_KV_REST_API_URL ||
      env.KV_REST_API_URL ||
      undefined,
    upstashRedisRestToken:
      env.UPSTASH_REDIS_REST_TOKEN ||
      env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN ||
      env.KV_REST_API_TOKEN ||
      undefined,
    publicBaseUrl: (env.PUBLIC_BASE_URL || "https://mcsealms.vercel.app").replace(/\/+$/, ""),
    port: Number(env.PORT || 3000),
    maxSealmsPerOwner: Number(env.MAX_SEALMS_PER_OWNER || 10),
    maxActiveInviteCodesPerSealm: Number(env.MAX_ACTIVE_INVITE_CODES_PER_SEALM || 10),
    maxWhitelistImport: Number(env.MAX_WHITELIST_IMPORT || 50),
    maxDailyPendingInvites: Number(env.MAX_DAILY_INVITES || 50),
    allowInsecureLocalPanelUrls: env.SEALMS_ALLOW_INSECURE_LOCAL_PANEL === "true",
  };
}
