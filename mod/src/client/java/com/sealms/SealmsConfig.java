package com.sealms;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonObject;
import net.fabricmc.loader.api.FabricLoader;

import java.io.IOException;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;

public final class SealmsConfig {
	private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();
	private static String backendUrl = SealmsBuildConfig.DEFAULT_BACKEND_URL;
	private static String curseforgeApiKey = SealmsBuildConfig.CURSEFORGE_API_KEY;

	private SealmsConfig() {}

	public static void load() {
		String sysBackend = System.getProperty("sealms.backendUrl");
		if (sysBackend != null && !sysBackend.isBlank()) {
			backendUrl = stripTrailingSlash(sysBackend);
		}
		String sysCfKey = System.getProperty("sealms.curseforgeApiKey");
		if (sysCfKey != null && !sysCfKey.isBlank()) {
			curseforgeApiKey = sysCfKey.trim();
		}

		Path cfgPath = FabricLoader.getInstance().getConfigDir().resolve("sealms.json");
		if (Files.exists(cfgPath)) {
			try {
				JsonObject obj = GSON.fromJson(Files.readString(cfgPath), JsonObject.class);
				if (obj != null) {
					if (obj.has("backendUrl") && !obj.get("backendUrl").getAsString().isBlank()) {
						backendUrl = stripTrailingSlash(obj.get("backendUrl").getAsString());
					}
					if (obj.has("curseforgeApiKey") && !obj.get("curseforgeApiKey").getAsString().isBlank()) {
						curseforgeApiKey = obj.get("curseforgeApiKey").getAsString().trim();
					}
				}
			} catch (Exception e) {
				SealmsMod.LOGGER.warn("Failed to read sealms.json config: {}", e.getMessage());
			}
		} else {
			saveDefault(cfgPath);
		}
	}

	private static void saveDefault(Path cfgPath) {
		try {
			Files.createDirectories(cfgPath.getParent());
			JsonObject obj = new JsonObject();
			obj.addProperty("backendUrl", backendUrl);
			Files.writeString(cfgPath, GSON.toJson(obj));
		} catch (IOException ignored) {
		}
	}

	public static String getBackendUrl() {
		return backendUrl;
	}

	public static String getCurseForgeApiKey() {
		return curseforgeApiKey;
	}

	public static String buildUrl(String path, String query) {
		String normalizedPath = path.startsWith("/") ? path : "/" + path;
		URI base = URI.create(backendUrl);
		StringBuilder sb = new StringBuilder();
		sb.append(base.getScheme()).append("://").append(base.getAuthority()).append(normalizedPath);
		if (query != null && !query.isBlank()) {
			sb.append('?').append(query);
		}
		return sb.toString();
	}

	private static String stripTrailingSlash(String url) {
		String trimmed = url.trim();
		while (trimmed.endsWith("/")) {
			trimmed = trimmed.substring(0, trimmed.length() - 1);
		}
		return trimmed;
	}
}
