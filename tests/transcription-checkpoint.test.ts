import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { config } from '../src/config';
import { enqueueTranscription, isTranscribing, setProcessingGuildGuard } from '../src/processing/transcribe';
import { cacheDir, deleteRecording, readMeta, readTranscript, saveMeta, tracksDir } from '../src/store';
import { getProcessingProgress } from '../src/processing/progress';

vi.mock('../src/processing/ffmpeg', () => ({ runFfmpeg: vi.fn(async () => 'time=00:40:00') }));
vi.mock('../src/processing/vad', async (original) => ({
  ...(await original<typeof import('../src/processing/vad')>()),
  detectSpeechIntervals: vi.fn(async () => [{ start: 0, end: 2400 }]),
  extractBatch: vi.fn(async (_master, _batch, output) => fs.writeFileSync(output, Buffer.alloc(2048))),
}));

it('reusa o primeiro bloco após a segunda chamada falhar e expurga o checkpoint ao terminar', async () => {
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
    enqueueTranscription(id);
    await vi.waitFor(() => {
      expect(readMeta(id)?.transcription?.status).toBe('done');
      expect(isTranscribing(id)).toBe(false);
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(readTranscript(id)?.map((segment) => segment.text)).toEqual(['Primeiro trecho.', 'Segundo trecho.']);
    expect(getProcessingProgress(id)).toMatchObject({
      stage: 'done',
      tracksCompleted: 1,
      batchesCompleted: 2,
      reusedBatches: 1,
    });
    expect(fs.existsSync(path.join(cacheDir(id), 'asr-checkpoints'))).toBe(false);
  } finally {
    setProcessingGuildGuard(() => false);
    deleteRecording(id);
    Object.assign(config, original);
    vi.unstubAllGlobals();
  }
});
