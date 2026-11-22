import { SignJWT, jwtVerify } from "jose";

export interface SealmsJwtPayload {
  uuid: string;
  username: string;
}

const ISSUER = "sealms";
const AUDIENCE = "sealms-client";
const TOKEN_TTL = "7d";

function getSecretKey(secret: string): Uint8Array {
  if (!secret || secret.length < 16) {
    throw new Error("JWT_SECRET must be at least 16 characters");
  }
  return new TextEncoder().encode(secret);
}

export async function signSealmsJwt(
  payload: SealmsJwtPayload,
  secret: string
): Promise<string> {
  return new SignJWT({ uuid: payload.uuid, username: payload.username })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(payload.uuid)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(TOKEN_TTL)
    .sign(getSecretKey(secret));
}

export async function verifySealmsJwt(
  token: string,
  secret: string
): Promise<SealmsJwtPayload> {
  const { payload } = await jwtVerify(token, getSecretKey(secret), {
    issuer: ISSUER,
    audience: AUDIENCE,
  });
  const uuid = typeof payload.uuid === "string" ? payload.uuid : payload.sub;
  const username = typeof payload.username === "string" ? payload.username : "";
  if (!uuid || !username) {
    throw new Error("Invalid Sealms JWT claims");
  }
  return { uuid, username };
}
