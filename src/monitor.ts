import { describeBackupProblem, evaluateBackupHeartbeat, readBackupHeartbeat } from './backupHeartbeat';
import { config } from './config';
import { client } from './discord/client';
import { diskUsedPct, freeMB } from './disk';
import { operationalPii, operationalWarn } from './operationalLog';

/**
 * Monitoramento leve: em vez de observability corporativa, o próprio bot avisa
 * o(s) dono(s) por DM quando algo importante acontece (disco enchendo, etc.).
 * Com cooldown por tipo de alerta pra não virar spam.
 */

const ALERT_COOLDOWN_MS = 60 * 60 * 1000; // no máx. 1 alerta por hora por tipo
// Backup velho não muda de hora em hora; um lembrete por dia basta e não vira spam.
const ALERT_COOLDOWN_BY_CATEGORY: Record<string, number> = { backup: 24 * 60 * 60 * 1000 };
const lastAlertAt = new Map<string, number>();

/**
 * A chave é `categoria` ou `categoria:escopo`. A categoria vem de literais do
 * código (disk, backup, autorecord-collision...) e é logada em claro: é o que um
 * operador precisa ver em `docker logs`. Escopo (guild/canal) e mensagem podem
 * carregar identificadores e continuam sob a política de PII.
 */
function alertCategory(key: string): string {
  const category = key.split(':', 1)[0];
  return /^[a-z][a-z0-9-]{0,40}$/.test(category) ? category : 'other';
}

/** Avisa o(s) dono(s) por DM. `key` agrupa alertas do mesmo tipo (cooldown). */
export async function alertOwners(key: string, message: string): Promise<void> {
  const now = Date.now();
  const category = alertCategory(key);
  const cooldown = ALERT_COOLDOWN_BY_CATEGORY[category] ?? ALERT_COOLDOWN_MS;
  if (now - (lastAlertAt.get(key) ?? 0) < cooldown) return;
  lastAlertAt.set(key, now);
  operationalWarn(
    `Alerta operacional emitido category=${category} scope=${operationalPii(key.slice(category.length + 1) || '-')} detail=${operationalPii(message)}.`,
  );
  for (const id of config.ownerIds) {
    try {
      await client.users.send(id, `⚠️ **Kassinão — alerta**\n${message}`);
    } catch {
      // DM fechada / usuário indisponível — o evento operacional acima fica de registro.
    }
  }
}

let timer: NodeJS.Timeout | undefined;

/** Começa o monitor periódico (chamar quando o client estiver pronto). */
export function startMonitor(): void {
  if (timer) return;
  const check = (): void => {
    const pct = diskUsedPct();
    if (pct >= config.diskAlertPct) {
      void alertOwners(
        'disk',
        `O disco do servidor está em **${pct}%** de uso (só **${freeMB()} MB** livres). ` +
          `Apague gravações antigas ou aumente o disco — gravações novas podem começar a falhar.`,
      );
    }
    // Backup declarado como ativo precisa provar que rodou: o script grava um
    // heartbeat no volume de estado a cada upload verificado.
    if (config.backupEnabled) {
      const problem = describeBackupProblem(evaluateBackupHeartbeat(readBackupHeartbeat(config.stateDir), Date.now()));
      if (problem) void alertOwners('backup', problem);
    }
  };
  check();
  timer = setInterval(check, 10 * 60 * 1000);
  timer.unref?.();
}
