import crypto from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config';
import { resumeGuildProcessing } from '../src/processing/http';
import { enqueueTranscription, retryMinutes, setProcessingGuildGuard } from '../src/processing/transcribe';
import { deleteRecording, readMeta, saveMeta, saveTranscript, type MinutesState } from '../src/store';

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * Ata que falha: a primeira falha vira `pending` à espera do retry (sem DM), e a
 * última vira `error` com aviso. Transcrição já pronta (doneTrackIds) para o
 * teste exercitar só o passo da ata; o provedor da ata responde 400 (não retentável).
 */
function seed(recordingId: string, guildId: string, minutes?: MinutesState): void {
  const now = Date.now();
  saveMeta({
    id: recordingId,
    guildId,
    guildName: 'Guild de teste',
    voiceChannelId: 'voice-test',
    voiceChannelName: 'Sala de teste',
    startedBy: { id: 'u1', name: 'Mauro' },
    startedAt: now - 1_000,
    endedAt: now,
    status: 'done',
    participants: [{ id: 'u1', name: 'Mauro', avatar: null, trackFile: 'u1.flac', index: 0 }],
    events: [],
    notes: [],
    transcription: { status: 'pending', attempts: 0, doneTrackIds: ['u1'] },
    ...(minutes ? { minutes } : {}),
  });
  saveTranscript(recordingId, [{ startMs: 0, endMs: 500, speaker: 'Mauro', text: 'Vamos lançar.' }]);
}

async function runWithFailingMinutes(
  minutes?: MinutesState,
  response = () => Response.json({ error: { message: 'bad request' } }, { status: 400 }),
) {
  const guildId = `guild-minutes-retry-${crypto.randomUUID()}`;
  const recordingId = `recording-minutes-retry-${crypto.randomUUID()}`;
  const original = {
    transcribeProvider: config.transcribeProvider,
    minutesEnabled: config.minutesEnabled,
    minutesProvider: config.minutesProvider,
    minutesModel: config.minutesModel,
    groqApiKey: config.groqApiKey,
  };
  config.transcribeProvider = 'command';
  config.minutesEnabled = 'true';
  config.minutesProvider = 'groq';
  config.minutesModel = 'llama-test';
  config.groqApiKey = 'test-groq-key';
  setProcessingGuildGuard((candidate) => candidate === guildId);
  resumeGuildProcessing(guildId);
  const fetchMock = vi.fn(async () => response());
  vi.stubGlobal('fetch', fetchMock);
  const onDone = vi.fn();
  const onSettled = vi.fn();
  seed(recordingId, guildId, minutes);
  try {
    enqueueTranscription(recordingId, onDone, onSettled);
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
      const state = readMeta(recordingId)?.minutes;
      expect(state?.status === 'pending' || state?.status === 'error').toBe(true);
      expect(state?.status).not.toBe('running');
    });
    // deixa a cadeia de promessas (scheduleMinutesRetry / notifyDone) terminar
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { meta: readMeta(recordingId), onDone, onSettled, fetchMock };
  } finally {
    Object.assign(config, original);
    deleteRecording(recordingId);
  }
}

describe('ata que falha', () => {
  it('não repete geração aceita quando o corpo da resposta se perde', async () => {
    const { meta, onDone, onSettled, fetchMock } = await runWithFailingMinutes(
      undefined,
      () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.error(new Error('synthetic response stream failure'));
            },
          }),
          { status: 200 },
        ),
    );
    expect(meta?.minutes).toMatchObject({ status: 'error', attempts: 1, retryScheduled: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('primeira falha vira pending à espera do retry, sem avisar ninguém ainda', async () => {
    const { meta, onDone, onSettled } = await runWithFailingMinutes();
    expect(meta?.minutes).toMatchObject({ status: 'pending', attempts: 1, retryScheduled: true });
    expect(meta?.minutes?.error).toBeTruthy();
    expect(onDone).not.toHaveBeenCalled();
    expect(onSettled).not.toHaveBeenCalled();
  });

  it('última tentativa vira error definitivo e aí sim avisa', async () => {
    const { meta, onDone, onSettled } = await runWithFailingMinutes({
      status: 'pending',
      model: 'llama-test',
      attempts: 2,
      retryScheduled: true,
    });
    expect(meta?.minutes).toMatchObject({ status: 'error', attempts: 3, retryScheduled: false });
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone.mock.calls[0][0]).toMatchObject({ minutes: { status: 'error' } });
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('retry autorizado reinicia só a ata terminal sem reenviar áudio', async () => {
    const id = `manual-minutes-${crypto.randomUUID()}`;
    const guildId = `guild-${crypto.randomUUID()}`;
    const original = {
      minutesEnabled: config.minutesEnabled,
      minutesProvider: config.minutesProvider,
      groqApiKey: config.groqApiKey,
    };
    config.minutesEnabled = 'true';
    config.minutesProvider = 'groq';
    config.groqApiKey = 'synthetic-key';
    setProcessingGuildGuard((candidate) => candidate === guildId);
    seed(id, guildId, { status: 'error', attempts: 3 });
    const meta = readMeta(id)!;
    meta.transcription!.status = 'done';
    saveMeta(meta);
    const minutes = { resumo: 'Ata recuperada.', decisoes: [], acoes: [], topicos: [], porParticipante: [] };
    const fetchMock = vi.fn(async (_url: string) =>
      Response.json({ choices: [{ message: { content: JSON.stringify(minutes) }, finish_reason: 'stop' }] }),
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      expect(retryMinutes(id)).toBe('queued');
      expect(retryMinutes(id)).toBe('busy');
      await vi.waitFor(() => expect(readMeta(id)?.minutes?.status).toBe('done'));
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]?.[0]).toContain('/chat/completions');
      expect(retryMinutes(id)).toBe('not-failed');
    } finally {
      Object.assign(config, original);
      setProcessingGuildGuard(() => false);
      deleteRecording(id);
    }
  });
});
