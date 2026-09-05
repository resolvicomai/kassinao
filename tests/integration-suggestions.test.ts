import { describe, expect, it, vi } from 'vitest';
import { suggestArtifactLinks } from '../src/integrations/suggestions';
import { parseIntegrationConfiguration } from '../src/integrations/config';

const context = { guildId: '1', channelId: '2' };
const configuration = parseIntegrationConfiguration({
  KASSINAO_CONTEXT_SCOPES: JSON.stringify([
    {
      ...context,
      githubRepositories: ['example/work'],
      jira: { site: 'https://example.atlassian.net', projects: ['WORK'] },
      documentOrigins: ['https://docs.example'],
    },
  ]),
});
const input = (tarefa: string) => ({ context, actions: [{ tarefa }] });

describe('exact integration suggestions', () => {
  it('uses exact action/source citations, deduplicates links and never assigns general meeting mentions to actions', () => {
    const result = suggestArtifactLinks(
      {
        context,
        actions: [
          {
            tarefa: 'Revisar [PR](https://github.com/example/work/pull/17).',
            source: { quote: 'Eu reviso https://github.com/example/work/pull/17 e WORK-42.' },
          },
          { tarefa: 'Falar com a equipe', source: { quote: 'Vamos conversar.' } },
        ],
        summary: 'Houve menção a WORK-99.',
        transcript: [{ text: 'O documento está em https://docs.example/design.' }],
      },
      configuration,
    );
    expect(result.actionSuggestions[0]).toEqual([
      {
        reference: expect.objectContaining({
          kind: 'github-pull',
          number: 17,
          url: 'https://github.com/example/work/pull/17',
        }),
        citedIn: ['task', 'source'],
      },
      { reference: expect.objectContaining({ kind: 'jira-issue', issueKey: 'WORK-42' }), citedIn: ['source'] },
    ]);
    expect(result.actionSuggestions[1]).toEqual([]);
    expect(result.meetingSuggestions).toEqual([
      { reference: expect.objectContaining({ issueKey: 'WORK-99' }), citedIn: ['summary'] },
      { reference: expect.objectContaining({ url: 'https://docs.example/design' }), citedIn: ['transcript'] },
    ]);
    expect(result.truncated).toBe(false);
  });
  it('rejects false origins, ambiguous projects and references outside the meeting allowlist without network', () => {
    const fetch = vi.fn(() => {
      throw new Error('No network allowed');
    });
    vi.stubGlobal('fetch', fetch);
    try {
      for (const text of [
        'https://github.com.evil/example/work/pull/17',
        'https://github.com@example.evil/example/work/pull/17',
        'https://evil.example/WORK-42',
        'https://github.com/example/work/pull/17?next=WORK-42',
        'https://github.com%2eevil/example/work/pull/17',
        'OTHER-42',
        '#17',
        'Aquele PR do parser',
      ]) {
        expect(suggestArtifactLinks(input(text), configuration).actionSuggestions[0]).toEqual([]);
      }
      expect(
        suggestArtifactLinks(
          { ...input('WORK-42 example/work#17'), context: { guildId: '1', channelId: 'other' } },
          configuration,
        ).actionSuggestions[0],
      ).toEqual([]);
      const ambiguous = {
        scopes: [
          ...configuration.scopes,
          { ...configuration.scopes[0], jira: { site: 'https://another.atlassian.net', projects: ['WORK'] } },
        ],
      };
      expect(suggestArtifactLinks(input('WORK-42'), ambiguous).actionSuggestions[0]).toEqual([]);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('preserves explicit GitHub shorthand and marks bounded text/reference scans as incomplete', () => {
    expect(
      suggestArtifactLinks(input('example/work#17'), configuration).actionSuggestions[0][0].reference,
    ).toMatchObject({ kind: 'github-issue', number: 17 });
    const long = suggestArtifactLinks(input('x'.repeat(20_001) + ' WORK-42'), configuration);
    expect(long).toMatchObject({ actionSuggestions: [[]], truncated: true });
    const cutId = suggestArtifactLinks(input('x'.repeat(19_990) + ' WORK-1234567890'), configuration);
    expect(cutId).toMatchObject({ actionSuggestions: [[]], truncated: true });
    const many = suggestArtifactLinks(
      input(Array.from({ length: 110 }, (_, i) => `WORK-${i + 1}`).join(' ')),
      configuration,
    );
    expect(many.actionSuggestions[0]).toHaveLength(100);
    expect(many.truncated).toBe(true);
  });
});
