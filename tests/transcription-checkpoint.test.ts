import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { config } from '../src/config';
import { enqueueTranscription, isTranscribing, setProcessingGuildGuard } from '../src/processing/transcribe';
import { cacheDir, deleteRecording, readMeta, readTranscript, saveMeta, tracksDir } from '../src/store';
import { getProcessingProgress } from '../src/processing/progress';
import * as stateFile from '../src/stateFile';
import { pauseGuildProcessing } from '../src/processing/http';
import { getRemoteDeletionSummary } from '../src/processing/remoteDeletion';

vi.mock('../src/processing/ffmpeg', () => ({ runFfmpeg: vi.fn(async () => 'time=00:40:00') }));
vi.mock('../src/processing/vad', async (original) => ({
  ...(await original<typeof import('../src/processing/vad')>()),
  detectSpeechIntervals: vi.fn(async () => [{ start: 0, end: 2400 }]),
  extractBatch: vi.fn(async (_master, _batch, output) => fs.writeFileSync(output, Buffer.alloc(2048))),
}));

it.each(['regular', 'hardlink', 'oversized'])(
  'retoma com checkpoint %s e expurga o cache ao terminar',
  async (checkpointKind) => {
    const id = `checkpoint-${crypto.randomUUID()}`;
    const guildId = `guild-${crypto.randomUUID()}`;
    const original = {
      transcribeProvider: config.transcribeProvider,
      groqApiKey: config.groqApiKey,
      minutesEnabled: config.minutesEnabled,
    };
    config.transcribeProvider = 'groq';
    config.groqApiKey = 'synthetic-key';
    config.minutesEnabled = 'false';
    setProcessingGuildGuard((candidate) => candidate === guildId);
    saveMeta({
      id,
      guildId,
      guildName: 'Test',
      voiceChannelId: 'voice',
      voiceChannelName: 'Test',
      startedBy: null,
      startedAt: Date.now() - 2400000,
      endedAt: Date.now(),
      status: 'done',
      participants: [{ id: 'user', name: 'Speaker', avatar: null, index: 0, trackFile: 'user.flac' }],
      notes: [],
      events: [],
    });
    fs.mkdirSync(tracksDir(id), { recursive: true });
    fs.writeFileSync(path.join(tracksDir(id), 'user.flac'), 'synthetic-audio');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ segments: [{ start: 0, end: 10, text: 'Primeiro trecho.' }] }))
      .mockResolvedValueOnce(Response.json({}, { status: 400 }))
      .mockResolvedValueOnce(
        Response.json({
          segments: [
            { start: 0, end: 10, text: checkpointKind === 'regular' ? 'Segundo trecho.' : 'Primeiro refeito.' },
          ],
        }),
      )
      .mockResolvedValueOnce(Response.json({ segments: [{ start: 0, end: 10, text: 'Segundo trecho.' }] }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      enqueueTranscription(id);
      await vi.waitFor(() => {
        expect(readMeta(id)?.transcription?.status).toBe('error');
        expect(isTranscribing(id)).toBe(false);
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fs.existsSync(path.join(cacheDir(id), 'asr-checkpoints'))).toBe(true);
      const checkpointFile = path.join(
        cacheDir(id),
        'asr-checkpoints',
        `${crypto.createHash('sha256').update('user').digest('hex')}.json`,
      );
      if (checkpointKind === 'hardlink')
        fs.linkSync(checkpointFile, path.join(cacheDir(id), 'preserved-checkpoint.json'));
      if (checkpointKind === 'oversized') fs.appendFileSync(checkpointFile, ' '.repeat(16 * 1024 * 1024));
      enqueueTranscription(id);
      await vi.waitFor(() => {
        expect(readMeta(id)?.transcription?.status).toBe('done');
        expect(isTranscribing(id)).toBe(false);
      });
      expect(fetchMock).toHaveBeenCalledTimes(checkpointKind === 'regular' ? 3 : 4);
      expect(readTranscript(id)?.map((segment) => segment.text)).toEqual([
        checkpointKind === 'regular' ? 'Primeiro trecho.' : 'Primeiro refeito.',
        'Segundo trecho.',
      ]);
      expect(getProcessingProgress(id)).toMatchObject({
        stage: 'done',
        tracksCompleted: 1,
        batchesCompleted: 2,
        ...(checkpointKind === 'regular' ? { reusedBatches: 1 } : {}),
      });
      expect(getProcessingProgress(id)?.reusedBatches ?? 0).toBe(checkpointKind === 'regular' ? 1 : 0);
      expect(fs.existsSync(path.join(cacheDir(id), 'asr-checkpoints'))).toBe(false);
    } finally {
      setProcessingGuildGuard(() => false);
      deleteRecording(id);
      Object.assign(config, original);
      vi.unstubAllGlobals();
    }
  },
);

