package com.sealms.ui;

import com.mojang.realmsclient.RealmsMainScreen;
import com.mojang.realmsclient.dto.RealmsServer;
import com.mojang.realmsclient.gui.screens.configuration.RealmsConfigurationTab;
import com.mojang.realmsclient.gui.screens.configuration.RealmsConfigureWorldScreen;
import com.sealms.api.SealmsApiClient;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.Font;
import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.components.StringWidget;
import net.minecraft.client.gui.components.tabs.GridLayoutTab;
import net.minecraft.client.gui.layouts.GridLayout;
import net.minecraft.network.chat.Component;

import java.util.concurrent.CompletableFuture;

/**
 * Replaces the vanilla Subscription tab in RealmsConfigureWorldScreen with live
 * Pterodactyl server metrics (CPU %, RAM, Disk, Uptime, Network I/O), Restart button,
 * "Allow members to wake server" toggle, Update Credentials, and Unlink Sealm.
 */
public class SealmResourcesTab extends GridLayoutTab implements RealmsConfigurationTab {
	public static final Component TITLE = Component.translatable("sealms.resources.title");

	private final RealmsConfigureWorldScreen configScreen;
	private final Minecraft minecraft;
	private RealmsServer serverData;

	private final StringWidget statusLabel;
	private final StringWidget cpuLabel;
	private final StringWidget ramLabel;
	private final StringWidget diskLabel;
	private final StringWidget uptimeLabel;
	private final StringWidget networkLabel;
	private final StringWidget feedbackLabel;

	private final Button refreshButton;
	private final Button restartButton;
	private final Button allowWakeButton;
	private final Button updateCredsButton;
	private final Button unlinkButton;

	private boolean allowMemberWake = true;
	private boolean isOwner = true;

	public SealmResourcesTab(
			RealmsConfigureWorldScreen configScreen,
			Minecraft minecraft,
			RealmsServer serverData
	) {
		super(TITLE);
		this.configScreen = configScreen;
		this.minecraft = minecraft;
		this.serverData = serverData;

		Font font = minecraft.font;
		GridLayout.RowHelper rows = this.layout.rowSpacing(6).createRowHelper(1);

		this.statusLabel = rows.addChild(new StringWidget(Component.literal("Status: Loading..."), font));
		this.cpuLabel = rows.addChild(new StringWidget(Component.literal("CPU: --"), font));
		this.ramLabel = rows.addChild(new StringWidget(Component.literal("RAM: --"), font));
		this.diskLabel = rows.addChild(new StringWidget(Component.literal("Disk: --"), font));
		this.uptimeLabel = rows.addChild(new StringWidget(Component.literal("Uptime: --"), font));
		this.networkLabel = rows.addChild(new StringWidget(Component.literal("Network I/O: --"), font));

		this.refreshButton = rows.addChild(Button.builder(Component.translatable("sealms.resources.refresh"), b -> fetchMetrics())
				.width(210).build());
		this.restartButton = rows.addChild(Button.builder(Component.translatable("sealms.resources.restart"), b -> onRestart())
				.width(210).build());
		this.allowWakeButton = rows.addChild(Button.builder(Component.translatable("sealms.resources.allowWake.on"), b -> onToggleWake())
				.width(210).build());
		this.updateCredsButton = rows.addChild(Button.builder(Component.translatable("sealms.resources.updateCredentials"),
				b -> this.minecraft.gui.setScreen(new UpdateCredentialsScreen(this.configScreen, this.serverData.id)))
				.width(210).build());
		this.unlinkButton = rows.addChild(Button.builder(Component.translatable("sealms.resources.unlink"), b -> onUnlink())
				.width(210).build());

		this.feedbackLabel = rows.addChild(new StringWidget(Component.empty(), font));
	}

	@Override
	public void onSelected(RealmsServer server) {
		this.serverData = server;
		fetchMetrics();
	}

	@Override
	public void updateData(RealmsServer server) {
		this.serverData = server;
	}

