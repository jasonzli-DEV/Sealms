package com.sealms.ui;

import com.sealms.api.SealmsApiClient;
import com.sealms.api.WingsTransferClient;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.components.EditBox;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.network.chat.CommonComponents;
import net.minecraft.network.chat.Component;
import net.minecraft.realms.RealmsScreen;

import java.io.File;
import java.util.concurrent.CompletableFuture;

/**
 * Fallback "Load from URL" screen for direct .zip world links, as well as the
 * progress screen used when downloading a CurseForge World .zip and uploading it
 * directly to Pterodactyl Wings.
 */
public class LoadWorldFromUrlScreen extends RealmsScreen {
	private final Screen parent;
	private final long realmId;
	private final int slotId;
	private final boolean minigame;
	private final String initialUrl;
	private final String worldName;

	private EditBox urlBox;
	private Button loadButton;
	private volatile Component statusMessage = Component.empty();
	private volatile double progressFraction = -1;
	private boolean busy = false;

	public LoadWorldFromUrlScreen(Screen parent, long realmId, int slotId, boolean minigame, String initialUrl, String worldName) {
		super(Component.translatable("sealms.templates.loadUrl"));
		this.parent = parent;
		this.realmId = realmId;
		this.slotId = slotId;
		this.minigame = minigame;
		this.initialUrl = initialUrl != null ? initialUrl : "";
		this.worldName = worldName != null ? worldName : "Custom World";
	}

	@Override
	protected void init() {
		int centerX = this.width / 2;
		int centerY = this.height / 2;

		this.urlBox = new EditBox(this.font, centerX - 140, centerY - 22, 280, 20, Component.literal("Direct .zip URL"));
		this.urlBox.setMaxLength(1024);
		this.urlBox.setValue(this.initialUrl);
		this.urlBox.setHint(Component.literal("https://.../world.zip"));
		this.addRenderableWidget(this.urlBox);

		this.loadButton = Button.builder(Component.literal("Download & Upload to Sealm"), b -> startTransfer())
				.bounds(centerX - 140, centerY + 10, 180, 20)
				.build();
		this.addRenderableWidget(this.loadButton);

		this.addRenderableWidget(Button.builder(CommonComponents.GUI_CANCEL, b -> onClose())
				.bounds(centerX + 46, centerY + 10, 94, 20)
				.build());

		if (!this.initialUrl.isBlank() && !this.busy) {
			startTransfer();
		}
	}

	private void startTransfer() {
		if (busy) return;
		String url = this.urlBox.getValue().trim();
		if (!url.startsWith("http://") && !url.startsWith("https://")) {
			this.statusMessage = Component.literal("Enter a valid http(s):// .zip URL.");
			return;
		}
		if (this.realmId <= 0) {
			this.statusMessage = Component.literal("No active Sealm selected.");
			return;
		}

		this.busy = true;
		this.loadButton.active = false;
		this.progressFraction = 0.0;
		this.statusMessage = Component.literal("Downloading world archive...");

		CompletableFuture.runAsync(() -> {
			File tempZip = null;
			try {
				tempZip = WingsTransferClient.downloadZipToTemp(url, (read, total) -> {
					if (total > 0) {
						this.progressFraction = 0.5 * ((double) read / total);
					}
				});

				this.statusMessage = Component.literal("Requesting signed Wings upload URL...");
				String signedUploadUrl = SealmsApiClient.requestSignedUploadUrl(this.realmId);
				if (signedUploadUrl.isBlank()) {
					throw new IllegalStateException("Backend did not return a signed upload URL");
				}

				String remoteName = "sealms_upload_" + System.currentTimeMillis() + ".zip";
				this.statusMessage = Component.literal("Uploading world directly to Wings...");
				WingsTransferClient.uploadZipToWings(signedUploadUrl, tempZip, remoteName, (sent, total) -> {
					if (total > 0) {
						this.progressFraction = 0.5 + 0.45 * ((double) sent / total);
					}
				});

				this.statusMessage = Component.literal("Extracting world & restarting server...");
				this.progressFraction = 0.96;
				SealmsApiClient.notifyUploadComplete(this.realmId, remoteName, this.slotId, this.minigame, this.worldName);
				this.progressFraction = 1.0;
			} catch (Exception e) {
				throw new RuntimeException(e.getMessage(), e);
			} finally {
				if (tempZip != null && tempZip.exists()) {
					tempZip.delete();
				}
			}
		}).whenComplete((v, err) -> this.minecraft.execute(() -> {
			this.busy = false;
			this.loadButton.active = true;
			if (err != null) {
				Throwable cause = err;
				while (cause.getCause() != null) cause = cause.getCause();
				this.statusMessage = Component.literal("Transfer failed: " + cause.getMessage());
				this.progressFraction = -1;
			} else {
				this.statusMessage = Component.literal("World uploaded & applied!");
				this.minecraft.gui.setScreen(this.parent);
			}
		}));
	}

	@Override
	public void extractRenderState(GuiGraphicsExtractor graphics, int mouseX, int mouseY, float delta) {
		super.extractRenderState(graphics, mouseX, mouseY, delta);
		int centerX = this.width / 2;
		int centerY = this.height / 2;
		graphics.centeredText(this.font, this.title, centerX, centerY - 52, 0xFFFFFFFF);
		graphics.centeredText(this.font, this.statusMessage, centerX, centerY + 42, 0xFF7DD3FC);

		if (this.progressFraction >= 0) {
			int barW = 240;
			int barX = centerX - barW / 2;
			int barY = centerY + 58;
			graphics.fill(barX, barY, barX + barW, barY + 8, 0xFF1E293B);
			int fillW = (int) (barW * Math.max(0.0, Math.min(1.0, this.progressFraction)));
			graphics.fill(barX, barY, barX + fillW, barY + 8, 0xFF38BDF8);
		}
	}

	@Override
	public void onClose() {
		this.minecraft.gui.setScreen(this.parent);
	}
}
