import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { config } from '../src/config';
import { enforcePrivateUmask, PRIVATE_FILE_UMASK } from '../src/privateUmask';

describe('permissões padrão do processo', () => {
  it('bloqueia grupo e outros antes de qualquer arquivo da aplicação ser criado', () => {
    const setUmask = vi.fn(() => 0o022);

    expect(enforcePrivateUmask(setUmask)).toBe(0o022);
    expect(PRIVATE_FILE_UMASK).toBe(0o077);
    expect(setUmask).toHaveBeenCalledWith(0o077);
  });

  it.runIf(process.platform !== 'win32')('mantém o diretório de gravações acessível só ao dono', () => {
    expect(fs.statSync(config.recordingsDir).mode & 0o777).toBe(0o700);
  });
});
