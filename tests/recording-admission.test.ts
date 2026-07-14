import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RecordingAdmissionGuard } from '../src/recorder/recordingAdmission';

const roots: string[] = [];

function guard(overrides: Partial<ConstructorParameters<typeof RecordingAdmissionGuard>[1]> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kassinao-recording-admission-'));
  roots.push(root);
  return new RecordingAdmissionGuard(path.join(root, '.recording-admission.json'), {
    maxStartsPerGuild24h: 2,
    maxStartsGlobalPerHour: 3,
    maxStartsGlobal24h: 5,
    maxPendingProcessing: 3,
    ...overrides,
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function commit(
  admission: RecordingAdmissionGuard,
  guildId: string,
  origin: 'manual' | 'auto',
  now: number,
  recordingId: string,
) {
  const result = admission.reserve(guildId, origin, now);
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) throw new Error('expected admission');
  expect(result.reservation.bindRecording(recordingId)).toBe(true);
  expect(result.reservation.commit(now)).toBe(true);
  return result.reservation;
}

describe('admissão durável de gravações', () => {
  it('conta reservas concorrentes nas cotas e desfaz tudo quando o início falha', () => {
    const admission = guard({ maxStartsPerGuild24h: 1 });
    const pending = admission.reserve('guild-a', 'manual', 1_000);
    expect(pending).toMatchObject({ ok: true });
    expect(admission.reserve('guild-a', 'auto', 2_000)).toMatchObject({
      ok: false,
      reason: 'guild-daily-limit',
    });
    if (!pending.ok) throw new Error('expected admission');
    expect(pending.reservation.rollback()).toBe(true);
    expect(admission.reserve('guild-a', 'auto', 3_000)).toMatchObject({ ok: true });
  });

  it('aplica a mesma cota por servidor a inícios manuais e automáticos', () => {
    const admission = guard();

    commit(admission, 'guild-a', 'manual', 1_000, 'rec-1');
    commit(admission, 'guild-a', 'auto', 2_000, 'rec-2');

    expect(admission.reserve('guild-a', 'manual', 3_000)).toEqual({
      ok: false,
      reason: 'guild-daily-limit',
      retryAfterMs: 86_398_000,
    });
  });

  it('aplica tetos globais móveis de uma hora e 24 horas', () => {
    const admission = guard({
      maxStartsPerGuild24h: 10,
      maxStartsGlobalPerHour: 2,
      maxStartsGlobal24h: 3,
      maxPendingProcessing: 10,
    });
    commit(admission, 'guild-a', 'manual', 1_000, 'rec-1');
    commit(admission, 'guild-b', 'auto', 2_000, 'rec-2');

    expect(admission.reserve('guild-c', 'manual', 3_000)).toEqual({
      ok: false,
      reason: 'global-hourly-limit',
      retryAfterMs: 3_598_000,
    });

    commit(admission, 'guild-c', 'manual', 3_601_000, 'rec-3');
    expect(admission.reserve('guild-d', 'auto', 3_602_000)).toEqual({
      ok: false,
      reason: 'global-daily-limit',
      retryAfterMs: 82_799_000,
    });
  });

  it('reserva capacidade de processamento antes da captura e só libera no fim', () => {
    const admission = guard({
      maxStartsPerGuild24h: 10,
      maxStartsGlobalPerHour: 10,
      maxStartsGlobal24h: 10,
      maxPendingProcessing: 1,
    });
    const first = admission.reserve('guild-a', 'manual', 1_000);
    expect(first).toMatchObject({ ok: true });
    expect(admission.reserve('guild-b', 'auto', 2_000)).toEqual({
      ok: false,
      reason: 'processing-capacity',
    });
    if (!first.ok) throw new Error('expected admission');
    expect(first.reservation.rollback()).toBe(true);

    const committed = commit(admission, 'guild-b', 'auto', 3_000, 'rec-2');
    expect(admission.reserve('guild-c', 'manual', 4_000)).toEqual({
      ok: false,
      reason: 'processing-capacity',
    });
    expect(admission.complete('rec-2')).toBe(true);
    expect(admission.pendingProcessingCount()).toBe(0);
    expect(admission.reserve('guild-c', 'manual', 5_000)).toMatchObject({ ok: true });
    expect(committed.rollback()).toBe(false);
  });

  it('mantém cotas e vagas após reinício e reconcilia reservas de crash', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kassinao-recording-admission-'));
    roots.push(root);
    const file = path.join(root, '.recording-admission.json');
    const limits = {
      maxStartsPerGuild24h: 1,
      maxStartsGlobalPerHour: 10,
      maxStartsGlobal24h: 10,
      maxPendingProcessing: 3,
    };
    const beforeCrash = new RecordingAdmissionGuard(file, limits);
    commit(beforeCrash, 'guild-a', 'manual', 1_000, 'rec-1');
    const interrupted = beforeCrash.reserve('guild-b', 'auto', 2_000);
    const abandoned = beforeCrash.reserve('guild-c', 'manual', 3_000);
    if (!interrupted.ok || !abandoned.ok) throw new Error('expected reservations');
    expect(interrupted.reservation.bindRecording('rec-2')).toBe(true);

    const afterCrash = new RecordingAdmissionGuard(file, limits);
    expect(
      afterCrash.reconcile(
        new Map([
          ['rec-1', { guildId: 'guild-a', startedAt: 1_000 }],
          ['rec-2', { guildId: 'guild-b', startedAt: 2_000 }],
          ['rec-legacy', { guildId: 'guild-legacy', startedAt: 2_500 }],
        ]),
        4_000,
      ),
    ).toBe(true);
    expect(afterCrash.pendingProcessingCount()).toBe(3);
    expect(afterCrash.reserve('guild-a', 'auto', 5_000)).toMatchObject({
      ok: false,
      reason: 'guild-daily-limit',
    });
    expect(afterCrash.reserve('guild-new', 'manual', 5_000)).toEqual({
      ok: false,
      reason: 'processing-capacity',
    });
    expect(afterCrash.complete('rec-1')).toBe(true);
    expect(afterCrash.complete('rec-2')).toBe(true);
    expect(afterCrash.complete('rec-legacy')).toBe(true);
    expect(afterCrash.pendingProcessingCount()).toBe(0);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('falha fechado quando o estado persistido está corrompido', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kassinao-recording-admission-'));
    roots.push(root);
    const file = path.join(root, '.recording-admission.json');
    fs.writeFileSync(file, '{', { mode: 0o600 });
    const admission = new RecordingAdmissionGuard(file, {
      maxStartsPerGuild24h: 2,
      maxStartsGlobalPerHour: 3,
      maxStartsGlobal24h: 5,
      maxPendingProcessing: 3,
    });

    expect(admission.isHealthy()).toBe(false);
    expect(admission.reserve('guild-a', 'manual', 1_000)).toEqual({
      ok: false,
      reason: 'storage-unavailable',
    });
    expect(fs.readFileSync(file, 'utf8')).toBe('{');
  });
});
