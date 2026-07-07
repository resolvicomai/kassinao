import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { buildAaiKeyterms } from '../src/processing/transcribe';
import {
  audioBytesOf,
  audioExpiryOf,
  deleteAudioOnly,
  forgetAudioBytes,
  readMeta,
  readTranscript,
  RecordingMeta,
  saveMeta,
  saveTranscript,
  textExpiryOf,
} from '../src/store';

const DIR = process.env.RECORDINGS_DIR!;
const DAY = 24 * 60 * 60 * 1000;

function makeMeta(id: string, extra: Partial<RecordingMeta> = {}): RecordingMeta {
  return {
    id,
    guildId: 'g1',
    guildName: 'time',
    voiceChannelId: 'c1',
    voiceChannelName: 'daily',
    startedBy: { id: 'u1', name: 'Ana' },
    startedAt: Date.now() - 3600_000,
    endedAt: Date.now(),
    status: 'done',
    participants: [{ id: 'u1', name: 'Ana', avatar: null, trackFile: '1-u1.flac', index: 1 }],
    events: [],
    notes: [],
    ...extra,
  };
}

/** Liga/desliga o modo ilimitado em cima do config já importado (os helpers leem na hora). */
function setUnlimited(on: boolean): void {
  (config as { audioRetentionUnlimited: boolean }).audioRetentionUnlimited = on;
  (config as { textRetentionUnlimited: boolean }).textRetentionUnlimited = on;
}

describe('retenção ilimitada (helpers respondem pela config ATUAL)', () => {
  beforeEach(() => setUnlimited(false));

  it('modo limitado: usa a data gravada no meta', () => {
    const exp = Date.now() + 3 * DAY;
    const m = makeMeta('ret-1', { expiresAt: exp, textExpiresAt: exp + 10 * DAY });
    expect(audioExpiryOf(m)).toBe(exp);
    expect(textExpiryOf(m)).toBe(exp + 10 * DAY);
  });

  it('modo limitado: meta antigo SEM data gravada ganha uma computada do endedAt', () => {
    const m = makeMeta('ret-2');
    const audio = audioExpiryOf(m)!;
    expect(audio).toBeGreaterThan(Date.now());
    expect(audio).toBe(m.endedAt! + config.retentionDays * DAY);
  });

  it('modo ilimitado: data de morte gravada no meta É IGNORADA (gravações antigas sobrevivem)', () => {
    setUnlimited(true);
    const m = makeMeta('ret-3', { expiresAt: Date.now() - DAY, textExpiresAt: Date.now() - DAY });
    expect(audioExpiryOf(m)).toBeUndefined();
    expect(textExpiryOf(m)).toBeUndefined();
  });

  it('gravação ao vivo (sem endedAt) não tem expiração em nenhum modo', () => {
    const m = makeMeta('ret-4', { status: 'recording', endedAt: undefined });
    expect(audioExpiryOf(m)).toBeUndefined();
    expect(textExpiryOf(m)).toBeUndefined();
  });
});

describe('liberar espaço (deleteAudioOnly) e tamanho em disco', () => {
  const ID = 'liberar-teste-1';
  const rec = path.join(DIR, ID);

  beforeEach(() => {
    setUnlimited(false);
    fs.rmSync(rec, { recursive: true, force: true });
    fs.mkdirSync(path.join(rec, 'tracks'), { recursive: true });
    fs.mkdirSync(path.join(rec, 'cache', 'sub'), { recursive: true });
    fs.writeFileSync(path.join(rec, 'tracks', '1-u1.flac'), Buffer.alloc(2048));
    fs.writeFileSync(path.join(rec, 'cache', 'sub', 'mix.mp3'), Buffer.alloc(1024));
    saveMeta(makeMeta(ID));
    saveTranscript(ID, [{ startMs: 0, endMs: 1000, speaker: 'Ana', text: 'oi' }]);
    forgetAudioBytes(ID);
  });

  it('audioBytesOf soma tracks + cache (recursivo) e cacheia', () => {
    expect(audioBytesOf(ID)).toBe(3072);
    // arquivo novo não aparece até invalidar o cache (TTL 60s)
    fs.writeFileSync(path.join(rec, 'cache', 'extra.bin'), Buffer.alloc(512));
    expect(audioBytesOf(ID)).toBe(3072);
    forgetAudioBytes(ID);
    expect(audioBytesOf(ID)).toBe(3584);
  });

  it('audioBytesOf rejeita id fora do padrão (sem tocar o filesystem)', () => {
    expect(audioBytesOf('../../../etc')).toBe(0);
  });

  it('deleteAudioOnly apaga só o áudio; meta e transcrição ficam, audioDeleted liga', () => {
    const meta = readMeta(ID)!;
    deleteAudioOnly(meta);
    expect(fs.existsSync(path.join(rec, 'tracks'))).toBe(false);
    expect(fs.existsSync(path.join(rec, 'cache'))).toBe(false);
    expect(readMeta(ID)?.audioDeleted).toBe(true);
    expect(readTranscript(ID)?.length).toBe(1);
    expect(audioBytesOf(ID)).toBe(0);
  });
});

describe('keyterms do Universal-3.5-Pro (AssemblyAI)', () => {
  it('inclui participantes, presença, servidor e canal — sem duplicar', () => {
    const m = makeMeta('kt-1', {
      participants: [
        { id: 'u1', name: 'Kaio Vsf', avatar: null, trackFile: '1.flac', index: 1 },
        { id: 'u2', name: 'Ana', avatar: null, trackFile: '2.flac', index: 2 },
      ],
      presence: [
        { id: 'u2', name: 'Ana', joinedAtMs: 0 },
        { id: 'u3', name: 'Mudo da Silva', joinedAtMs: 0 },
      ],
    });
    const terms = buildAaiKeyterms(m);
    expect(terms).toContain('Kaio Vsf');
    expect(terms).toContain('Mudo da Silva');
    expect(terms).toContain('time');
    expect(terms).toContain('daily');
    expect(terms.filter((t) => t === 'Ana')).toHaveLength(1);
  });

  it('respeita o limite da API: descarta termos com mais de 6 palavras e nomes de 1 caractere', () => {
    const m = makeMeta('kt-2', {
      participants: [
        { id: 'u1', name: 'um dois tres quatro cinco seis sete', avatar: null, trackFile: '1.flac', index: 1 },
        { id: 'u2', name: 'x', avatar: null, trackFile: '2.flac', index: 2 },
      ],
    });
    const terms = buildAaiKeyterms(m);
    expect(terms).not.toContain('um dois tres quatro cinco seis sete');
    expect(terms).not.toContain('x');
  });

  it('soma o vocabulário fixo do TRANSCRIBE_KEYTERMS', () => {
    const orig = config.transcribeKeyterms;
    (config as { transcribeKeyterms: string[] }).transcribeKeyterms = ['Projeto Andrômeda', 'OKR Q3'];
    try {
      const terms = buildAaiKeyterms(makeMeta('kt-3'));
      expect(terms).toContain('Projeto Andrômeda');
      expect(terms).toContain('OKR Q3');
    } finally {
      (config as { transcribeKeyterms: string[] }).transcribeKeyterms = orig;
    }
  });
});
