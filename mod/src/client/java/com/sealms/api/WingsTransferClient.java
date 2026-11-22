package com.sealms.api;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.UUID;

/**
 * Handles direct client <-> Pterodactyl Wings bulk world .zip transfers
 * (bypassing Vercel's 4.5 MB payload limit completely).
 */
public final class WingsTransferClient {

	@FunctionalInterface
	public interface ProgressListener {
		void onProgress(long bytesTransferred, long totalBytes);
	}

	private WingsTransferClient() {}

	public static File downloadZipToTemp(String downloadUrl, ProgressListener listener) throws Exception {
		HttpURLConnection conn = (HttpURLConnection) URI.create(downloadUrl).toURL().openConnection();
		conn.setRequestMethod("GET");
		conn.setConnectTimeout(15_000);
		conn.setReadTimeout(120_000);
		conn.setInstanceFollowRedirects(true);
		conn.setRequestProperty("User-Agent", "Sealms/1.0 Minecraft/26.3");

		int code = conn.getResponseCode();
		if (code < 200 || code >= 300) {
			throw new IllegalStateException("Download failed with HTTP " + code);
		}

		long totalBytes = conn.getContentLengthLong();
		File tempFile = File.createTempFile("sealms-world-", ".zip");
		tempFile.deleteOnExit();

		try (InputStream in = new BufferedInputStream(conn.getInputStream());
			 OutputStream out = new FileOutputStream(tempFile)) {
			byte[] buf = new byte[16 * 1024];
			long readTotal = 0;
			int n;
			while ((n = in.read(buf)) != -1) {
				out.write(buf, 0, n);
				readTotal += n;
				if (listener != null) {
					listener.onProgress(readTotal, totalBytes);
				}
			}
		} finally {
			conn.disconnect();
		}
		return tempFile;
	}

	public static void uploadZipToWings(
			String signedUploadUrl,
			File zipFile,
			String remoteFileName,
			ProgressListener listener
	) throws Exception {
		String boundary = "----SealmsBoundary" + UUID.randomUUID().toString().replace("-", "");
		byte[] header = (
				"--" + boundary + "\r\n" +
				"Content-Disposition: form-data; name=\"files\"; filename=\"" + remoteFileName + "\"\r\n" +
				"Content-Type: application/zip\r\n\r\n"
		).getBytes(StandardCharsets.UTF_8);
		byte[] footer = ("\r\n--" + boundary + "--\r\n").getBytes(StandardCharsets.UTF_8);

		long fileLen = zipFile.length();
		long contentLen = header.length + fileLen + footer.length;

		HttpURLConnection conn = (HttpURLConnection) URI.create(signedUploadUrl).toURL().openConnection();
		conn.setDoOutput(true);
		conn.setRequestMethod("POST");
		conn.setConnectTimeout(15_000);
		conn.setReadTimeout(300_000);
		conn.setFixedLengthStreamingMode(contentLen);
		conn.setRequestProperty("Content-Type", "multipart/form-data; boundary=" + boundary);

		try (OutputStream out = conn.getOutputStream();
			 InputStream in = new BufferedInputStream(new FileInputStream(zipFile))) {
			out.write(header);
			byte[] buf = new byte[16 * 1024];
			long written = 0;
			int n;
			while ((n = in.read(buf)) != -1) {
				out.write(buf, 0, n);
				written += n;
				if (listener != null) {
					listener.onProgress(written, fileLen);
				}
			}
			out.write(footer);
			out.flush();
		}

		int code = conn.getResponseCode();
		conn.disconnect();
		if (code < 200 || code >= 300) {
			throw new IllegalStateException("Wings upload failed with HTTP " + code);
		}
	}
}
