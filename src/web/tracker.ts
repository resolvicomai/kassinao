/**
 * Contador de downloads em andamento por gravação: impede que o delete
 * (manual ou da limpeza automática) apague arquivos sendo streamados.
 */
const active = new Map<string, number>();
const activeByUser = new Map<string, number>();
let activeTotal = 0;

const MAX_ACTIVE_DOWNLOADS_PER_USER = 2;
const MAX_ACTIVE_DOWNLOADS_GLOBAL = 16;

export interface DownloadLease {
  release(): void;
}

/**
 * Reserva uma vaga antes de cozinhar/servir mídia. A cota é pequena de
 * propósito: um membro autenticado não pode transformar streams lentos em
 * exaustão de descritores, CPU ou disco da VPS.
 */
export function acquireDownload(recordingId: string, userId: string): DownloadLease | undefined {
  const userActive = activeByUser.get(userId) ?? 0;
  if (userActive >= MAX_ACTIVE_DOWNLOADS_PER_USER || activeTotal >= MAX_ACTIVE_DOWNLOADS_GLOBAL) return undefined;

  active.set(recordingId, (active.get(recordingId) ?? 0) + 1);
  activeByUser.set(userId, userActive + 1);
  activeTotal++;

  let released = false;
  return {
    release() {
      if (released) return;
      released = true;

      const recordingActive = (active.get(recordingId) ?? 1) - 1;
      if (recordingActive <= 0) active.delete(recordingId);
      else active.set(recordingId, recordingActive);

      const nextUserActive = (activeByUser.get(userId) ?? 1) - 1;
      if (nextUserActive <= 0) activeByUser.delete(userId);
      else activeByUser.set(userId, nextUserActive);

      activeTotal = Math.max(0, activeTotal - 1);
    },
  };
}

export function hasActiveDownloads(recordingId: string): boolean {
  return (active.get(recordingId) ?? 0) > 0;
}
