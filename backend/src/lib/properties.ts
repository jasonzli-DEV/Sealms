export interface ServerProperties {
  rawLines: string[];
  values: Record<string, string>;
}

export interface RealmsSlotOptionsInput {
  pvp?: boolean;
  spawnAnimals?: boolean;
  spawnMonsters?: boolean;
  spawnNPCs?: boolean;
  spawnProtection?: number;
  commandBlocks?: boolean;
  forceGameMode?: boolean;
  difficulty?: number; // 0=peaceful, 1=easy, 2=normal, 3=hard
  gameMode?: number; // 0=survival, 1=creative, 2=adventure, 3=spectator
  slotName?: string;
}

const DIFFICULTY_TO_STRING: Record<number, string> = {
  0: "peaceful",
  1: "easy",
  2: "normal",
  3: "hard",
};

const STRING_TO_DIFFICULTY: Record<string, number> = {
  peaceful: 0,
  "0": 0,
  easy: 1,
  "1": 1,
  normal: 2,
  "2": 2,
  hard: 3,
  "3": 3,
};

const GAMEMODE_TO_STRING: Record<number, string> = {
  0: "survival",
  1: "creative",
  2: "adventure",
  3: "spectator",
};

const STRING_TO_GAMEMODE: Record<string, number> = {
  survival: 0,
  "0": 0,
  creative: 1,
  "1": 1,
  adventure: 2,
  "2": 2,
  spectator: 3,
  "3": 3,
};

export const RESTART_REQUIRED_KEYS = new Set([
  "level-name",
  "max-players",
  "spawn-protection",
  "enable-command-block",
  "spawn-monsters",
  "spawn-animals",
  "spawn-npcs",
  "force-gamemode",
  "pvp",
]);

export function parseServerProperties(content: string): ServerProperties {
  const rawLines = content.split(/\r?\n/);
  const values: Record<string, string> = {};

  for (const line of rawLines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("!")) {
      continue;
    }
    const eqIndex = line.indexOf("=");
    if (eqIndex === -1) continue;
    const key = line.slice(0, eqIndex).trim();
    const val = line.slice(eqIndex + 1).trim();
    values[key] = val;
  }

  return { rawLines, values };
}

export function updateServerProperties(
  content: string,
  updates: Record<string, string>
): { content: string; changedKeys: string[]; requiresRestart: boolean; liveCommands: string[] } {
  const parsed = parseServerProperties(content);
  const changedKeys: string[] = [];
  const remaining = new Map<string, string>();

  for (const [k, v] of Object.entries(updates)) {
    if (parsed.values[k] !== v) {
      changedKeys.push(k);
    }
    remaining.set(k, v);
  }

  const outLines = parsed.rawLines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("!")) {
      return line;
    }
    const eqIndex = line.indexOf("=");
    if (eqIndex === -1) return line;
    const key = line.slice(0, eqIndex).trim();
    if (remaining.has(key)) {
      const nextVal = remaining.get(key)!;
      remaining.delete(key);
      return `${key}=${nextVal}`;
    }
    return line;
  });

  for (const [key, val] of remaining.entries()) {
    outLines.push(`${key}=${val}`);
  }

  const liveCommands: string[] = [];
  if (changedKeys.includes("difficulty")) {
    const d = updates.difficulty;
    if (d && ["peaceful", "easy", "normal", "hard"].includes(d)) {
      liveCommands.push(`difficulty ${d}`);
    }
  }
  if (changedKeys.includes("gamemode")) {
    const gm = updates.gamemode;
    if (gm && ["survival", "creative", "adventure", "spectator"].includes(gm)) {
      liveCommands.push(`defaultgamemode ${gm}`);
    }
  }

  const requiresRestart = changedKeys.some((k) => RESTART_REQUIRED_KEYS.has(k));

  return {
    content: outLines.join("\n"),
    changedKeys,
    requiresRestart,
    liveCommands,
  };
}

export function propertiesToRealmsOptions(
  values: Record<string, string>,
  slotName = ""
): Required<RealmsSlotOptionsInput> {
  const parseBool = (key: string, fallback: boolean) => {
    const v = values[key]?.toLowerCase();
    if (v === "true") return true;
    if (v === "false") return false;
    return fallback;
  };
  const difficultyStr = (values["difficulty"] ?? "normal").toLowerCase();
  const gamemodeStr = (values["gamemode"] ?? "survival").toLowerCase();
  const spawnProtection = Number.parseInt(values["spawn-protection"] ?? "0", 10);

  return {
    pvp: parseBool("pvp", true),
    spawnAnimals: parseBool("spawn-animals", true),
    spawnMonsters: parseBool("spawn-monsters", true),
    spawnNPCs: parseBool("spawn-npcs", true),
    spawnProtection: Number.isFinite(spawnProtection) ? spawnProtection : 0,
    commandBlocks: parseBool("enable-command-block", false),
    forceGameMode: parseBool("force-gamemode", false),
    difficulty: STRING_TO_DIFFICULTY[difficultyStr] ?? 2,
    gameMode: STRING_TO_GAMEMODE[gamemodeStr] ?? 0,
    slotName,
  };
}

export function realmsOptionsToPropertiesUpdates(
  opts: RealmsSlotOptionsInput
): Record<string, string> {
  const updates: Record<string, string> = {};
  if (typeof opts.pvp === "boolean") updates["pvp"] = String(opts.pvp);
  if (typeof opts.spawnAnimals === "boolean") updates["spawn-animals"] = String(opts.spawnAnimals);
  if (typeof opts.spawnMonsters === "boolean") updates["spawn-monsters"] = String(opts.spawnMonsters);
  if (typeof opts.spawnNPCs === "boolean") updates["spawn-npcs"] = String(opts.spawnNPCs);
  if (typeof opts.spawnProtection === "number" && Number.isFinite(opts.spawnProtection)) {
    updates["spawn-protection"] = String(Math.max(0, Math.floor(opts.spawnProtection)));
  }
  if (typeof opts.commandBlocks === "boolean") {
    updates["enable-command-block"] = String(opts.commandBlocks);
  }
  if (typeof opts.forceGameMode === "boolean") {
    updates["force-gamemode"] = String(opts.forceGameMode);
  }
  if (typeof opts.difficulty === "number" && opts.difficulty in DIFFICULTY_TO_STRING) {
    updates["difficulty"] = DIFFICULTY_TO_STRING[opts.difficulty];
  }
  if (typeof opts.gameMode === "number" && opts.gameMode in GAMEMODE_TO_STRING) {
    updates["gamemode"] = GAMEMODE_TO_STRING[opts.gameMode];
  }
  return updates;
}