it.each([
  'checkpoint-unavailable',
  'accepted-response-lost',
  'invalid-json',
  'missing-job-id',
  'abort-after-job-id',
] as const)('não repete custo por %s', async (failure) => {
  const id = `checkpoint-${crypto.randomUUID()}`;
  const guildId = `guild-${crypto.randomUUID()}`;
  const original = {
    transcribeProvider: config.transcribeProvider,
    groqApiKey: config.groqApiKey,
    minutesEnabled: config.minutesEnabled,
    assemblyaiApiKey: config.assemblyaiApiKey,
    transcribeFallbackProvider: config.transcribeFallbackProvider,
  };
  const abortAfterId = failure === 'abort-after-job-id';
  const assemblyai = failure === 'invalid-json' || failure === 'missing-job-id' || abortAfterId;
  config.transcribeProvider = assemblyai ? 'assemblyai' : 'groq';
  config.assemblyaiApiKey = 'synthetic-key';
  config.transcribeFallbackProvider = 'groq';
  config.groqApiKey = 'synthetic-key';
  config.minutesEnabled = 'false';
  setProcessingGuildGuard((candidate) => candidate === guildId);
  saveMeta({
    id,
    guildId,
    guildName: 'Test',
    voiceChannelId: 'voice',
    voiceChannelName: 'Test',
    startedBy: null,
    startedAt: Date.now() - 2400000,
    endedAt: Date.now(),
    status: 'done',
    participants: [{ id: 'user', name: 'Speaker', avatar: null, index: 0, trackFile: 'user.flac' }],
    notes: [],
    events: [],
  });
  fs.mkdirSync(tracksDir(id), { recursive: true });
  fs.writeFileSync(path.join(tracksDir(id), 'user.flac'), 'synthetic-audio');
  const write = stateFile.writeJsonStateAtomic;
  const checkpointWrite = vi.spyOn(stateFile, 'writeJsonStateAtomic').mockImplementation((file, value) => {
    if (failure === 'checkpoint-unavailable' && file.includes(`${path.sep}asr-checkpoints${path.sep}`))
      throw Object.assign(new Error('synthetic checkpoint permission failure'), { code: 'EACCES' });
    write(file, value);
  });
  const originalJson = Response.prototype.json;
  const parse = vi.spyOn(Response.prototype, 'json').mockImplementation(async function (this: Response) {
    const value = await originalJson.call(this);
    if (abortAfterId && value?.id === 'known-paid-job') {
      setProcessingGuildGuard(() => false);
      pauseGuildProcessing(guildId);
    }
    return value;
  });
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (assemblyai) {
      if (url.endsWith('/upload')) return Response.json({ upload_url: 'https://provider.invalid/upload' });
      if (init?.method === 'DELETE') return new Response('', { status: 500 });
      if (abortAfterId) return Response.json({ id: 'known-paid-job', status: 'queued' });
      return failure === 'invalid-json'
        ? new Response('{broken', { status: 200 })
        : Response.json({ status: 'queued' });
    }
    return failure === 'accepted-response-lost'
      ? new Response(
          new ReadableStream({
            pull(controller) {
              controller.error(new Error('synthetic response stream failure'));
            },
          }),
          { status: 200 },
        )
      : Response.json({ segments: [{ start: 0, end: 10, text: 'Resultado pago preservado.' }] });
  });
  vi.stubGlobal('fetch', fetchMock);
  try {
    enqueueTranscription(id);
    await vi.waitFor(() => {
      expect(isTranscribing(id)).toBe(false);
      expect(readMeta(id)?.transcription?.status).toBe(
        failure === 'checkpoint-unavailable' ? 'done' : abortAfterId ? 'pending' : 'error',
      );
    });
    if (abortAfterId) {
      expect(getRemoteDeletionSummary(id)).toEqual({ active: 0, pending: 1, needsAttention: 0 });
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(
        fetchMock.mock.calls.filter(([url, init]) => url.endsWith('/transcript') && init?.method === 'POST'),
      ).toHaveLength(1);
    } else if (failure === 'checkpoint-unavailable') {
      expect(readTranscript(id)?.[0].text).toBe('Resultado pago preservado.');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } else {
      expect(readMeta(id)?.transcription).toMatchObject({ attempts: 1, retryScheduled: false });
      expect(readTranscript(id)).toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(assemblyai ? 2 : 1);
      if (assemblyai)
        expect(fetchMock.mock.calls.every(([url]) => url.startsWith('https://api.assemblyai.com/'))).toBe(true);
    }
    enqueueTranscription(id);
    expect(fetchMock).toHaveBeenCalledTimes(
      abortAfterId ? 3 : failure === 'checkpoint-unavailable' || assemblyai ? 2 : 1,
    );
  } finally {
    parse.mockRestore();
    checkpointWrite.mockRestore();
    setProcessingGuildGuard(() => false);
    deleteRecording(id);
    Object.assign(config, original);
    vi.unstubAllGlobals();
  }
});
