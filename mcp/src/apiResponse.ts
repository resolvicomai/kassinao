/**
 * Parses a successful API response without ever copying an upstream response
 * body into an MCP-visible error. Meeting content may itself be adversarial.
 */
export async function readApiJson(response: Pick<Response, 'json' | 'ok' | 'status'>): Promise<unknown> {
  if (!response.ok) {
    throw new Error(`Kassinão request failed (HTTP ${response.status}). Try again in a moment.`);
  }
  try {
    return await response.json();
  } catch {
    throw new Error('Kassinão returned an invalid JSON response.');
  }
}
