import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createCommitmentService,
  CommitmentInputError,
  CommitmentAuthorizationUnavailableError,
  CommitmentAccessError,
  COMPLETION_EVIDENCE_MAX_AGE_MS,
  removeStoredMeetingCommitments,
  type CommitmentServiceOptions,
} from '../src/commitments';
import { createIntegrationClient } from '../src/integrations/client';
import { parseIntegrationConfiguration } from '../src/integrations/config';
import type { ArtifactSnapshot } from '../src/integrations/types';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const meeting = { id: 'meeting-1', guildId: '1', voiceChannelId: '2', startedAt: Date.parse('2026-09-04T13:00:00Z') };
const action = {
  tarefa: 'Validar o parser',
  responsavel: 'Ana',
  prazo: 'amanhã',
  source: { startMs: 1000, endMs: 3000, quote: 'Ana vai validar o parser amanhã.' },
};
function setup(overrides: Partial<CommitmentServiceOptions> = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kassinao-commitments-'));
  dirs.push(stateDir);
  const options: CommitmentServiceOptions = {
    stateDir,
    authorize: async () => true,
    authorizeArtifact: async () => true,
    now: () => Date.parse('2026-09-04T14:00:00Z'),
    timezone: 'America/Sao_Paulo',
    ...overrides,
  };
  return { options, service: createCommitmentService(options) };
}
function integrations() {
  return createIntegrationClient(
    parseIntegrationConfiguration({
      KASSINAO_CONTEXT_SCOPES: JSON.stringify([{ guildId: '1', channelId: '2', githubRepositories: ['example/app'] }]),
      GITHUB_CONTEXT_TOKEN: 'fixture',
    }),
  );
}

describe('persistent commitment identity and state', () => {
  it('keeps identity/status/source across reorder, deadline changes and restart', async () => {
    const { service, options } = setup();
    const [initial] = service.syncMeeting(meeting, [action, { tarefa: 'Outra tarefa' }]);
    await service.setStatus('user1', initial.id, 'confirmed');
    const second = service
      .syncMeeting(meeting, [{ tarefa: 'Outra tarefa' }, { ...action, prazo: 'sexta' }])
      .find((c) => c.task === action.tarefa)!;
    expect(second).toMatchObject({
      id: initial.id,
      status: 'confirmed',
      deadline: 'sexta',
      lastStatusBy: 'user1',
      source: action.source,
    });
    expect((await createCommitmentService(options).listForUser('user1')).find((c) => c.id === initial.id)?.status).toBe(
      'confirmed',
    );
    expect(fs.statSync(path.join(options.stateDir, 'commitments.json')).mode & 0o777).toBe(0o600);
  });
  it('does not cancel a commitment missing from a regenerated summary', async () => {
    const { service } = setup();
    const [entry] = service.syncMeeting(meeting, [action]);
    await service.setStatus('user1', entry.id, 'confirmed');
    service.syncMeeting(meeting, []);
    expect((await service.listForUser('user1'))[0]).toMatchObject({ sourcePresent: false, status: 'confirmed' });
  });
  it('isolates identities between meetings and repeated identical actions', () => {
    const { service } = setup();
    const records = service.syncMeeting(meeting, [action, action]);
    const [other] = service.syncMeeting({ ...meeting, id: 'meeting-2' }, [action]);
    expect(new Set([...records, other].map((r) => r.id)).size).toBe(3);
  });
  it('deletes commitment and recipient state on recording removal', async () => {
    const { service } = setup();
    const [entry] = service.syncMeeting(meeting, [action]);
    await service.setPreference('user1', entry.id, { mode: 'follow' });
    service.removeMissingMeetings(new Set());
    expect(await service.listForUser('user1')).toEqual([]);
    expect(service.listFollowers()).toEqual([]);
  });
  it('requires current ACL for reads and mutations', async () => {
    let access = true;
    const { service } = setup({
      authorize: async () => access,
    });
    const [entry] = service.syncMeeting(meeting, [action]);
    access = false;
    expect(await service.listForUser('user1')).toEqual([]);
    await expect(service.setStatus('user1', entry.id, 'completed')).rejects.toThrow('indisponível');
    await expect(service.setPreference('user1', entry.id, { mode: 'follow' })).rejects.toThrow();
  });
  it('propagates sanitized authorization unavailability instead of returning an empty list', async () => {
    const { service } = setup({
      authorize: async () => {
        throw new Error('Discord 429 with private detail');
      },
    });
    const [entry] = service.syncMeeting(meeting, [action]);
    await expect(service.listForUser('user1')).rejects.toBeInstanceOf(CommitmentAuthorizationUnavailableError);
    await expect(service.setStatus('user1', entry.id, 'completed')).rejects.toBeInstanceOf(
      CommitmentAuthorizationUnavailableError,
    );
    expect((await service.prepareDigest('user1')).items).toEqual([]);
  });
  it('marks unavailable source reads as partial while mutations still require authorization', async () => {
    let available = true;
    const { service } = setup({
      integrations: integrations(),
      authorizeArtifact: async () => {
        if (!available) throw new Error('private upstream detail');
        return true;
      },
    });
    const [entry] = service.syncMeeting(meeting, [action]);
    await service.setLinks('user1', entry.id, ['https://github.com/example/app/issues/12']);
    available = false;
    expect((await service.listForUser('user1'))[0]).toMatchObject({ sourceAccessIncomplete: true, links: [] });
    await expect(service.setLinks('user1', entry.id, [])).rejects.toBeInstanceOf(
      CommitmentAuthorizationUnavailableError,
    );
  });
  it('removes stored commitments without a runtime or authorization service', async () => {
    const { service, options } = setup();
    const [entry] = service.syncMeeting(meeting, [action]);
    service.syncMeeting({ ...meeting, id: 'meeting-2' }, [action]);
    await service.setPreference('user1', entry.id, { mode: 'follow' });
    removeStoredMeetingCommitments(options.stateDir, meeting.id);
    expect((await service.listForUser('user1')).map((item) => item.meetingId)).toEqual(['meeting-2']);
    expect(service.listFollowers()).toEqual([]);
    expect(() => removeStoredMeetingCommitments(options.stateDir, 'unknown')).not.toThrow();
  });
  it('rejects malformed persisted recipient state and keeps it quarantined', async () => {
    const { service, options } = setup();
    service.syncMeeting(meeting, [action]);
    const file = path.join(options.stateDir, 'commitments.json');
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    state.users = { user1: { bad: { mode: 'follow' } } };
    fs.writeFileSync(file, JSON.stringify(state));
    expect(await service.listForUser('user1')).toEqual([]);
    expect(fs.readdirSync(options.stateDir).some((name) => name.startsWith('commitments.json.corrupt-'))).toBe(true);
  });
});

