import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchWithDeadline,
  fetchWithRetry,
  UpstreamBodyLimitError,
  UpstreamResponseLostError,
} from '../src/processing/http';
import { RemoteDeletionQueue } from '../src/processing/remoteDeletion';

afterEach(() => vi.unstubAllGlobals());

describe('prazo HTTP inclui o corpo e todas as tentativas', () => {
  it('interrompe um corpo que nunca termina depois de receber os headers', async () => {
    const cancel = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new ReadableStream({ cancel }))),
    );
    await expect(fetchWithDeadline('https://provider.invalid', {}, { timeoutMs: 25 })).rejects.toMatchObject({
      name: 'TimeoutError',
    });
    expect(cancel).toHaveBeenCalled();
  });

  it('inclui backoff no prazo total e não repete resposta que excede o limite', async () => {
    const fetchMock = vi.fn(async () => new Response('unavailable', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      fetchWithRetry('https://provider.invalid', {}, { attempts: 4, totalTimeoutMs: 25 }),
    ).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockResolvedValue(new Response('123456789'));
    await expect(
      fetchWithRetry('https://provider.invalid', {}, { attempts: 4, maxResponseBytes: 8 }),
    ).rejects.toBeInstanceOf(UpstreamBodyLimitError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(['POST', 'PATCH', 'GET', 'DELETE'])(
    'corpo perdido de %s só permite repetir métodos idempotentes',
    async (method) => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            new ReadableStream({
              pull(controller) {
                controller.error(new Error('synthetic response stream failure'));
              },
            }),
            { status: 200 },
          ),
        )
        .mockResolvedValueOnce(Response.json({ id: 'second-job' }));
      vi.stubGlobal('fetch', fetchMock);
      const result = fetchWithRetry('https://provider.invalid/transcript', { method }, { attempts: 2 });
      if (method === 'POST' || method === 'PATCH') {
        await expect(result).rejects.toBeInstanceOf(UpstreamResponseLostError);
        expect(fetchMock).toHaveBeenCalledTimes(1);
      } else {
        expect(await (await result).json()).toEqual({ id: 'second-job' });
        expect(fetchMock).toHaveBeenCalledTimes(2);
      }
    },
  );
});

describe('exclusões remotas sobrevivem ao processo', () => {
  it.skipIf(process.platform === 'win32').each(['symlink', 'dangling-symlink', 'hardlink', 'oversized'])(
    'não sobrescreve referências quando o arquivo é %s',
    (kind) => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-deletion-'));
      const file = path.join(directory, 'pending.json');
      const preserved = path.join(directory, 'preserved.json');
      const queue = new RemoteDeletionQueue(file, () => 'synthetic-key');
      try {
        queue.track('existing-job', 'recording');
        const original = fs.readFileSync(file, 'utf8');
        fs.renameSync(file, preserved);
        if (kind === 'hardlink') fs.linkSync(preserved, file);
        else if (kind === 'oversized') fs.writeFileSync(file, original + ' '.repeat(2 * 1024 * 1024));
        else fs.symlinkSync(kind === 'symlink' ? preserved : path.join(directory, 'missing.json'), file);
        const before = fs.lstatSync(file);
        expect(() => queue.ensureCapacity()).toThrow('state unavailable');
        expect(() => queue.track('another-job', 'recording')).toThrow('state unavailable');
        expect(fs.lstatSync(file).ino).toBe(before.ino);
        expect(fs.readFileSync(preserved, 'utf8')).toBe(original);
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it('retoma job ativo, preserva falha e só remove a referência após confirmar a exclusão', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-deletion-'));
    const file = path.join(directory, 'pending.json');
    let now = Date.now();
    const request = vi.fn(async () => new Response('', { status: 500 }));
    try {
      const first = new RemoteDeletionQueue(
        file,
        () => 'synthetic-key',
        request,
        () => now,
      );
      first.track('synthetic-job', 'synthetic-recording');
      await first.drain();
      expect(request).not.toHaveBeenCalled();
      const restarted = new RemoteDeletionQueue(
        file,
        () => 'synthetic-key',
        request,
        () => now,
      );
      restarted.recover();
      await restarted.drain();
      expect(restarted.summary()).toEqual({ active: 0, pending: 1, needsAttention: 0 });
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(fs.readFileSync(file, 'utf8')).not.toContain('synthetic-key');
      now += 60_001;
      request
        .mockResolvedValueOnce(Response.json({ text: null }))
        .mockResolvedValueOnce(new Response('', { status: 404 }));
      await restarted.drain();
      expect(request.mock.calls).toHaveLength(3);
      expect(restarted.summary()).toEqual({ active: 0, pending: 0, needsAttention: 0 });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('não descarta 404 sem um DELETE aceito, para após 12 tentativas e permite retry explícito', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-deletion-'));
    const file = path.join(directory, 'pending.json');
    let now = Date.now();
    const request = vi.fn(async () => new Response('', { status: 404 }));
    try {
      const queue = new RemoteDeletionQueue(
        file,
        () => 'synthetic-key',
        request,
        () => now,
      );
      queue.track('job', 'recording');
      queue.recover();
      for (let attempt = 0; attempt < 14; attempt++) {
        await queue.drain();
        now += 24 * 60 * 60_000;
      }
      expect(request).toHaveBeenCalledTimes(12);
      expect(queue.summary()).toEqual({ active: 0, pending: 0, needsAttention: 1 });
      expect(queue.retry('recording')).toBe(1);
      expect(queue.summary().pending).toBe(1);
      fs.writeFileSync(file, '{broken');
      expect(() => queue.track('another-job', 'recording')).toThrow('state unavailable');
      expect(fs.readFileSync(file, 'utf8')).toBe('{broken');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
