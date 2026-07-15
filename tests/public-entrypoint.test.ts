import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..');

async function reservePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('porta temporária indisponível');
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

function request(port: number, pathname: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: pathname,
        headers: { host: `127.0.0.1:${port}`, connection: 'close' },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.once('error', reject);
        res.once('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.once('error', reject);
    req.end();
  });
}

async function stop(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise<void>((resolve) => child.once('exit', () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

describe('entrypoint público isolado', () => {
  const homes: string[] = [];
  const children: ChildProcessWithoutNullStreams[] = [];

  afterEach(async () => {
    await Promise.all(children.splice(0).map(stop));
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  });

  it('inicia com somente a allowlist pública e não expõe a política sintética', async () => {
    const port = await reservePort();
    const home = mkdtempSync(path.join(tmpdir(), 'kassinao-public-entrypoint-'));
    homes.push(home);
    const publicEnvironment = {
      NODE_ENV: 'production',
      PATH: process.env.PATH ?? '',
      HOME: home,
      HOSTNAME: 'public-entrypoint-test',
      PORT: String(port),
      WEB_BIND_ADDRESS: '127.0.0.1',
      PUBLIC_URL: `http://127.0.0.1:${port}`,
      DOCS_URL: `http://127.0.0.1:${port}`,
      SOURCE_URL: 'https://github.com/example/kassinao',
      KASSINAO_RELEASE_DIGEST: `sha256:${'a'.repeat(64)}`,
      KASSINAO_DEPLOYMENT_FINGERPRINT: 'b'.repeat(32),
      TRUST_PROXY_HOPS: '0',
      REPO_PUBLIC: 'true',
      TZ: 'UTC',
      LANG: 'C',
    };
    // `env -i` reproduz o container Linux. macOS injeta
    // __CF_USER_TEXT_ENCODING depois de spawn(), mesmo com env explícito.
    const child = spawn(
      '/usr/bin/env',
      [
        '-i',
        ...Object.entries(publicEnvironment).map(([key, value]) => `${key}=${value}`),
        process.execPath,
        '--import',
        'tsx',
        'src/public.ts',
      ],
      {
        cwd: ROOT,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    children.push(child);
    child.stdin.end();

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });

    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(
        () => reject(new Error(`entrypoint público não iniciou\nstdout: ${stdout}\nstderr: ${stderr}`)),
        10_000,
      );
      const poll = setInterval(() => {
        if (!stdout.includes('Superfícies públicas em')) return;
        clearInterval(poll);
        clearTimeout(deadline);
        resolve();
      }, 20);
      child.once('exit', (code, signal) => {
        clearInterval(poll);
        clearTimeout(deadline);
        reject(new Error(`entrypoint público encerrou (${code ?? signal})\nstdout: ${stdout}\nstderr: ${stderr}`));
      });
    });

    const health = await request(port, '/health');
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body)).toMatchObject({ ok: true, surface: 'public' });

    const privacy = await request(port, '/privacy');
    expect(privacy.status).toBe(404);
    expect(privacy.body).toBe('Not found.');
    expect(privacy.body).not.toContain('Synthetic value');
  }, 15_000);
});
