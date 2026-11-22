package com.sealms.mixin;

import com.mojang.realmsclient.util.task.GetServerDetailsTask;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.Constant;
import org.spongepowered.asm.mixin.injection.ModifyConstant;

/**
 * Extends the maximum 503 Retry-After loop count from 40 to 120 retries
 * so heavy modded Pterodactyl servers that take 2-3+ minutes to boot
 * never time out during seamless auto-start.
 */
@Mixin(GetServerDetailsTask.class)
public class GetServerDetailsTaskMixin {

	@ModifyConstant(method = "fetchServerAddress", constant = @Constant(intValue = 40))
	private int sealms$extendAutoStartRetries(int original) {
		return 120;
	}
}
