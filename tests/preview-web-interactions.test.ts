import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const rootDir = path.resolve(__dirname, '..');

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Não foi possível reservar uma porta para o preview.');
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

describe.sequential('preview web interativo', () => {
  let previewProcess: ChildProcessWithoutNullStreams;
  let baseUrl: string;
  let canonicalOrigin: string;
  let processOutput = '';

  beforeAll(async () => {
    const port = await availablePort();
    baseUrl = `http://127.0.0.1:${port}`;
    canonicalOrigin = `http://localhost:${port}`;
    previewProcess = spawn(process.execPath, ['--import', 'tsx', 'scripts/preview-web.ts'], {
      cwd: rootDir,
      env: { ...process.env, PREVIEW_PORT: String(port) },
      stdio: 'pipe',
    });
    previewProcess.stdout.on('data', (chunk) => (processOutput += String(chunk)));
    previewProcess.stderr.on('data', (chunk) => (processOutput += String(chunk)));

    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (previewProcess.exitCode !== null) throw new Error(`Preview encerrou antes de iniciar:\n${processOutput}`);
      try {
        const health = await fetch(`${baseUrl}/health`);
        if (health.ok) return;
      } catch {
        // O processo ainda está subindo.
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Preview não iniciou a tempo:\n${processOutput}`);
  }, 15_000);

  afterAll(async () => {
    if (!previewProcess || previewProcess.exitCode !== null) return;
    previewProcess.kill('SIGTERM');
    await Promise.race([once(previewProcess, 'exit'), new Promise((resolve) => setTimeout(resolve, 2_000))]);
  });

  it('simula liberar e apagar gravações mantendo o estado posterior coerente', async () => {
    const initialPage = await fetch(`${baseUrl}/app/rec/preview-done`);
    expect(initialPage.headers.get('referrer-policy')).toBe('same-origin');
    const rejected = await fetch(`${baseUrl}/app/rec/preview-error/liberar-audio`, {
      method: 'POST',
      headers: { origin: 'null' },
    });
    expect(rejected.status).toBe(403);

    const free = await fetch(`${baseUrl}/app/rec/preview-done/liberar-audio`, {
      method: 'POST',
      headers: { origin: canonicalOrigin },
      redirect: 'manual',
    });
    expect(free.status).toBe(303);
    expect(free.headers.get('location')).toBe('/app/rec/preview-done?freed=1#exportar');

    const freedPage = await fetch(`${baseUrl}/app/rec/preview-done?freed=1`).then((response) => response.text());
    expect(freedPage).toContain('Espaço liberado: o áudio foi apagado');
    expect(freedPage).toContain('O áudio já expirou.');
    expect(freedPage).not.toContain('action="/app/rec/preview-done/liberar-audio"');
    expect(freedPage).toContain('action="/app/rec/preview-done/delete"');
    expect((await fetch(`${baseUrl}/app/rec/preview-done/audio`)).status).toBe(410);

    const remove = await fetch(`${baseUrl}/app/rec/preview-partial/delete`, {
      method: 'POST',
      headers: { origin: canonicalOrigin },
      redirect: 'manual',
    });
    expect(remove.status).toBe(303);
    expect(remove.headers.get('location')).toBe('/app?deleted=1');

    const index = await fetch(`${baseUrl}/app?deleted=1`).then((response) => response.text());
    expect(index).toContain('Gravação apagada para sempre.');
    expect(index).not.toContain('/app/rec/preview-partial');
    expect((await fetch(`${baseUrl}/app/rec/preview-partial`)).status).toBe(404);
  });

  it('rejeita mutações incompatíveis com uma gravação ao vivo', async () => {
    for (const action of ['liberar-audio', 'delete']) {
      const response = await fetch(`${baseUrl}/app/rec/preview-live/${action}`, { method: 'POST' });
      expect(response.status).toBe(409);
    }
    expect((await fetch(`${baseUrl}/app/rec/preview-live`)).status).toBe(200);
  });

  it('faz player e todos os downloads da página responderem sem cair no 404 genérico', async () => {
    expect((await fetch(`${baseUrl}/app/rec/preview-error/audio`)).status).toBe(200);
    for (const format of ['mp3', 'flac', 'mix', 'audacity']) {
      const response = await fetch(`${baseUrl}/app/rec/preview-error/download/${format}`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-disposition')).toContain(`kassinao-preview-${format}.txt`);
    }
    for (const [id, file] of [
      ['preview-done', 'ata.md'],
      ['preview-done', 'transcricao.md'],
      ['preview-done', 'transcricao.txt'],
    ]) {
      const response = await fetch(`${baseUrl}/app/rec/${id}/${file}`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-disposition')).toContain('attachment');
    }
  });

  it('simula geração e revogação MCP sem emitir um token real', async () => {
    const generated = await fetch(`${baseUrl}/app/conectar-ia/gerar`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ label: 'Assistente fictício' }),
      redirect: 'manual',
    });
    expect(generated.status).toBe(303);
    expect(generated.headers.get('location')).toBe('/app/conectar-ia/codigo');

    const display = await fetch(`${baseUrl}/app/conectar-ia/codigo`, { redirect: 'manual' });
    const generatedPage = await display.text();
    expect(display.status).toBe(200);
    expect(display.headers.get('cache-control')).toBe('no-store');
    expect(generatedPage).toContain('Conexão preparada');
    expect(generatedPage).toContain('Assistente fictício');
    expect(generatedPage).toContain('preview-only-code-never-valid');
    expect(generatedPage).not.toContain('refreshToken');
    const replay = await fetch(`${baseUrl}/app/conectar-ia/codigo`, { redirect: 'manual' });
    expect(replay.status).toBe(303);
    expect(replay.headers.get('location')).toBe('/app/conectar-ia');

    const revokeOne = await fetch(`${baseUrl}/app/conectar-ia/revogar/preview-claude-desktop`, {
      method: 'POST',
      redirect: 'manual',
    });
    expect(revokeOne.status).toBe(303);
    expect(revokeOne.headers.get('location')).toBe('/app/conectar-ia?revoked=one');

    const oneLeft = await fetch(`${baseUrl}/app/conectar-ia?revoked=one`).then((response) => response.text());
    expect(oneLeft).toContain('Conexão revogada. O token parou de funcionar imediatamente.');
    expect(oneLeft).toContain('Suas conexões (1)');
    expect(oneLeft).not.toContain('preview-claude');
    expect(oneLeft).toContain('preview-cursor');

    const revokeAll = await fetch(`${baseUrl}/app/conectar-ia/revogar`, {
      method: 'POST',
      redirect: 'manual',
    });
    expect(revokeAll.status).toBe(303);
    expect(revokeAll.headers.get('location')).toBe('/app/conectar-ia?revoked=1');

    const noneLeft = await fetch(`${baseUrl}/app/conectar-ia?revoked=1`).then((response) => response.text());
    expect(noneLeft).toContain('Todas as suas conexões foram revogadas.');
    expect(noneLeft).toContain('Nenhuma conexão ativa');
  });

  it('não deixa a busca apontar para uma gravação removida durante o preview', async () => {
    const remove = await fetch(`${baseUrl}/app/rec/preview-done/delete`, {
      method: 'POST',
      redirect: 'manual',
    });
    expect(remove.status).toBe(303);

    const search = await fetch(`${baseUrl}/app?q=prazo`).then((response) => response.text());
    expect(search).not.toContain('href="/app/rec/preview-done#t=');
    const resultId = /href="\/app\/rec\/([^"#?]+)#t=/.exec(search)?.[1];
    expect(resultId).toBeTruthy();
    expect((await fetch(`${baseUrl}/app/rec/${resultId}`)).status).toBe(200);
  });

  it('simula logout voltando para a superfície pública', async () => {
    const logout = await fetch(`${baseUrl}/app/logout`, { method: 'POST', redirect: 'manual' });
    expect(logout.status).toBe(303);
    expect(logout.headers.get('location')).toBe('/?preview=logged-out');
  });
});
