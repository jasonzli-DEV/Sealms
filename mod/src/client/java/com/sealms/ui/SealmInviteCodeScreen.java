package com.sealms.ui;

import com.sealms.api.SealmsApiClient;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.network.chat.CommonComponents;
import net.minecraft.network.chat.Component;
import net.minecraft.realms.RealmsScreen;

import java.util.concurrent.CompletableFuture;

/**
 * Generates and copies shareable Sealms invite codes/links (SLM-XXXXX / mcsealms.vercel.app/invite/...).
 */
public class SealmInviteCodeScreen extends RealmsScreen {
	private final Screen parent;
	private final long realmId;

	private String generatedCode = "";
	private String generatedUrl = "";
	private Component statusMessage = Component.literal("Click Generate to create a 7-day invite link.");
	private Button generateButton;
	private Button copyCodeButton;
	private Button copyUrlButton;

	public SealmInviteCodeScreen(Screen parent, long realmId) {
		super(Component.translatable("sealms.players.inviteCode"));
		this.parent = parent;
		this.realmId = realmId;
	}

	@Override
	protected void init() {
		int centerX = this.width / 2;
		int centerY = this.height / 2;

		this.generateButton = Button.builder(Component.literal("Generate Invite Code"), b -> onGenerate())
				.bounds(centerX - 105, centerY - 26, 210, 20)
				.build();
		this.addRenderableWidget(this.generateButton);

		this.copyCodeButton = Button.builder(Component.literal("Copy Code"), b -> {
			if (!generatedCode.isEmpty()) {
				this.minecraft.keyboardHandler.setClipboard(generatedCode);
				this.statusMessage = Component.literal("Copied code: " + generatedCode);
			}
		}).bounds(centerX - 105, centerY + 2, 102, 20).build();
		this.copyCodeButton.active = !generatedCode.isEmpty();
		this.addRenderableWidget(this.copyCodeButton);

		this.copyUrlButton = Button.builder(Component.literal("Copy Link"), b -> {
			if (!generatedUrl.isEmpty()) {
				this.minecraft.keyboardHandler.setClipboard(generatedUrl);
				this.statusMessage = Component.literal("Copied invite URL!");
			}
		}).bounds(centerX + 3, centerY + 2, 102, 20).build();
		this.copyUrlButton.active = !generatedUrl.isEmpty();
		this.addRenderableWidget(this.copyUrlButton);

		this.addRenderableWidget(Button.builder(CommonComponents.GUI_DONE, b -> onClose())
				.bounds(centerX - 105, centerY + 34, 210, 20)
				.build());
	}

	private void onGenerate() {
		this.generateButton.active = false;
		this.statusMessage = Component.literal("Generating invite code...");
		CompletableFuture.supplyAsync(() -> {
			try {
				return SealmsApiClient.createInviteCode(this.realmId, null, 168);
			} catch (Exception e) {
				throw new RuntimeException(e.getMessage(), e);
			}
		}).whenComplete((res, err) -> this.minecraft.execute(() -> {
			this.generateButton.active = true;
			if (err != null) {
				Throwable cause = err;
				while (cause.getCause() != null) cause = cause.getCause();
				this.statusMessage = Component.literal("Failed: " + cause.getMessage());
			} else {
				this.generatedCode = res.code();
				this.generatedUrl = res.url();
				this.copyCodeButton.active = true;
				this.copyUrlButton.active = true;
				this.statusMessage = Component.literal("Created: " + res.code() + " (" + res.url() + ")");
			}
		}));
	}

	@Override
	public void extractRenderState(GuiGraphicsExtractor graphics, int mouseX, int mouseY, float delta) {
		super.extractRenderState(graphics, mouseX, mouseY, delta);
		int centerX = this.width / 2;
		int centerY = this.height / 2;
		graphics.centeredText(this.font, this.title, centerX, centerY - 58, 0xFFFFFFFF);
		graphics.centeredText(this.font, this.statusMessage, centerX, centerY + 66, 0xFF7DD3FC);
	}

	@Override
	public void onClose() {
		this.minecraft.gui.setScreen(this.parent);
	}
}
