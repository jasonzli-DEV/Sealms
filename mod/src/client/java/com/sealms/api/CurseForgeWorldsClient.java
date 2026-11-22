package com.sealms.api;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.mojang.realmsclient.dto.WorldTemplate;
import com.sealms.SealmsConfig;

import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Queries the CurseForge Worlds API (classId=17, gameVersion=26.3, allowModDistribution=true)
 * directly from the client mod using the build-time injected API key.
 */
public final class CurseForgeWorldsClient {
	private static final String API_BASE = "https://api.curseforge.com/v1";
	private static final int MINECRAFT_GAME_ID = 432;
	private static final int WORLDS_CLASS_ID = 17;
	private static final String TARGET_GAME_VERSION = "26.3";

	private static final Gson GSON = new Gson();
	private static final HttpClient HTTP = HttpClient.newBuilder()
			.connectTimeout(Duration.ofSeconds(10))
			.build();

	// Maps template ID -> direct download URL for the selected CurseForge world .zip
	private static final Map<String, String> DOWNLOAD_URLS = new ConcurrentHashMap<>();

	public enum SortMode {
		POPULARITY(2, "Popularity"),
		TOTAL_DOWNLOADS(6, "Total Downloads"),
		LAST_UPDATED(3, "Last Updated");

		public final int sortField;
		public final String label;

		SortMode(int sortField, String label) {
			this.sortField = sortField;
			this.label = label;
		}

		public SortMode next() {
			SortMode[] vals = values();
			return vals[(ordinal() + 1) % vals.length];
		}
	}

	private CurseForgeWorldsClient() {}

	public static String getDownloadUrl(String templateId) {
		return DOWNLOAD_URLS.get(templateId);
	}

	public static List<WorldTemplate> searchWorlds(
			String searchFilter,
			SortMode sortMode,
			int pageIndex,
			int pageSize,
			WorldTemplate.WorldTemplateType templateType
	) throws Exception {
		String apiKey = SealmsConfig.getCurseForgeApiKey();
		if (apiKey == null || apiKey.isBlank()) {
			return List.of();
		}

		StringBuilder url = new StringBuilder(API_BASE)
				.append("/mods/search?gameId=").append(MINECRAFT_GAME_ID)
				.append("&classId=").append(WORLDS_CLASS_ID)
				.append("&gameVersion=").append(URLEncoder.encode(TARGET_GAME_VERSION, StandardCharsets.UTF_8))
				.append("&sortField=").append(sortMode.sortField)
				.append("&sortOrder=desc")
				.append("&index=").append(Math.max(0, pageIndex) * pageSize)
				.append("&pageSize=").append(pageSize);

		if (searchFilter != null && !searchFilter.isBlank()) {
			url.append("&searchFilter=").append(URLEncoder.encode(searchFilter.trim(), StandardCharsets.UTF_8));
		}

		HttpRequest req = HttpRequest.newBuilder()
				.uri(URI.create(url.toString()))
				.timeout(Duration.ofSeconds(15))
				.header("Accept", "application/json")
				.header("x-api-key", apiKey)
				.GET()
				.build();

		HttpResponse<String> res = HTTP.send(req, HttpResponse.BodyHandlers.ofString());
		if (res.statusCode() < 200 || res.statusCode() >= 300) {
			throw new IllegalStateException("CurseForge API returned HTTP " + res.statusCode());
		}

		JsonObject root = GSON.fromJson(res.body(), JsonObject.class);
		JsonArray data = root != null && root.has("data") ? root.getAsJsonArray("data") : new JsonArray();
		List<WorldTemplate> templates = new ArrayList<>();

		for (JsonElement el : data) {
			JsonObject mod = el.getAsJsonObject();
			if (mod.has("allowModDistribution") && !mod.get("allowModDistribution").getAsBoolean()) {
				continue;
			}
			String id = "cf-" + mod.get("id").getAsLong();
			String name = mod.has("name") ? mod.get("name").getAsString() : "World";
			String author = "CurseForge";
			if (mod.has("authors") && mod.getAsJsonArray("authors").size() > 0) {
				author = mod.getAsJsonArray("authors").get(0).getAsJsonObject().get("name").getAsString();
			}
			URI websiteUrl = null;
			if (mod.has("links") && mod.getAsJsonObject("links").has("websiteUrl")) {
				try {
					websiteUrl = URI.create(mod.getAsJsonObject("links").get("websiteUrl").getAsString());
				} catch (Exception ignored) {}
			}

			String downloadUrl = null;
			if (mod.has("latestFiles") && mod.getAsJsonArray("latestFiles").size() > 0) {
				for (JsonElement fileEl : mod.getAsJsonArray("latestFiles")) {
					JsonObject fileObj = fileEl.getAsJsonObject();
					if (fileObj.has("downloadUrl") && !fileObj.get("downloadUrl").isJsonNull()) {
						downloadUrl = fileObj.get("downloadUrl").getAsString();
						break;
					}
				}
			}
			if (downloadUrl == null || downloadUrl.isBlank()) {
				continue;
			}
			DOWNLOAD_URLS.put(id, downloadUrl);

			templates.add(new WorldTemplate(
					id,
					name,
					TARGET_GAME_VERSION,
					author,
					websiteUrl,
					null,
					null,
					"",
					templateType
			));
		}

		return templates;
	}
}
