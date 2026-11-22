import net from "node:net";

export interface SlpResult {
  online: boolean;
  playersOnline?: number;
  playersMax?: number;
  motd?: string;
  latencyMs?: number;
}

function encodeVarInt(value: number): Buffer {
  const bytes: number[] = [];
  let v = value >>> 0;
  do {
    let temp = v & 0x7f;
    v >>>= 7;
    if (v !== 0) temp |= 0x80;
    bytes.push(temp);
  } while (v !== 0);
  return Buffer.from(bytes);
}

function decodeVarInt(buf: Buffer, offset: number): { value: number; bytesRead: number } | null {
  let numRead = 0;
  let result = 0;
  while (offset + numRead < buf.length) {
    const read = buf[offset + numRead];
    result |= (read & 0x7f) << (7 * numRead);
    numRead++;
    if (numRead > 5) {
      throw new Error("VarInt too big");
    }
    if ((read & 0x80) === 0) {
      return { value: result, bytesRead: numRead };
    }
  }
  return null;
}

function encodeString(str: string): Buffer {
  const utf8 = Buffer.from(str, "utf8");
  return Buffer.concat([encodeVarInt(utf8.length), utf8]);
}

function buildPacket(packetId: number, payload: Buffer): Buffer {
  const idBuf = encodeVarInt(packetId);
  const body = Buffer.concat([idBuf, payload]);
  return Buffer.concat([encodeVarInt(body.length), body]);
}

export function parseHostPort(address: string): { host: string; port: number } {
  const trimmed = address.trim();
  const lastColon = trimmed.lastIndexOf(":");
  if (lastColon === -1) {
    return { host: trimmed, port: 25565 };
  }
  const host = trimmed.slice(0, lastColon).replace(/^\[|\]$/g, "");
  const port = Number(trimmed.slice(lastColon + 1));
  return { host, port: Number.isFinite(port) && port > 0 ? port : 25565 };
}

export async function pingMinecraftServer(
  address: string,
  timeoutMs = 2500
): Promise<SlpResult> {
  const { host, port } = parseHostPort(address);
  const startedAt = Date.now();

  return new Promise<SlpResult>((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    let buffer: Buffer = Buffer.alloc(0);

    const finish = (result: SlpResult) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs);
    socket.on("timeout", () => finish({ online: false }));
    socket.on("error", () => finish({ online: false }));
    socket.on("close", () => finish({ online: false }));

    socket.connect(port, host, () => {
      const portBuf = Buffer.alloc(2);
      portBuf.writeUInt16BE(port, 0);

      const handshakePayload = Buffer.concat([
        encodeVarInt(767), // protocol version
        encodeString(host),
        portBuf,
        encodeVarInt(1), // next state = status
      ]);

      const handshakePacket = buildPacket(0x00, handshakePayload);
      const statusRequestPacket = buildPacket(0x00, Buffer.alloc(0));
      socket.write(Buffer.concat([handshakePacket, statusRequestPacket]));
    });

    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      try {
        const packetLen = decodeVarInt(buffer, 0);
        if (!packetLen) return;
        const totalNeeded = packetLen.bytesRead + packetLen.value;
        if (buffer.length < totalNeeded) return;

        let offset = packetLen.bytesRead;
        const packetId = decodeVarInt(buffer, offset);
        if (!packetId || packetId.value !== 0x00) {
          finish({ online: false });
          return;
        }
        offset += packetId.bytesRead;

        const strLen = decodeVarInt(buffer, offset);
        if (!strLen) return;
        offset += strLen.bytesRead;
        if (buffer.length < offset + strLen.value) return;

        const jsonStr = buffer.subarray(offset, offset + strLen.value).toString("utf8");
        const parsed = JSON.parse(jsonStr) as {
          players?: { online?: number; max?: number };
          description?: string | { text?: string };
        };

        const motd =
          typeof parsed.description === "string"
            ? parsed.description
            : parsed.description?.text ?? "";

        finish({
          online: true,
          playersOnline: parsed.players?.online ?? 0,
          playersMax: parsed.players?.max ?? 20,
          motd,
          latencyMs: Date.now() - startedAt,
        });
      } catch {
        finish({ online: false });
      }
    });
  });
}
