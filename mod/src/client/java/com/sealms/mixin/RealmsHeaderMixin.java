package com.sealms.mixin;

import com.mojang.realmsclient.gui.RealmsHeader;
import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.components.ImageWidget;
import net.minecraft.client.gui.layouts.Layout;
import org.spongepowered.asm.mixin.Final;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

import java.net.URI;

/**
 * Cleanly hides the top-right Realms News envelope icon without shifting
 * remaining header controls.
 */
@Mixin(RealmsHeader.class)
public class RealmsHeaderMixin {

	@Shadow
	@Final
	private Button newsButton;

	@Inject(method = "createLayout", at = @At("HEAD"))
	private void sealms$hideNewsButton(ImageWidget logo, int headerHeight, int width, CallbackInfoReturnable<Layout> cir) {
		if (this.newsButton != null) {
			this.newsButton.visible = false;
			this.newsButton.active = false;
		}
	}

	@Inject(method = "setNews", at = @At("HEAD"), cancellable = true)
	private void sealms$suppressNewsUpdates(URI uri, boolean hasUnread, CallbackInfo ci) {
		if (this.newsButton != null) {
			this.newsButton.visible = false;
			this.newsButton.active = false;
		}
		ci.cancel();
	}
}
