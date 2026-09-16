import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { config } from '../src/config';
import { enqueueTranscription, isTranscribing, setProcessingGuildGuard } from '../src/processing/transcribe';
import { deleteRecording, readMeta, readTranscript, saveMeta, tracksDir } from '../src/store';

vi.mock('../src/processing/ffmpeg', () => ({ runFfmpeg: vi.fn(async () => 'time=00:40:00') }));
vi.mock('../src/processing/vad', async (original) => ({
  ...(await original<typeof import('../src/processing/vad')>()),
  detectSpeechIntervals: vi.fn(async () => [{ start: 0, end: 2400 }]),
  extractBatch: vi.fn(async (_master, _batch, output) => fs.writeFileSync(output, Buffer.alloc(2048))),
}));

function fixture() {
  const id = `audio-${crypto.randomUUID()}`;
  const guildId = `guild-${crypto.randomUUID()}`;
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
  return { id, guildId };
}

it('apaga o áudio assim que a transcrição completa está salva', async () => {
  const { id, guildId } = fixture();
  const original = {
    transcribeProvider: config.transcribeProvider,
    groqApiKey: config.groqApiKey,
    minutesEnabled: config.minutesEnabled,
  };
  config.transcribeProvider = 'groq';
  config.groqApiKey = 'synthetic-key';
  config.minutesEnabled = 'false';
  setProcessingGuildGuard((candidate) => candidate === guildId);
  // mockImplementation, não mockResolvedValue: o corpo de uma Response só pode ser lido uma vez.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ segments: [{ start: 0, end: 10, text: 'Combinamos a data.' }] })),
  );
  try {
    expect(fs.existsSync(tracksDir(id))).toBe(true);
    enqueueTranscription(id);
    await vi.waitFor(() => {
      expect(readMeta(id)?.transcription?.status).toBe('done');
      expect(isTranscribing(id)).toBe(false);
    });
    // O texto fica; o artefato pesado some sem esperar RETENTION_DAYS.
    expect(readTranscript(id)?.map((segment) => segment.text)).toEqual(['Combinamos a data.']);
    expect(readMeta(id)?.audioDeleted).toBe(true);
    expect(fs.existsSync(tracksDir(id))).toBe(false);
  } finally {
    setProcessingGuildGuard(() => false);
    deleteRecording(id);
    Object.assign(config, original);
    vi.unstubAllGlobals();
  }
});

it('preserva o áudio quando a transcrição falha, para a retentativa ainda ter o que ler', async () => {
  const { id, guildId } = fixture();
  const original = {
    transcribeProvider: config.transcribeProvider,
    groqApiKey: config.groqApiKey,
    minutesEnabled: config.minutesEnabled,
  };
  config.transcribeProvider = 'groq';
  config.groqApiKey = 'synthetic-key';
  config.minutesEnabled = 'false';
  setProcessingGuildGuard((candidate) => candidate === guildId);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({}, { status: 400 })),
  );
  try {
    enqueueTranscription(id);
    await vi.waitFor(() => {
      expect(readMeta(id)?.transcription?.status).toBe('error');
      expect(isTranscribing(id)).toBe(false);
    });
    expect(readMeta(id)?.audioDeleted).toBeFalsy();
    expect(fs.existsSync(path.join(tracksDir(id), 'user.flac'))).toBe(true);
  } finally {
    setProcessingGuildGuard(() => false);
    deleteRecording(id);
    Object.assign(config, original);
    vi.unstubAllGlobals();
  }
});
