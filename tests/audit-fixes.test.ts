import { describe, expect, it } from 'vitest';
import { isOwnLink } from '../src/ask';
import { transcriptionBlocksAudioTrim } from '../src/cleanup';
import { RecordingMeta } from '../src/store';

// Regressões nascidas da auditoria adversarial (#12–#25):
// - isOwnLink: allowlist de link do /perguntar por FRONTEIRA de origem (não prefixo cru).
// - transcriptionBlocksAudioTrim: guard que impede o trim de áudio de apagar faixas
//   ainda não transcritas no gap de retry parcial.

describe('isOwnLink (allowlist de link do /perguntar)', () => {
  const base = 'https://kass.example.com';

  it('aceita a própria origem e caminhos/âncoras dela', () => {
    expect(isOwnLink(base, base)).toBe(true);
    expect(isOwnLink(`${base}/`, base)).toBe(true);
    expect(isOwnLink(`${base}/rec/abc123#t=970`, base)).toBe(true); // a citação real do RAG
    expect(isOwnLink(`${base}#topo`, base)).toBe(true);
  });

  it('REJEITA domínio lookalike que passaria no startsWith (o FP corrigido)', () => {
    expect(isOwnLink(`${base}.evil.tld/phish`, base)).toBe(false);
    expect(isOwnLink(`${base}-evil.tld`, base)).toBe(false);
    expect(isOwnLink('https://kass.example.competitor.com/x', base)).toBe(false);
  });

  it('REJEITA outros hosts e esquema diferente', () => {
    expect(isOwnLink('https://evil.tld/phish', base)).toBe(false);
    expect(isOwnLink('http://kass.example.com/rec/1', base)).toBe(false); // http ≠ https origin
    expect(isOwnLink('javascript:alert(1)', base)).toBe(false);
  });
});

describe('transcriptionBlocksAudioTrim (guard de retenção vs transcrição pendente)', () => {
  const meta = (transcription: unknown): RecordingMeta => ({ transcription }) as unknown as RecordingMeta;

  it('BLOQUEIA o trim enquanto a transcrição pode reler as faixas', () => {
    expect(transcriptionBlocksAudioTrim(meta({ status: 'pending' }))).toBe(true);
    expect(transcriptionBlocksAudioTrim(meta({ status: 'running' }))).toBe(true);
    // gap de retry parcial: id fora da fila em memória, mas retryScheduled persistido
    expect(transcriptionBlocksAudioTrim(meta({ status: 'partial', retryScheduled: true }))).toBe(true);
  });

  it('LIBERA o trim quando a transcrição está resolvida (não vai reler faixas)', () => {
    expect(transcriptionBlocksAudioTrim(meta({ status: 'done' }))).toBe(false);
    expect(transcriptionBlocksAudioTrim(meta({ status: 'partial', retryScheduled: false }))).toBe(false); // parcial final
    expect(transcriptionBlocksAudioTrim(meta({ status: 'error' }))).toBe(false);
    expect(transcriptionBlocksAudioTrim(meta({ status: 'disabled' }))).toBe(false);
    expect(transcriptionBlocksAudioTrim(meta(undefined))).toBe(false); // sem transcrição
  });
});
