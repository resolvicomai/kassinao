import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config';
import {
  assertGuildWorkActive,
  createGuildWorkContext,
  fetchWithRetry,
  GuildWorkPausedError,
  pauseGuildProcessing,
  resumeGuildProcessing,
  runWithGuildWorkContext,
} from '../src/processing/http';
import { generateMinutes, llmChat } from '../src/processing/minutes';
import { commandTranscribe, enqueueTranscription, setProcessingGuildGuard } from '../src/processing/transcribe';
import { deleteRecording, readMeta, saveMeta, saveTranscript, type RecordingMeta } from '../src/store';

afterEach(() => {
  vi.unstubAllGlobals();
});

function workFor(guildId: string, allowed = () => true) {
  resumeGuildProcessing(guildId);
  return createGuildWorkContext(guildId, allowed);
}

describe('fronteira de egress por guild', () => {
  it('aborta a geração em voo e nunca a reativa ao retomar', () => {
    const guildId = 'guild-generation';
    const oldWork = workFor(guildId);

    // Eventos GuildAvailable duplicados não podem desregistrar a lease ativa.
    resumeGuildProcessing(guildId);
    pauseGuildProcessing(guildId);
    expect(oldWork.signal.aborted).toBe(true);

    expect(() => assertGuildWorkActive(oldWork)).toThrow(GuildWorkPausedError);

    resumeGuildProcessing(guildId);
    const newWork = createGuildWorkContext(guildId, () => true);
    expect(newWork.signal.aborted).toBe(false);
    expect(oldWork.signal.aborted).toBe(true);
  });

  it('interrompe o backoff sem disparar uma segunda requisição', async () => {
    const guildId = 'guild-retry';
    const work = workFor(guildId);
    const fetchMock = vi.fn(async () => new Response('temporariamente indisponível', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);

    const pending = fetchWithRetry('https://provider.invalid/transcribe', { signal: work.signal }, { attempts: 3 });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    pauseGuildProcessing(guildId);

    await expect(pending).rejects.toBeInstanceOf(GuildWorkPausedError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('propaga o cancelamento para a chamada interativa do /perguntar', async () => {
    const guildId = 'guild-ask';
    const work = workFor(guildId);
    const original = {
      minutesProvider: config.minutesProvider,
      groqApiKey: config.groqApiKey,
      minutesModel: config.minutesModel,
    };
    config.minutesProvider = 'groq';
    config.groqApiKey = 'test-groq-key';
    config.minutesModel = 'llama-test';
    const fetchMock = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          if (!init?.signal) throw new Error('llmChat não propagou a lease da guild');
          init.signal.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const pending = runWithGuildWorkContext(work, () => llmChat('sistema', 'pergunta', 100, { json: false }));
    try {
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      pauseGuildProcessing(guildId);
      await expect(pending).rejects.toBeInstanceOf(GuildWorkPausedError);
    } finally {
      config.minutesProvider = original.minutesProvider;
      config.groqApiKey = original.groqApiKey;
      config.minutesModel = original.minutesModel;
      resumeGuildProcessing(guildId);
    }
  });

  it('para o map-reduce antes do próximo bloco quando a guild é pausada', async () => {
    const guildId = 'guild-map-reduce';
    const work = workFor(guildId);
    const original = {
      minutesProvider: config.minutesProvider,
      groqApiKey: config.groqApiKey,
      minutesModel: config.minutesModel,
      minutesMaxTokens: config.minutesMaxTokens,
    };
    config.minutesProvider = 'groq';
    config.groqApiKey = 'test-groq-key';
    config.minutesModel = 'llama-test';
    config.minutesMaxTokens = 4096;

    const fetchMock = vi.fn(async () =>
      Response.json({
        choices: [{ message: { content: JSON.stringify({ notas: ['primeiro bloco'] }) }, finish_reason: 'stop' }],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const meta = {
      id: 'recording-map-reduce',
      guildId,
      locale: 'pt',
      voiceChannelName: 'Reunião',
      participants: [{ id: '1', name: 'Mauro' }],
      notes: [],
    } as RecordingMeta;
    const pending = generateMinutes(
      meta,
      [{ startMs: 0, endMs: 1, speaker: 'Mauro', text: 'conteúdo '.repeat(2200) }],
      work,
    );

    try {
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      pauseGuildProcessing(guildId);
      await expect(pending).rejects.toBeInstanceOf(GuildWorkPausedError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      config.minutesProvider = original.minutesProvider;
      config.groqApiKey = original.groqApiKey;
      config.minutesModel = original.minutesModel;
      config.minutesMaxTokens = original.minutesMaxTokens;
      resumeGuildProcessing(guildId);
    }
  });

  it('mata o transcritor local em voo ao pausar a guild', async () => {
    const guildId = 'guild-local-command';
    const work = workFor(guildId);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kassinao-command-cancel-'));
    const input = path.join(dir, 'input.mp3');
    fs.writeFileSync(input, 'fake audio');
    const originalCommand = config.transcribeCommand;
    config.transcribeCommand = "sleep 30; printf '[]' > {output}; test -f {input}";

    try {
      const pending = commandTranscribe(input, dir, 1, work);
      pauseGuildProcessing(guildId);
      await expect(pending).rejects.toBeInstanceOf(GuildWorkPausedError);
    } finally {
      config.transcribeCommand = originalCommand;
      resumeGuildProcessing(guildId);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('retoma a ata quando a guild volta antes de o job abortado sair da fila', async () => {
    const guildId = `guild-minutes-race-${crypto.randomUUID()}`;
    const recordingId = `recording-minutes-race-${crypto.randomUUID()}`;
    const original = {
      transcribeProvider: config.transcribeProvider,
      minutesEnabled: config.minutesEnabled,
      minutesProvider: config.minutesProvider,
      minutesModel: config.minutesModel,
      groqApiKey: config.groqApiKey,
    };
    let operational = true;
    let firstSignal: AbortSignal | undefined;
    const firstRequestStarted = Promise.withResolvers<void>();
    const onDone = vi.fn();
    const onSettled = vi.fn();
    const minutes = {
      resumo: 'Ata retomada.',
      decisoes: ['Continuar o lançamento.'],
      acoes: [],
      topicos: [{ titulo: 'Lançamento', inicioMs: 0 }],
      porParticipante: [{ nome: 'Mauro', pontos: ['Validou a retomada.'] }],
    };

    config.transcribeProvider = 'command';
    config.minutesEnabled = 'true';
    config.minutesProvider = 'groq';
    config.minutesModel = 'llama-test';
    config.groqApiKey = 'test-groq-key';
    setProcessingGuildGuard((candidate) => candidate === guildId && operational);
    resumeGuildProcessing(guildId);

    const fetchMock = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      if (fetchMock.mock.calls.length === 1) {
        firstSignal = init?.signal ?? undefined;
        firstRequestStarted.resolve();
        return new Promise<Response>((_resolve, reject) => {
          const rejectPaused = () => reject(firstSignal?.reason ?? new Error('processamento pausado'));
          if (firstSignal?.aborted) rejectPaused();
          else firstSignal?.addEventListener('abort', rejectPaused, { once: true });
        });
      }
      return Promise.resolve(
        Response.json({
          choices: [{ message: { content: JSON.stringify(minutes) }, finish_reason: 'stop' }],
        }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

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
    });
    saveTranscript(recordingId, [{ startMs: 0, endMs: 500, speaker: 'Mauro', text: 'Vamos lançar.' }]);

    try {
      enqueueTranscription(recordingId, onDone, onSettled);
      await firstRequestStarted.promise;

      // A rejeição do fetch só roda na próxima microtask. A guild volta ainda
      // nesta pilha, enquanto `queued` contém a gravação — a corrida original.
      operational = false;
      pauseGuildProcessing(guildId);
      operational = true;
      resumeGuildProcessing(guildId);

      await vi.waitFor(() => {
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(readMeta(recordingId)?.minutes?.status).toBe('done');
        expect(onDone).toHaveBeenCalledTimes(1);
        expect(onSettled).toHaveBeenCalledTimes(1);
      });
      expect(firstSignal?.aborted).toBe(true);
      expect(onDone.mock.calls[0][0]).toMatchObject({
        id: recordingId,
        transcription: { status: 'done' },
        minutes: { status: 'done' },
      });
    } finally {
      operational = false;
      setProcessingGuildGuard(() => false);
      pauseGuildProcessing(guildId);
      deleteRecording(recordingId);
      config.transcribeProvider = original.transcribeProvider;
      config.minutesEnabled = original.minutesEnabled;
      config.minutesProvider = original.minutesProvider;
      config.minutesModel = original.minutesModel;
      config.groqApiKey = original.groqApiKey;
    }
  });
});