	private void fetchMetrics() {
		if (this.serverData == null) return;
		this.refreshButton.active = false;
		this.feedbackLabel.setMessage(Component.literal("Refreshing live metrics..."));

		CompletableFuture.supplyAsync(() -> {
			try {
				return SealmsApiClient.getResources(this.serverData.id);
			} catch (Exception e) {
				throw new RuntimeException(e.getMessage(), e);
			}
		}).whenComplete((m, err) -> this.minecraft.execute(() -> {
			this.refreshButton.active = true;
			if (err != null) {
				Throwable cause = err;
				while (cause.getCause() != null) cause = cause.getCause();
				this.statusLabel.setMessage(Component.literal("Status: Error / Credentials Invalid"));
				this.feedbackLabel.setMessage(Component.literal(cause.getMessage() != null ? cause.getMessage() : "Failed to load resources"));
				return;
			}
			this.allowMemberWake = m.allowMemberWake();
			this.isOwner = "owner".equalsIgnoreCase(m.role());

			this.statusLabel.setMessage(Component.literal("Status: " + m.state().toUpperCase() + (m.suspended() ? " (SUSPENDED)" : "")));
			String cpuLimit = m.cpuLimitPercent() > 0 ? String.format(" / %.0f%%", m.cpuLimitPercent()) : "";
			this.cpuLabel.setMessage(Component.literal(String.format("CPU: %.1f%%%s", m.cpuPercent(), cpuLimit)));
			this.ramLabel.setMessage(Component.literal("RAM: " + formatBytes(m.memoryBytes()) + " / " + formatBytes(m.memoryLimitBytes())));
			this.diskLabel.setMessage(Component.literal("Disk: " + formatBytes(m.diskBytes()) + " / " + formatBytes(m.diskLimitBytes())));
			this.uptimeLabel.setMessage(Component.literal("Uptime: " + formatDuration(m.uptimeMs())));
			this.networkLabel.setMessage(Component.literal("Network: RX " + formatBytes(m.networkRxBytes()) + " / TX " + formatBytes(m.networkTxBytes())));

			this.allowWakeButton.setMessage(Component.translatable(
					this.allowMemberWake ? "sealms.resources.allowWake.on" : "sealms.resources.allowWake.off"));
			this.allowWakeButton.visible = this.isOwner;
			this.updateCredsButton.visible = this.isOwner;
			this.unlinkButton.visible = this.isOwner;
			this.feedbackLabel.setMessage(Component.empty());
		}));
	}

	private void onRestart() {
		if (this.serverData == null) return;
		this.restartButton.active = false;
		this.feedbackLabel.setMessage(Component.literal("Sending restart signal..."));
		CompletableFuture.runAsync(() -> {
			try {
				SealmsApiClient.restartServer(this.serverData.id);
			} catch (Exception e) {
				throw new RuntimeException(e.getMessage(), e);
			}
		}).whenComplete((v, err) -> this.minecraft.execute(() -> {
			this.restartButton.active = true;
			if (err != null) {
				this.feedbackLabel.setMessage(Component.literal("Restart failed: " + err.getMessage()));
			} else {
				this.feedbackLabel.setMessage(Component.literal("Restart signal sent!"));
			}
		}));
	}

	private void onToggleWake() {
		if (this.serverData == null || !this.isOwner) return;
		boolean next = !this.allowMemberWake;
		this.allowWakeButton.active = false;
		CompletableFuture.runAsync(() -> {
			try {
				SealmsApiClient.setAllowMemberWake(this.serverData.id, next);
			} catch (Exception e) {
				throw new RuntimeException(e.getMessage(), e);
			}
		}).whenComplete((v, err) -> this.minecraft.execute(() -> {
			this.allowWakeButton.active = true;
			if (err == null) {
				this.allowMemberWake = next;
				this.allowWakeButton.setMessage(Component.translatable(
						this.allowMemberWake ? "sealms.resources.allowWake.on" : "sealms.resources.allowWake.off"));
				this.feedbackLabel.setMessage(Component.literal("Saved auto-start preference."));
			} else {
				this.feedbackLabel.setMessage(Component.literal("Failed to update setting."));
			}
		}));
	}

	private void onUnlink() {
		if (this.serverData == null || !this.isOwner) return;
		this.unlinkButton.active = false;
		this.feedbackLabel.setMessage(Component.literal("Unlinking Sealm & wiping encrypted API key..."));
		CompletableFuture.runAsync(() -> {
			try {
				SealmsApiClient.unlinkSealm(this.serverData.id);
			} catch (Exception e) {
				throw new RuntimeException(e.getMessage(), e);
			}
		}).whenComplete((v, err) -> this.minecraft.execute(() -> {
			if (err == null) {
				RealmsMainScreen.refreshServerList();
				this.minecraft.gui.setScreen(this.configScreen.getLastScreen());
			} else {
				this.unlinkButton.active = true;
				this.feedbackLabel.setMessage(Component.literal("Unlink failed: " + err.getMessage()));
			}
		}));
	}

	private static String formatBytes(long bytes) {
		if (bytes <= 0) return "0 B";
		if (bytes < 1024) return bytes + " B";
		double kb = bytes / 1024.0;
		if (kb < 1024) return String.format("%.1f KB", kb);
		double mb = kb / 1024.0;
		if (mb < 1024) return String.format("%.1f MB", mb);
		return String.format("%.2f GB", mb / 1024.0);
	}

	private static String formatDuration(long ms) {
		if (ms <= 0) return "Offline";
		long totalSec = ms / 1000;
		long hrs = totalSec / 3600;
		long mins = (totalSec % 3600) / 60;
		long secs = totalSec % 60;
		if (hrs > 0) return String.format("%dh %dm %ds", hrs, mins, secs);
		if (mins > 0) return String.format("%dm %ds", mins, secs);
		return secs + "s";
	}
}
