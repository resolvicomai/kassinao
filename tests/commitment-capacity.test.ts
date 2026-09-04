import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { CommitmentCapacityError, createCommitmentService } from '../src/commitments';
import { createIntegrationClient } from '../src/integrations/client';
import { createRecipientArtifactAccess, withRecipientArtifactAccess } from '../src/integrations/access';
import { parseIntegrationConfiguration } from '../src/integrations/config';

const dirs: string[] = [];
const meeting = { id: 'synthetic', guildId: '1', voiceChannelId: '2', startedAt: 0 };
function directory() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kassinao-capacity-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

it('filters before source reads, preserves partial views, and rotates followed sources beyond one budget', async () => {
  const configuration = parseIntegrationConfiguration({
    KASSINAO_CONTEXT_SCOPES: JSON.stringify([{ guildId: '1', githubRepositories: ['example/app'] }]),
    GITHUB_CONTEXT_TOKEN: 'synthetic-technical',
  });
  const request = vi.fn<typeof fetch>(async (url) =>
    Response.json({ number: Number(String(url).split('/').at(-1)), state: 'open', title: 'Synthetic' }),
  );
  const access = createRecipientArtifactAccess(
    configuration,
    { '123': { githubToken: 'synthetic-personal', jira: {} } },
    { fetch: request },
  );
  const service = createCommitmentService({
    stateDir: directory(),
    authorize: async () => true,
    authorizeArtifact: access.canRead,
    integrations: createIntegrationClient(configuration),
  });
  const entries = service.syncMeeting(
    meeting,
    Array.from({ length: 11 }, (_, i) => ({ tarefa: `Task ${i}` })),
  );
  for (const [i, entry] of entries.entries()) {
    await withRecipientArtifactAccess(() =>
      service.setLinks(
        '123',
        entry.id,
        Array.from({ length: 10 }, (_, j) => `https://github.com/example/app/issues/${i * 10 + j + 1}`),
      ),
    );
  }
  const [followed] = service.syncMeeting({ ...meeting, id: 'followed', voiceChannelId: '3' }, [
    { tarefa: 'Followed without external source' },
  ]);
  await service.setPreference('123', followed.id, { mode: 'follow' });
  request.mockClear();
  const digest = await withRecipientArtifactAccess(() => service.prepareDigest('123'));
  expect(digest.items.map((item) => item.commitment.id)).toEqual([followed.id]);
  expect(request).not.toHaveBeenCalled();
  expect(
    (await withRecipientArtifactAccess(() => service.listForUser('123', { channelId: '3' }))).map((entry) => entry.id),
  ).toEqual([followed.id]);
  expect(request).not.toHaveBeenCalled();

  const visible = await withRecipientArtifactAccess(() => service.listForUser('123'));
  expect(visible).toHaveLength(12);
  expect(request).toHaveBeenCalledTimes(100);
  expect(visible.some((entry) => entry.sourceAccessIncomplete && entry.links.length === 0)).toBe(true);
  for (const entry of entries) await service.setPreference('123', entry.id, { mode: 'follow' });
  const seen = new Set<string>();
  for (let round = 0; round < 2; round++) {
    request.mockClear();
    const next = await withRecipientArtifactAccess(() => service.prepareDigest('123'));
    expect(request.mock.calls.length).toBeLessThanOrEqual(100);
    for (const item of next.items) {
      expect(item.commitment.sourceAccessIncomplete).toBe(false);
      seen.add(item.commitment.id);
    }
    await withRecipientArtifactAccess(() => service.acknowledgeDigest('123', next));
  }
  expect(seen.size).toBe(12);
});

it('rejects growth before publishing an unreadable file and permits cleanup of an oversized legacy file', async () => {
  const stateDir = directory();
  const file = path.join(stateDir, 'commitments.json');
  const service = createCommitmentService({ stateDir, authorize: async () => true });
  const actions = Array.from({ length: 500 }, (_, i) => ({
    tarefa: `${i} `.padEnd(2000, 'X'),
    responsavel: 'Y'.repeat(200),
    prazo: 'Z'.repeat(200),
    source: { startMs: 0, endMs: 1000, quote: 'Q'.repeat(1000) },
  }));
  let accepted = 0;
  let before = '';
  for (; accepted < 20; accepted++) {
    before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    try {
      service.syncMeeting({ ...meeting, id: `meeting-${accepted}` }, actions);
    } catch (error) {
      expect(error).toBeInstanceOf(CommitmentCapacityError);
      break;
    }
  }
  expect(accepted).toBeGreaterThan(0);
  expect(accepted).toBeLessThan(20);
  expect(fs.readFileSync(file, 'utf8')).toBe(before);
  expect(fs.statSync(file).size).toBeLessThanOrEqual(32 * 1024 * 1024);
  expect(await service.listForUser('123', { limit: 1 })).toHaveLength(1);
  const legacy = JSON.parse(before);
  for (const entry of Object.values(legacy.commitments).slice(0, 500)) {
    const copy = {
      ...(entry as Record<string, unknown>),
      id: crypto.randomBytes(16).toString('hex'),
      meetingId: 'legacy-meeting',
    };
    legacy.commitments[copy.id] = copy;
  }
  fs.writeFileSync(file, JSON.stringify(legacy, null, 2));
  expect(fs.statSync(file).size).toBeGreaterThan(32 * 1024 * 1024);
  expect(await service.listForUser('123', { limit: 1 })).toHaveLength(1);
  service.removeMeeting('legacy-meeting');
  expect(fs.statSync(file).size).toBeLessThanOrEqual(32 * 1024 * 1024);
  expect(await service.listForUser('123', { meetingId: 'legacy-meeting' })).toEqual([]);
}, 20000);
