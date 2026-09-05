import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  createCommitmentService,
  CommitmentAccessError,
  CommitmentConflictError,
  type CommitmentServiceOptions,
} from '../src/commitments';
import type { ArtifactReference, ArtifactSnapshot } from '../src/integrations/types';

const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const meeting = { id: 'meeting', guildId: '1', voiceChannelId: '2', startedAt: Date.parse('2026-09-04T13:00:00Z') };
const action = {
  tarefa: 'Enviar proposta',
  responsavel: 'Ana',
  prazo: 'amanhã',
  source: { startMs: 1000, endMs: 3000, quote: 'Ana envia a proposta para o cliente A amanhã.' },
};
const other = {
  ...action,
  prazo: '11/09/2026',
  source: { startMs: 10000, endMs: 12000, quote: 'Ana envia a proposta para o cliente B dia onze.' },
};
const url = 'https://github.com/example/app/pull/1';
function reference(value: string): ArtifactReference {
  return {
    kind: 'github-pull',
    url: value,
    origin: 'https://github.com',
    repository: 'example/app',
    number: Number(value.split('/').at(-1)),
  };
}
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
function fixture(overrides: Partial<CommitmentServiceOptions> = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commitment-domain-'));
  directories.push(stateDir);
  let clock = Date.parse('2026-09-06T13:00:00Z');
  let snapshot: ArtifactSnapshot = { state: 'open', label: 'Aberto', checkedAt: clock, deployed: null };
  const options: CommitmentServiceOptions = {
    stateDir,
    authorize: async () => true,
    authorizeArtifact: async () => true,
    authorizeRepair: async (user) => user === 'admin',
    authorizeSource: async () => true,
    authorizeChannel: async () => true,
    now: () => clock,
    timezone: 'America/Sao_Paulo',
    integrations: { resolve: reference, lookup: async () => snapshot },
    ...overrides,
  };
  const service = createCommitmentService(options);
  const view = async (id: string, user = 'reader') => (await service.listForUser(user, { commitmentId: id }))[0];
  return {
    service,
    options,
    view,
    now: () => clock,
    advance: (ms = 1) => {
      clock += ms;
    },
    snapshot: (next: ArtifactSnapshot) => {
      snapshot = next;
    },
  };
}

it('keeps completion on the same source when identical tasks are reordered', async () => {
  const f = fixture();
  const [a, b] = f.service.syncMeeting(meeting, [action, other]);
  await f.service.setStatus('reader', a.id, 'completed');
  await f.service.setPreference('reader', a.id, { mode: 'follow' });
  const [newB, newA] = f.service.syncMeeting(meeting, [other, action]);
  expect(newB).toMatchObject({ id: b.id, status: 'mentioned', source: other.source });
  expect(newA).toMatchObject({ id: a.id, status: 'completed', source: action.source, reviewRequired: false });
  expect((await f.view(a.id)).preference.mode).toBe('follow');
});

it('does not trust positional identity for repeated actions without a source', async () => {
  const f = fixture();
  const a = { ...action, source: undefined },
    b = { ...other, source: undefined };
  const [initial] = f.service.syncMeeting(meeting, [a, b]);
  await f.service.setStatus('reader', initial.id, 'completed', { acknowledgeReview: true });
  const changed = f.service.syncMeeting(meeting, [b, a]);
  expect(changed.every((entry) => entry.reviewRequired)).toBe(true);
  expect(changed.find((entry) => entry.id === initial.id)?.deadline).toBe(a.prazo);
  expect((await f.view(initial.id)).deadlineState).toBe('unknown');
});

