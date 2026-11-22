package com.sealms.api;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;

/**
 * Calls GET /api/client directly from the client mod during "Add a Sealm"
 * so owners can pick from their accessible Pterodactyl servers without sending
 * their key to Sealms until they confirm linking.
 */
public final class PteroDirectClient {
	private static final Gson GSON = new Gson();
	private static final HttpClient HTTP = HttpClient.newBuilder()
			.connectTimeout(Duration.ofSeconds(10))
			.followRedirects(HttpClient.Redirect.NORMAL)
			.build();

	public record PteroServerSummary(String identifier, String name, String description) {}

	private PteroDirectClient() {}

	public static List<PteroServerSummary> listAccessibleServers(String panelUrl, String apiKey) throws Exception {
		String base = panelUrl.trim();
		while (base.endsWith("/")) {
			base = base.substring(0, base.length() - 1);
		}
		HttpRequest req = HttpRequest.newBuilder()
				.uri(URI.create(base + "/api/client"))
				.timeout(Duration.ofSeconds(15))
				.header("Authorization", "Bearer " + apiKey.trim())
				.header("Accept", "application/json")
				.GET()
				.build();

		HttpResponse<String> res = HTTP.send(req, HttpResponse.BodyHandlers.ofString());
		if (res.statusCode() == 401 || res.statusCode() == 403) {
			throw new IllegalStateException("Invalid Pterodactyl API key (" + res.statusCode() + ")");
		}
		if (res.statusCode() < 200 || res.statusCode() >= 300) {
			throw new IllegalStateException("Panel returned HTTP " + res.statusCode());
		}

		JsonObject root = GSON.fromJson(res.body(), JsonObject.class);
		JsonArray data = root != null && root.has("data") ? root.getAsJsonArray("data") : new JsonArray();
		List<PteroServerSummary> result = new ArrayList<>();
		for (JsonElement el : data) {
			JsonObject attrs = el.getAsJsonObject().getAsJsonObject("attributes");
			if (attrs == null) continue;
			String id = attrs.has("identifier") ? attrs.get("identifier").getAsString() : "";
			String name = attrs.has("name") ? attrs.get("name").getAsString() : id;
			String desc = attrs.has("description") && !attrs.get("description").isJsonNull()
					? attrs.get("description").getAsString() : "";
			if (!id.isBlank()) {
				result.add(new PteroServerSummary(id, name, desc));
			}
		}
		return result;
	}
}
