package com.sealms.ui;

import com.mojang.realmsclient.RealmsMainScreen;
import com.sealms.api.PteroDirectClient;
import com.sealms.api.SealmsApiClient;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.components.Checkbox;
import net.minecraft.client.gui.components.EditBox;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.network.chat.CommonComponents;
import net.minecraft.network.chat.Component;
import net.minecraft.realms.RealmsScreen;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;

/**
 * Replaces the "Buy a Realm" / Free Trial flow.
 * Allows owners to enter their Pterodactyl Panel URL & Client API key (ptlc_),
 * fetch accessible servers directly from GET /api/client, or enter a Server ID manually,
 * with an opt-in checkbox to send Pending Invites to existing whitelist.json players.
 */
public class AddSealmScreen extends RealmsScreen {
	private final Screen parent;

	private EditBox panelUrlBox;
	private EditBox apiKeyBox;
	private EditBox serverIdBox;
	private Checkbox importWhitelistCheckbox;
	private Button fetchButton;
	private Button linkButton;

	private List<PteroDirectClient.PteroServerSummary> fetchedServers = new ArrayList<>();
	private final List<Button> serverPickerButtons = new ArrayList<>();
	private String selectedServerName = "";
	private Component statusMessage = Component.empty();
	private int statusColor = 0xFFAAAAAA;
	private boolean busy = false;

	public AddSealmScreen(Screen parent) {
		super(Component.translatable("sealms.add.title"));
		this.parent = parent;
	}

	@Override
	protected void init() {
		int centerX = this.width / 2;
		int fieldWidth = 260;
		int left = centerX - fieldWidth / 2;
		int y = 38;

		this.panelUrlBox = new EditBox(this.font, left, y, fieldWidth, 20, Component.translatable("sealms.add.panelUrl"));
		this.panelUrlBox.setMaxLength(256);
		this.panelUrlBox.setHint(Component.literal("https://panel.example.com"));
		this.addRenderableWidget(this.panelUrlBox);

		y += 34;
		this.apiKeyBox = new EditBox(this.font, left, y, fieldWidth - 96, 20, Component.translatable("sealms.add.apiKey"));
		this.apiKeyBox.setMaxLength(256);
		this.apiKeyBox.setHint(Component.literal("ptlc_..."));
		this.addRenderableWidget(this.apiKeyBox);

		this.fetchButton = Button.builder(Component.translatable("sealms.add.fetchServers"), b -> onFetchServers())
				.bounds(left + fieldWidth - 92, y, 92, 20)
				.build();
		this.addRenderableWidget(this.fetchButton);

		y += 34;
		this.serverIdBox = new EditBox(this.font, left, y, fieldWidth, 20, Component.translatable("sealms.add.serverId"));
		this.serverIdBox.setMaxLength(64);
		this.serverIdBox.setHint(Component.literal("e.g. a1b2c3d4 (or pick below)"));
		this.addRenderableWidget(this.serverIdBox);

		y += 28;
		this.importWhitelistCheckbox = Checkbox.builder(Component.translatable("sealms.add.importWhitelist"), this.font)
				.pos(left, y)
				.selected(false)
				.build();
		this.addRenderableWidget(this.importWhitelistCheckbox);

		rebuildServerPicker(left, y + 26, fieldWidth);

		int bottomY = this.height - 32;
		this.linkButton = Button.builder(Component.translatable("sealms.add.link"), b -> onLinkSealm())
				.bounds(centerX - 132, bottomY, 128, 20)
				.build();
		this.addRenderableWidget(this.linkButton);

		this.addRenderableWidget(Button.builder(CommonComponents.GUI_CANCEL, b -> onClose())
				.bounds(centerX + 4, bottomY, 128, 20)
				.build());
	}

	private void rebuildServerPicker(int left, int startY, int fieldWidth) {
		for (Button btn : this.serverPickerButtons) {
			this.removeWidget(btn);
		}
		this.serverPickerButtons.clear();

		int maxVisible = Math.min(fetchedServers.size(), 4);
		for (int i = 0; i < maxVisible; i++) {
			PteroDirectClient.PteroServerSummary srv = fetchedServers.get(i);
			String label = srv.name() + " (" + srv.identifier() + ")";
			Button btn = Button.builder(Component.literal(label), b -> {
				this.serverIdBox.setValue(srv.identifier());
				this.selectedServerName = srv.name();
				this.statusMessage = Component.literal("Selected: " + srv.name());
				this.statusColor = 0xFF7DD3FC;
			}).bounds(left, startY + i * 22, fieldWidth, 20).build();
			this.serverPickerButtons.add(btn);
			this.addRenderableWidget(btn);
		}
	}