it('versions human edits, preserves followers and retains their correction across regeneration', async () => {
  const f = fixture();
  const [entry] = f.service.syncMeeting(meeting, [action]);
  await f.service.setStatus('reader', entry.id, 'confirmed');
  await f.service.setPreference('reader', entry.id, { mode: 'follow' });
  const before = await f.view(entry.id);
  await f.service.editForUser(
    'reader',
    entry.id,
    { task: 'Enviar proposta A', assignee: 'Ana Lima', deadline: '11/09/2026' },
    { expectedRevision: before.revision! },
  );
  const edited = await f.view(entry.id);
  expect(edited).toMatchObject({
    task: 'Enviar proposta A',
    assignee: 'Ana Lima',
    reviewRequired: true,
    preference: { mode: 'follow' },
    extracted: { task: action.tarefa, assignee: 'Ana' },
  });
  expect(edited.history?.filter((event) => event.kind === 'edit').map((event) => event.field)).toEqual([
    'task',
    'assignee',
    'deadline',
  ]);
  await expect(
    f.service.editForUser('reader', entry.id, { task: 'stale' }, { expectedRevision: before.revision! }),
  ).rejects.toBeInstanceOf(CommitmentConflictError);
  await expect(f.service.setStatus('reader', entry.id, 'confirmed')).rejects.toThrow('Confira');
  await f.service.setStatus('reader', entry.id, 'confirmed', {
    expectedRevision: edited.revision,
    acknowledgeReview: true,
  });
  const [regenerated] = f.service.syncMeeting(meeting, [{ ...action, responsavel: 'Ana Maria' }]);
  expect(regenerated).toMatchObject({
    id: entry.id,
    assignee: 'Ana Lima',
    reviewRequired: true,
    extracted: { assignee: 'Ana Maria' },
  });
  expect((await createCommitmentService(f.options).listForUser('reader'))[0].task).toBe('Enviar proposta A');
});

it('updates an unedited extraction by stable source without moving subscriptions to a new identity', async () => {
  const f = fixture();
  const [entry] = f.service.syncMeeting(meeting, [action]);
  await f.service.setStatus('reader', entry.id, 'confirmed');
  await f.service.setPreference('reader', entry.id, { mode: 'follow' });
  const [changed] = f.service.syncMeeting(meeting, [{ ...action, responsavel: 'Ana Lima', prazo: '11/09/2026' }]);
  expect(changed).toMatchObject({
    id: entry.id,
    assignee: 'Ana Lima',
    deadline: '11/09/2026',
    status: 'confirmed',
    reviewRequired: true,
  });
  expect((await f.view(entry.id)).deadlineState).toBe('unknown');
  expect((await f.view(entry.id)).preference.mode).toBe('follow');
});

it('keeps mentions and incomplete coverage out of overdue until explicit review', async () => {
  const f = fixture();
  const [entry] = f.service.syncMeeting(
    { ...meeting, sourceQuality: { audioIncomplete: true, transcriptionPartial: true } },
    [action],
  );
  await f.service.setPreference('reader', entry.id, { mode: 'follow' });
  expect(await f.view(entry.id)).toMatchObject({
    deadlineState: 'unknown',
    reviewRequired: true,
    sourceQuality: { audioIncomplete: true, transcriptionPartial: true },
  });
  expect((await f.service.prepareDigest('reader')).items[0].reason).toContain('gravação incompleta');
  await expect(f.service.setStatus('reader', entry.id, 'confirmed')).rejects.toThrow('Confira');
  await f.service.setStatus('reader', entry.id, 'confirmed', { acknowledgeReview: true });
  expect((await f.view(entry.id)).deadlineState).toBe('overdue');
  f.service.syncMeeting({ ...meeting, sourceQuality: { audioIncomplete: true, transcriptionPartial: true } }, [action]);
  expect((await f.view(entry.id)).reviewRequired).toBe(false);
  const [mention] = f.service.syncMeeting({ ...meeting, id: 'hypothesis' }, [action]);
  expect((await f.view(mention.id)).deadlineState).toBe('unknown');
});

it.each([true, false])('rejects concurrent link replacement with explicit revision=%s', async (explicit) => {
  const waiting = deferred(),
    entered = deferred();
  let blocked = false;
  const f = fixture({
    authorizeArtifact: async (user) => {
      if (user === 'alice' && blocked) {
        entered.release();
        await waiting.promise;
      }
      return true;
    },
  });
  const [entry] = f.service.syncMeeting(meeting, [action]);
  await f.service.setLinks('bob', entry.id, [url]);
  const revision = (await f.view(entry.id)).revision;
  blocked = true;
  const alice = f.service.setLinks('alice', entry.id, [url], explicit ? { expectedRevision: revision } : {});
  const rejection = expect(alice).rejects.toBeInstanceOf(CommitmentConflictError);
  await entered.promise;
  await f.service.setLinks('bob', entry.id, [url, `${url}2`]);
  waiting.release();
  await rejection;
  expect((await f.view(entry.id)).links.map((link) => link.reference.url)).toEqual([url, `${url}2`]);
});

