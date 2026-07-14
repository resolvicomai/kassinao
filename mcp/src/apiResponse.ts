const DEFAULT_MAX_JSON_BYTES = 32 * 1024 * 1024;

/**
 * Parses a successful API response without ever copying an upstream response
 * body into an MCP-visible error. The stream is bounded before concatenation or
 * JSON.parse so a hostile origin cannot turn a small token response into OOM.
 */
export async function readApiJson(response: Response, maxBytes = DEFAULT_MAX_JSON_BYTES): Promise<unknown> {
  if (!response.ok) {
    throw new Error(`Kassinão request failed (HTTP ${response.status}). Try again in a moment.`);
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error('Kassinão returned an invalid JSON response.');
  }
  try {
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new Error('oversized');

    if (!response.body) return JSON.parse(await response.text()) as unknown;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw new Error('oversized');
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const payload = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      payload.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload)) as unknown;
  } catch {
    throw new Error('Kassinão returned an invalid JSON response.');
  }
}
