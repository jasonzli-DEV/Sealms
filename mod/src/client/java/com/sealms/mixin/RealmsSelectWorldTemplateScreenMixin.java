package com.sealms.mixin;

import com.mojang.datafixers.util.Either;
import com.mojang.realmsclient.client.RealmsClient;
import com.mojang.realmsclient.dto.RealmsServer;
import com.mojang.realmsclient.dto.WorldTemplate;
import com.mojang.realmsclient.dto.WorldTemplatePaginatedList;
import com.mojang.realmsclient.gui.screens.RealmsSelectWorldTemplateScreen;
import com.sealms.SealmsSelectionContext;
import com.sealms.api.CurseForgeWorldsClient;
import com.sealms.ui.LoadWorldFromUrlScreen;
import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.components.EditBox;
import net.minecraft.network.chat.Component;
import net.minecraft.realms.RealmsScreen;
import org.spongepowered.asm.mixin.Final;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.Unique;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

import java.util.List;

/**
 * Replaces vanilla template catalog fetching with direct client-side CurseForge Worlds API
 * queries (classId=17, gameVersion=26.3, allowModDistribution=true), adds a compact search box,
 * cycle sort button (Popularity -> Total Downloads -> Last Updated), and "Load from URL" fallback.
 */
@Mixin(RealmsSelectWorldTemplateScreen.class)
public abstract class RealmsSelectWorldTemplateScreenMixin extends RealmsScreen {

	@Shadow
	@Final
	private RealmsServer.WorldType worldType;

	@Shadow
	private WorldTemplate selectedTemplate;

	@Shadow
	protected abstract void fetchTemplatesAsync(WorldTemplatePaginatedList list);

	@Unique
	private EditBox sealms$searchBox;

	@Unique
	private Button sealms$sortButton;

	@Unique
	private CurseForgeWorldsClient.SortMode sealms$sortMode = CurseForgeWorldsClient.SortMode.POPULARITY;

	@Unique
	private String sealms$currentQuery = "";

	protected RealmsSelectWorldTemplateScreenMixin(Component title) {
		super(title);
	}

	@Inject(method = "init", at = @At("TAIL"))
	private void sealms$addCurseForgeControls(CallbackInfo ci) {
		int topY = 8;
		int centerX = this.width / 2;

		this.sealms$searchBox = new EditBox(this.font, centerX - 185, topY, 150, 18, Component.translatable("sealms.templates.search"));
		this.sealms$searchBox.setHint(Component.translatable("sealms.templates.search"));
		this.sealms$searchBox.setValue(this.sealms$currentQuery);
		this.sealms$searchBox.setResponder(q -> this.sealms$currentQuery = q);
		this.addRenderableWidget(this.sealms$searchBox);

		this.addRenderableWidget(Button.builder(Component.literal("Search"), b -> sealms$reloadCatalog())
				.bounds(centerX - 31, topY, 50, 18)
				.build());

		this.sealms$sortButton = Button.builder(Component.literal("Sort: " + this.sealms$sortMode.label), b -> {
			this.sealms$sortMode = this.sealms$sortMode.next();
			b.setMessage(Component.literal("Sort: " + this.sealms$sortMode.label));
			sealms$reloadCatalog();
		}).bounds(centerX + 23, topY, 115, 18).build();
		this.addRenderableWidget(this.sealms$sortButton);

		this.addRenderableWidget(Button.builder(Component.translatable("sealms.templates.loadUrl"), b -> {
			boolean isMinigame = this.worldType == RealmsServer.WorldType.MINIGAME;
			this.minecraft.gui.setScreen(new LoadWorldFromUrlScreen(
					this,
					SealmsSelectionContext.getActiveRealmId(),
					SealmsSelectionContext.getActiveSlot(),
					isMinigame,
					"",
					"Custom URL World"
			));
		}).bounds(centerX + 142, topY, 85, 18).build());
	}

	@Unique
	private void sealms$reloadCatalog() {
		this.fetchTemplatesAsync(new WorldTemplatePaginatedList(10));
	}

	@Inject(method = "fetchTemplates", at = @At("HEAD"), cancellable = true)
	private void sealms$fetchCurseForgeWorlds(
			WorldTemplatePaginatedList currentList,
			RealmsClient client,
			CallbackInfoReturnable<Either<WorldTemplatePaginatedList, Exception>> cir
	) {
		try {
			int nextPage = currentList != null ? currentList.page() : 0;
			WorldTemplate.WorldTemplateType type = this.worldType == RealmsServer.WorldType.MINIGAME
					? WorldTemplate.WorldTemplateType.MINIGAME
					: WorldTemplate.WorldTemplateType.WORLD_TEMPLATE;
			List<WorldTemplate> worlds = CurseForgeWorldsClient.searchWorlds(
					this.sealms$currentQuery,
					this.sealms$sortMode,
					nextPage,
					10,
					type
			);
			WorldTemplatePaginatedList result = new WorldTemplatePaginatedList(
					worlds,
					nextPage + 1,
					10,
					worlds.size() < 10 ? (nextPage * 10 + worlds.size()) : (nextPage + 2) * 10
			);
			cir.setReturnValue(Either.left(result));
		} catch (Exception e) {
			cir.setReturnValue(Either.right(e));
		}
	}

	@Inject(method = "selectTemplate", at = @At("HEAD"), cancellable = true)
	private void sealms$uploadSelectedCurseForgeWorld(CallbackInfo ci) {
		if (this.selectedTemplate == null) return;
		String cfDownloadUrl = CurseForgeWorldsClient.getDownloadUrl(this.selectedTemplate.id());
		if (cfDownloadUrl != null && !cfDownloadUrl.isBlank()) {
			boolean isMinigame = this.worldType == RealmsServer.WorldType.MINIGAME;
			this.minecraft.gui.setScreen(new LoadWorldFromUrlScreen(
					this,
					SealmsSelectionContext.getActiveRealmId(),
					SealmsSelectionContext.getActiveSlot(),
					isMinigame,
					cfDownloadUrl,
					this.selectedTemplate.name()
			));
			ci.cancel();
		}
	}
}
