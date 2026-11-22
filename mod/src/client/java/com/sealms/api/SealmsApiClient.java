package com.sealms.api;

import com.google.gson.Gson;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.sealms.SealmsConfig;
import com.sealms.auth.SealmsAuthManager;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * HTTP client for Sealms-specific backend routes (/sealms/*).
 */
public final class SealmsApiClient {
	private static final Gson GSON = new Gson();
	private static final HttpClient HTTP = HttpClient.newBuilder()
			.connectTimeout(Duration.ofSeconds(10))
			.build();

	// Cached server addresses by numeric realm ID (populated when /worlds is fetched)
	private static final Map<Long, String> SERVER_ADDRESSES = new ConcurrentHashMap<>();

	private SealmsApiClient() {}

	public static void recordServerAddress(long realmId, String address) {
		if (address != null && !address.isBlank()) {
			SERVER_ADDRESSES.put(realmId, address);
		}
	}

	public static String getServerAddress(long realmId) {
		return SERVER_ADDRESSES.get(realmId);
	}

	public record ResourceMetrics(
			String state,
			boolean suspended,
			double cpuPercent,
			double cpuLimitPercent,
			long memoryBytes,
			long memoryLimitBytes,
			long diskBytes,
			long diskLimitBytes,
			long networkRxBytes,
			long networkTxBytes,
			long uptimeMs,
			boolean allowMemberWake,
			boolean credentialsInvalid,
			String role
	) {}

	public record InviteCodeResult(String code, String url, String expiresAt) {}

	public static JsonObject linkServer(
			String panelUrl,
			String apiKey,
			String serverId,
			String name,
			boolean importWhitelist
	) throws Exception {
		JsonObject payload = new JsonObject();
		payload.addProperty("panelUrl", panelUrl);
		payload.addProperty("apiKey", apiKey);
		payload.addProperty("serverId", serverId);
		if (name != null && !name.isBlank()) {
			payload.addProperty("name", name);
		}
		payload.addProperty("importWhitelist", importWhitelist);
		return sendJson("POST", "/sealms", payload);
	}

	public static JsonObject redeemInviteCode(String codeOrUrl) throws Exception {
		JsonObject payload = new JsonObject();
		payload.addProperty("code", codeOrUrl);
		return sendJson("POST", "/sealms/invites/redeem", payload);
	}

	public static ResourceMetrics getResources(long realmId) throws Exception {
		JsonObject obj = sendJson("GET", "/sealms/" + realmId + "/resources", null);
		return new ResourceMetrics(
				getStr(obj, "state", "unknown"),
				getBool(obj, "isSuspended", false),
				getDouble(obj, "cpuPercent", 0),
				getDouble(obj, "cpuLimitPercent", 0),
				getLong(obj, "memoryBytes", 0),
				getLong(obj, "memoryLimitBytes", 0),
				getLong(obj, "diskBytes", 0),
				getLong(obj, "diskLimitBytes", 0),
				getLong(obj, "networkRxBytes", 0),
				getLong(obj, "networkTxBytes", 0),
				getLong(obj, "uptimeMs", 0),
				getBool(obj, "allowMemberWake", true),
				getBool(obj, "credentialsInvalid", false),
				getStr(obj, "role", "member")
		);
	}

	public static void restartServer(long realmId) throws Exception {
		sendJson("POST", "/sealms/" + realmId + "/restart", new JsonObject());
	}

	public static void updateCredentials(long realmId, String newApiKey) throws Exception {
		JsonObject payload = new JsonObject();
		payload.addProperty("apiKey", newApiKey);
		sendJson("PATCH", "/sealms/" + realmId + "/credentials", payload);
	}

	public static void setAllowMemberWake(long realmId, boolean allow) throws Exception {
		JsonObject payload = new JsonObject();
		payload.addProperty("allowMemberWake", allow);
		sendJson("PATCH", "/sealms/" + realmId + "/settings", payload);
	}

	public static void unlinkSealm(long realmId) throws Exception {
		sendJson("DELETE", "/sealms/" + realmId, null);
	}

	public static JsonObject syncWhitelist(long realmId) throws Exception {
		return sendJson("POST", "/sealms/" + realmId + "/sync-whitelist", new JsonObject());
	}

	public static InviteCodeResult createInviteCode(long realmId, Integer maxUses, int expiresInHours) throws Exception {
		JsonObject payload = new JsonObject();
		if (maxUses != null) {
			payload.addProperty("maxUses", maxUses);
		}
		payload.addProperty("expiresInHours", expiresInHours);
		JsonObject res = sendJson("POST", "/sealms/" + realmId + "/invites/code", payload);
		return new InviteCodeResult(
				getStr(res, "code", ""),
				getStr(res, "url", ""),
				getStr(res, "expiresAt", "")
		);
	}

	public static String requestSignedUploadUrl(long realmId) throws Exception {
		JsonObject res = sendJson("PUT", "/worlds/" + realmId + "/backups/upload", new JsonObject());
		return getStr(res, "uploadEndpoint", "");
	}

	public static void notifyUploadComplete(long realmId, String fileName, int slot, boolean minigame, String worldName) throws Exception {
		JsonObject payload = new JsonObject();
		payload.addProperty("fileName", fileName);
		payload.addProperty("slot", slot);
		payload.addProperty("minigame", minigame);
		if (worldName != null && !worldName.isBlank()) {
			payload.addProperty("worldName", worldName);
		}
		sendJson("POST", "/sealms/" + realmId + "/upload-complete", payload);
	}

	private static JsonObject sendJson(String method, String path, JsonObject body) throws Exception {
		String token = SealmsAuthManager.getOrFetchToken();
		HttpResponse<String> res = execute(method, path, body, token);
		if (res.statusCode() == 401) {
			SealmsAuthManager.invalidateToken();
			token = SealmsAuthManager.getOrFetchToken();
			res = execute(method, path, body, token);
		}
		if (res.statusCode() == 204) {
			return new JsonObject();
		}
		if (res.statusCode() < 200 || res.statusCode() >= 300) {
			String msg = res.body();
			try {
				JsonObject errObj = GSON.fromJson(res.body(), JsonObject.class);
				if (errObj != null && errObj.has("error")) {
					msg = errObj.get("error").getAsString();
				}
			} catch (Exception ignored) {
			}
			throw new IllegalStateException(msg != null && !msg.isBlank() ? msg : "HTTP " + res.statusCode());
		}
		if (res.body() == null || res.body().isBlank()) {
			return new JsonObject();
		}
		return GSON.fromJson(res.body(), JsonObject.class);
	}

	private static HttpResponse<String> execute(String method, String path, JsonObject body, String token) throws Exception {
		HttpRequest.Builder builder = HttpRequest.newBuilder()
				.uri(URI.create(SealmsConfig.buildUrl(path, null)))
				.timeout(Duration.ofSeconds(25))
				.header("Authorization", "Bearer " + token)
				.header("Accept", "application/json");

		if (body != null) {
			builder.header("Content-Type", "application/json");
			builder.method(method, HttpRequest.BodyPublishers.ofString(GSON.toJson(body)));
		} else {
			builder.method(method, HttpRequest.BodyPublishers.noBody());
		}
		return HTTP.send(builder.build(), HttpResponse.BodyHandlers.ofString());
	}

	private static String getStr(JsonObject obj, String key, String def) {
		JsonElement el = obj.get(key);
		return el != null && !el.isJsonNull() ? el.getAsString() : def;
	}

	private static boolean getBool(JsonObject obj, String key, boolean def) {
		JsonElement el = obj.get(key);
		return el != null && !el.isJsonNull() ? el.getAsBoolean() : def;
	}

	private static double getDouble(JsonObject obj, String key, double def) {
		JsonElement el = obj.get(key);
		return el != null && !el.isJsonNull() ? el.getAsDouble() : def;
	}

	private static long getLong(JsonObject obj, String key, long def) {
		JsonElement el = obj.get(key);
		return el != null && !el.isJsonNull() ? el.getAsLong() : def;
	}
}