describe('per-recipient change digests', () => {
  it('starts silent, requires opt-in, and only acknowledges a confirmed delivery', async () => {
    const { service, options } = setup();
    const [entry] = service.syncMeeting(meeting, [action]);
    expect((await service.prepareDigest('user1')).items).toEqual([]);
    expect(service.listFollowers()).toEqual([]);
    await service.setPreference('user1', entry.id, { mode: 'follow' });
    const first = await service.prepareDigest('user1');
    expect(first.items).toHaveLength(1);
    expect((await service.prepareDigest('user1')).id).toBe(first.id);
    await service.acknowledgeDigest('user1', first);
    expect((await service.listForUser('user1'))[0].lastNotice?.reason).toBe(first.items[0].reason);
    expect((await service.listForUser('user2'))[0].lastNotice).toBeUndefined();
    expect((await createCommitmentService(options).prepareDigest('user1')).items).toEqual([]);
    await service.setStatus('user1', entry.id, 'completed');
    expect((await service.prepareDigest('user1')).items).toHaveLength(1);
  });
  it('does not acknowledge a newer change or an inaccessible meeting', async () => {
    let access = true;
    const { service } = setup({ authorize: async () => access });
    const [entry] = service.syncMeeting(meeting, [action]);
    await service.setPreference('user1', entry.id, { mode: 'follow' });
    const first = await service.prepareDigest('user1');
    await service.setStatus('user1', entry.id, 'confirmed');
    await service.acknowledgeDigest('user1', first);
    expect((await service.prepareDigest('user1')).items).toHaveLength(1);
    access = false;
    await service.acknowledgeDigest('user1', await service.prepareDigest('user1'));
    expect((await service.prepareDigest('user1')).items).toEqual([]);
  });
  it('honors mute/snooze separately for each user', async () => {
    let now = meeting.startedAt;
    const { service } = setup({ now: () => now });
    const [entry] = service.syncMeeting(meeting, [action]);
    await service.setPreference('user1', entry.id, { mode: 'follow', snoozedUntil: now + 1000 });
    await service.setPreference('user2', entry.id, { mode: 'follow' });
    expect((await service.prepareDigest('user1')).items).toEqual([]);
    expect((await service.prepareDigest('user2')).items).toHaveLength(1);
    now += 1001;
    expect((await service.prepareDigest('user1')).items).toHaveLength(1);
    await service.setPreference('user1', entry.id, { mode: 'mute' });
    expect(service.listFollowers()).toEqual(['user2']);
  });
  it('emits the due/overdue transitions once using the meeting date and timezone', async () => {
    let now = meeting.startedAt;
    const { service } = setup({ now: () => now });
    const [entry] = service.syncMeeting(meeting, [action]);
    await service.setStatus('user1', entry.id, 'confirmed');
    await service.setPreference('user1', entry.id, { mode: 'follow' });
    await service.acknowledgeDigest('user1', await service.prepareDigest('user1'));
    now = Date.parse('2026-09-05T03:00:00Z');
    const due = await service.prepareDigest('user1');
    expect(due.items[0].commitment.deadlineState).toBe('due');
    await service.acknowledgeDigest('user1', due);
    now = Date.parse('2026-09-06T03:00:00Z');
    const overdue = await service.prepareDigest('user1');
    expect(overdue.items[0].reason).toContain('venceu');
    await service.acknowledgeDigest('user1', overdue);
    now += 86400000;
    expect((await service.prepareDigest('user1')).items).toEqual([]);
  });
});

