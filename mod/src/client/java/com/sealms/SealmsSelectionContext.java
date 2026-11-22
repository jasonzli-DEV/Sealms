package com.sealms;

import com.mojang.realmsclient.dto.RealmsServer;

/**
 * Tracks the currently active Sealm being configured so template/URL uploads
 * know which Sealm ID and slot to target.
 */
public final class SealmsSelectionContext {
	private static volatile long activeRealmId = -1L;
	private static volatile int activeSlot = 1;

	private SealmsSelectionContext() {}

	public static void setActiveServer(RealmsServer server) {
		if (server != null) {
			activeRealmId = server.id;
			activeSlot = Math.max(1, Math.min(3, server.activeSlot));
		}
	}

	public static long getActiveRealmId() {
		return activeRealmId;
	}

	public static int getActiveSlot() {
		return activeSlot;
	}
}
