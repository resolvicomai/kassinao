/** Nunca permite que credenciais MCP acompanhem redirects HTTP. */
export function strictFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  return fetch(input, { ...init, redirect: 'error' });
}