describe('artifact reconciliation', () => {
  it('returns the form input error type for an unauthorized URL', async () => {
    const { service } = setup({ integrations: integrations() });
    const [entry] = service.syncMeeting(meeting, [action]);
    await expect(service.setLinks('user1', entry.id, ['https://evil.test/'])).rejects.toBeInstanceOf(
      CommitmentInputError,
    );
  });
  it('keeps merge separate from commitment completion and suppresses unchanged checks', async () => {
    const client = integrations();
    const snapshot: ArtifactSnapshot = {
      state: 'merged',
      label: 'Merged',
      deployed: null,
      checkedAt: 1000,
      updatedAt: '2026-09-04T10:00:00Z',
    };
    client.lookup = vi.fn().mockImplementation(async () => ({ ...snapshot }));
    const { service } = setup({ integrations: client });
    const [entry] = service.syncMeeting(meeting, [action]);
    await service.setLinks('user1', entry.id, ['https://github.com/example/app/pull/12']);
    await service.setPreference('user1', entry.id, { mode: 'follow' });
    await service.acknowledgeDigest('user1', await service.prepareDigest('user1'));
    expect((await service.reconcile()).changed).toBe(1);
    const digest = await service.prepareDigest('user1');
    expect(digest.items[0].commitment.status).toBe('mentioned');
    expect(digest.items[0].commitment.links[0].snapshot?.deployed).toBeNull();
    await service.acknowledgeDigest('user1', digest);
    snapshot.checkedAt++;
    expect((await service.reconcile()).changed).toBe(0);
    expect((await service.prepareDigest('user1')).items).toEqual([]);
  });
  it('hides external references when only the meeting is authorized', async () => {
    let externalAccess = true;
    const { service } = setup({ integrations: integrations(), authorizeArtifact: async () => externalAccess });
    const [entry] = service.syncMeeting(meeting, [action]);
    await service.setLinks('user1', entry.id, ['https://github.com/example/app/issues/12']);
    externalAccess = false;
    expect((await service.listForUser('user1'))[0].links).toEqual([]);
    await expect(service.setLinks('user1', entry.id, ['https://github.com/example/app/issues/13'])).rejects.toThrow();
  });
  it('preserves hidden links when a user saves only their visible links', async () => {
    let limited = false;
    const { service } = setup({
      integrations: integrations(),
      authorizeArtifact: async (_user, ref) => !limited || ref.number === 12,
    });
    const [entry] = service.syncMeeting(meeting, [action]);
    await service.setLinks('user1', entry.id, [
      'https://github.com/example/app/issues/12',
      'https://github.com/example/app/issues/13',
    ]);
    limited = true;
    expect((await service.listForUser('user1'))[0].links).toHaveLength(1);
    await service.setLinks('user1', entry.id, []);
    limited = false;
    expect((await service.listForUser('user1'))[0].links.map((link) => link.reference.number)).toEqual([13]);
  });
  it('bounds each sweep, rotates work and prevents overlapping reconciliation', async () => {
    const client = integrations();
    let finish!: (value: ArtifactSnapshot) => void;
    client.lookup = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue({ state: 'open', label: 'Open', checkedAt: 1, deployed: null });
    const { service } = setup({ integrations: client, maxRequestsPerReconcile: 1 });
    const [entry] = service.syncMeeting(meeting, [action]);
    await service.setLinks('user1', entry.id, [
      'https://github.com/example/app/issues/12',
      'https://github.com/example/app/issues/13',
    ]);
    const first = service.reconcile();
    expect((await service.reconcile()).checked).toBe(0);
    finish({ state: 'open', label: 'Open', checkedAt: 1, deployed: null });
    expect((await first).checked).toBe(1);
    expect((await service.reconcile()).checked).toBe(1);
    expect(vi.mocked(client.lookup).mock.calls.map((call) => call[0].number)).toEqual([12, 13]);
  });
  it('does not consult sources for a paused guild and keeps its history', async () => {
    const client = integrations();
    client.lookup = vi.fn();
    const { service } = setup({ integrations: client, isMeetingActive: () => false });
    const [entry] = service.syncMeeting(meeting, [action]);
    await service.setLinks('user1', entry.id, ['https://github.com/example/app/issues/12']);
    expect(await service.reconcile()).toEqual({ checked: 0, changed: 0, skipped: 1 });
    expect(client.lookup).not.toHaveBeenCalled();
    expect(await service.listForUser('user1')).toHaveLength(1);
  });
});

