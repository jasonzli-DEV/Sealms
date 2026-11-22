package com.sealms.mixin;

import com.mojang.realmsclient.RealmsMainScreen;
import com.mojang.realmsclient.dto.RealmsServer;
import com.mojang.realmsclient.gui.RealmsServerList;
import com.sealms.api.SealmsApiClient;
import com.sealms.ping.LocalSlpPinger;
import com.sealms.ui.AddSealmScreen;
import com.sealms.ui.JoinWithCodeScreen;
import net.minecraft.SharedConstants;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.network.chat.Component;
import net.minecraft.realms.RealmsScreen;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.Unique;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * Hooks "Add a Sealm" (replacing Buy a Realm / PDP), hooks "Join with Code",
 * and triggers async local SLP pings for live MOTDs, player counts, and
 * vanilla-parity server/client version compatibility checks.
 */
@Mixin(RealmsMainScreen.class)
public abstract class RealmsMainScreenMixin extends RealmsScreen {

	@Shadow
	private RealmsServerList serverList;

	@Shadow
	protected abstract void updateButtonStates();

	protected RealmsMainScreenMixin(Component title) {
		super(title);
	}

	@Inject(method = "openRealmsPdp", at = @At("HEAD"), cancellable = true)
	private void sealms$openAddSealmScreen(CallbackInfo ci) {
		this.minecraft.gui.setScreen(new AddSealmScreen(this));
		ci.cancel();
	}

	@Inject(method = "openPdpIfNoRealms", at = @At("HEAD"), cancellable = true)
	private void sealms$disableAutoPdpRedirect(CallbackInfo ci) {
		ci.cancel();
	}

	@Inject(method = "openJoinRealmScreen", at = @At("HEAD"), cancellable = true)
	private void sealms$openJoinWithCodeScreen(CallbackInfo ci) {
		Screen current = this.minecraft.gui.screen();
		this.minecraft.gui.setScreen(new JoinWithCodeScreen(current != null ? current : this));
		ci.cancel();
	}

	@Inject(method = "refreshListAndLayout", at = @At("TAIL"))
	private void sealms$triggerLocalSlpPings(CallbackInfo ci) {
		if (this.serverList == null) return;
		for (RealmsServer server : this.serverList) {
			String addr = SealmsApiClient.getServerAddress(server.id);
			if (addr != null) {
				sealms$applySlpStatus(server, LocalSlpPinger.getCached(server.id));
				LocalSlpPinger.pingAsync(server.id, addr, () -> this.minecraft.execute(() -> {
					sealms$applySlpStatus(server, LocalSlpPinger.getCached(server.id));
					this.updateButtonStates();
				}));
			}
		}
	}

	@Unique
	private static void sealms$applySlpStatus(RealmsServer server, LocalSlpPinger.PingStatus status) {
		if (status == null || !status.online()) {
			return;
		}
		if (status.motd() != null && !status.motd().isBlank()) {
			server.motd = status.motd() + " (" + status.playersOnline() + "/" + status.playersMax() + ")";
		} else {
			String base = (server.motd != null && !server.motd.equals("...")) ? server.motd : "Online";
			if (!base.contains("(")) {
				server.motd = base + " (" + status.playersOnline() + "/" + status.playersMax() + ")";
			}
		}

		// Vanilla Realms version compatibility handling
		int clientProtocol = SharedConstants.getCurrentVersion().protocolVersion();
		if (status.protocolVersion() > 0) {
			if (status.versionName() != null && !status.versionName().isBlank()) {
				server.activeVersion = status.versionName();
			}
			if (status.protocolVersion() == clientProtocol) {
				server.compatibility = RealmsServer.Compatibility.COMPATIBLE;
			} else if (status.protocolVersion() > clientProtocol) {
				server.compatibility = RealmsServer.Compatibility.NEEDS_UPGRADE;
			} else {
				server.compatibility = RealmsServer.Compatibility.NEEDS_DOWNGRADE;
			}
		}
	}
}
