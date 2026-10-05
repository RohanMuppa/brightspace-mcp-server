import { MAX_FILE_SIZE } from "../../src/utils/file-validator.js";

/**
 * A body that never ends on its own: 1 MB chunks beginning with a PDF header,
 * up to twice MAX_FILE_SIZE. It records how many chunks were pulled and whether
 * the reader cancelled it, so a test can show a capped read stopped at the
 * limit instead of buffering the whole source.
 */
export function oversizeBody() {
  const chunkSize = 1024 * 1024;
  const totalChunks = (2 * MAX_FILE_SIZE) / chunkSize;
  const state = { pulled: 0, cancelled: false, totalChunks };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (state.pulled === totalChunks) return controller.close();
      const chunk = new Uint8Array(chunkSize);
      if (state.pulled === 0) chunk.set(Buffer.from("%PDF-1.4\n"));
      controller.enqueue(chunk);
      state.pulled += 1;
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { stream, state };
}

/** Pulls stop just past the cap, well short of the whole source. */
export const CHUNKS_AT_CAP = MAX_FILE_SIZE / (1024 * 1024);