describe('explicit cross-meeting relationships', () => {
  it('groups three source records explicitly, survives restart and preserves them on unlink', async () => {
    const { service, options } = setup();
    const entries = [1, 2, 3].map((n) => service.syncMeeting({ ...meeting, id: `meeting-${n}` }, [action])[0]);
    expect(new Set((await service.listForUser('user1')).map((entry) => entry.groupId)).size).toBe(3);
    await service.mergeForUser('user1', entries[0].id, entries[1].id);
    await service.mergeForUser('user1', entries[1].id, entries[2].id);
    const grouped = await createCommitmentService(options).listForUser('user1');
    expect(grouped).toHaveLength(3);
    expect(new Set(grouped.map((entry) => entry.groupId)).size).toBe(1);
    expect(
      grouped.every(
        (entry) => entry.relatedIds?.length === 2 && entry.status === 'mentioned' && entry.preference.mode === 'mute',
      ),
    ).toBe(true);
    await service.unlinkForUser('user1', entries[1].id, entries[2].id);
    expect(new Set((await service.listForUser('user1')).map((entry) => entry.groupId)).size).toBe(2);
    service.syncMeeting({ ...meeting, id: 'meeting-1' }, [action]);
    expect((await service.listForUser('user1')).find((entry) => entry.id === entries[0].id)?.directRelatedIds).toEqual([
      entries[1].id,
    ]);
  });

  it('does not traverse hidden meetings or reveal their IDs/history in groups and bounded pages', async () => {
    let limited = false;
    const { service } = setup({ authorize: async (_user, meetingId) => !limited || meetingId !== 'hidden-meeting' });
    const [a] = service.syncMeeting(meeting, [action]);
    const [hidden] = service.syncMeeting({ ...meeting, id: 'hidden-meeting' }, [
      { tarefa: 'Segredo de outra reunião' },
    ]);
    const [c] = service.syncMeeting({ ...meeting, id: 'third-meeting' }, [action]);
    await service.mergeForUser('user1', a.id, hidden.id);
    await service.mergeForUser('user1', hidden.id, c.id);
    limited = true;
    const visible = await service.listForUser('user1');
    expect(visible).toHaveLength(2);
    expect(new Set(visible.map((entry) => entry.groupId)).size).toBe(2);
    expect(visible.every((entry) => entry.relatedIds?.length === 0)).toBe(true);
    for (const secret of [hidden.id, hidden.meetingId, hidden.task])
      expect(JSON.stringify(visible)).not.toContain(secret);
    limited = false;
    const scoped = await service.listForUser('user1', { meetingIds: [meeting.id], limit: 1 });
    expect(scoped[0].groupId).toBe(visible.find((entry) => entry.id === a.id)?.groupId);
    expect(JSON.stringify(scoped)).not.toContain(hidden.id);
  });

  it('propagates status/preferences only by explicit related IDs and denies the whole mutation on revoked access', async () => {
    let blocked = '';
    const { service, options } = setup({ authorize: async (_user, meetingId) => meetingId !== blocked });
    const [a] = service.syncMeeting(meeting, [action]);
    const [b] = service.syncMeeting({ ...meeting, id: 'second' }, [action]);
    await service.mergeForUser('user1', a.id, b.id);
    await service.setStatus('user1', a.id, 'confirmed');
    expect((await service.listForUser('user1')).find((entry) => entry.id === b.id)?.status).toBe('mentioned');
    await service.setStatus('user1', a.id, 'completed', { relatedIds: [b.id] });
    await service.setPreference('user1', a.id, { mode: 'follow' }, { relatedIds: [b.id] });
    expect(
      (await service.listForUser('user1')).every(
        (entry) => entry.status === 'completed' && entry.preference.mode === 'follow',
      ),
    ).toBe(true);
    blocked = 'second';
    await expect(service.setStatus('user1', a.id, 'cancelled', { relatedIds: [b.id] })).rejects.toBeInstanceOf(
      CommitmentAccessError,
    );
    await expect(service.setPreference('user1', a.id, { mode: 'mute' }, { relatedIds: [b.id] })).rejects.toBeInstanceOf(
      CommitmentAccessError,
    );
    await expect(service.unlinkForUser('user1', a.id, b.id)).rejects.toBeInstanceOf(CommitmentAccessError);
    const stored = await createCommitmentService({ ...options, authorize: async () => true }).listForUser('user1');
    expect(stored.every((entry) => entry.status === 'completed' && entry.preference.mode === 'follow')).toBe(true);
    expect(new Set(stored.map((entry) => entry.groupId)).size).toBe(1);
  });

  it('rejects unrelated propagation and removes only deleted source records plus orphan relation evidence', async () => {
    const { service, options } = setup();
    const [a] = service.syncMeeting(meeting, [action]);
    const [b] = service.syncMeeting({ ...meeting, id: 'second' }, [action]);
    await expect(service.mergeForUser('user1', a.id, '__proto__')).rejects.toBeInstanceOf(CommitmentAccessError);
    await expect(service.setStatus('user1', a.id, 'completed', { relatedIds: [b.id] })).rejects.toBeInstanceOf(
      CommitmentInputError,
    );
    await service.mergeForUser('user1', a.id, b.id);
    service.removeMeeting('second');
    expect(await service.listForUser('user1')).toHaveLength(1);
    expect(fs.readFileSync(path.join(options.stateDir, 'commitments.json'), 'utf8')).not.toContain(b.id);
  });

  it('keeps per-record digest snapshots when a grouped member changes after preparation', async () => {
    const { service } = setup();
    const [a] = service.syncMeeting(meeting, [action]);
    const [b] = service.syncMeeting({ ...meeting, id: 'second' }, [action]);
    await service.mergeForUser('user1', a.id, b.id);
    await service.setPreference('user1', a.id, { mode: 'follow' }, { relatedIds: [b.id] });
    const digest = await service.prepareDigest('user1');
    expect(digest.items).toHaveLength(2);
    expect(new Set(digest.items.map((item) => item.commitment.groupId)).size).toBe(1);
    await service.setStatus('user1', b.id, 'completed');
    await service.acknowledgeDigest('user1', digest);
    expect((await service.prepareDigest('user1')).items.map((item) => item.commitment.id)).toEqual([b.id]);
  });
});

