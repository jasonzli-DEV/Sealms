package com.sealms.mixin;

import com.mojang.realmsclient.client.FileUpload;
import com.mojang.realmsclient.client.UploadStatus;
import com.mojang.realmsclient.dto.UploadInfo;
import com.mojang.realmsclient.gui.screens.UploadResult;
import com.sealms.SealmsMod;
import com.sealms.api.SealmsApiClient;
import com.sealms.api.WingsTransferClient;
import org.spongepowered.asm.mixin.Final;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

import java.io.File;
import java.util.concurrent.CompletableFuture;

/**
 * Redirects vanilla Realms world uploads directly to Pterodactyl Wings using
 * the signed upload URL returned by PUT /worlds/:id/backups/upload, feeding
 * progress directly into vanilla's UploadStatus progress bar, then notifies
 * POST /sealms/:id/upload-complete to decompress and bind level-name.
 */
@Mixin(FileUpload.class)
public class FileUploadMixin {

	@Shadow
	@Final
	private File file;

	@Shadow
	@Final
	private long realmId;

	@Shadow
	@Final
	private int slotId;

	@Shadow
	@Final
	private UploadInfo uploadInfo;

	@Shadow
	@Final
	private UploadStatus uploadStatus;

	@Inject(method = "startUpload", at = @At("HEAD"), cancellable = true)
	private void sealms$directWingsUpload(CallbackInfoReturnable<CompletableFuture<UploadResult>> cir) {
		if (this.uploadInfo == null || this.uploadInfo.uploadEndpoint() == null) {
			return;
		}
		String signedUrl = this.uploadInfo.uploadEndpoint().toString();
		cir.setReturnValue(CompletableFuture.supplyAsync(() -> {
			try {
				String remoteName = "sealms_slot" + this.slotId + "_" + System.currentTimeMillis() + ".zip";
				WingsTransferClient.uploadZipToWings(signedUrl, this.file, remoteName, (sent, total) -> {
					this.uploadStatus.onWrite(sent);
				});
				SealmsApiClient.notifyUploadComplete(this.realmId, remoteName, this.slotId, false, null);
				return new UploadResult(204, null);
			} catch (Exception e) {
				SealmsMod.LOGGER.error("Direct Wings world upload failed", e);
				return new UploadResult(500, e.getMessage());
			}
		}));
	}
}
