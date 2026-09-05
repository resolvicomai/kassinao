import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createCommitmentService, type CommitmentView } from '../src/commitments';
import type { ArtifactReference } from '../src/integrations/types';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});
const directory = () => {
  const result = fs.mkdtempSync(path.join(os.tmpdir(), 'commitment-revision-'));
  directories.push(result);
  return result;
};
const meeting = { id: 'meeting', guildId: '1', voiceChannelId: '2', startedAt: 1000 };
const action = { tarefa: 'Synthetic task', source: { startMs: 0, endMs: 100, quote: 'Synthetic source' } };
const reference = (url: string): ArtifactReference => ({
  kind: 'github-pull',
  url,
  origin: 'https://github.com',
  repository: 'example/private',
  number: Number(url.split('/').at(-1)),
});

it('does not reveal a hidden source through an offline dictionary of public revision tokens', async () => {
  let now = 2000;
  const service = createCommitmentService({
    stateDir: directory(),
    authorize: async () => true,
    authorizeArtifact: async (user) => user === 'writer',
    now: () => now,
    integrations: {
      resolve: reference,
      lookup: async () => {
        throw new Error('Network forbidden');
      },
    },
  });
  const [entry] = service.syncMeeting(meeting, [action]);
  const [before] = await service.listForUser('reader');
  now = 3000;
  await service.setLinks('writer', entry.id, ['https://github.com/example/private/pull/17']);
  const [hidden] = await service.listForUser('reader');
  expect(hidden.links).toEqual([]);
  expect(hidden.history).toEqual([]);
  // Everything used for this dictionary is in the reader's two authorized projections.
  const publicFields: Partial<CommitmentView> = { ...before };
  for (const key of [
    'revision',
    'canRepair',
    'completionConflict',
    'sourceAccessIncomplete',
    'deadlineState',
    'deadlineDate',
    'channelFollowed',
    'effectiveCompletion',
    'lastNotice',
    'preference',
    'directRelatedIds',
    'groupId',
    'relatedMentions',
    'relatedIds',
  ] as const)
    delete publicFields[key];
  const matches = [16, 17, 18].filter((number) => {
    const url = `https://github.com/example/private/pull/${number}`;
    const ref = reference(url);
    const guess = {
      ...publicFields,
      links: [{ reference: ref, addedAt: hidden.updatedAt }],
      history: [
        {
          at: hidden.updatedAt,
          actorId: 'writer',
          kind: 'link',
          before: 'sem vínculo',
          after: url,
          reference: ref,
        },
      ],
      updatedAt: hidden.updatedAt,
    };
    return crypto.createHash('sha256').update(JSON.stringify(guess)).digest('hex') === hidden.revision;
  });
  expect(matches).toEqual([]);
});

it('keeps revisions stable with a shared private key across instances and changes them on mutation', async () => {
  const options = {
    stateDir: directory(),
    revisionSecret: 'synthetic-private-revision-key-0123456789abcdef',
    authorize: async () => true,
    now: () => 2000,
  };
  const first = createCommitmentService(options);
  const [entry] = first.syncMeeting(meeting, [action]);
  const [before] = await first.listForUser('reader');
  const restarted = createCommitmentService(options);
  expect((await restarted.listForUser('reader'))[0].revision).toBe(before.revision);
  await restarted.setStatus('reader', entry.id, 'confirmed', { expectedRevision: before.revision });
  const [after] = await first.listForUser('reader');
  expect(after.revision).not.toBe(before.revision);
  expect((await createCommitmentService(options).listForUser('reader'))[0].revision).toBe(after.revision);
  const differentKey = createCommitmentService({
    ...options,
    revisionSecret: 'different-private-revision-key-0123456789abcdef',
  });
  expect((await differentKey.listForUser('reader'))[0].revision).not.toBe(after.revision);
  const raw = fs.readFileSync(path.join(options.stateDir, 'commitments.json'), 'utf8');
  expect(raw).not.toContain(options.revisionSecret);
});
