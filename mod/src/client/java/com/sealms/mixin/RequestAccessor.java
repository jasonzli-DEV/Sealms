package com.sealms.mixin;

import com.mojang.realmsclient.client.Request;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;

import java.net.HttpURLConnection;

@Mixin(Request.class)
public interface RequestAccessor {
	@Accessor("connection")
	HttpURLConnection sealms$getConnection();
}
