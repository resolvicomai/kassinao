import { afterEach, describe, expect, it, vi } from 'vitest';
import { macOsProcessIdentity } from '../mcp/src/credentialLock';

describe('isolamento do subprocesso de identidade MCP', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('entrega ao ps somente locale fixo, sem token ou ambiente arbitrário', () => {
    vi.stubEnv('KASSINAO_REFRESH_TOKEN', 'never-forward-this-token');
    vi.stubEnv('OPERATOR_CONTROLLED', 'never-forward-this-value');

    let receivedEnvironment: NodeJS.ProcessEnv | undefined;
    const identity = macOsProcessIdentity(42, (file, args, options) => {
      expect(file).toBe('/bin/ps');
      expect(args).toEqual(['-o', 'lstart=', '-p', '42']);
      receivedEnvironment = options.env;
      return 'Tue Jul 15 12:34:56 2026\n';
    });

    expect(identity).toBe('darwin:Tue Jul 15 12:34:56 2026');
    expect(receivedEnvironment).toEqual({ LC_ALL: 'C' });
    expect(receivedEnvironment).not.toHaveProperty('KASSINAO_REFRESH_TOKEN');
    expect(receivedEnvironment).not.toHaveProperty('OPERATOR_CONTROLLED');
  });
});
