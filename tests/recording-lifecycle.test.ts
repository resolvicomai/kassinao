import { describe, expect, it } from 'vitest';
import {
  BoundedIdSet,
  canManuallyStartRecording,
  controlSessionId,
  MarkClickDeduper,
  shouldRearmAutoRecord,
  shouldRearmOnPopulationDrop,
} from '../src/recorder/lifecycle';
import { SessionRegistry } from '../src/recorder/manager';

interface FakeSession {
  id: string;
}

describe('SessionRegistry — concorrência do ciclo de gravação', () => {
  it('concede uma única reserva para dois /gravar no mesmo servidor', () => {
    const manager = new SessionRegistry<FakeSession>();
    const first = manager.reserveStart('g1', 'c1', 'daily');
    const second = manager.reserveStart('g1', 'c1', 'daily');

    expect(first).toBeDefined();
    expect(second).toBeUndefined();
    expect(manager.startingInfo('g1')).toMatchObject({ channelId: 'c1', channelName: 'daily' });
  });

  it('duas salas do mesmo servidor coexistem quando cada uma usa uma identidade de voz', () => {
    const manager = new SessionRegistry<FakeSession>();
    const daily = manager.reserveStart('g1', 'c1', 'daily', 4)!;
    const extra = manager.reserveStart('g1', 'c2', 'suporte', 4, { identityLabel: 'helper-1' });

    expect(extra).toBeDefined();
    const s1 = { id: 'rec-1' };
    const s2 = { id: 'rec-2' };
    expect(manager.attachStarting(daily, s1)).toBe(true);
    expect(manager.commitStart(daily, s1)).toBe(true);
    expect(manager.attachStarting(extra!, s2)).toBe(true);
    expect(manager.commitStart(extra!, s2)).toBe(true);

    expect(manager.getByChannel('g1', 'c1')).toBe(s1);
    expect(manager.getByChannel('g1', 'c2')).toBe(s2);
    expect(manager.listByGuild('g1')).toHaveLength(2);
    expect(manager.busyLabels('g1')).toEqual(new Set(['default', 'helper-1']));
  });

  it('a mesma identidade de voz não grava duas salas: é uma conexão por bot user', () => {
    const manager = new SessionRegistry<FakeSession>();
    expect(manager.reserveStart('g1', 'c1', 'daily')).toBeDefined();
    expect(manager.reserveStart('g1', 'c2', 'suporte')).toBeUndefined(); // ambas 'default'
    expect(manager.reserveStart('g1', 'c2', 'suporte', undefined, { identityLabel: 'helper-1' })).toBeDefined();
  });

  it('o mesmo canal nunca tem duas gravações, nem com identidades diferentes', () => {
    const manager = new SessionRegistry<FakeSession>();
    expect(manager.reserveStart('g1', 'c1', 'daily')).toBeDefined();
    expect(manager.reserveStart('g1', 'c1', 'daily', undefined, { identityLabel: 'helper-1' })).toBeUndefined();
  });

  it('getById acha a sessão ativa certa e ignora as que estão encerrando', () => {
    const manager = new SessionRegistry<FakeSession>();
    const r1 = manager.reserveStart('g1', 'c1', 'daily')!;
    const r2 = manager.reserveStart('g2', 'c9', 'retro')!;
    const s1 = { id: 'rec-1' };
    const s2 = { id: 'rec-2' };
    manager.attachStarting(r1, s1);
    manager.commitStart(r1, s1);
    manager.attachStarting(r2, s2);
    manager.commitStart(r2, s2);

    expect(manager.getById('rec-1')).toBe(s1);
    expect(manager.getById('rec-2')).toBe(s2);
    // encerrando deixa de ser "ao vivo" — mesmo contrato do get() histórico
    manager.beginStop('g1', s1);
    expect(manager.getById('rec-1')).toBeUndefined();
  });

  it('busyChannels lista as salas ocupadas com a fase certa', () => {
    const manager = new SessionRegistry<FakeSession>();
    manager.reserveStart('g1', 'c1', 'daily'); // starting
    const r2 = manager.reserveStart('g1', 'c2', 'suporte', undefined, { identityLabel: 'helper-1' })!;
    const s2 = { id: 'rec-2' };
    manager.attachStarting(r2, s2);
    manager.commitStart(r2, s2); // recording

    const busy = manager.busyChannels('g1');
    expect(busy).toHaveLength(2);
    expect(busy.find((b) => b.channelId === 'c1')?.phase).toBe('starting');
    expect(busy.find((b) => b.channelId === 'c2')?.phase).toBe('recording');
    expect(busy.find((b) => b.channelId === 'c2')?.channelName).toBe('suporte');
  });

  it('mantém servidores diferentes independentes', () => {
    const manager = new SessionRegistry<FakeSession>();
    expect(manager.reserveStart('g1', 'c1', 'daily')).toBeDefined();
    expect(manager.reserveStart('g2', 'c2', 'suporte')).toBeDefined();
  });

  it('aplica o teto global contando sessões iniciando, ativas e encerrando', () => {
    const manager = new SessionRegistry<FakeSession>();
    const starting = manager.reserveStart('g1', 'c1', 'daily', 3)!;
    const activeReservation = manager.reserveStart('g2', 'c2', 'suporte', 3)!;
    const stoppingReservation = manager.reserveStart('g3', 'c3', 'planning', 3)!;
    const active = { id: 'active' };
    const stopping = { id: 'stopping' };

    expect(manager.attachStarting(activeReservation, active)).toBe(true);
    expect(manager.commitStart(activeReservation, active)).toBe(true);
    expect(manager.attachStarting(stoppingReservation, stopping)).toBe(true);
    expect(manager.commitStart(stoppingReservation, stopping)).toBe(true);
    expect(manager.beginStop('g3', stopping)).toBe('claimed');

    expect(manager.busyCount()).toBe(3);
    expect(manager.reserveStart('g4', 'c4', 'retro', 3)).toBeUndefined();

    manager.releaseStart(starting);
    expect(manager.reserveStart('g4', 'c4', 'retro', 3)).toBeDefined();
  });

  it('cancelamento aborta o sinal e impede attach/commit tardio', () => {
    const manager = new SessionRegistry<FakeSession>();
    const reservation = manager.reserveStart('g1', 'c1', 'daily')!;
    const session = { id: 's1' };
    expect(manager.attachStarting(reservation, session)).toBe(true);

    const cancelled = manager.cancelStart('g1');

    expect(reservation.signal.aborted).toBe(true);
    expect(cancelled).toMatchObject({ session, cancelRequested: true });
    expect(manager.commitStart(reservation, session)).toBe(false);
  });

  it('release antigo não apaga uma reserva mais nova', () => {
    const manager = new SessionRegistry<FakeSession>();
    const oldReservation = manager.reserveStart('g1', 'c1', 'daily')!;
    manager.releaseStart(oldReservation);
    const currentReservation = manager.reserveStart('g1', 'c2', 'planning')!;

    manager.releaseStart(oldReservation);

    expect(manager.startingInfo('g1')).toMatchObject({ channelId: 'c2' });
    expect(manager.attachStarting(currentReservation, { id: 's2' })).toBe(true);
  });

  it('commit move para ativo e encerramento só pode ser assumido uma vez', () => {
    const manager = new SessionRegistry<FakeSession>();
    const reservation = manager.reserveStart('g1', 'c1', 'daily')!;
    const session = { id: 's1' };
    expect(manager.attachStarting(reservation, session)).toBe(true);
    expect(manager.commitStart(reservation, session)).toBe(true);
    expect(manager.get('g1')).toBe(session);
    expect(manager.reserveStart('g1', 'c1', 'daily')).toBeUndefined();

    expect(manager.beginStop('g1', session)).toBe('claimed');
    expect(manager.beginStop('g1', session)).toBe('already-stopping');
    expect(manager.get('g1')).toBeUndefined();
    expect(manager.stoppingSession('g1')).toBe(session);
    expect(manager.reserveStart('g1', 'c1', 'daily')).toBeUndefined();

    manager.finishStop('g1', session);
    expect(manager.isBusy('g1')).toBe(false);
  });

  it('cancelAllStarts aborta todas as inicializações anexadas', () => {
    const manager = new SessionRegistry<FakeSession>();
    const r1 = manager.reserveStart('g1', 'c1', 'daily')!;
    const r2 = manager.reserveStart('g2', 'c2', 'suporte')!;
    manager.attachStarting(r1, { id: 's1' });
    manager.attachStarting(r2, { id: 's2' });

    expect(
      manager
        .cancelAllStarts()
        .map((s) => s.id)
        .sort(),
    ).toEqual(['s1', 's2']);
    expect(r1.signal.aborted).toBe(true);
    expect(r2.signal.aborted).toBe(true);
  });
});

