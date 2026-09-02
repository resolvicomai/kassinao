const DEFAULT_MAX_JSON_BYTES = 32 * 1024 * 1024;

/**
 * Parses a successful API response without ever copying an upstream response
 * body into an MCP-visible error. The stream is bounded before concatenation or
 * JSON.parse so a hostile origin cannot turn a small token response into OOM.
 */
/**
 * Maps an HTTP failure to advice the assistant can act on, without ever copying
 * the upstream body. Permanent errors (400/403/404/413) must not read as "try
 * again": a wrong meeting id or a revoked account would loop forever.
 */
export function describeHttpFailure(status: number, retryAfterHeader?: string | null): string {
  switch (status) {
    case 400:
      return 'Kassinão rejected the request parameters (HTTP 400). Check the tool arguments (dates, cursor, query) instead of retrying.';
    case 403:
      return 'Your Discord account no longer has access to this Kassinão instance or its meetings (HTTP 403). Ask the instance operator; retrying will not help.';
    case 404:
      return 'Kassinão has no such meeting, or your account cannot access it (HTTP 404). Check the meeting id instead of retrying.';
    case 413:
      return 'The transcript is too large for a direct read (HTTP 413). Ask for a smaller transcriptLimit.';
    case 429: {
      const seconds = Number.parseInt(retryAfterHeader ?? '', 10);
      const wait = Number.isFinite(seconds) && seconds > 0 ? seconds : 30;
      return `Rate limited by Kassinão (HTTP 429). Wait ${wait} seconds before the next call; scans are capped per minute.`;
    }
    default:
      return `Kassinão request failed (HTTP ${status}). Try again in a moment.`;
  }
}

export async function readApiJson(response: Response, maxBytes = DEFAULT_MAX_JSON_BYTES): Promise<unknown> {
  if (!response.ok) {
    throw new Error(describeHttpFailure(response.status, response.headers.get('retry-after')));
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
