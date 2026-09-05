/** This tool only reads the server's current commitment state. */
export function createCommitmentsTool(apiGet: (path: string, args: Record<string, unknown>) => Promise<unknown>) {
  return {
    name: 'list_commitments',
    description:
      'Read the current recorded lifecycle of authorized meeting commitments: mentioned, confirmed, completed or cancelled. Defaults to meetings in the last 30 days. Mentioned is not confirmed and has no overdue obligation. reviewRequired means the current version needs human review even if the previous manual status remains confirmed/completed; sourceQuality carries incomplete audio/transcript coverage. completionConflict reports disagreement with manual completion. By itself, a merge does not prove completion or deployment. effectiveCompletion reports a recent source reading that meets the explicit user-selected completionRule; this does not change manual status or prove deployment. A null result is not proof of unfinished work. Links and snapshots require current artifact access. sourceAccessIncomplete means source checks were unavailable or exceeded the read budget; retry with a smaller limit or inspect contextUrl. Source quotes require transcript permission. Follow nextCursor until null, then nextScanCursor; empty pages may still have continuation. Read-only: this tool never changes status, links or notifications.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        preset: {
          type: 'string',
          enum: [
            'today',
            'yesterday',
            'this_week',
            'last_week',
            'this_month',
            'last_month',
            'last_7_days',
            'last_30_days',
          ],
        },
        from: {
          type: 'string',
          description: 'Meeting date/window start: YYYY-MM-DD in the configured timezone or ISO-8601.',
        },
        to: { type: 'string', description: 'Meeting date/window end, inclusive: YYYY-MM-DD or ISO-8601.' },
        last: { type: 'string', description: 'Rolling meeting window, for example 60d or 2w.' },
        guildId: { type: 'string' },
        channelId: { type: 'string' },
        status: { type: 'string', enum: ['mentioned', 'confirmed', 'completed', 'cancelled'] },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 100 },
        cursor: { type: 'string', description: 'Opaque nextCursor; keep the same filters and connection.' },
        scanCursor: {
          type: 'string',
          description: 'Opaque nextScanCursor; use only when nextCursor is null, with the same filters and connection.',
        },
      },
    },
    call: (args: Record<string, unknown>) => apiGet('/api/commitments', args),
  };
}
