import { Locale, t } from '../i18n';

type ServerErrorLogger = (message: string, error: unknown) => void;

export function reportManualRecordingStartFailure(
  error: unknown,
  locale: Locale,
  logger: ServerErrorLogger = (message, detail) => console.error(message, detail),
): string {
  logger('Erro no /gravar:', error);
  return t(locale, 'record.start-failed');
}
