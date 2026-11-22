package com.sealms.ui;

import com.mojang.realmsclient.RealmsMainScreen;
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
 * Allows players to paste an invite code (SLM-XXXXX) or full mcsealms.vercel.app/invite/... URL
 * and redeem it to join a Sealm immediately.
 */
public class JoinWithCodeScreen extends RealmsScreen {
	private final Screen parent;
	private EditBox codeBox;
	private Button joinButton;
	private Component statusMessage = Component.empty();
	private int statusColor = 0xFFAAAAAA;
	private boolean busy = false;

	public JoinWithCodeScreen(Screen parent) {
		super(Component.translatable("sealms.join.title"));
		this.parent = parent;
	}

	@Override
	protected void init() {
		int centerX = this.width / 2;
		int centerY = this.height / 2;

		this.codeBox = new EditBox(this.font, centerX - 130, centerY - 20, 260, 20, Component.translatable("sealms.join.codeLabel"));
		this.codeBox.setMaxLength(256);
		this.codeBox.setHint(Component.literal("SLM-XXXXX or https://mcsealms.vercel.app/invite/..."));
		this.addRenderableWidget(this.codeBox);
		this.setInitialFocus(this.codeBox);

		this.joinButton = Button.builder(Component.translatable("sealms.join.submit"), b -> onRedeem())
				.bounds(centerX - 130, centerY + 14, 126, 20)
				.build();
		this.addRenderableWidget(this.joinButton);

		this.addRenderableWidget(Button.builder(CommonComponents.GUI_CANCEL, b -> onClose())
				.bounds(centerX + 4, centerY + 14, 126, 20)
				.build());
	}

	private void onRedeem() {
		if (busy) return;
		String code = this.codeBox.getValue().trim();
		if (code.isEmpty()) {
			this.statusMessage = Component.literal("Please paste an invite code or invite URL.");
			this.statusColor = 0xFFF87171;
			return;
		}
		this.busy = true;
		this.joinButton.active = false;
		this.statusMessage = Component.literal("Redeeming invite code...");
		this.statusColor = 0xFFAAAAAA;

		CompletableFuture.runAsync(() -> {
			try {
				SealmsApiClient.redeemInviteCode(code);
			} catch (Exception e) {
				throw new RuntimeException(e.getMessage(), e);
			}
		}).whenComplete((v, err) -> this.minecraft.execute(() -> {
			this.busy = false;
			this.joinButton.active = true;
			if (err != null) {
				Throwable cause = err;
				while (cause.getCause() != null) cause = cause.getCause();
				this.statusMessage = Component.literal("Failed: " + cause.getMessage());
				this.statusColor = 0xFFF87171;
			} else {
				RealmsMainScreen.refreshServerList();
				this.minecraft.gui.setScreen(this.parent);
			}
		}));
	}

	@Override
	public void extractRenderState(GuiGraphicsExtractor graphics, int mouseX, int mouseY, float delta) {
		super.extractRenderState(graphics, mouseX, mouseY, delta);
		int centerX = this.width / 2;
		int centerY = this.height / 2;

		graphics.centeredText(this.font, this.title, centerX, centerY - 56, 0xFFFFFFFF);
		graphics.text(this.font, Component.translatable("sealms.join.codeLabel"), centerX - 130, centerY - 33, 0xFFA0A0A0);
		if (!this.statusMessage.getString().isEmpty()) {
			graphics.centeredText(this.font, this.statusMessage, centerX, centerY + 46, this.statusColor);
		}
	}

	@Override
	public void onClose() {
		this.minecraft.gui.setScreen(this.parent);
	}
}
