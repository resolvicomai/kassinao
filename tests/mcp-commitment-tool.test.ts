import { describe, expect, it, vi } from 'vitest';
import { createCommitmentsTool } from '../mcp/src/commitmentTool';

describe('list_commitments tool', () => {
  it('exposes only bounded read filters and forwards the cursor to the read endpoint', async () => {
    const response = { commitments: [{ id: 'fixture', status: 'confirmed' }], nextCursor: null };
    const apiGet = vi.fn(async () => response);
    const tool = createCommitmentsTool(apiGet);
    expect(tool.name).toBe('list_commitments');
    expect(tool.inputSchema.additionalProperties).toBe(false);
    expect(tool.inputSchema.properties.limit).toMatchObject({ type: 'integer', minimum: 1, maximum: 100 });
    expect(tool.inputSchema.properties.status.enum).toEqual(['mentioned', 'confirmed', 'completed', 'cancelled']);
    for (const write of ['setStatus', 'urls', 'follow']) expect(tool.inputSchema.properties).not.toHaveProperty(write);
    const args = { status: 'confirmed', guildId: '1', channelId: '2', last: '60d', limit: 10, cursor: 'opaque' };
    expect(await tool.call(args)).toBe(response);
    expect(apiGet).toHaveBeenCalledExactlyOnceWith('/api/commitments', args);
    expect(tool.description).toMatch(/merge does not prove completion or deployment/);
  });
});
