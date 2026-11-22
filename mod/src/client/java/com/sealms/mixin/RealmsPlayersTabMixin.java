package com.sealms.mixin;

import com.mojang.realmsclient.dto.RealmsServer;
import com.mojang.realmsclient.gui.screens.configuration.RealmsConfigureWorldScreen;
import com.mojang.realmsclient.gui.screens.configuration.RealmsPlayersTab;
import com.sealms.api.SealmsApiClient;
import com.sealms.ui.SealmInviteCodeScreen;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.components.tabs.GridLayoutTab;
import net.minecraft.client.gui.layouts.LinearLayout;
import net.minecraft.network.chat.Component;
import org.spongepowered.asm.mixin.Final;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

import java.util.concurrent.CompletableFuture;

/**
 * Adds "Sync from Server" (reconciles manual /whitelist remove changes) and
 * "Create Invite Code" buttons to the Players tab.
 */
@Mixin(RealmsPlayersTab.class)
public abstract class RealmsPlayersTabMixin extends GridLayoutTab {

	@Shadow
	@Final
	private RealmsConfigureWorldScreen configurationScreen;

	@Shadow
	@Final
	private Minecraft minecraft;

	@Shadow
	private RealmsServer serverData;

	protected RealmsPlayersTabMixin(Component title) {
		super(title);
	}

	@Inject(method = "<init>", at = @At("TAIL"))
	private void sealms$addSyncAndInviteCodeButtons(
			RealmsConfigureWorldScreen configScreen,
			Minecraft mc,
			RealmsServer server,
			CallbackInfo ci
	) {
		LinearLayout bar = LinearLayout.horizontal().spacing(8);

		Button syncBtn = Button.builder(Component.translatable("sealms.players.sync"), b -> {
			if (this.serverData == null) return;
			b.active = false;
			CompletableFuture.runAsync(() -> {
				try {
					SealmsApiClient.syncWhitelist(this.serverData.id);
				} catch (Exception ignored) {
				}
			}).whenComplete((v, err) -> this.minecraft.execute(() -> {
				b.active = true;
				this.configurationScreen.fetchServerData(this.serverData.id);
			}));
		}).width(120).build();

		Button codeBtn = Button.builder(Component.translatable("sealms.players.inviteCode"), b -> {
			if (this.serverData == null) return;
			this.minecraft.gui.setScreen(new SealmInviteCodeScreen(this.configurationScreen, this.serverData.id));
		}).width(120).build();

		bar.addChild(syncBtn);
		bar.addChild(codeBtn);
		this.layout.addChild(bar, 2, 0);
	}
}
