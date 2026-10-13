/** The server sends keep-alives every 15 seconds; three silent intervals mean reconnect. */
export function readEventChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  return new Promise((resolve, reject) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    const abort = () => {
      finish();
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      finish();
      reject(new Error("Event stream heartbeat timed out"));
    }, 45000);
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener("abort", abort, { once: true });
    reader.read().then(chunk => { finish(); resolve(chunk); }, error => { finish(); reject(error); });
  });
}
