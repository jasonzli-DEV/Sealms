import { Hono } from "hono";
import type { AppEnv } from "../context.js";

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export const webRoutes = new Hono<AppEnv>();

webRoutes.get("/", (c) => {
  return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Sealms — Pterodactyl-Powered Realms for Minecraft 26.3</title>
  <meta property="og:title" content="Sealms — Pterodactyl-Powered Realms" />
  <meta property="og:description" content="Replace vanilla Minecraft Realms with any Pterodactyl game server while keeping the exact Realms UI and workflow." />
  <style>
    :root { color-scheme: dark; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #0f1115; color: #f3f4f6; margin: 0; padding: 48px 20px; display: flex; justify-content: center; }
    main { max-width: 640px; width: 100%; background: #171a21; border: 1px solid #262b36; border-radius: 14px; padding: 32px; }
    h1 { margin: 0 0 8px; font-size: 2rem; color: #7dd3fc; }
    p { line-height: 1.6; color: #cbd5e1; }
    a { color: #38bdf8; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .badge { display: inline-block; padding: 4px 10px; border-radius: 999px; background: #1e293b; color: #7dd3fc; font-size: 0.85rem; margin-bottom: 16px; }
  </style>
</head>
<body>
  <main>
    <div class="badge">Minecraft 26.3 • Fabric</div>
    <h1>Sealms</h1>
    <p>Sealms replaces the vanilla Minecraft Realms backend with any Pterodactyl-compatible game server, preserving the exact look, feel, auto-start workflow, backups, world slots, and invite system.</p>
    <p><a href="/privacy">Privacy Policy</a></p>
  </main>
</body>
</html>`);
});

webRoutes.get("/invite/:code", async (c) => {
  const code = c.req.param("code").toUpperCase();
  const { getCollections, config } = c.get("deps");

  let sealmName = "a Sealms Server";
  let ownerName = "a friend";
  let valid = false;

  try {
    const { invites, sealms } = await getCollections();
    const invite = await invites.findOne({ code, expiresAt: { $gt: new Date() } });
    if (invite && (invite.maxUses === null || invite.uses < invite.maxUses)) {
      const sealm = await sealms.findOne({ numericId: invite.sealmNumericId });
      if (sealm) {
        sealmName = sealm.name;
        ownerName = sealm.ownerName;
        valid = true;
      }
    }
  } catch {
    // Graceful fallback if DB is unavailable
  }

  const safeCode = escapeHtml(code);
  const safeName = escapeHtml(sealmName);
  const safeOwner = escapeHtml(ownerName);
  const inviteUrl = escapeHtml(`${config.publicBaseUrl}/invite/${code}`);

  return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Join ${safeName} on Sealms</title>
  <meta property="og:type" content="website" />
  <meta property="og:title" content="You're invited to ${safeName}!" />
  <meta property="og:description" content="${safeOwner} invited you to join ${safeName} on Sealms (Minecraft 26.3). Open Sealms and click 'Join with Code' with ${safeCode}." />
  <meta property="og:url" content="${inviteUrl}" />
  <meta name="theme-color" content="#38bdf8" />
  <style>
    :root { color-scheme: dark; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #0f1115; color: #f3f4f6; margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 20px; }
    .card { max-width: 460px; width: 100%; background: #171a21; border: 1px solid #262b36; border-radius: 16px; padding: 32px; text-align: center; box-shadow: 0 20px 50px rgba(0,0,0,0.4); }
    h1 { margin: 0 0 8px; font-size: 1.5rem; }
    .sub { color: #94a3b8; margin: 0 0 24px; }
    .code { font-family: ui-monospace, SFMono-Regular, monospace; font-size: 1.75rem; font-weight: 700; letter-spacing: 0.08em; background: #0b0d11; border: 1px solid #334155; border-radius: 10px; padding: 14px 18px; margin-bottom: 18px; color: #7dd3fc; }
    button { background: #0284c7; color: #fff; border: 0; border-radius: 10px; padding: 12px 22px; font-size: 1rem; font-weight: 600; cursor: pointer; width: 100%; }
    button:hover { background: #0369a1; }
    .hint { font-size: 0.85rem; color: #94a3b8; margin-top: 18px; line-height: 1.5; }
    .expired { color: #f87171; font-weight: 600; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${valid ? `Join ${safeName}` : "Invite Unavailable"}</h1>
    <p class="sub">${valid ? `Invited by ${safeOwner} • Minecraft 26.3` : `<span class="expired">This invite code is invalid or expired.</span>`}</p>
    <div class="code" id="code">${safeCode}</div>
    <button onclick="copyCode()" id="copyBtn">Copy Invite Code</button>
    <p class="hint">Launch Minecraft 26.3 with the <strong>Sealms</strong> Fabric mod, open <strong>Sealms</strong>, click <strong>Join with Code</strong>, and paste the code above.</p>
  </div>
  <script>
    function copyCode() {
      navigator.clipboard.writeText(${JSON.stringify(code)}).then(function() {
        var btn = document.getElementById('copyBtn');
        btn.textContent = 'Copied!';
        setTimeout(function() { btn.textContent = 'Copy Invite Code'; }, 2000);
      });
    }
  </script>
</body>
</html>`);
});

webRoutes.get("/privacy", (c) => {
  return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Sealms — Privacy Policy</title>
  <style>
    :root { color-scheme: dark; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #0f1115; color: #f3f4f6; margin: 0; padding: 48px 20px; display: flex; justify-content: center; }
    main { max-width: 720px; width: 100%; background: #171a21; border: 1px solid #262b36; border-radius: 14px; padding: 32px; line-height: 1.65; }
    h1 { color: #7dd3fc; margin-top: 0; }
    h2 { color: #e2e8f0; margin-top: 24px; }
    li { color: #cbd5e1; margin-bottom: 6px; }
    p { color: #cbd5e1; }
  </style>
</head>
<body>
  <main>
    <h1>Sealms Privacy Policy</h1>
    <p>Effective Date: 2026</p>
    <h2>1. Data We Store</h2>
    <ul>
      <li><strong>Minecraft Identity:</strong> Your Mojang UUID and username verified via Mojang's official <code>hasJoined</code> handshake. Your Mojang access token is <strong>never</strong> transmitted to or stored by Sealms.</li>
      <li><strong>Linked Server Metadata:</strong> Panel HTTPS URL, Pterodactyl server identifier, display name, description, slot configuration, member/operator UUIDs, and invite codes.</li>
      <li><strong>Encrypted API Keys:</strong> Pterodactyl Client API keys (<code>ptlc_</code>) are encrypted at rest using <strong>AES-256-GCM</strong> with authenticated encryption and are never returned to any client or API response.</li>
      <li><strong>Ephemeral Data:</strong> Login nonces expire automatically after 60 seconds; invite codes expire automatically at their configured TTL.</li>
    </ul>
    <h2>2. Data Transfer Boundaries</h2>
    <p>World archives (<code>.zip</code>) are transferred directly between your Minecraft client and your Pterodactyl Wings node using temporary signed URLs. Sealms never stores or inspects your world data.</p>
    <h2>3. Deletion Guarantees</h2>
    <p>Server owners can unlink a Sealm at any time from the Configure screen (<code>DELETE /sealms/:id</code>), which immediately deletes the server document, its encrypted Pterodactyl API key, and all active invite codes from MongoDB.</p>
  </main>
</body>
</html>`);
});
