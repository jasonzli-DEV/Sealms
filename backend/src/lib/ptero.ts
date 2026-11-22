import { safeFetch, type ValidateUrlOptions } from "./ssrf.js";

export class PteroAuthError extends Error {
  readonly status: number;
  constructor(status: number, message = "Pterodactyl API key is invalid or revoked") {
    super(message);
    this.name = "PteroAuthError";
    this.status = status;
  }
}

export class PteroApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "PteroApiError";
    this.status = status;
  }
}

export interface PteroServerDetails {
  identifier: string;
  name: string;
  description: string;
  limits: {
    memoryMb: number;
    diskMb: number;
    cpuPercent: number;
  };
  primaryAllocation: {
    ip: string;
    ipAlias: string | null;
    port: number;
    address: string;
  } | null;
}

export interface PteroResources {
  currentState: "offline" | "starting" | "running" | "stopping" | string;
  isSuspended: boolean;
  memoryBytes: number;
  cpuAbsolute: number;
  diskBytes: number;
  networkRxBytes: number;
  networkTxBytes: number;
  uptimeMs: number;
}

export interface PteroBackup {
  uuid: string;
  name: string;
  bytes: number;
  createdAt: string;
  isSuccessful: boolean;
  isLocked: boolean;
}

export interface PteroFileEntry {
  name: string;
  isFile: boolean;
  size: number;
  modifiedAt: string;
}

export type PteroPowerSignal = "start" | "stop" | "restart" | "kill";

export interface PteroClient {
  getServerDetails(panelUrl: string, apiKey: string, serverId: string): Promise<PteroServerDetails>;
  getResources(panelUrl: string, apiKey: string, serverId: string): Promise<PteroResources>;
  sendPowerSignal(panelUrl: string, apiKey: string, serverId: string, signal: PteroPowerSignal): Promise<void>;
  sendCommand(panelUrl: string, apiKey: string, serverId: string, command: string): Promise<void>;
  listBackups(panelUrl: string, apiKey: string, serverId: string): Promise<PteroBackup[]>;
  restoreBackup(panelUrl: string, apiKey: string, serverId: string, backupUuid: string, truncate?: boolean): Promise<void>;
  createBackup(panelUrl: string, apiKey: string, serverId: string, name?: string): Promise<PteroBackup>;
  readFile(panelUrl: string, apiKey: string, serverId: string, filePath: string): Promise<string>;
  writeFile(panelUrl: string, apiKey: string, serverId: string, filePath: string, content: string): Promise<void>;
  listFiles(panelUrl: string, apiKey: string, serverId: string, directory?: string): Promise<PteroFileEntry[]>;
  compressFiles(panelUrl: string, apiKey: string, serverId: string, root: string, files: string[]): Promise<{ name: string }>;
  decompressFile(panelUrl: string, apiKey: string, serverId: string, root: string, file: string): Promise<void>;
  deleteFiles(panelUrl: string, apiKey: string, serverId: string, root: string, files: string[]): Promise<void>;
  renameFiles(panelUrl: string, apiKey: string, serverId: string, root: string, files: Array<{ from: string; to: string }>): Promise<void>;
  createFolder(panelUrl: string, apiKey: string, serverId: string, root: string, name: string): Promise<void>;
  getSignedDownloadUrl(panelUrl: string, apiKey: string, serverId: string, filePath: string): Promise<string>;
  getSignedUploadUrl(panelUrl: string, apiKey: string, serverId: string): Promise<string>;
}

