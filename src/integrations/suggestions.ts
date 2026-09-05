import { resolveArtifact } from './client';
import type { IntegrationConfiguration } from './config';
import type { ArtifactReference, IntegrationContext } from './types';

type CitationKind = 'task' | 'source' | 'summary' | 'transcript';
export interface ArtifactSuggestion {
  reference: ArtifactReference;
  citedIn: CitationKind[];
}
export interface SuggestionInput {
  context: IntegrationContext;
  actions: readonly { tarefa: string; source?: { quote: string } }[];
  summary?: string;
  transcript?: readonly { text: string }[];
}
export interface ArtifactSuggestions {
  /** Parallel to the supplied actions, up to the explicit 200-action scan cap. */
  actionSuggestions: ArtifactSuggestion[][];
  /** General meeting references never become links for an unrelated action. */
  meetingSuggestions: ArtifactSuggestion[];
  truncated: boolean;
}

// URL tokens are consumed whole, so IDs inside a rejected URL cannot be reinterpreted as a Jira link.
const references =
  /(?<![\p{L}\p{N}_])https?:\/\/[^\s<>"'`]+|(?<![\w/.-])[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}#[1-9]\d*\b|(?<![\w/-])[A-Z][A-Z0-9_]{0,39}-\d+\b/gu;

function citationToken(value: string): string {
  let token = value.replace(/[.,;:!?]+$/, '');
  // Strip prose/Markdown wrappers, preserving balanced parentheses in document paths.
  for (const [opening, closing] of [
    ['(', ')'],
    ['[', ']'],
  ] as const) {
    let balance = 0;
    for (const char of token) balance += char === opening ? 1 : char === closing ? -1 : 0;
    while (balance < 0 && token.endsWith(closing)) {
      token = token.slice(0, -1);
      balance++;
    }
  }
  return token;
}

/** Exact, allowlisted suggestions only. This never fetches, writes or infers which action a general mention belongs to. */
export function suggestArtifactLinks(
  input: SuggestionInput,
  configuration: Pick<IntegrationConfiguration, 'scopes'>,
): ArtifactSuggestions {
  let charactersLeft = 250_000;
  let candidatesLeft = 500;
  const urls = new Set<string>();
  let truncated = input.actions.length > 200;
  const scan = (raw: string | undefined, kind: CitationKind, into: Map<string, ArtifactSuggestion>) => {
    if (!raw) return;
    const length = Math.min(raw.length, 20_000, charactersLeft);
    if (length < raw.length) truncated = true;
    charactersLeft -= length;
    const text = raw.slice(0, length);
    for (const match of text.matchAll(references)) {
      // A cut URL/ID could still parse as a different valid reference. Never suggest that prefix.
      if (length < raw.length && match.index + match[0].length === length) continue;
      if (!candidatesLeft) {
        truncated = true;
        break;
      }
      candidatesLeft--;
      try {
        const reference = resolveArtifact(citationToken(match[0]), input.context, configuration.scopes);
        if (!urls.has(reference.url) && urls.size >= 100) {
          truncated = true;
          continue;
        }
        urls.add(reference.url);
        const previous = into.get(reference.url);
        if (previous) {
          if (!previous.citedIn.includes(kind)) previous.citedIn.push(kind);
        } else into.set(reference.url, { reference, citedIn: [kind] });
      } catch {
        /* Rejected/ambiguous references remain plain meeting text. */
      }
    }
  };
  const actionSuggestions = input.actions.slice(0, 200).map((action) => {
    const found = new Map<string, ArtifactSuggestion>();
    scan(action.tarefa, 'task', found);
    scan(action.source?.quote, 'source', found);
    return [...found.values()];
  });
  const meeting = new Map<string, ArtifactSuggestion>();
  scan(input.summary, 'summary', meeting);
  if ((input.transcript?.length ?? 0) > 1000) truncated = true;
  for (const segment of (input.transcript ?? []).slice(0, 1000)) {
    if (!charactersLeft || !candidatesLeft) {
      truncated = true;
      break;
    }
    scan(segment.text, 'transcript', meeting);
  }
  return { actionSuggestions, meetingSuggestions: [...meeting.values()], truncated };
}
