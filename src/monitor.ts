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
const lastAlertAt = new Map<string, number>();

/** Avisa o(s) dono(s) por DM. `key` agrupa alertas do mesmo tipo (cooldown). */
export async function alertOwners(key: string, message: string): Promise<void> {
  const now = Date.now();
  if (now - (lastAlertAt.get(key) ?? 0) < ALERT_COOLDOWN_MS) return;
  lastAlertAt.set(key, now);
  operationalWarn(`Alerta operacional emitido key=${operationalPii(key)} detail=${operationalPii(message)}.`);
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
  };
  check();
  timer = setInterval(check, 10 * 60 * 1000);
  timer.unref?.();
}

export function stopMonitor(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}
