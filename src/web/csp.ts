import crypto from 'node:crypto';

/** Marcador interno: só scripts declarados pelo template recebem o nonce real. */
export const CSP_NONCE_PLACEHOLDER = '__KASSINAO_CSP_NONCE__';
export const CSP_NONCE_ATTR = ` nonce="${CSP_NONCE_PLACEHOLDER}"`;

function validNonce(nonce: string): boolean {
  return /^[A-Za-z0-9+/_=-]{20,128}$/.test(nonce);
}

export function createCspNonce(): string {
  return crypto.randomBytes(24).toString('base64');
}

export function applyCspNonce(html: string, nonce: string): string {
  if (!validNonce(nonce)) throw new Error('Nonce CSP inválido.');
  return html.replaceAll(CSP_NONCE_PLACEHOLDER, nonce);
}

export function contentSecurityPolicy(nonce: string): string {
  if (!validNonce(nonce)) throw new Error('Nonce CSP inválido.');
  return (
    "default-src 'self'; img-src 'self' https://cdn.discordapp.com data:; media-src 'self'; " +
    `style-src 'self' 'unsafe-inline'; script-src 'self' 'nonce-${nonce}'; frame-ancestors 'none'; ` +
    "base-uri 'none'; form-action 'self'; object-src 'none'"
  );
}
