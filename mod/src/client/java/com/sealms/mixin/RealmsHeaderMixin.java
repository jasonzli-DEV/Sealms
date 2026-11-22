package com.sealms.mixin;

import com.mojang.realmsclient.gui.RealmsHeader;
import net.minecraft.client.gui.components.AbstractWidget;
import net.minecraft.client.gui.components.ImageWidget;
import net.minecraft.client.gui.layouts.Layout;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Unique;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

import java.lang.reflect.Field;
import java.net.URI;

/**
 * Cleanly hides the top-right Realms News envelope icon without shifting
 * remaining header controls.
 */
@Mixin(RealmsHeader.class)
public class RealmsHeaderMixin {

	@Unique
	private void sealms$disableNewsWidget() {
		try {
			Field field = RealmsHeader.class.getDeclaredField("newsButton");
			field.setAccessible(true);
			Object btn = field.get(this);
			if (btn instanceof AbstractWidget widget) {
				widget.visible = false;
				widget.active = false;
				widget.setWidth(0);
				widget.setHeight(0);
			}
		} catch (Throwable ignored) {
		}
	}

	@Inject(method = "<init>", at = @At("TAIL"))
	private void sealms$hideNewsOnConstruct(CallbackInfo ci) {
		sealms$disableNewsWidget();
	}

	@Inject(method = "createLayout", at = @At("RETURN"))
	private void sealms$hideNewsAfterLayout(ImageWidget logo, int headerHeight, int width, CallbackInfoReturnable<Layout> cir) {
		sealms$disableNewsWidget();
	}

	@Inject(method = "setNews", at = @At("HEAD"), cancellable = true)
	private void sealms$suppressNewsUpdates(URI uri, boolean hasUnread, CallbackInfo ci) {
		sealms$disableNewsWidget();
		ci.cancel();
	}
}