export function createPteroClient(options: ValidateUrlOptions & { fetchImpl?: typeof fetch } = {}): PteroClient {
  async function request(
    panelUrl: string,
    apiKey: string,
    path: string,
    init: RequestInit = {},
    expectText = false
  ): Promise<unknown> {
    const base = panelUrl.replace(/\/+$/, "");
    const url = `${base}${path}`;
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${apiKey}`);
    headers.set("Accept", "application/json");
    if (init.body && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }

    const res = await safeFetch(url, { ...init, headers }, options);

    if (res.status === 401 || res.status === 403) {
      throw new PteroAuthError(res.status);
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new PteroApiError(res.status, errText || `Pterodactyl API error (${res.status})`);
    }

    if (res.status === 204) {
      return undefined;
    }

    if (expectText) {
      return res.text();
    }

    const text = await res.text();
    if (!text) return undefined;
    return JSON.parse(text);
  }

  return {
    async getServerDetails(panelUrl, apiKey, serverId) {
      const data = (await request(
        panelUrl,
        apiKey,
        `/api/client/servers/${encodeURIComponent(serverId)}`
      )) as {
        attributes: {
          identifier: string;
          name: string;
          description?: string;
          limits?: { memory?: number; disk?: number; cpu?: number };
          relationships?: {
            allocations?: {
              data?: Array<{
                attributes: {
                  ip: string;
                  ip_alias?: string | null;
                  port: number;
                  is_default: boolean;
                };
              }>;
            };
          };
        };
      };

      const attrs = data.attributes;
      const allocations = attrs.relationships?.allocations?.data ?? [];
      const primary =
        allocations.find((a) => a.attributes.is_default)?.attributes ??
        allocations[0]?.attributes ??
        null;

      const host = primary ? (primary.ip_alias || primary.ip) : null;
      return {
        identifier: attrs.identifier,
        name: attrs.name,
        description: attrs.description ?? "",
        limits: {
          memoryMb: attrs.limits?.memory ?? 0,
          diskMb: attrs.limits?.disk ?? 0,
          cpuPercent: attrs.limits?.cpu ?? 0,
        },
        primaryAllocation: primary && host
          ? {
              ip: primary.ip,
              ipAlias: primary.ip_alias ?? null,
              port: primary.port,
              address: `${host}:${primary.port}`,
            }
          : null,
      };
    },

    async getResources(panelUrl, apiKey, serverId) {
      const data = (await request(
        panelUrl,
        apiKey,
        `/api/client/servers/${encodeURIComponent(serverId)}/resources`
      )) as {
        attributes: {
          current_state: string;
          is_suspended: boolean;
          resources: {
            memory_bytes: number;
            cpu_absolute: number;
            disk_bytes: number;
            network_rx_bytes: number;
            network_tx_bytes: number;
            uptime: number;
          };
        };
      };
      const a = data.attributes;
      return {
        currentState: a.current_state,
        isSuspended: Boolean(a.is_suspended),
        memoryBytes: a.resources?.memory_bytes ?? 0,
        cpuAbsolute: a.resources?.cpu_absolute ?? 0,
        diskBytes: a.resources?.disk_bytes ?? 0,
        networkRxBytes: a.resources?.network_rx_bytes ?? 0,
        networkTxBytes: a.resources?.network_tx_bytes ?? 0,
        uptimeMs: a.resources?.uptime ?? 0,
      };
    },

    async sendPowerSignal(panelUrl, apiKey, serverId, signal) {
      await request(
        panelUrl,
        apiKey,
        `/api/client/servers/${encodeURIComponent(serverId)}/power`,
        {
          method: "POST",
          body: JSON.stringify({ signal }),
        }
      );
    },

    async sendCommand(panelUrl, apiKey, serverId, command) {
      await request(
        panelUrl,
        apiKey,
        `/api/client/servers/${encodeURIComponent(serverId)}/command`,
        {
          method: "POST",
          body: JSON.stringify({ command }),
        }
      );
    },

    async listBackups(panelUrl, apiKey, serverId) {
      const data = (await request(
        panelUrl,
        apiKey,
        `/api/client/servers/${encodeURIComponent(serverId)}/backups`
      )) as {
        data?: Array<{
          attributes: {
            uuid: string;
            name: string;
            bytes: number;
            created_at: string;
            is_successful: boolean;
            is_locked: boolean;
          };
        }>;
      };
      return (data.data ?? []).map((b) => ({
        uuid: b.attributes.uuid,
        name: b.attributes.name,
        bytes: b.attributes.bytes,
        createdAt: b.attributes.created_at,
        isSuccessful: Boolean(b.attributes.is_successful),
        isLocked: Boolean(b.attributes.is_locked),
      }));
    },

    async restoreBackup(panelUrl, apiKey, serverId, backupUuid, truncate = true) {
      await request(
        panelUrl,
        apiKey,
        `/api/client/servers/${encodeURIComponent(serverId)}/backups/${encodeURIComponent(backupUuid)}/restore`,
        {
          method: "POST",
          body: JSON.stringify({ truncate }),
        }
      );
    },

    async createBackup(panelUrl, apiKey, serverId, name) {
      const data = (await request(
        panelUrl,
        apiKey,
        `/api/client/servers/${encodeURIComponent(serverId)}/backups`,
        {
          method: "POST",
          body: JSON.stringify(name ? { name } : {}),
        }
      )) as {
        attributes: {
          uuid: string;
          name: string;
          bytes: number;
          created_at: string;
          is_successful: boolean;
          is_locked: boolean;
        };
      };
      return {
        uuid: data.attributes.uuid,
        name: data.attributes.name,
        bytes: data.attributes.bytes,
        createdAt: data.attributes.created_at,
        isSuccessful: Boolean(data.attributes.is_successful),
        isLocked: Boolean(data.attributes.is_locked),
      };
    },

    async readFile(panelUrl, apiKey, serverId, filePath) {
      const text = await request(
        panelUrl,
        apiKey,
        `/api/client/servers/${encodeURIComponent(serverId)}/files/contents?file=${encodeURIComponent(filePath)}`,
        { method: "GET" },
        true
      );
      return typeof text === "string" ? text : "";
    },

    async writeFile(panelUrl, apiKey, serverId, filePath, content) {
      await request(
        panelUrl,
        apiKey,
        `/api/client/servers/${encodeURIComponent(serverId)}/files/write?file=${encodeURIComponent(filePath)}`,
        {
          method: "POST",
          headers: { "Content-Type": "text/plain" },
          body: content,
        },
        true
      );
    },

    async listFiles(panelUrl, apiKey, serverId, directory = "/") {
      const data = (await request(
        panelUrl,
        apiKey,
        `/api/client/servers/${encodeURIComponent(serverId)}/files/list?directory=${encodeURIComponent(directory)}`
      )) as {
        data?: Array<{
          attributes: {
            name: string;
            is_file: boolean;
            size: number;
            modified_at: string;
          };
        }>;
      };
      return (data.data ?? []).map((f) => ({
        name: f.attributes.name,
        isFile: Boolean(f.attributes.is_file),
        size: f.attributes.size ?? 0,
        modifiedAt: f.attributes.modified_at ?? "",
      }));
    },

    async compressFiles(panelUrl, apiKey, serverId, root, files) {
      const data = (await request(
        panelUrl,
        apiKey,
        `/api/client/servers/${encodeURIComponent(serverId)}/files/compress`,
        {
          method: "POST",
          body: JSON.stringify({ root, files }),
        }
      )) as { attributes: { name: string } };
      return { name: data.attributes.name };
    },

    async decompressFile(panelUrl, apiKey, serverId, root, file) {
      await request(
        panelUrl,
        apiKey,
        `/api/client/servers/${encodeURIComponent(serverId)}/files/decompress`,
        {
          method: "POST",
          body: JSON.stringify({ root, file }),
        }
      );
    },

    async deleteFiles(panelUrl, apiKey, serverId, root, files) {
      await request(
        panelUrl,
        apiKey,
        `/api/client/servers/${encodeURIComponent(serverId)}/files/delete`,
        {
          method: "POST",
          body: JSON.stringify({ root, files }),
        }
      );
    },

    async renameFiles(panelUrl, apiKey, serverId, root, files) {
      await request(
        panelUrl,
        apiKey,
        `/api/client/servers/${encodeURIComponent(serverId)}/files/rename`,
        {
          method: "PUT",
          body: JSON.stringify({ root, files }),
        }
      );
    },

    async createFolder(panelUrl, apiKey, serverId, root, name) {
      await request(
        panelUrl,
        apiKey,
        `/api/client/servers/${encodeURIComponent(serverId)}/files/create-folder`,
        {
          method: "POST",
          body: JSON.stringify({ root, name }),
        }
      );
    },

    async getSignedDownloadUrl(panelUrl, apiKey, serverId, filePath) {
      const data = (await request(
        panelUrl,
        apiKey,
        `/api/client/servers/${encodeURIComponent(serverId)}/files/download?file=${encodeURIComponent(filePath)}`
      )) as { attributes: { url: string } };
      return data.attributes.url;
    },

    async getSignedUploadUrl(panelUrl, apiKey, serverId) {
      const data = (await request(
        panelUrl,
        apiKey,
        `/api/client/servers/${encodeURIComponent(serverId)}/files/upload`
      )) as { attributes: { url: string } };
      return data.attributes.url;
    },
  };
}