it('rejects stale related revisions atomically and exposes revisions for outside-page neighbours', async () => {
  const f = fixture();
  const [a] = f.service.syncMeeting(meeting, [action]);
  const [b] = f.service.syncMeeting({ ...meeting, id: 'second' }, [other]);
  await f.service.mergeForUser('reader', a.id, b.id);
  const beforeA = await f.view(a.id),
    beforeB = await f.view(b.id);
  await f.service.setStatus('reader', b.id, 'completed');
  await expect(
    f.service.setStatus('reader', a.id, 'confirmed', {
      expectedRevision: beforeA.revision,
      expectedRevisions: { [b.id]: beforeB.revision! },
      relatedIds: [b.id],
    }),
  ).rejects.toBeInstanceOf(CommitmentConflictError);
  expect((await f.view(a.id)).status).toBe('mentioned');
  await expect(
    f.service.unlinkForUser('reader', a.id, b.id, {
      expectedRevision: beforeA.revision,
      otherExpectedRevision: beforeB.revision,
    }),
  ).rejects.toBeInstanceOf(CommitmentConflictError);
  const [visible] = await f.service.listForUser('reader', { commitmentId: a.id, includeRelatedMentions: true });
  expect(visible.relatedMentions?.[0].revision).toBe((await f.view(b.id)).revision);
});

it.each(['mute', 'snooze'] as const)(
  'rechecks %s after asynchronous source checks and immediately before delivery',
  async (mode) => {
    let waiting: ReturnType<typeof deferred> | undefined, entered: ReturnType<typeof deferred> | undefined;
    const f = fixture({
      authorizeArtifact: async () => {
        if (waiting) {
          entered!.release();
          await waiting.promise;
        }
        return true;
      },
    });
    const [entry] = f.service.syncMeeting(meeting, [action]);
    await f.service.setLinks('reader', entry.id, [url]);
    await f.service.setPreference('reader', entry.id, { mode: 'follow' });
    const ready = await f.service.prepareDigest('reader');
    waiting = deferred();
    entered = deferred();
    const preparing = f.service.prepareDigest('reader');
    await entered.promise;
    await f.service.setPreference(
      'reader',
      entry.id,
      mode === 'mute' ? { mode: 'mute' } : { mode: 'follow', snoozedUntil: f.now() + 60000 },
    );
    waiting.release();
    expect((await preparing).items).toEqual([]);
    waiting = undefined;
    expect((await f.service.revalidateDigest('reader', ready)).items).toEqual([]);
    await f.service.setPreference('reader', entry.id, { mode: 'follow' });
    waiting = deferred();
    entered = deferred();
    const validating = f.service.revalidateDigest('reader', ready);
    await entered.promise;
    await f.service.setPreference('reader', entry.id, { mode: 'mute' });
    waiting.release();
    expect((await validating).items).toEqual([]);
  },
);

it('drops a prepared selection after source ACL or recording ACL is revoked', async () => {
  let recording = true,
    artifact = true;
  const f = fixture({ authorize: async () => recording, authorizeArtifact: async () => artifact });
  const [entry] = f.service.syncMeeting(meeting, [action]);
  await f.service.setLinks('reader', entry.id, [url]);
  await f.service.setPreference('reader', entry.id, { mode: 'follow' });
  const ready = await f.service.prepareDigest('reader');
  artifact = false;
  expect((await f.service.revalidateDigest('reader', ready)).items).toEqual([]);
  artifact = true;
  recording = false;
  expect((await f.service.revalidateDigest('reader', ready)).items).toEqual([]);
});

it('repairs only inaccessible dependencies with dedicated authority and no hidden addresses in the result', async () => {
  let access = true;
  const repair = vi.fn(async (user: string) => user === 'admin');
  const f = fixture({ authorizeArtifact: async () => access, authorizeRepair: repair });
  const [entry] = f.service.syncMeeting(meeting, [action]);
  const urls = Array.from({ length: 10 }, (_, index) => `https://github.com/example/app/pull/${index + 1}`);
  await f.service.setLinks('reader', entry.id, urls);
  await f.service.setCompletionRule('reader', entry.id, { kind: 'artifact', state: 'merged', url: urls[0] });
  access = false;
  const hidden = await f.view(entry.id);
  expect(hidden.canRepair).toBe(false);
  expect(JSON.stringify(hidden)).not.toContain('https://github.com');
  await expect(
    f.service.repairForUser('reader', entry.id, { expectedRevision: hidden.revision! }),
  ).rejects.toBeInstanceOf(CommitmentAccessError);
  await f.service.repairForUser('admin', entry.id, { expectedRevision: hidden.revision! });
  const repaired = await f.view(entry.id, 'admin');
  expect(repaired).toMatchObject({ links: [], completionRule: { kind: 'manual' } });
  expect(JSON.stringify(repaired.history)).not.toContain('https://github.com');
  expect(repair).toHaveBeenCalledWith('admin', meeting.id, { fresh: true });
  access = true;
  await f.service.setLinks('admin', entry.id, [url]);
  expect((await f.view(entry.id)).links).toHaveLength(1);
});

