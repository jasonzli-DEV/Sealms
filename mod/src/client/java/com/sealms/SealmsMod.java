package com.sealms;

import net.fabricmc.api.ClientModInitializer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public class SealmsMod implements ClientModInitializer {
	public static final String MOD_ID = "sealms";
	public static final Logger LOGGER = LoggerFactory.getLogger(MOD_ID);

	@Override
	public void onInitializeClient() {
		SealmsConfig.load();
		LOGGER.info("Sealms initialized (backend={})", SealmsConfig.getBackendUrl());
	}
}