describe('history and utility feedback', () => {
  it('follows future channel commitments explicitly, preserves individual mute and revalidates every meeting ACL', async () => {
    let allowed = true;
    const { service, options } = setup({ authorize: async () => allowed });
    const [first] = service.syncMeeting(meeting, [action]);
    await service.setChannelPreference('user1', first.id, 'follow');
    const [second] = service.syncMeeting({ ...meeting, id: 'future-meeting' }, [action]);
    service.syncMeeting({ ...meeting, id: 'other-channel', voiceChannelId: 'other' }, [action]);
    const restarted = createCommitmentService(options);
    expect(restarted.listFollowers()).toEqual(['user1']);
    expect((await restarted.prepareDigest('user1')).items.map((item) => item.commitment.id).sort()).toEqual(
      [first.id, second.id].sort(),
    );
    await restarted.acknowledgeDigest('user1', await restarted.prepareDigest('user1'));
    await restarted.setFeedback('user1', second.id, 'useful');
    expect((await restarted.listForUser('user1')).find((entry) => entry.id === second.id)?.preference.mode).toBe(
      'follow',
    );
    await restarted.setPreference('user1', first.id, { mode: 'mute' });
    await restarted.setStatus('user1', first.id, 'confirmed');
    await restarted.setStatus('user1', second.id, 'confirmed');
    expect((await restarted.prepareDigest('user1')).items.map((item) => item.commitment.id)).toEqual([second.id]);
    allowed = false;
    expect((await restarted.prepareDigest('user1')).items).toEqual([]);
    await expect(restarted.setChannelPreference('user1', first.id, 'follow')).rejects.toBeInstanceOf(
      CommitmentAccessError,
    );
    allowed = true;
    await restarted.setChannelPreference('user1', first.id, 'mute');
    expect(restarted.listFollowers()).toEqual([]);
    expect((await restarted.prepareDigest('user1')).items).toEqual([]);
  });

  it('keeps bounded actor/time/before/after history across restart and regeneration', async () => {
    const { service, options } = setup();
    const [entry] = service.syncMeeting(meeting, [action]);
    for (let i = 0; i < 55; i++) await service.setStatus('user1', entry.id, i % 2 ? 'mentioned' : 'confirmed');
    service.syncMeeting(meeting, [action]);
    const [view] = await createCommitmentService(options).listForUser('user1');
    expect(view.history).toHaveLength(50);
    expect(view.history?.at(-1)).toEqual({
      actorId: 'user1',
      at: options.now!(),
      kind: 'status',
      before: 'mentioned',
      after: 'confirmed',
    });
  });

  it('checks origin context for removed-link history and hides previous notices after source revocation', async () => {
    let allowed = true;
    const authorizeArtifact = vi.fn(async () => allowed);
    const adapter = integrations();
    adapter.lookup = vi
      .fn()
      .mockResolvedValue({ state: 'open', label: 'Em andamento', checkedAt: meeting.startedAt, deployed: null });
    const { service } = setup({ integrations: adapter, authorizeArtifact });
    const [entry] = service.syncMeeting(meeting, [action]);
    const url = 'https://github.com/example/app/issues/12';
    await service.setLinks('user1', entry.id, [url]);
    await service.setPreference('user1', entry.id, { mode: 'follow' });
    await service.acknowledgeDigest('user1', await service.prepareDigest('user1'));
    await service.reconcile();
    const changed = await service.prepareDigest('user1');
    expect(changed.items[0].reason).toContain('example/app#12');
    expect(changed.items[0].reason).toContain('Em andamento');
    await service.acknowledgeDigest('user1', changed);
    await service.setLinks('user1', entry.id, []);
    expect((await service.listForUser('user1'))[0].history?.filter((event) => event.kind === 'link')).toHaveLength(2);
    allowed = false;
    const [hidden] = await service.listForUser('user1');
    expect(JSON.stringify(hidden)).not.toContain('example/app');
    expect(hidden.lastNotice).toBeUndefined();
    expect(authorizeArtifact).toHaveBeenCalledWith('user1', expect.objectContaining({ url }), {
      guildId: '1',
      channelId: '2',
    });
  });

  it('records utility independently from following and exposes only aggregate counts', async () => {
    let allowed = true;
    const { service, options } = setup({ authorize: async () => allowed });
    const [entry] = service.syncMeeting(meeting, [action]);
    await service.setFeedback('user1', entry.id, 'useful');
    await service.setFeedback('user2', entry.id, 'dismissed');
    expect((await service.listForUser('user1'))[0].preference).toMatchObject({ mode: 'mute', feedback: 'useful' });
    expect(service.listFollowers()).toEqual([]);
    expect(createCommitmentService(options).feedbackSummary()).toEqual({ useful: 1, dismissed: 1, responses: 2 });
    await service.setPreference('user1', entry.id, { mode: 'follow' });
    expect((await service.listForUser('user1'))[0].preference.feedback).toBe('useful');
    allowed = false;
    await expect(service.setFeedback('user1', entry.id, 'dismissed')).rejects.toBeInstanceOf(CommitmentAccessError);
    allowed = true;
    await service.setFeedback('user1', entry.id, undefined);
    expect(service.feedbackSummary()).toEqual({ useful: 0, dismissed: 1, responses: 1 });
    service.removeMeeting(meeting.id);
    expect(service.feedbackSummary()).toEqual({ useful: 0, dismissed: 0, responses: 0 });
  });
});

