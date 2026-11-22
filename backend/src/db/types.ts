import type { ObjectId } from "mongodb";

export interface SealmSlotConfig {
  levelName: string;
  name?: string;
  options?: {
    pvp?: boolean;
    spawnAnimals?: boolean;
    spawnMonsters?: boolean;
    spawnNPCs?: boolean;
    spawnProtection?: number;
    commandBlocks?: boolean;
    forceGameMode?: boolean;
    difficulty?: number;
    gameMode?: number;
  };
}

export interface SealmMember {
  uuid: string;
  name: string;
  operator: boolean;
  accepted: boolean;
  invitedAt: Date;
}

export interface SealmDoc {
  _id?: ObjectId;
  numericId: number;
  ownerUuid: string;
  ownerName: string;
  name: string;
  description: string;
  state: "OPEN" | "CLOSED";
  allowMemberWake: boolean;
  activeSlot: 1 | 2 | 3;
  minigameActive?: boolean;
  minigameName?: string;
  slots: Record<number, SealmSlotConfig>;
  ptero: {
    panelUrl: string;
    serverId: string;
    serverHash: string;
    encryptedApiKey: string;
    address?: string;
    credentialsInvalid?: boolean;
  };
  members: SealmMember[];
  createdAt: Date;
}

export interface AuthNonceDoc {
  _id?: ObjectId;
  nonce: string;
  expiresAt: Date;
}

export interface InviteCodeDoc {
  _id?: ObjectId;
  code: string;
  sealmId: ObjectId;
  sealmNumericId: number;
  createdBy: string;
  maxUses: number | null;
  uses: number;
  expiresAt: Date;
  createdAt: Date;
}

export interface BlockedOwnerDoc {
  _id?: ObjectId;
  playerUuid: string;
  blockedOwnerUuid: string;
  createdAt: Date;
}

export interface CounterDoc {
  _id: string;
  seq: number;
}
