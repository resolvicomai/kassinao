import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RecordingMeta } from '../src/store';
import type { WebUser } from '../src/web/auth';
import {
  applyCspNonce,
  contentSecurityPolicy,
  CSP_NONCE_PLACEHOLDER,
  DEFAULT_REFERRER_POLICY,
  referrerPolicyForPath,
  WEB_REFERRER_POLICY,
} from '../src/web/csp';
import { docsPage } from '../src/web/docs';
import { landingPage } from '../src/web/landing';
import { connectPage, messagePage, recordingPage, recordingsIndexPage } from '../src/web/page';

const user: WebUser = {
  typ: 'session',
  id: 'csp-user',
  name: 'Alice',
  avatar: null,
  exp: Date.now() + 60_000,
  jti: 'csp-session',
};

function exampleRecording(): RecordingMeta {
  return JSON.parse(fs.readFileSync(path.join(process.cwd(), 'docs', 'example', 'meta.json'), 'utf8')) as RecordingMeta;
}

describe('Content Security Policy sem script inline irrestrito', () => {
  it('preserva o Origin dos formulários POST same-origin sem vazar referrer para outros sites', () => {
    // Pelo Fetch Standard, `no-referrer` serializa o Origin de POST no-cors
    // como `null`; o middleware CSRF rejeita esse valor antes da rota.
    expect(WEB_REFERRER_POLICY).toBe('same-origin');
    expect(referrerPolicyForPath('/app/rec/exemplo')).toBe(WEB_REFERRER_POLICY);
    expect(referrerPolicyForPath('/auth/callback')).toBe(DEFAULT_REFERRER_POLICY);
    expect(DEFAULT_REFERRER_POLICY).toBe('no-referrer');
  });

  it('autoriza somente scripts marcados com o nonce da resposta', () => {
    const nonce = 'dGVzdC1ub25jZS0xMjM0NQ==';
    const policy = contentSecurityPolicy(nonce);

    expect(policy).toContain(`script-src 'self' 'nonce-${nonce}'`);
    expect(policy).not.toContain("script-src 'self' 'unsafe-inline'");

    const marked = `<script nonce="${CSP_NONCE_PLACEHOLDER}">window.ok=true</script>`;
    expect(applyCspNonce(marked, nonce)).toBe(`<script nonce="${nonce}">window.ok=true</script>`);
    // Um script injetado sem o marcador deliberado não ganha nonce por acidente.
    expect(applyCspNonce('<script>window.evil=true</script>', nonce)).toBe('<script>window.evil=true</script>');
  });

  it('todas as páginas marcam seus scripts e não usam handlers HTML executáveis', () => {
    const meta = exampleRecording();
    const pages = [
      landingPage('pt'),
      docsPage('pt'),
      recordingPage(meta, { live: false, canDelete: true, user, lang: 'pt' }),
      recordingsIndexPage([{ meta, canDelete: true }], { user, lang: 'pt' }),
      connectPage({ lang: 'pt', user, sessions: [] }),
      messagePage('Aviso', 'Mensagem', user, 'pt'),
    ];

    for (const html of pages) {
      const scripts = html.match(/<script\b[^>]*>/gi) ?? [];
      expect(scripts.length).toBeGreaterThan(0);
      for (const script of scripts) {
        expect(script).toContain(`nonce="${CSP_NONCE_PLACEHOLDER}"`);
      }
      expect(html).not.toMatch(/\son(?:click|submit|load|error|change|input|focus|blur)\s*=/i);
    }
  });
});
