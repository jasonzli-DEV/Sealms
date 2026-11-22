import type { AppConfig } from "./config.js";
import type { SealmsCollections } from "./db/client.js";
import type { MojangClient } from "./lib/mojang.js";
import type { PteroClient } from "./lib/ptero.js";
import type { RateLimiter } from "./lib/ratelimit.js";
import type { SlpResult } from "./lib/slp.js";
import type { SealmsJwtPayload } from "./lib/jwt.js";

export interface AppDeps {
  config: AppConfig;
  getCollections: () => Promise<SealmsCollections>;
  mojang: MojangClient;
  ptero: PteroClient;
  rateLimiter: RateLimiter;
  pingServer: (address: string, timeoutMs?: number) => Promise<SlpResult>;
}

export interface AppVariables {
  user?: SealmsJwtPayload;
  deps: AppDeps;
}

export type AppEnv = {
  Variables: AppVariables;
};
