import { commitPrivateStateLayout } from './config';
import { validateTranscriptionConfig } from './processing/transcribe';

/**
 * Gate único de boot: nenhuma migração, rotação ou identidade é persistida
 * antes de todas as validações que podem impedir o processo de iniciar.
 */
export function validateAndCommitRuntimeConfiguration(): string | undefined {
  const error = validateTranscriptionConfig();
  if (error) return error;
  commitPrivateStateLayout();
  return undefined;
}
