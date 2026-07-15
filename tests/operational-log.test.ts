import { describe, expect, it, vi } from 'vitest';
import { operationalError, operationalPii, operationalPiiEnabled, operationalWarn } from '../src/operationalLog';

describe('operational logging privacy', () => {
  it('keeps PII disabled unless the operator uses the exact explicit opt-in', () => {
    expect(operationalPiiEnabled(undefined)).toBe(false);
    expect(operationalPiiEnabled('false')).toBe(false);
    expect(operationalPiiEnabled('TRUE')).toBe(false);
    expect(operationalPiiEnabled(' true ')).toBe(false);
    expect(operationalPiiEnabled('true')).toBe(true);
  });

  it('redacts identifiers and names by default', () => {
    expect(operationalPii('guild-123', undefined)).toBe('[redacted]');
    expect(operationalPii('Mauro', 'false')).toBe('[redacted]');
  });

  it('sanitizes opted-in values against multiline and ANSI log injection', () => {
    expect(operationalPii('Mauro\n\u001b[31madmin', 'true')).toBe('Mauro admin');
    expect(operationalPii(undefined, 'true')).toBe('-');
  });

  it('hides error messages by default and reveals a sanitized message only with opt-in', () => {
    const error = new TypeError('recording user-123\nfailed');
    expect(operationalError(error, undefined)).toBe('TypeError');
    expect(operationalError(error, 'true')).toBe('TypeError: recording user-123 failed');

    const hostileName = new Error('message');
    hostileName.name = 'user-123\nforged';
    expect(operationalError(hostileName, undefined)).toBe('Error');
  });

  it('sanitizes the final log line at the single console boundary', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    operationalWarn('event\n\u001b[31mforged');

    expect(warn).toHaveBeenCalledWith('event forged');
    warn.mockRestore();
  });
});
