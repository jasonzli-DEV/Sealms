package com.sealms.mixin;

import com.mojang.realmsclient.client.Request;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * Ensures Mojang's sessionId ("sid") cookie is never attached to outgoing
 * RealmsClient HTTP requests sent to the Sealms backend.
 */
@Mixin(Request.class)
public class RequestMixin {

	@Inject(method = "cookie(Ljava/lang/String;Ljava/lang/String;)V", at = @At("HEAD"), cancellable = true)
	private void sealms$stripMojangSidCookie(String key, String value, CallbackInfo ci) {
		if ("sid".equals(key)) {
			ci.cancel();
		}
	}
}
