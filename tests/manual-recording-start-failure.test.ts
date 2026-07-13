import { describe, expect, it, vi } from 'vitest';
import { reportManualRecordingStartFailure } from '../src/recorder/manualStartFailure';

describe('falha ao iniciar gravação manual', () => {
  it('não inclui o detalhe interno na resposta em português', () => {
    const secret = 'connect ECONNREFUSED discord.internal:443 token=super-secret';

    const message = reportManualRecordingStartFailure(new Error(secret), 'pt', vi.fn());

    expect(message).toBe('❌ Não consegui iniciar a gravação. Tenta de novo daqui a pouco.');
    expect(message).not.toContain(secret);
  });

  it('responde com a mensagem genérica localizada em inglês', () => {
    const message = reportManualRecordingStartFailure(new Error('private detail'), 'en', vi.fn());

    expect(message).toBe("❌ I couldn't start the recording. Try again in a moment.");
  });

  it('preserva o erro completo somente no logger do servidor', () => {
    const error = new Error('private detail');
    const logger = vi.fn();

    reportManualRecordingStartFailure(error, 'pt', logger);

    expect(logger).toHaveBeenCalledWith('Erro no /gravar:', error);
  });
});
