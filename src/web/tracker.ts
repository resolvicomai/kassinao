/**
 * Contador de downloads em andamento por gravação: impede que o delete
 * (manual ou da limpeza automática) apague arquivos sendo streamados.
 */
const active = new Map<string, number>();

export function beginDownload(recordingId: string): void {
  active.set(recordingId, (active.get(recordingId) ?? 0) + 1);
}

export function endDownload(recordingId: string): void {
  const n = (active.get(recordingId) ?? 1) - 1;
  if (n <= 0) active.delete(recordingId);
  else active.set(recordingId, n);
}

export function hasActiveDownloads(recordingId: string): boolean {
  return (active.get(recordingId) ?? 0) > 0;
}
