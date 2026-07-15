import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const INSTALLER = path.join(ROOT, 'scripts', 'install-shared-host-controls.sh');
const source = readFileSync(INSTALLER, 'utf8');
const hardener = readFileSync(path.join(ROOT, 'scripts', 'harden-docker-egress.sh'), 'utf8');

function shellLiteral(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

describe('installer de controles para host Docker compartilhado', () => {
  it('é Bash válido e barra execução sem root antes de qualquer instalação', () => {
    const syntax = spawnSync('bash', ['-n', INSTALLER], { encoding: 'utf8' });
    expect(syntax.status, syntax.stderr).toBe(0);

    if ((process.getuid?.() ?? 1) !== 0) {
      const execution = spawnSync('bash', [INSTALLER], { encoding: 'utf8' });
      expect(execution.status).not.toBe(0);
      expect(execution.stderr).toContain('execute como root');
    }
  });

  it('exige escopo shared, ACK dedicado vazio e storage LUKS já provado', () => {
    expect(source).toContain('[ "$(env_value KASSINAO_HOST_SCOPE)" = shared ]');
    expect(source).toContain('[ -z "$(env_value KASSINAO_DEDICATED_DOCKER_HOST_ACK)" ]');
    expect(source).toContain('scripts/verify-shared-luks-storage.sh');
    expect(source).toContain('scripts/check-shared-migration-rollback.sh');
    expect(source).toContain('"KASSINAO_ENV_FILE=$ENV_FILE" "$SHARED_VERIFIER_SOURCE"');
    expect(source).toContain('"KASSINAO_ENV_FILE=$ENV_FILE" "$SHARED_ROLLBACK_CHECKER_SOURCE"');
    expect(source).toContain('KASSINAO_DATA_ROOT precisa ficar acessível');
    expect(source).toContain('mounts privados precisam ser filhos exatos');

    const verifierGate = source.indexOf('"KASSINAO_ENV_FILE=$ENV_FILE" "$SHARED_VERIFIER_SOURCE"');
    const rollbackGate = source.indexOf('"KASSINAO_ENV_FILE=$ENV_FILE" "$SHARED_ROLLBACK_CHECKER_SOURCE"');
    const mutationBoundary = source.indexOf('# A partir daqui começam as mutações');
    expect(verifierGate).toBeGreaterThan(0);
    expect(rollbackGate).toBeGreaterThan(verifierGate);
    expect(mutationBoundary).toBeGreaterThan(rollbackGate);
    expect(mutationBoundary).toBeGreaterThan(verifierGate);
  });

  it('executa o audit preflight selado antes de instalar ou ativar egress', () => {
    expect(source).toContain('scripts/audit-shared-vps-security.sh');
    expect(source).toContain('"$SHARED_AUDIT_SOURCE" --preflight');
    expect(source).toContain('preflight shared reprovou o host; nenhum controle de egress foi instalado ou ativado');

    const preflight = source.indexOf('env -i "PATH=$PATH" "HOME=${HOME:-/root}" "$SHARED_AUDIT_SOURCE" --preflight');
    const mutationBoundary = source.indexOf('# A partir daqui começam as mutações');
    const installEgress = source.indexOf('install -o root -g root -m 0755 "$ROOT/scripts/harden-docker-egress.sh"');
    const enableEgress = source.indexOf('systemctl enable kassinao-docker-egress.service kassinao-health-watch.timer');
    const restartEgress = source.indexOf('systemctl restart kassinao-docker-egress.service');

    expect(preflight).toBeGreaterThan(0);
    expect(mutationBoundary).toBeGreaterThan(preflight);
    expect(installEgress).toBeGreaterThan(mutationBoundary);
    expect(enableEgress).toBeGreaterThan(mutationBoundary);
    expect(restartEgress).toBeGreaterThan(mutationBoundary);
    expect(source.slice(0, mutationBoundary)).not.toMatch(
      /systemctl\s+(?:start|restart|enable)\s+kassinao-(?:docker-egress|egress-fail-closed)/,
    );

    const directory = mkdtempSync(path.join(tmpdir(), 'kassinao-shared-installer-gate-'));
    const bin = path.join(directory, 'bin');
    const calls = path.join(directory, 'mutations.log');
    const failingAudit = path.join(directory, 'audit-shared');
    mkdirSync(bin);
    writeFileSync(failingAudit, '#!/usr/bin/env bash\nexit 42\n');
    chmodSync(failingAudit, 0o755);
    for (const command of ['systemctl', 'install']) {
      const executable = path.join(bin, command);
      writeFileSync(
        executable,
        `#!/usr/bin/env bash\nprintf '%s:%s\\n' ${shellLiteral(command)} "$*" >> ${shellLiteral(calls)}\n`,
      );
      chmodSync(executable, 0o755);
    }
    const gate = source.slice(preflight, mutationBoundary);
    const execution = spawnSync(
      'bash',
      [
        '-c',
        [
          'set -Eeuo pipefail',
          'die() { printf \'ERRO: %s\\n\' "$*" >&2; exit 1; }',
          `SHARED_AUDIT_SOURCE=${shellLiteral(failingAudit)}`,
          gate,
          'systemctl restart kassinao-docker-egress.service',
          'install source /usr/local/sbin/kassinao-harden-docker-egress',
        ].join('\n'),
      ],
      {
        encoding: 'utf8',
        env: {
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          HOME: directory,
        },
      },
    );
    expect(execution.status).not.toBe(0);
    expect(execution.stderr).toContain('nenhum controle de egress foi instalado ou ativado');
    expect(existsSync(calls) ? readFileSync(calls, 'utf8') : '').toBe('');
  });

  it('repete o contrato estático selado sob lock antes de liberar o health-watch', () => {
    const dockerPidGate = source.indexOf('[ "$docker_main_pid_after" = "$docker_main_pid_before" ]');
    const finalPreflight = source.indexOf(
      '"KASSINAO_ENV_FILE=$ENV_FILE" \\\n  "$SHARED_AUDIT_SOURCE" --preflight >/dev/null',
      dockerPidGate,
    );
    const unlock = source.indexOf('flock -u 9', dockerPidGate);
    const healthStart = source.indexOf('systemctl start kassinao-health-watch.service', dockerPidGate);

    expect(dockerPidGate).toBeGreaterThan(0);
    expect(finalPreflight).toBeGreaterThan(dockerPidGate);
    expect(unlock).toBeGreaterThan(finalPreflight);
    expect(healthStart).toBeGreaterThan(unlock);
    expect(source).toContain('contrato estático shared divergiu antes de ativar o health-watch');
  });

  it('materializa somente a allowlist mínima do verifier em shared.env', () => {
    for (const key of [
      'KASSINAO_DATA_ROOT',
      'KASSINAO_RECORDINGS_DIR',
      'KASSINAO_STATE_DIR',
      'KASSINAO_AUTH_DIR',
      'KASSINAO_MODEL_CACHE_DIR',
      'KASSINAO_UID',
      'KASSINAO_GID',
      'KASSINAO_SHARED_LUKS_BACKING_FILE',
      'KASSINAO_SHARED_LUKS_MAPPER',
      'KASSINAO_SHARED_LUKS_UUID',
    ]) {
      expect(source).toContain(`  ${key}\n`);
    }
    expect(source).toContain('/etc/kassinao/shared.env');
    expect(source).toContain('install -o root -g root -m 0600 "$SHARED_ENV_TMP"');
    expect(source).not.toMatch(/DISCORD_TOKEN.*shared\.env/);
    expect(source).not.toMatch(/TUNNEL_TOKEN.*shared\.env/);
  });

  it('falha fechado quando o docker.service ainda carrega controles dedicados', () => {
    expect(source).toContain('/etc/systemd/system/docker.service.d/kassinao-egress.conf');
    expect(source).toContain('/usr/local/sbin/kassinao-verify-storage-encryption');
    expect(source).toContain('/etc/kassinao/storage-paths');
    expect(source).toContain('artefato do adapter dedicated ainda existe');
    expect(source).toContain('systemctl show docker.service -p DropInPaths');
    expect(source).toContain('systemctl show docker.service -p ExecStartPre');
    expect(source).toContain('docker.service ainda carrega o drop-in dedicado');
    expect(source).toContain('controles dedicados antigos ainda estão instalados');
    expect(source).toContain('docker_main_pid_after');
    expect(source).toContain('[ "$docker_main_pid_after" = "$docker_main_pid_before" ]');
  });

  it('não configura nem reinicia o daemon, SSH, UFW ou daemon.json', () => {
    expect(source).not.toContain('/etc/docker/daemon.json');
    expect(source).not.toContain('/etc/ssh');
    expect(source).not.toMatch(/\bufw\b/);
    expect(source).not.toContain('DOCKER_DROPIN_SOURCE');
    expect(source).not.toMatch(/install[^\n]*docker\.service\.d/);
    expect(source).not.toMatch(
      /systemctl\s+(?:start|stop|restart|reload|enable|disable|mask|unmask)\s+docker(?:\.service)?\b/,
    );
    expect(source).not.toContain('systemctl daemon-reexec');
  });

  it('instala somente scripts e units escopados ao Kassinão', () => {
    for (const script of [
      'kassinao-health-watch',
      'kassinao-verify-shared-luks-storage',
      'kassinao-check-shared-migration-rollback',
      'kassinao-harden-docker-egress',
      'kassinao-egress-fail-closed',
    ]) {
      expect(source).toContain(`/usr/local/sbin/${script}`);
    }
    expect(source).not.toMatch(/install[^\n]*\/usr\/local\/sbin\/kassinao-verify-storage-encryption/);
    for (const unit of [
      'kassinao-health-watch.service',
      'kassinao-health-watch.timer',
      'kassinao-docker-egress.service',
      'kassinao-egress-fail-closed.service',
      'kassinao-rollback-clean.service',
      'kassinao-rollback-clean.timer',
    ]) {
      expect(source).toContain(unit);
    }
    expect(source).toContain(
      'systemctl enable kassinao-docker-egress.service kassinao-health-watch.timer kassinao-rollback-clean.timer',
    );
    expect(source).not.toMatch(/systemctl start kassinao-egress-fail-closed\.service/);
  });

  it('não cria, move ou deduplica o hook FORWARD global no modo shared', () => {
    expect(hardener).toContain('if [ "${1:-}" = --shared-host ]');
    expect(hardener).toContain('check_shared_global_hooks()');
    expect(hardener).toContain('if [ "$HOST_SCOPE" = dedicated ]; then');
    expect(hardener).toContain('canonicalize_first_rule ipt FORWARD -j DOCKER-USER');
    expect(hardener).toContain('canonicalize_first_rule ip6t FORWARD -j DOCKER-USER');
    expect(hardener).toContain('nenhuma regra foi alterada');

    const sharedGate = hardener.indexOf('if [ "$HOST_SCOPE" = shared ] && ! check_shared_global_hooks');
    const firstPolicyMutation = hardener.indexOf('for tool in ipt ip6t; do', sharedGate);
    const dedicatedOnly = hardener.indexOf('if [ "$HOST_SCOPE" = dedicated ]; then', firstPolicyMutation);
    const ipv4GlobalMutation = hardener.indexOf('canonicalize_first_rule ipt FORWARD -j DOCKER-USER', dedicatedOnly);
    const ipv6GlobalMutation = hardener.indexOf('canonicalize_first_rule ip6t FORWARD -j DOCKER-USER', dedicatedOnly);
    expect(sharedGate).toBeGreaterThan(0);
    expect(firstPolicyMutation).toBeGreaterThan(sharedGate);
    expect(dedicatedOnly).toBeGreaterThan(firstPolicyMutation);
    expect(ipv4GlobalMutation).toBeGreaterThan(dedicatedOnly);
    expect(ipv6GlobalMutation).toBeGreaterThan(ipv4GlobalMutation);
    expect(source).toContain('ExecStart=/usr/local/sbin/kassinao-harden-docker-egress --shared-host');
    expect(source).toContain('unit de egress efetiva não usa o modo shared isolado');
  });

  it('liga o health-watch ao contrato shared sem injetar overrides no ambiente privilegiado', () => {
    expect(source).toContain('HEALTH_DROPIN="$HEALTH_DROPIN_DIR/10-shared-host.conf"');
    const currentDropinStart = source.indexOf('expected_health_dropin="$(printf');
    const currentDropinEnd = source.indexOf('installed_env_file=', currentDropinStart);
    expect(currentDropinStart).toBeGreaterThan(0);
    expect(currentDropinEnd).toBeGreaterThan(currentDropinStart);
    const currentDropin = source.slice(currentDropinStart, currentDropinEnd);
    expect(currentDropin).not.toMatch(/^\s*['"]Environment=/m);
    expect(currentDropin).toContain("grep -c '^Environment='");
    expect(source).toContain('ExecStartPre=/usr/local/sbin/kassinao-check-shared-migration-rollback');
    expect(source).toContain("grep -Fqx 'ProtectSystem=strict'");
    expect(source).toContain("grep -Fqx 'ReadWritePaths=/run/lock/kassinao'");
    expect(source).toContain("'PrivateDevices=false'");
    expect(source).toContain("'CapabilityBoundingSet=CAP_SYS_ADMIN CAP_NET_ADMIN CAP_NET_RAW'");
    expect(source).toContain(
      'ReadOnlyPaths=/etc/kassinao/shared.env $ENV_FILE $SHARED_AUDIT_SOURCE $data_root $backing_file',
    );
    expect(source).toContain('mktemp "$HEALTH_DROPIN_DIR/.10-shared-host.conf.XXXXXX"');
    expect(source).toContain('mv -f -- "$HEALTH_DROPIN_TMP" "$HEALTH_DROPIN"');
    expect(source).toContain('health-watch possui drop-in diferente do adapter shared');
    expect(source).toContain('expected_installed_health_dropin');
    expect(source).toContain('expected_legacy_health_dropin');
    expect(source).toContain('installed_env_file="$installed_deploy_dir/.env"');
    expect(source).toContain('systemctl show kassinao-health-watch.service -p CapabilityBoundingSet --value');
    expect(source).toContain("*' cap_sys_admin '*");
    expect(source).toContain('systemctl show kassinao-health-watch.service -p PrivateDevices --value');
    expect(source).toContain('systemctl show kassinao-health-watch.service -p ExecStartPre --value');
    expect(source).toContain('health-watch efetivo não executa o checker de rollback');
    expect(source).toContain('health-watch efetivo não pode receber Environment');
    expect(source).toContain('[ -z "$health_environment" ]');
  });

  it('permite upgrade auditado para outra release sem aceitar troca de storage', () => {
    expect(source).toContain(
      'installed_deploy_dir="$(env_value KASSINAO_DEPLOY_DIR "$ETC_KASSINAO/host-controls.env")"',
    );
    expect(source).toContain('[ "$installed_data_root" = "$data_root" ]');
    expect(source).toContain('marker shared pertence a outro storage');
    expect(source).toContain('marker shared possui chaves extras ou formato divergente');
    expect(source).toContain('mv -f -- "$HEALTH_DROPIN_TMP" "$HEALTH_DROPIN"');
    expect(source.indexOf('rollback_dir="$data_root/rollback"')).toBeLessThan(
      source.indexOf('if [ "$shared_marker_present" = true ]; then'),
    );
  });

  it('nunca sobrescreve controle homônimo sem proveniência da release shared registrada', () => {
    expect(source).toContain('shared_marker_present=false');
    expect(source).toContain('release registrada diverge do próprio manifesto');
    expect(source).toContain('controle homônimo sem marker shared recusado');
    expect(source).toContain('controle instalado não pertence à release shared registrada');
    expect(source).toContain('controle gerado não pertence à release shared registrada');
    expect(source).toContain('drop-in homônimo do health-watch existe sem marker shared');

    const provenanceGate = source.indexOf('assert_existing_control_source()');
    const mutationBoundary = source.indexOf('# A partir daqui começam as mutações');
    expect(provenanceGate).toBeGreaterThan(0);
    expect(mutationBoundary).toBeGreaterThan(provenanceGate);
  });

  it('protege o lifecycle concorrente e aceita somente containers shared sem restart autônomo', () => {
    expect(source).toContain('flock -w 120 9');
    expect(source).toContain('restart=no antes de instalar controles shared');
    expect(source).toContain('com.docker.compose.project');
    expect(source).toContain('com.docker.compose.service');
    expect(source).toContain('containers shared existentes exigem runtime');
    expect(source).toContain('maintenance.lock precisa preexistir como regular 0600 root:root sem hardlink');
    expect(source).toContain('exec 9<>"$lock_file"');
    expect(source).toContain('diretório do drop-in shared precisa ser 0755 root:root');
    expect(source).toContain('systemd-tmpfiles --create /etc/tmpfiles.d/kassinao.conf');
    expect(source).toContain('systemd-tmpfiles --create /etc/tmpfiles.d/kassinao-rollback.conf');
  });
});
