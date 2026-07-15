import { Locale, t } from '../i18n';
import { operationalError, operationalFailure } from '../operationalLog';

type ServerErrorLogger = (message: string, error: unknown) => void;

export function reportManualRecordingStartFailure(
  error: unknown,
  locale: Locale,
  logger: ServerErrorLogger = (message, detail) => operationalFailure(`${message} error=${operationalError(detail)}.`),
): string {
  logger('Erro no /gravar:', error);
  return t(locale, 'record.start-failed');
}
