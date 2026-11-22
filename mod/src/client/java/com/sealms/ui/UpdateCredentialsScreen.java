package com.sealms.ui;

import com.sealms.api.SealmsApiClient;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.components.EditBox;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.network.chat.CommonComponents;
import net.minecraft.network.chat.Component;
import net.minecraft.realms.RealmsScreen;

import java.util.concurrent.CompletableFuture;

/**
 * Allows owners to replace a rotated or revoked Pterodactyl ptlc_ API key.
 */
public class UpdateCredentialsScreen extends RealmsScreen {
	private final Screen parent;
	private final long realmId;
	private EditBox apiKeyBox;
	private Button saveButton;
	private Component statusMessage = Component.empty();
	private int statusColor = 0xFFAAAAAA;

	public UpdateCredentialsScreen(Screen parent, long realmId) {
		super(Component.translatable("sealms.credentials.title"));
		this.parent = parent;
		this.realmId = realmId;
	}

	@Override
	protected void init() {
		int centerX = this.width / 2;
		int centerY = this.height / 2;

		this.apiKeyBox = new EditBox(this.font, centerX - 130, centerY - 20, 260, 20, Component.translatable("sealms.add.apiKey"));
		this.apiKeyBox.setMaxLength(256);
		this.apiKeyBox.setHint(Component.literal("ptlc_..."));
		this.addRenderableWidget(this.apiKeyBox);
		this.setInitialFocus(this.apiKeyBox);

		this.saveButton = Button.builder(Component.translatable("sealms.credentials.save"), b -> onSave())
				.bounds(centerX - 130, centerY + 14, 126, 20)
				.build();
		this.addRenderableWidget(this.saveButton);

		this.addRenderableWidget(Button.builder(CommonComponents.GUI_CANCEL, b -> onClose())
				.bounds(centerX + 4, centerY + 14, 126, 20)
				.build());
	}

	private void onSave() {
		String key = this.apiKeyBox.getValue().trim();
		if (key.isEmpty()) {
			this.statusMessage = Component.literal("Enter a valid ptlc_ API key.");
			this.statusColor = 0xFFF87171;
			return;
		}
		this.saveButton.active = false;
		this.statusMessage = Component.literal("Verifying new credentials...");
		this.statusColor = 0xFFAAAAAA;

		CompletableFuture.runAsync(() -> {
			try {
				SealmsApiClient.updateCredentials(this.realmId, key);
			} catch (Exception e) {
				throw new RuntimeException(e.getMessage(), e);
			}
		}).whenComplete((v, err) -> this.minecraft.execute(() -> {
			this.saveButton.active = true;
			if (err != null) {
				Throwable cause = err;
				while (cause.getCause() != null) cause = cause.getCause();
				this.statusMessage = Component.literal("Failed: " + cause.getMessage());
				this.statusColor = 0xFFF87171;
			} else {
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
		if (!this.statusMessage.getString().isEmpty()) {
			graphics.centeredText(this.font, this.statusMessage, centerX, centerY + 46, this.statusColor);
		}
	}

	@Override
	public void onClose() {
		this.minecraft.gui.setScreen(this.parent);
	}
}