describe('controles vinculados à sessão', () => {
  it('aceita somente prefixo:id e rejeita botões legados ou adulterados', () => {
    expect(controlSessionId('kassinao_stop:2026-07-10-abc', 'kassinao_stop')).toBe('2026-07-10-abc');
    expect(controlSessionId('kassinao_stop', 'kassinao_stop')).toBeUndefined();
    expect(controlSessionId('kassinao_stop:s1:extra', 'kassinao_stop')).toBeUndefined();
    expect(controlSessionId('kassinao_note:s1', 'kassinao_stop')).toBeUndefined();
  });
});

describe('permissão de início manual', () => {
  it('permite membro presente com ViewChannel', () => {
    expect(canManuallyStartRecording({ canView: true, isPresent: true, canManageGuild: false })).toBe(true);
  });

  it('nega observador fora da sala mesmo que enxergue o canal', () => {
    expect(canManuallyStartRecording({ canView: true, isPresent: false, canManageGuild: false })).toBe(false);
  });

  it('permite operação remota somente a ManageGuild que também enxerga o canal', () => {
    expect(canManuallyStartRecording({ canView: true, isPresent: false, canManageGuild: true })).toBe(true);
    expect(canManuallyStartRecording({ canView: false, isPresent: false, canManageGuild: true })).toBe(false);
  });
});

