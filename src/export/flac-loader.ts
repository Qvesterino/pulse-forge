/** Load the optional FLAC/WASM codec only after an export is requested. */
export async function loadFlacEncoder() {
  try {
    return await import("./flac");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/fetch|load|import|network|module/i.test(message)) {
      throw new Error(
        "KYX could not load the FLAC encoder. Connect to the internet for its first use; after it loads, KYX caches it for offline use.",
      );
    }
    throw error;
  }
}
