/**
 * v1.4.22 W5 reconcile (Sr-H2) — shared `ReadableStream` constructor
 * for Server-Sent-Events handlers.
 *
 * The Coach chat route used to construct three separate
 * `new ReadableStream({ start(controller) { try { … } finally {
 * controller.close(); } } })` blocks — one for the refusal path, one
 * for the provider-error path, one for the happy path. Each emitted a
 * different mix of frames but the construction shape was identical.
 *
 * Extract the boilerplate so future SSE consumers (the v1.5 iOS
 * daily-briefing live-regenerate endpoint is the next one) inherit the
 * same try/finally close semantics without copy-paste.
 *
 * The `emit` callback receives the controller and is awaited inside
 * the `start` body. Any error inside the callback re-enters the
 * `finally` and closes the stream cleanly so the client sees the
 * connection terminate (and never sees a hung response).
 */

export interface SseController<T = Uint8Array> {
  enqueue: (chunk: T) => void;
}

/**
 * Build a `ReadableStream<Uint8Array>` whose `start` callback runs the
 * supplied `emit` function inside a try/finally that always closes the
 * controller. Use the returned stream with the standard SSE response
 * headers (`Content-Type: text/event-stream`, `Cache-Control: no-cache`).
 */
export function createSseStream(
  emit: (controller: SseController) => void | Promise<void>,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        await emit(controller);
      } finally {
        controller.close();
      }
    },
  });
}
