export const MINECRAFT_USERNAME_REGEX = /^[a-zA-Z0-9_]{3,16}$/;

export interface MojangProfile {
  uuid: string; // dashed lowercase UUID
  username: string;
}

export function isValidMinecraftUsername(username: string): boolean {
  return MINECRAFT_USERNAME_REGEX.test(username);
}

export function formatDashedUuid(rawUuid: string): string {
  const clean = rawUuid.replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(clean)) {
    throw new Error(`Invalid Mojang UUID: ${rawUuid}`);
  }
  return `${clean.slice(0, 8)}-${clean.slice(8, 12)}-${clean.slice(12, 16)}-${clean.slice(16, 20)}-${clean.slice(20)}`;
}

export function stripUuid(uuid: string): string {
  return uuid.replace(/-/g, "").toLowerCase();
}

export interface MojangClient {
  verifyHasJoined(username: string, serverId: string): Promise<MojangProfile | null>;
  lookupProfileByUsername(username: string): Promise<MojangProfile | null>;
}

export function createMojangClient(fetchImpl: typeof fetch = fetch): MojangClient {
  return {
    async verifyHasJoined(username: string, serverId: string): Promise<MojangProfile | null> {
      if (!isValidMinecraftUsername(username)) {
        return null;
      }
      const url = new URL("https://sessionserver.mojang.com/session/minecraft/hasJoined");
      url.searchParams.set("username", username);
      url.searchParams.set("serverId", serverId);

      const res = await fetchImpl(url.toString(), {
        method: "GET",
        headers: { Accept: "application/json" },
      });

      if (res.status === 204 || res.status === 404 || !res.ok) {
        return null;
      }

      const data = (await res.json()) as { id?: string; name?: string };
      if (!data.id || !data.name) {
        return null;
      }

      return {
        uuid: formatDashedUuid(data.id),
        username: data.name,
      };
    },

    async lookupProfileByUsername(username: string): Promise<MojangProfile | null> {
      if (!isValidMinecraftUsername(username)) {
        return null;
      }
      const res = await fetchImpl(
        `https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(username)}`,
        {
          method: "GET",
          headers: { Accept: "application/json" },
        }
      );

      if (res.status === 204 || res.status === 404 || !res.ok) {
        return null;
      }

      const data = (await res.json()) as { id?: string; name?: string };
      if (!data.id || !data.name) {
        return null;
      }

      return {
        uuid: formatDashedUuid(data.id),
        username: data.name,
      };
    },
  };
}
