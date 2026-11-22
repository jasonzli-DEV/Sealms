package com.sealms.ping;

import com.google.gson.Gson;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Runs lightweight local Minecraft Server List Ping (SLP) checks asynchronously
 * from the client mod so the main Sealms list shows live player counts, MOTDs,
 * and server/client version compatibility without burdening the Vercel backend.
 */
public final class LocalSlpPinger {
	private static final Gson GSON = new Gson();
	private static final ExecutorService EXECUTOR = Executors.newCachedThreadPool(r -> {
		Thread t = new Thread(r, "Sealms-SLP-Pinger");
		t.setDaemon(true);
		return t;
	});

	public record PingStatus(
			boolean online,
			int playersOnline,
			int playersMax,
			String motd,
			String versionName,
			int protocolVersion,
			long timestampMs
	) {}

	private static final Map<Long, PingStatus> CACHE = new ConcurrentHashMap<>();
	private static final long CACHE_TTL_MS = 15_000;

	private LocalSlpPinger() {}

	public static PingStatus getCached(long realmId) {
		return CACHE.get(realmId);
	}

	public static void pingAsync(long realmId, String address, Runnable onComplete) {
		if (address == null || address.isBlank()) return;
		PingStatus existing = CACHE.get(realmId);
		if (existing != null && (System.currentTimeMillis() - existing.timestampMs()) < CACHE_TTL_MS) {
			return;
		}
		CompletableFuture.runAsync(() -> {
			PingStatus status = pingNow(address, 2500);
			CACHE.put(realmId, status);
			if (onComplete != null) {
				onComplete.run();
			}
		}, EXECUTOR);
	}

	public static PingStatus pingNow(String address, int timeoutMs) {
		String host = address.trim();
		int port = 25565;
		int colon = host.lastIndexOf(':');
		if (colon > 0) {
			try {
				port = Integer.parseInt(host.substring(colon + 1));
				host = host.substring(0, colon);
			} catch (NumberFormatException ignored) {}
		}

		try (Socket socket = new Socket()) {
			socket.connect(new InetSocketAddress(host, port), timeoutMs);
			socket.setSoTimeout(timeoutMs);

			DataOutputStream out = new DataOutputStream(socket.getOutputStream());
			DataInputStream in = new DataInputStream(socket.getInputStream());

			// Handshake packet (0x00)
			ByteArrayOutputStream hs = new ByteArrayOutputStream();
			writeVarInt(hs, 0x00);
			writeVarInt(hs, 767);
			writeString(hs, host);
			hs.write((port >> 8) & 0xFF);
			hs.write(port & 0xFF);
			writeVarInt(hs, 1); // status state
			sendPacket(out, hs.toByteArray());

			// Status Request packet (0x00)
			sendPacket(out, new byte[]{0x00});
			out.flush();

			// Status Response
			readVarInt(in); // packet length
			int packetId = readVarInt(in);
			if (packetId != 0x00) {
				return new PingStatus(false, 0, 0, "", "", -1, System.currentTimeMillis());
			}
			int jsonLen = readVarInt(in);
			byte[] jsonBytes = in.readNBytes(jsonLen);
			JsonObject obj = GSON.fromJson(new String(jsonBytes, StandardCharsets.UTF_8), JsonObject.class);

			int online = 0;
			int max = 20;
			if (obj != null && obj.has("players") && obj.get("players").isJsonObject()) {
				JsonObject players = obj.getAsJsonObject("players");
				if (players.has("online")) online = players.get("online").getAsInt();
				if (players.has("max")) max = players.get("max").getAsInt();
			}

			String versionName = "";
			int protocolVersion = -1;
			if (obj != null && obj.has("version") && obj.get("version").isJsonObject()) {
				JsonObject ver = obj.getAsJsonObject("version");
				if (ver.has("name") && !ver.get("name").isJsonNull()) {
					versionName = ver.get("name").getAsString().trim();
				}
				if (ver.has("protocol") && !ver.get("protocol").isJsonNull()) {
					protocolVersion = ver.get("protocol").getAsInt();
				}
			}

			String motd = "";
			if (obj != null && obj.has("description")) {
				motd = extractPlainText(obj.get("description")).replaceAll("§[0-9a-fk-orA-FK-OR]", "").replace("\n", " ").trim();
			}

			return new PingStatus(true, online, max, motd, versionName, protocolVersion, System.currentTimeMillis());
		} catch (Exception e) {
			return new PingStatus(false, 0, 0, "", "", -1, System.currentTimeMillis());
		}
	}

	private static String extractPlainText(JsonElement el) {
		if (el == null || el.isJsonNull()) return "";
		if (el.isJsonPrimitive()) return el.getAsString();
		StringBuilder sb = new StringBuilder();
		if (el.isJsonObject()) {
			JsonObject obj = el.getAsJsonObject();
			if (obj.has("text") && obj.get("text").isJsonPrimitive()) {
				sb.append(obj.get("text").getAsString());
			}
			if (obj.has("extra") && obj.get("extra").isJsonArray()) {
				for (JsonElement child : obj.getAsJsonArray("extra")) {
					sb.append(extractPlainText(child));
				}
			}
		} else if (el.isJsonArray()) {
			for (JsonElement child : el.getAsJsonArray()) {
				sb.append(extractPlainText(child));
			}
		}
		return sb.toString();
	}

	private static void sendPacket(DataOutputStream out, byte[] payload) throws IOException {
		ByteArrayOutputStream framed = new ByteArrayOutputStream();
		writeVarInt(framed, payload.length);
		framed.write(payload);
		out.write(framed.toByteArray());
	}

	private static void writeString(ByteArrayOutputStream out, String s) throws IOException {
		byte[] bytes = s.getBytes(StandardCharsets.UTF_8);
		writeVarInt(out, bytes.length);
		out.write(bytes);
	}

	private static void writeVarInt(ByteArrayOutputStream out, int value) {
		int v = value;
		do {
			int temp = v & 0x7F;
			v >>>= 7;
			if (v != 0) temp |= 0x80;
			out.write(temp);
		} while (v != 0);
	}

	private static int readVarInt(DataInputStream in) throws IOException {
		int numRead = 0;
		int result = 0;
		byte read;
		do {
			read = in.readByte();
			result |= (read & 0x7F) << (7 * numRead);
			numRead++;
			if (numRead > 5) throw new IOException("VarInt too big");
		} while ((read & 0x80) != 0);
		return result;
	}
}
