package com.sealms.mixin;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.mojang.realmsclient.client.RealmsClient;
import com.mojang.realmsclient.client.Request;
import com.sealms.SealmsConfig;
import com.sealms.SealmsMod;
import com.sealms.api.SealmsApiClient;
import com.sealms.auth.SealmsAuthManager;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

import java.net.HttpURLConnection;

/**
 * Redirects RealmsClient HTTP URLs to Sealms backend, strips Mojang session cookies,
 * injects Authorization: Bearer <sealms_jwt>, and records server addresses for local SLP pings.
 */
@Mixin(RealmsClient.class)
public class RealmsClientMixin {

	@Inject(method = "url(Ljava/lang/String;Ljava/lang/String;Z)Ljava/lang/String;", at = @At("HEAD"), cancellable = true)
	private static void sealms$redirectUrl(String path, String query, boolean alternative, CallbackInfoReturnable<String> cir) {
		cir.setReturnValue(SealmsConfig.buildUrl(path, query));
	}

	@Inject(method = "frontendV2Url(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;", at = @At("HEAD"), cancellable = true)
	private static void sealms$redirectFrontendV2Url(String path, String query, CallbackInfoReturnable<String> cir) {
		cir.setReturnValue(SealmsConfig.buildUrl(path, query));
	}

	@Inject(method = "execute(Lcom/mojang/realmsclient/client/Request;)Ljava/lang/String;", at = @At("HEAD"))
	private void sealms$injectBearerToken(Request<?> request, CallbackInfoReturnable<String> cir) {
		try {
			HttpURLConnection conn = ((RequestAccessor) (Object) request).sealms$getConnection();
			if (conn != null) {
				String url = conn.getURL().toString();
				// Public endpoints do not require auth
				if (!url.contains("/mco/available")
						&& !url.contains("/mco/client/compatible")
						&& !url.contains("/feature/v1")) {
					String token = SealmsAuthManager.getOrFetchToken();
					conn.setRequestProperty("Authorization", "Bearer " + token);
				}
			}
		} catch (Exception e) {
			SealmsMod.LOGGER.warn("Failed to attach Sealms JWT to RealmsClient request: {}", e.getMessage());
		}
	}

	@Inject(method = "execute(Lcom/mojang/realmsclient/client/Request;)Ljava/lang/String;", at = @At("RETURN"))
	private void sealms$captureServerAddresses(Request<?> request, CallbackInfoReturnable<String> cir) {
		String body = cir.getReturnValue();
		if (body == null || !body.contains("sealmsAddress")) {
			return;
		}
		try {
			JsonElement root = JsonParser.parseString(body);
			if (!root.isJsonObject()) return;
			JsonObject obj = root.getAsJsonObject();
			if (obj.has("servers") && obj.get("servers").isJsonArray()) {
				JsonArray servers = obj.getAsJsonArray("servers");
				for (JsonElement el : servers) {
					if (el.isJsonObject()) {
						recordFromObject(el.getAsJsonObject());
					}
				}
			} else {
				recordFromObject(obj);
			}
		} catch (Exception ignored) {
		}
	}

	private static void recordFromObject(JsonObject obj) {
		if (obj.has("id") && obj.has("sealmsAddress") && !obj.get("sealmsAddress").isJsonNull()) {
			SealmsApiClient.recordServerAddress(
					obj.get("id").getAsLong(),
					obj.get("sealmsAddress").getAsString()
			);
		}
	}
}