describe('explicit completion evidence', () => {
  function fixture() {
    let at = Date.parse('2026-09-08T14:00:00Z');
    let allowed = true;
    let snapshot: ArtifactSnapshot = { state: 'merged', label: 'PR incorporado', checkedAt: at, deployed: null };
    const adapter = createIntegrationClient(
      parseIntegrationConfiguration({
        KASSINAO_CONTEXT_SCOPES: JSON.stringify([
          {
            guildId: '1',
            channelId: '2',
            githubRepositories: ['example/app'],
            jira: { site: 'https://example.atlassian.net', projects: ['EX'] },
            documentOrigins: ['https://docs.google.com'],
          },
        ]),
      }),
    );
    adapter.lookup = vi.fn(async () => ({ ...snapshot }));
    const result = setup({ integrations: adapter, now: () => at, authorizeArtifact: async () => allowed });
    const [entry] = result.service.syncMeeting(meeting, [action]);
    return {
      ...result,
      entry,
      adapter,
      now: () => at,
      advance: (ms: number) => {
        at += ms;
      },
      snapshot: (value: ArtifactSnapshot) => {
        snapshot = value;
      },
      revoke: () => {
        allowed = false;
      },
    };
  }

  it('requires an explicit PR criterion, keeps manual state unchanged and expires evidence without claiming delay', async () => {
    const f = fixture();
    const url = 'https://github.com/example/app/pull/12';
    await f.service.setLinks('user1', f.entry.id, [url]);
    await f.service.reconcile();
    expect((await f.service.listForUser('user1'))[0].deadlineState).toBe('unknown');
    await f.service.setPreference('user1', f.entry.id, { mode: 'follow' });
    await f.service.acknowledgeDigest('user1', await f.service.prepareDigest('user1'));
    await f.service.setCompletionRule('user1', f.entry.id, { kind: 'artifact', url, state: 'merged' });
    const [view] = await f.service.listForUser('user1');
    expect(view).toMatchObject({
      status: 'mentioned',
      deadlineState: 'settled',
      effectiveCompletion: { url, state: 'merged', checkedAt: f.now() },
    });
    const done = await f.service.prepareDigest('user1');
    expect(done.items[0].reason).toContain('Critério escolhido atendido');
    await f.service.acknowledgeDigest('user1', done);
    f.advance(15 * 60000);
    f.snapshot({ state: 'merged', label: 'PR incorporado', checkedAt: f.now(), deployed: null });
    await f.service.reconcile();
    expect((await f.service.prepareDigest('user1')).items).toEqual([]);
    f.advance(COMPLETION_EVIDENCE_MAX_AGE_MS + 1);
    expect((await f.service.listForUser('user1'))[0]).toMatchObject({
      deadlineState: 'unknown',
      effectiveCompletion: undefined,
    });
    expect((await f.service.prepareDigest('user1')).items[0].reason).toContain('não comprova atraso');
  });

  it('accepts Jira Done only for the exact selected issue and never treats a 404 as completion', async () => {
    const f = fixture();
    const url = 'https://example.atlassian.net/browse/EX-12';
    await f.service.setLinks('user1', f.entry.id, [url]);
    await f.service.setCompletionRule('user1', f.entry.id, { kind: 'artifact', url, state: 'done' });
    f.snapshot({ state: 'done', label: 'Concluído', checkedAt: f.now(), deployed: null });
    await f.service.reconcile();
    expect((await f.service.listForUser('user1'))[0].deadlineState).toBe('settled');
    f.snapshot({
      state: 'unavailable',
      label: 'Fonte indisponível',
      reason: 'not_found',
      checkedAt: f.now(),
      deployed: null,
    });
    await f.service.reconcile();
    const [view] = await f.service.listForUser('user1');
    expect(view.deadlineState).toBe('unknown');
    expect(view.effectiveCompletion).toBeUndefined();
    expect(view.status).toBe('mentioned');
    f.revoke();
    const [revoked] = await f.service.listForUser('user1');
    expect(JSON.stringify(revoked)).not.toContain('EX-12');
    expect(revoked).toMatchObject({
      deadlineState: 'unknown',
      status: 'mentioned',
      completionRule: undefined,
      effectiveCompletion: undefined,
    });
    await expect(f.service.setCompletionRule('user1', f.entry.id, { kind: 'manual' })).rejects.toBeInstanceOf(
      CommitmentAccessError,
    );
  });

  it('rejects mismatched source types and unlinked references; removing an authorized link resets its criterion', async () => {
    const f = fixture();
    const pull = 'https://github.com/example/app/pull/12';
    const issue = 'https://github.com/example/app/issues/13';
    await f.service.setLinks('user1', f.entry.id, [pull, issue]);
    await expect(
      f.service.setCompletionRule('user1', f.entry.id, { kind: 'artifact', url: issue, state: 'merged' }),
    ).rejects.toBeInstanceOf(CommitmentInputError);
    await expect(
      f.service.setCompletionRule('user1', f.entry.id, { kind: 'artifact', url: pull, state: 'done' }),
    ).rejects.toBeInstanceOf(CommitmentInputError);
    await expect(
      f.service.setCompletionRule('user1', f.entry.id, {
        kind: 'artifact',
        url: 'https://evil.test/12',
        state: 'done',
      }),
    ).rejects.toBeInstanceOf(CommitmentAccessError);
    await f.service.setCompletionRule('user1', f.entry.id, { kind: 'artifact', url: pull, state: 'merged' });
    await f.service.setLinks('user1', f.entry.id, [issue]);
    expect((await f.service.listForUser('user1'))[0].completionRule).toEqual({ kind: 'manual' });
  });

  it('never exposes a document snapshot as provider evidence', async () => {
    const f = fixture();
    await f.service.setLinks('user1', f.entry.id, ['https://docs.google.com/document/d/example']);
    f.snapshot({
      state: 'done',
      label: 'Conteúdo forjado',
      title: 'Título forjado',
      checkedAt: f.now(),
      deployed: null,
    });
    await f.service.reconcile();
    const [view] = await f.service.listForUser('user1');
    expect(view.links[0].snapshot).toMatchObject({ state: 'unverified', reason: 'manual_reference' });
    expect(JSON.stringify(view)).not.toContain('forjado');
  });

  it('filters both sides of rule history independently when a former artifact is revoked', async () => {
    let restricted = false;
    const { service } = setup({
      integrations: integrations(),
      authorizeArtifact: async (_user, ref) => !restricted || ref.number === 13,
    });
    const [entry] = service.syncMeeting(meeting, [action]);
    const first = 'https://github.com/example/app/pull/12',
      second = 'https://github.com/example/app/pull/13';
    await service.setLinks('user1', entry.id, [first, second]);
    await service.setCompletionRule('user1', entry.id, { kind: 'artifact', url: first, state: 'merged' });
    await service.setCompletionRule('user1', entry.id, { kind: 'artifact', url: second, state: 'merged' });
    restricted = true;
    const [view] = await service.listForUser('user1');
    expect(view.completionRule).toEqual({ kind: 'artifact', url: second, state: 'merged' });
    expect(JSON.stringify(view)).not.toContain(first);
    expect(view.history?.filter((event) => event.kind === 'completion-rule')).toHaveLength(1);
  });

  it('does not overwrite a concurrently selected criterion that was not authorized in the request', async () => {
    const adapter = integrations();
    let changeDuringCheck: (() => void) | undefined;
    const { service, options } = setup({
      integrations: adapter,
      authorizeArtifact: async () => {
        changeDuringCheck?.();
        changeDuringCheck = undefined;
        return true;
      },
    });
    const [entry] = service.syncMeeting(meeting, [action]);
    const first = 'https://github.com/example/app/pull/12',
      second = 'https://github.com/example/app/pull/13';
    await service.setLinks('user1', entry.id, [first, second]);
    changeDuringCheck = () => {
      const file = path.join(options.stateDir, 'commitments.json');
      const state = JSON.parse(fs.readFileSync(file, 'utf8'));
      state.commitments[entry.id].completionRule = { kind: 'artifact', url: second, state: 'merged' };
      fs.writeFileSync(file, JSON.stringify(state));
    };
    await expect(
      service.setCompletionRule('user1', entry.id, { kind: 'artifact', url: first, state: 'merged' }),
    ).rejects.toBeInstanceOf(CommitmentInputError);
    expect((await service.listForUser('user1'))[0].completionRule).toEqual({
      kind: 'artifact',
      url: second,
      state: 'merged',
    });
  });

  it('applies an exact criterion to explicitly selected group members only after every source context authorizes it', async () => {
    let denySecond = true;
    const at = Date.parse('2026-09-08T14:00:00Z');
    const adapter = createIntegrationClient(
      parseIntegrationConfiguration({
        KASSINAO_CONTEXT_SCOPES: JSON.stringify([{ guildId: '1', githubRepositories: ['example/app'] }]),
      }),
    );
    adapter.lookup = vi
      .fn()
      .mockResolvedValue({ state: 'merged', label: 'PR incorporado', checkedAt: at, deployed: null });
    const authorizeArtifact = vi.fn(async (_user, _reference, context) => !denySecond || context.channelId !== '3');
    const { service, options } = setup({ integrations: adapter, now: () => at, authorizeArtifact });
    const [a] = service.syncMeeting(meeting, [action]);
    const [b] = service.syncMeeting({ ...meeting, id: 'second', voiceChannelId: '3' }, [action]);
    const url = 'https://github.com/example/app/pull/12';
    await service.setLinks('user1', a.id, [url]);
    await service.mergeForUser('user1', a.id, b.id);
    await expect(
      service.setCompletionRule('user1', a.id, { kind: 'artifact', url, state: 'merged' }, { relatedIds: [b.id] }),
    ).rejects.toBeInstanceOf(CommitmentAccessError);
    const before = await createCommitmentService({ ...options, authorizeArtifact: async () => true }).listForUser(
      'user1',
    );
    expect(before.every((entry) => entry.completionRule === undefined)).toBe(true);
    expect(before.find((entry) => entry.id === b.id)?.links).toEqual([]);
    denySecond = false;
    await service.setCompletionRule('user1', a.id, { kind: 'artifact', url, state: 'merged' }, { relatedIds: [b.id] });
    const pending = await service.listForUser('user1');
    expect(
      pending.every((entry) => entry.deadlineState === 'unknown' && entry.completionRule?.kind === 'artifact'),
    ).toBe(true);
    expect(pending.find((entry) => entry.id === b.id)?.links[0].snapshot).toBeUndefined();
    await service.reconcile();
    expect(
      (await service.listForUser('user1')).every(
        (entry) => entry.deadlineState === 'settled' && entry.status === 'mentioned',
      ),
    ).toBe(true);
    expect(authorizeArtifact).toHaveBeenCalledWith('user1', expect.objectContaining({ url }), {
      guildId: '1',
      channelId: '3',
    });
    await service.setCompletionRule('user1', a.id, { kind: 'manual' }, { relatedIds: [b.id] });
    expect(
      (await service.listForUser('user1')).every(
        (entry) => entry.completionRule?.kind === 'manual' && entry.links.length === 1,
      ),
    ).toBe(true);
  });

  it('rejects copying a group criterion outside the target channel mapping without partial mutation', async () => {
    const f = fixture();
    const [other] = f.service.syncMeeting({ ...meeting, id: 'unmapped', voiceChannelId: '3' }, [action]);
    const url = 'https://github.com/example/app/pull/12';
    await f.service.setLinks('user1', f.entry.id, [url]);
    await f.service.mergeForUser('user1', f.entry.id, other.id);
    await expect(
      f.service.setCompletionRule(
        'user1',
        f.entry.id,
        { kind: 'artifact', url, state: 'merged' },
        { relatedIds: [other.id] },
      ),
    ).rejects.toBeInstanceOf(CommitmentInputError);
    expect((await f.service.listForUser('user1')).every((entry) => entry.completionRule === undefined)).toBe(true);
  });
});
