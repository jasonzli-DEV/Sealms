package com.sealms.mixin;

import com.mojang.realmsclient.dto.RealmsServer;
import com.mojang.realmsclient.gui.screens.configuration.RealmsConfigureWorldScreen;
import com.mojang.realmsclient.gui.screens.configuration.RealmsSubscriptionTab;
import com.sealms.SealmsSelectionContext;
import com.sealms.ui.SealmResourcesTab;
import net.minecraft.client.gui.components.tabs.Tab;
import net.minecraft.network.chat.Component;
import net.minecraft.realms.RealmsScreen;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.ModifyArg;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * Swaps the vanilla Subscription tab for the live Pterodactyl SealmResourcesTab
 * and records the active Sealm in SealmsSelectionContext.
 */
@Mixin(RealmsConfigureWorldScreen.class)
public abstract class RealmsConfigureWorldScreenMixin extends RealmsScreen {

	@Shadow
	private RealmsServer serverData;

	protected RealmsConfigureWorldScreenMixin(Component title) {
		super(title);
	}

	@Inject(method = "onRealmsDataFetched", at = @At("HEAD"))
	private void sealms$recordActiveServer(CallbackInfo ci) {
		SealmsSelectionContext.setActiveServer(this.serverData);
	}

	@ModifyArg(
			method = "onRealmsDataFetched",
			at = @At(
					value = "INVOKE",
					target = "Lnet/minecraft/client/gui/components/tabs/MenuTabBar$Builder;addTabs([Lnet/minecraft/client/gui/components/tabs/Tab;)Lnet/minecraft/client/gui/components/tabs/MenuTabBar$Builder;"
			),
			index = 0
	)
	private Tab[] sealms$replaceSubscriptionTabWithResources(Tab[] tabs) {
		if (tabs == null || this.serverData == null) return tabs;
		for (int i = 0; i < tabs.length; i++) {
			if (tabs[i] instanceof RealmsSubscriptionTab) {
				tabs[i] = new SealmResourcesTab(
						(RealmsConfigureWorldScreen) (Object) this,
						this.minecraft,
						this.serverData
				);
			}
		}
		return tabs;
	}
}
