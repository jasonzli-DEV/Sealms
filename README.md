# Sealms

**Sealms** is a Fabric mod for **Minecraft 26.3** and serverless Hono backend (`mcsealms.vercel.app`) that replaces the vanilla Realms backend with any Pterodactyl-compatible game server while preserving the exact look, feel, and workflow of vanilla Realms.

## Monorepo Layout

- `/mod` — Minecraft 26.3 Fabric client mod (Java 25, Fabric Loom 1.19.4, Fabric API `0.166.2+26.3`).
- `/backend` — TypeScript + Hono API deployed on Vercel Hobby with MongoDB Atlas M0 and Upstash Redis rate limiting.
- `/.github/workflows` — Automated CI for backend tests and 26.3 Fabric JAR builds with build-time `CURSEFORGE_API_KEY` injection.

## Quick Start

### 1. Backend (`/backend`)

```bash
cd backend
cp .env.example .env
# Fill in MONGODB_URI, JWT_SECRET, ENCRYPTION_KEY (64 hex chars), and optional UPSTASH_REDIS_*
pnpm install
pnpm test
pnpm dev
```

To deploy to Vercel, point a Vercel project at `/backend` and configure:
- `MONGODB_URI`
- `MONGODB_DB_NAME` (default `sealms`)
- `JWT_SECRET`
- `ENCRYPTION_KEY` (64 hex characters = 32 bytes for AES-256-GCM)
- `UPSTASH_REDIS_REST_URL` & `UPSTASH_REDIS_REST_TOKEN`
- `PUBLIC_BASE_URL` (e.g. `https://mcsealms.vercel.app`)

### 2. Client Mod (`/mod`)

```bash
cd mod
# Optional: inject CurseForge 3rd Party API key at build time
CURSEFORGE_API_KEY="your-key" ./gradlew build
```

The playable Fabric 26.3 mod JAR is produced at `mod/build/libs/sealms-1.0.0.jar`.

To test against a local backend, edit `.minecraft/config/sealms.json` or launch with `-Dsealms.backendUrl=http://localhost:3000`.

## License

MIT License — see [LICENSE](LICENSE).
