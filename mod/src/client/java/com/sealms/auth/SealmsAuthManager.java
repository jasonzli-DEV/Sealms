package com.sealms.auth;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.mojang.authlib.minecraft.SessionService;
import com.sealms.SealmsConfig;
import com.sealms.SealmsMod;
import net.minecraft.client.Minecraft;
import net.minecraft.client.User;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.UUID;

/**
 * Authenticates the client against the Sealms backend using Mojang's official
 * joinServer / hasJoined handshake. Mojang access tokens never leave the client.
 */
public final class SealmsAuthManager {
	private static final Gson GSON = new Gson();
	private static final HttpClient HTTP = HttpClient.newBuilder()
			.connectTimeout(Duration.ofSeconds(10))
			.build();

	private static volatile String cachedToken;
	private static volatile UUID cachedUserUuid;
	private static volatile long tokenIssuedAtMs;
	private static final long TOKEN_REFRESH_MS = 6L * 24 * 60 * 60 * 1000; // 6 days

	private SealmsAuthManager() {}

	public static synchronized String getOrFetchToken() throws Exception {
		Minecraft mc = Minecraft.getInstance();
		User user = mc.getUser();
		UUID currentUuid = user.getProfileId();

		if (cachedToken != null
				&& currentUuid.equals(cachedUserUuid)
				&& (System.currentTimeMillis() - tokenIssuedAtMs) < TOKEN_REFRESH_MS) {
			return cachedToken;
		}

		return authenticate(mc, user);
	}

	public static synchronized void invalidateToken() {
		cachedToken = null;
		tokenIssuedAtMs = 0;
	}

	private static String authenticate(Minecraft mc, User user) throws Exception {
		// 1. Request a 60s nonce (serverId) from Sealms backend
		HttpRequest challengeReq = HttpRequest.newBuilder()
				.uri(URI.create(SealmsConfig.buildUrl("/sealms/auth/challenge", null)))
				.timeout(Duration.ofSeconds(15))
				.header("Accept", "application/json")
				.POST(HttpRequest.BodyPublishers.noBody())
				.build();

		HttpResponse<String> challengeRes = HTTP.send(challengeReq, HttpResponse.BodyHandlers.ofString());
		if (challengeRes.statusCode() != 200) {
			throw new IllegalStateException("Sealms auth challenge failed (" + challengeRes.statusCode() + ")");
		}

		JsonObject challengeJson = GSON.fromJson(challengeRes.body(), JsonObject.class);
		String serverId = challengeJson.get("serverId").getAsString();

		// 2. Perform Mojang joinServer locally (accessToken stays strictly on client -> Mojang)
		SessionService sessionService = mc.services().sessionService();
		sessionService.joinServer(user.getProfileId(), user.getAccessToken(), serverId);

		// 3. Verify with Sealms backend (backend checks Mojang hasJoined -> issues stateless JWT)
		JsonObject verifyBody = new JsonObject();
		verifyBody.addProperty("username", user.getName());
		verifyBody.addProperty("serverId", serverId);

		HttpRequest verifyReq = HttpRequest.newBuilder()
				.uri(URI.create(SealmsConfig.buildUrl("/sealms/auth/verify", null)))
				.timeout(Duration.ofSeconds(15))
				.header("Content-Type", "application/json")
				.header("Accept", "application/json")
				.POST(HttpRequest.BodyPublishers.ofString(GSON.toJson(verifyBody)))
				.build();

		HttpResponse<String> verifyRes = HTTP.send(verifyReq, HttpResponse.BodyHandlers.ofString());
		if (verifyRes.statusCode() != 200) {
			throw new IllegalStateException("Sealms auth verify failed (" + verifyRes.statusCode() + "): " + verifyRes.body());
		}

		JsonObject verifyJson = GSON.fromJson(verifyRes.body(), JsonObject.class);
		String token = verifyJson.get("token").getAsString();

		cachedToken = token;
		cachedUserUuid = user.getProfileId();
		tokenIssuedAtMs = System.currentTimeMillis();
		SealmsMod.LOGGER.info("Authenticated with Sealms as {}", user.getName());
		return token;
	}
}
