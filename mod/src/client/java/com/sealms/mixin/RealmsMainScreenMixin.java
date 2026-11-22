package com.sealms.mixin;

import com.mojang.realmsclient.RealmsMainScreen;
import com.mojang.realmsclient.dto.RealmsServer;
import com.mojang.realmsclient.gui.RealmsServerList;
import com.mojang.realmsclient.gui.screens.RealmsPopups;
import com.sealms.api.SealmsApiClient;
import com.sealms.ping.LocalSlpPinger;
import com.sealms.ui.AddSealmScreen;
import com.sealms.ui.JoinWithCodeScreen;
import net.minecraft.SharedConstants;
import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.network.chat.Component;
import net.minecraft.realms.RealmsScreen;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.Unique;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

import java.util.concurrent.CompletableFuture;

/**
 * Hooks "Add a Sealm" (replacing Buy a Realm / PDP), hooks "Join with Code",
 * repurposes the Renew button as a 1-click "Restart" button for Owners/OPs,
 * allows Owners to "Unlink Sealm" via the Leave button, and triggers async local
 * SLP pings for live MOTDs, player counts, and version compatibility checks.
 */
@Mixin(RealmsMainScreen.class)
public abstract class RealmsMainScreenMixin extends RealmsScreen {

	@Shadow
	private RealmsServerList serverList;

	@Shadow
	private Button renewButton;

	@Shadow
	private Button leaveButton;

	@Shadow
	protected abstract void updateButtonStates();

	@Shadow
	protected abstract RealmsServer getSelectedServer();

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

	/**
	 * Repurpose the Renew button into a 1-click "Restart" button for Owners (and OPs).
	 */
	@Inject(method = "shouldRenewButtonBeActive", at = @At("HEAD"), cancellable = true)
	private void sealms$enableRestartButton(RealmsServer server, CallbackInfoReturnable<Boolean> cir) {
		if (server != null && this.minecraft.isLocalPlayer(server.ownerUUID)) {
			cir.setReturnValue(true);
		} else {
			cir.setReturnValue(false);
		}
	}

	@Inject(method = "onRenew", at = @At("HEAD"), cancellable = true)
	private void sealms$restartServerOnRenewClick(RealmsServer server, CallbackInfo ci) {
		ci.cancel();
		if (server == null) return;
		if (this.renewButton != null) {
			this.renewButton.active = false;
			this.renewButton.setMessage(Component.literal("Restarting..."));
		}
		CompletableFuture.runAsync(() -> {
			try {
				SealmsApiClient.restartServer(server.id);
			} catch (Exception ignored) {
			}
		}).whenComplete((v, err) -> this.minecraft.execute(() -> {
			if (this.renewButton != null) {
				this.renewButton.setMessage(Component.literal("Restart"));
				this.updateButtonStates();
			}
		}));
	}

	/**
	 * Allow both Members ("Leave Sealm") and Owners ("Unlink Sealm") to use the Leave button.
	 */
	@Inject(method = "shouldLeaveButtonBeActive", at = @At("HEAD"), cancellable = true)
	private void sealms$enableLeaveOrUnlink(RealmsServer server, CallbackInfoReturnable<Boolean> cir) {
		cir.setReturnValue(server != null);
	}

	@Inject(method = "leaveClicked", at = @At("HEAD"), cancellable = true)
	private void sealms$handleOwnerUnlinkOnLeaveClick(RealmsServer server, CallbackInfo ci) {
		if (server == null) return;
		if (this.minecraft.isLocalPlayer(server.ownerUUID)) {
			ci.cancel();
			Component msg = Component.literal("Unlink \"" + server.getName() + "\" and wipe its API key from Sealms? Your Pterodactyl server and worlds will NOT be deleted.");
			this.minecraft.gui.setScreen(RealmsPopups.infoPopupScreen(this, msg, popup -> {
				popup.onClose();
				CompletableFuture.runAsync(() -> {
					try {
						SealmsApiClient.unlinkSealm(server.id);
					} catch (Exception ignored) {
					}
				}).whenComplete((v, err) -> this.minecraft.execute(RealmsMainScreen::refreshServerList));
			}));
		}
	}

	@Inject(method = "updateButtonStates", at = @At("TAIL"))
	private void sealms$updateButtonLabels(CallbackInfo ci) {
		RealmsServer selected = this.getSelectedServer();
		if (this.renewButton != null && !"Restarting...".equals(this.renewButton.getMessage().getString())) {
			this.renewButton.setMessage(Component.literal("Restart"));
		}
		if (this.leaveButton != null) {
			boolean isOwner = selected != null && this.minecraft.isLocalPlayer(selected.ownerUUID);
			this.leaveButton.setMessage(Component.literal(isOwner ? "Unlink Sealm" : "Leave Sealm"));
		}
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
