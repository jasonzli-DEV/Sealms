import type { SealmDoc } from "../db/types.js";
import type { PteroBackup } from "./ptero.js";
import { propertiesToRealmsOptions } from "./properties.js";
import { stripUuid } from "./mojang.js";

export interface RealmsServerJson {
  id: number;
  remoteSubscriptionId: string;
  owner: string;
  ownerUUID: string;
  name: string;
  motd: string;
  state: "OPEN" | "CLOSED" | "UNINITIALIZED";
  daysLeft: number;
  expired: boolean;
  expiredTrial: boolean;
  worldType: "NORMAL" | "MINIGAME";
  players: Array<{
    uuid: string;
    name: string;
    operator: boolean;
    accepted: boolean;
    online: boolean;
    permission: string;
  }>;
  maxPlayers: number;
  minigameName: string | null;
  minigameId: number | null;
  minigameImage: string | null;
  activeSlot: number;
  slots: Array<{
    slotId: number;
    options: string;
    settings: Array<{ name: string; value: string }>;
  }>;
  member: boolean;
  compatibility: "COMPATIBLE";
  activeVersion: string;
  // Sealms extension fields (ignored by vanilla Gson, read by Sealms mod)
  sealmsAddress?: string;
  sealmsAllowMemberWake: boolean;
  sealmsCredentialsInvalid: boolean;
  sealmsCallerIsOperator: boolean;
}

export function mapSealmToRealmsServer(
  doc: SealmDoc,
  callerUuid: string,
  liveProperties?: Record<string, string>
): RealmsServerJson {
  const isOwner = doc.ownerUuid.toLowerCase() === callerUuid.toLowerCase();
  const callerMember = doc.members.find(
    (m) => m.uuid.toLowerCase() === callerUuid.toLowerCase()
  );

  const slotsArray = [1, 2, 3].map((slotId) => {
    const slotCfg = doc.slots[slotId] ?? { levelName: slotId === 1 ? "world" : `world_slot_${slotId}` };
    const isActive = doc.activeSlot === slotId;
    const opts = isActive && liveProperties
      ? propertiesToRealmsOptions(liveProperties, slotCfg.name ?? "")
      : {
          pvp: slotCfg.options?.pvp ?? true,
          spawnAnimals: slotCfg.options?.spawnAnimals ?? true,
          spawnMonsters: slotCfg.options?.spawnMonsters ?? true,
          spawnNPCs: slotCfg.options?.spawnNPCs ?? true,
          spawnProtection: slotCfg.options?.spawnProtection ?? 0,
          commandBlocks: slotCfg.options?.commandBlocks ?? false,
          forceGameMode: slotCfg.options?.forceGameMode ?? false,
          difficulty: slotCfg.options?.difficulty ?? 2,
          gameMode: slotCfg.options?.gameMode ?? 0,
          slotName: slotCfg.name ?? "",
        };

    const optionsJson = JSON.stringify({
      ...opts,
      version: "26.3",
      compatibility: "COMPATIBLE",
      empty: false,
    });

    return {
      slotId,
      options: optionsJson,
      settings: [
        { name: "hardcore", value: String(liveProperties?.["hardcore"] === "true") },
      ],
    };
  });

  return {
    id: doc.numericId,
    remoteSubscriptionId: `sealm-${doc.numericId}`,
    owner: doc.ownerName,
    ownerUUID: stripUuid(doc.ownerUuid),
    name: doc.name,
    motd: doc.ptero.credentialsInvalid
      ? (isOwner ? "API Key Invalid — Click Configure to Update Credentials" : "Server Temporarily Unavailable")
      : (liveProperties?.["motd"]?.replace(/\\u00a7[0-9a-fk-or]/gi, "").replace(/§[0-9a-fk-or]/gi, "").trim() ||
          (doc.description && doc.description.trim() !== "..." ? doc.description : "A Minecraft Server")),
    state: doc.state,
    daysLeft: 999,
    expired: false,
    expiredTrial: false,
    worldType: doc.minigameActive ? "MINIGAME" : "NORMAL",
    players: doc.members.map((m) => ({
      uuid: stripUuid(m.uuid),
      name: m.name,
      operator: m.operator,
      accepted: m.accepted,
      online: false,
      permission: m.operator ? "OPERATOR" : "MEMBER",
    })),
    maxPlayers: Number.parseInt(liveProperties?.["max-players"] ?? "20", 10) || 20,
    minigameName: doc.minigameActive ? (doc.minigameName ?? "Minigame") : null,
    minigameId: doc.minigameActive ? 1 : null,
    minigameImage: null,
    activeSlot: doc.activeSlot,
    slots: slotsArray,
    member: !isOwner,
    compatibility: "COMPATIBLE",
    activeVersion: "26.3",
    sealmsAddress: doc.ptero.address,
    sealmsAllowMemberWake: doc.allowMemberWake,
    sealmsCredentialsInvalid: Boolean(doc.ptero.credentialsInvalid),
    sealmsCallerIsOperator: isOwner || Boolean(callerMember?.operator),
  };
}

export function mapBackupsToRealms(backups: PteroBackup[]) {
  return {
    backups: backups.map((b) => ({
      backupId: b.uuid,
      lastModifiedDate: new Date(b.createdAt).getTime() || Date.now(),
      size: b.bytes,
      metadata: {
        name: b.name,
        world_type: "NORMAL",
        game_server_version: "26.3",
      },
    })),
  };
}