it('records a decisions-only cancellation and hides its provenance from an unauthorized reader', async () => {
  let readDecision = true;
  const f = fixture({ authorize: async (_user, id) => id !== 'decision-meeting' || readDecision });
  const [entry] = f.service.syncMeeting(meeting, [action]);
  const before = await f.view(entry.id);
  await f.service.recordDecisionForUser(
    'reader',
    entry.id,
    { meetingId: 'decision-meeting', source: other.source, kind: 'cancels', note: 'Cancelamento deliberado' },
    { expectedRevision: before.revision! },
  );
  expect(await f.view(entry.id)).toMatchObject({
    status: 'cancelled',
    resolution: { meetingId: 'decision-meeting', note: 'Cancelamento deliberado' },
  });
  readDecision = false;
  const hidden = await f.view(entry.id);
  expect(hidden.resolution).toBeUndefined();
  expect(hidden.history?.some((event) => event.kind === 'decision')).toBe(false);
  expect(JSON.stringify(hidden)).not.toContain('Cancelamento deliberado');
  f.service.removeMissingMeetings(new Set([meeting.id]));
  readDecision = true;
  expect((await f.view(entry.id)).resolution).toBeUndefined();
});

it('detects human completion conflicting with a recently reopened source without claiming deploy', async () => {
  const f = fixture();
  const [entry] = f.service.syncMeeting(meeting, [action]);
  await f.service.setLinks('reader', entry.id, [url]);
  await f.service.setStatus('reader', entry.id, 'completed');
  await f.service.reconcile();
  expect(await f.view(entry.id)).toMatchObject({ status: 'completed', completionConflict: { url, state: 'open' } });
  f.advance(3600001);
  expect((await f.view(entry.id)).completionConflict).toBeUndefined();
});

it('subscribes an authorized empty channel, excludes old settled history and supports future-only', async () => {
  const f = fixture();
  const context = { guildId: '1', channelId: '2' };
  await f.service.setChannelSubscription('reader', context, 'follow');
  expect(await f.service.listChannelPreferences('reader')).toMatchObject([
    { ...context, mode: 'follow', includeExisting: true },
  ]);
  const [entry] = f.service.syncMeeting(meeting, [action]);
  expect((await f.service.prepareDigest('reader')).items.map((item) => item.commitment.id)).toEqual([entry.id]);
  await f.service.setStatus('reader', entry.id, 'completed');
  f.advance();
  await f.service.setChannelSubscription('late', context, 'follow');
  expect((await f.service.prepareDigest('late')).items).toEqual([]);
  const [open] = f.service.syncMeeting({ ...meeting, id: 'existing-open' }, [action]);
  f.advance();
  await f.service.setChannelSubscription('future', context, 'follow', { includeExisting: false });
  expect(await f.service.listForUser('future', { followedOnly: true })).toEqual([]);
  f.advance();
  const [fresh] = f.service.syncMeeting({ ...meeting, id: 'new' }, [action]);
  expect((await f.service.prepareDigest('future')).items.map((item) => item.commitment.id)).toEqual([fresh.id]);
  expect((await f.service.prepareDigest('late')).items.map((item) => item.commitment.id).sort()).toEqual(
    [open.id, fresh.id].sort(),
  );
});

it('filters settled records before pagination and advances event inventory past effective completions', async () => {
  const f = fixture();
  await f.service.setChannelSubscription('reader', { guildId: '1', channelId: '2' }, 'follow');
  const closed = f.service.syncMeeting(
    meeting,
    Array.from({ length: 100 }, (_, index) => ({ tarefa: `Closed ${index}` })),
  );
  for (const entry of closed) await f.service.setStatus('reader', entry.id, 'completed');
  const [open] = f.service.syncMeeting({ ...meeting, id: 'open', voiceChannelId: '3' }, [action]);
  await f.service.setPreference('reader', open.id, { mode: 'follow' });
  expect(
    (await f.service.listForUser('reader', { followedOnly: true, openOnly: true, limit: 1 })).map((entry) => entry.id),
  ).toEqual([open.id]);
  expect((await f.service.listEventChannels('reader')).channels).toEqual([{ guildId: '1', channelId: '3' }]);
  expect((await f.service.listForUser('reader', { ids: [open.id] })).map((entry) => entry.id)).toEqual([open.id]);
});