	private void onFetchServers() {
		if (busy) return;
		String panelUrl = this.panelUrlBox.getValue().trim();
		String apiKey = this.apiKeyBox.getValue().trim();
		if (panelUrl.isEmpty() || apiKey.isEmpty()) {
			this.statusMessage = Component.literal("Enter Panel URL and Client API Key first.");
			this.statusColor = 0xFFF87171;
			return;
		}
		this.busy = true;
		this.fetchButton.active = false;
		this.statusMessage = Component.literal("Fetching servers from Pterodactyl...");
		this.statusColor = 0xFFAAAAAA;

		CompletableFuture.supplyAsync(() -> {
			try {
				return PteroDirectClient.listAccessibleServers(panelUrl, apiKey);
			} catch (Exception e) {
				throw new RuntimeException(e.getMessage(), e);
			}
		}).whenComplete((servers, err) -> this.minecraft.execute(() -> {
			this.busy = false;
			this.fetchButton.active = true;
			if (err != null) {
				this.statusMessage = Component.literal("Fetch failed (enter Server ID manually): " + unwrapMessage(err));
				this.statusColor = 0xFFFBBF24;
			} else if (servers.isEmpty()) {
				this.statusMessage = Component.literal("No servers found on that key. You can enter Server ID manually.");
				this.statusColor = 0xFFFBBF24;
			} else {
				this.fetchedServers = servers;
				int centerX = this.width / 2;
				rebuildServerPicker(centerX - 130, 160, 260);
				this.statusMessage = Component.literal("Found " + servers.size() + " server(s). Click one to select.");
				this.statusColor = 0xFF4ADE80;
			}
		}));
	}

	private void onLinkSealm() {
		if (busy) return;
		String panelUrl = this.panelUrlBox.getValue().trim();
		String apiKey = this.apiKeyBox.getValue().trim();
		String serverId = this.serverIdBox.getValue().trim();
		boolean importWl = this.importWhitelistCheckbox.selected();

		if (panelUrl.isEmpty() || apiKey.isEmpty() || serverId.isEmpty()) {
			this.statusMessage = Component.literal("Panel URL, API Key, and Server ID are required.");
			this.statusColor = 0xFFF87171;
			return;
		}

		this.busy = true;
		this.linkButton.active = false;
		this.statusMessage = Component.literal("Verifying & linking Sealm...");
		this.statusColor = 0xFFAAAAAA;

		CompletableFuture.runAsync(() -> {
			try {
				SealmsApiClient.linkServer(panelUrl, apiKey, serverId, selectedServerName, importWl);
			} catch (Exception e) {
				throw new RuntimeException(e.getMessage(), e);
			}
		}).whenComplete((v, err) -> this.minecraft.execute(() -> {
			this.busy = false;
			this.linkButton.active = true;
			if (err != null) {
				this.statusMessage = Component.literal("Link failed: " + unwrapMessage(err));
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
		int left = centerX - 130;

		graphics.centeredText(this.font, this.title, centerX, 12, 0xFFFFFFFF);
		graphics.text(this.font, Component.translatable("sealms.add.panelUrl"), left, 27, 0xFFA0A0A0);
		graphics.text(this.font, Component.translatable("sealms.add.apiKey"), left, 61, 0xFFA0A0A0);
		graphics.text(this.font, Component.translatable("sealms.add.serverId"), left, 95, 0xFFA0A0A0);

		if (!this.statusMessage.getString().isEmpty()) {
			graphics.centeredText(this.font, this.statusMessage, centerX, this.height - 52, this.statusColor);
		}
	}

	@Override
	public void onClose() {
		this.minecraft.gui.setScreen(this.parent);
	}

	private static String unwrapMessage(Throwable err) {
		Throwable cur = err;
		while (cur.getCause() != null) cur = cur.getCause();
		return cur.getMessage() != null ? cur.getMessage() : cur.getClass().getSimpleName();
	}
}