describe('rearme e deduplicação', () => {
  it('rearma auto-record só para continuidade técnica, nunca após parada humana ou disco', () => {
    expect(shouldRearmAutoRecord(true, 'tempo-maximo')).toBe(true);
    expect(shouldRearmAutoRecord(true, 'desconectado')).toBe(false);
    expect(shouldRearmAutoRecord(true, 'canal-alterado')).toBe(false);
    expect(shouldRearmAutoRecord(true, 'manual')).toBe(false);
    expect(shouldRearmAutoRecord(true, 'disco-cheio')).toBe(false);
    expect(shouldRearmAutoRecord(false, 'tempo-maximo')).toBe(false);
  });

  it('BoundedIdSet remove apenas o mais antigo, sem abrir janela de duplicação geral', () => {
    const ids = new BoundedIdSet(2);
    expect(ids.addOnce('a')).toBe(true);
    expect(ids.addOnce('b')).toBe(true);
    expect(ids.addOnce('b')).toBe(false);
    expect(ids.addOnce('c')).toBe(true);
    expect(ids.has('a')).toBe(false);
    expect(ids.has('b')).toBe(true);
    expect(ids.has('c')).toBe(true);
  });

  it('ignora duplo clique do mesmo usuário, mas não de outra pessoa ou depois da janela', () => {
    const clicks = new MarkClickDeduper(1500);
    expect(clicks.accept('s1', 'u1', 1000)).toBe(true);
    expect(clicks.accept('s1', 'u1', 1200)).toBe(false);
    expect(clicks.accept('s1', 'u2', 1200)).toBe(true);
    expect(clicks.accept('s1', 'u1', 2500)).toBe(true);
  });
});

describe('shouldRearmOnPopulationDrop — rearme por queda de população', () => {
  const rule = { minimum: 3 };

  it('sem sessão na sala, cair abaixo do mínimo rearma', () => {
    expect(shouldRearmOnPopulationDrop(rule, 2, undefined)).toBe(true);
  });

  it('sessão automática viva mantém o rearme imediato (ela encerra por abaixo-minimo)', () => {
    expect(shouldRearmOnPopulationDrop(rule, 2, { auto: true })).toBe(true);
  });

  it('sessão MANUAL viva ou encerrando nunca rearma: o /parar não pode religar a gravação', () => {
    expect(shouldRearmOnPopulationDrop(rule, 2, { auto: false })).toBe(false);
    expect(shouldRearmOnPopulationDrop(rule, 0, { auto: false })).toBe(false);
  });

  it('sala no mínimo ou acima, ou sem regra, nunca rearma', () => {
    expect(shouldRearmOnPopulationDrop(rule, 3, undefined)).toBe(false);
    expect(shouldRearmOnPopulationDrop(rule, 5, { auto: true })).toBe(false);
    expect(shouldRearmOnPopulationDrop(undefined, 0, undefined)).toBe(false);
  });
});