it('rotates event candidates after a whole page of externally completed records', async () => {
  const f = fixture();
  await f.service.setChannelSubscription('reader', { guildId: '1', channelId: '2' }, 'follow');
  const entries = f.service
    .syncMeeting(
      meeting,
      Array.from({ length: 105 }, (_, index) => ({ tarefa: `Candidate ${index}` })),
    )
    .sort((a, b) => a.id.localeCompare(b.id));
  for (const entry of entries.slice(0, -1)) {
    await f.service.setLinks('reader', entry.id, [url]);
    await f.service.setCompletionRule('reader', entry.id, { kind: 'artifact', state: 'merged', url });
  }
  f.snapshot({ state: 'merged', label: 'Merged', checkedAt: f.now(), deployed: null });
  await f.service.reconcile();
  expect(await f.service.listEventChannels('reader')).toEqual({ channels: [], incomplete: true });
  expect((await f.service.listEventChannels('reader')).channels).toEqual([{ guildId: '1', channelId: '2' }]);
});

it('rejects unverified decision sources and stale repairs without changing state', async () => {
  let verify = false,
    access = true;
  const f = fixture({ authorizeSource: async () => verify, authorizeArtifact: async () => access });
  const [entry] = f.service.syncMeeting(meeting, [action]);
  const old = await f.view(entry.id);
  const decision = { meetingId: 'decision-meeting', source: other.source, kind: 'cancels' as const };
  await expect(
    f.service.recordDecisionForUser('reader', entry.id, decision, { expectedRevision: old.revision! }),
  ).rejects.toBeInstanceOf(CommitmentAccessError);
  expect((await f.view(entry.id)).status).toBe('mentioned');
  await f.service.setLinks('reader', entry.id, [url]);
  access = false;
  await expect(f.service.repairForUser('admin', entry.id, { expectedRevision: old.revision! })).rejects.toBeInstanceOf(
    CommitmentConflictError,
  );
  verify = true;
  const current = await f.view(entry.id);
  await f.service.recordDecisionForUser('reader', entry.id, decision, { expectedRevision: current.revision! });
  expect((await f.view(entry.id)).status).toBe('cancelled');
});

it('keeps legacy source identity and human history without using old occurrence IDs as a new match', async () => {
  const f = fixture();
  const [a, b] = f.service.syncMeeting(meeting, [action, other]);
  await f.service.setStatus('reader', a.id, 'completed');
  const file = path.join(f.options.stateDir, 'commitments.json');
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const entry of Object.values(state.commitments) as Record<string, unknown>[]) {
    delete entry.extracted;
    delete entry.reviewRequired;
  }
  fs.writeFileSync(file, JSON.stringify(state));
  const fresh = createCommitmentService(f.options).syncMeeting(meeting, [other, action]);
  expect(fresh.map((entry) => [entry.id, entry.status])).toEqual([
    [b.id, 'mentioned'],
    [a.id, 'completed'],
  ]);
});

it('verifies the current literal source, preserving newlines, before replacement', async () => {
  const quote = 'A proposta foi cancelada.\nVamos preparar outra.';
  const source = { startMs: 12000, endMs: 15000, quote };
  let allowed = false;
  const verify = vi.fn(
    async (_user: string, _meeting: string, candidate: { quote: string }) => allowed && candidate.quote === quote,
  );
  const f = fixture({ authorizeSource: verify });
  const [old] = f.service.syncMeeting(meeting, [action]);
  const [next] = f.service.syncMeeting({ ...meeting, id: 'new-decision' }, [{ ...action, source }]);
  const opts = {
    expectedRevision: (await f.view(next.id)).revision!,
    otherExpectedRevision: (await f.view(old.id)).revision!,
  };
  await expect(f.service.replaceForUser('reader', next.id, old.id, 'supersedes', opts)).rejects.toBeInstanceOf(
    CommitmentAccessError,
  );
  allowed = true;
  await f.service.replaceForUser('reader', next.id, old.id, 'supersedes', opts);
  expect((await f.view(old.id)).resolution?.source.quote).toBe(quote);
  expect((await f.view(old.id)).status).toBe('cancelled');
});
