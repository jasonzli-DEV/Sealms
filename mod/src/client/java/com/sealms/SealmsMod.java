package com.sealms;

import net.fabricmc.api.ClientModInitializer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.spongepowered.asm.mixin.MixinEnvironment;

public class SealmsMod implements ClientModInitializer {
	public static final String MOD_ID = "sealms";
	public static final Logger LOGGER = LoggerFactory.getLogger(MOD_ID);

	@Override
	public void onInitializeClient() {
		SealmsConfig.load();
		LOGGER.info("Sealms initialized (backend={})", SealmsConfig.getBackendUrl());
		if (Boolean.getBoolean("sealms.auditMixins")) {
			LOGGER.info("Running Sealms Mixin audit...");
			MixinEnvironment.getCurrentEnvironment().audit();
			LOGGER.info("Sealms Mixin audit PASSED!");
			System.exit(0);
		}
	}
}
