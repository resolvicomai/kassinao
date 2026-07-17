#!/bin/bash -p
# Remove somente os controles escopados instalados pelo adapter shared. Nunca
# para containers, reinicia Docker ou apaga release, storage e segredos.
set -Eeuo pipefail
umask 077

die() { printf 'ERRO: %s\n' "$*" >&2; exit 1; }
CONFIRMATION=--confirm-remove-kassinao-shared-host-controls
[ "${1:-}" = "$CONFIRMATION" ] && [ "$#" -eq 1 ] ||
  die "uso: uninstall-shared-host-controls.sh $CONFIRMATION"
[ "$EUID" -eq 0 ] || die 'execute como root'

inherited_docker_environment_name=''
for inherited_name in DOCKER_HOST DOCKER_CONTEXT DOCKER_CONFIG DOCKER_TLS_VERIFY DOCKER_CERT_PATH DOCKER_API_VERSION; do
  if declare -p "$inherited_name" >/dev/null 2>&1; then
    inherited_docker_environment_name="$inherited_name"
    break
  fi
done
_saved_no_dump_marker="${KASSINAO_NO_DUMP_ACTIVE-}"
_saved_no_dump_preload="${LD_PRELOAD-}"
[ -r "/proc/$$/environ" ] || die '/proc é obrigatório para limpar o ambiente do uninstall shared'
while IFS='=' read -r -d '' _inherited_name _inherited_value; do
  unset "$_inherited_name" 2>/dev/null || true
done < "/proc/$$/environ"
unset _inherited_name _inherited_value
SAFE_SYSTEM_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH="$SAFE_SYSTEM_PATH" HOME=/root LC_ALL=C

_script_path="${BASH_SOURCE[0]}"
case "$_script_path" in /*) ;; ./*) _script_path="$PWD/${_script_path#./}" ;; *) _script_path="$PWD/$_script_path" ;; esac
case "$_script_path" in *//* | */./* | */../* | */. | */.. | */) die 'caminho do uninstall shared não é canônico' ;; esac
_script_dir="${_script_path%/*}"
case "$_script_dir" in */scripts) PROJECT_DIR="${_script_dir%/scripts}" ;; *) die 'uninstall shared precisa executar do kit selado' ;; esac
case "${MACHTYPE%%-*}" in x86_64) _no_dump_arch=amd64 ;; aarch64 | arm64) _no_dump_arch=arm64 ;; *) die 'arquitetura sem runtime no-dump' ;; esac
_no_dump_preload="$PROJECT_DIR/runtime/linux-$_no_dump_arch/libkassinao-no-dump.so"
# KASSINAO_HOST_NO_DUMP_BEGIN
if [ "$_saved_no_dump_marker" != "prctl-v1:$$" ] || [ "$_saved_no_dump_preload" != "$_no_dump_preload" ]; then
  exec /usr/bin/python3 "$PROJECT_DIR/scripts/no-dump-exec.py" \
    --bundle-root "$PROJECT_DIR" --script-relative scripts/uninstall-shared-host-controls.sh --arch "$_no_dump_arch" -- \
    "$_script_path" "$@"
fi
LD_PRELOAD="$_no_dump_preload"
export LD_PRELOAD
[ "$(ulimit -Sc)" = 0 ] && [ "$(ulimit -Hc)" = 0 ] || die 'core limit do uninstall shared não ficou selado'
IFS= read -r _no_dump_filter < "/proc/$$/coredump_filter" || _no_dump_filter=''
[[ "$_no_dump_filter" =~ ^0+$ ]] || die 'coredump_filter do uninstall shared não ficou selado'
# KASSINAO_HOST_NO_DUMP_END
unset _saved_no_dump_marker _saved_no_dump_preload _no_dump_filter _no_dump_arch _no_dump_preload _script_path _script_dir

[ -z "$inherited_docker_environment_name" ] || \
  die "$inherited_docker_environment_name não pode vir do ambiente; o uninstall usa somente o daemon local da VPS"
[ "$(id -u)" -eq 0 ] || die 'execute como root'
for command in awk cat chmod cmp dirname docker find flock grep iptables ip6tables rm rmdir sed sort stat systemctl tr; do
  command -v "$command" >/dev/null 2>&1 || die "$command não encontrado"
done
[ -n "$(command -v sha256sum 2>/dev/null || command -v shasum 2>/dev/null || true)" ] ||
  die 'sha256sum ou shasum é obrigatório'

export DOCKER_HOST=unix:///var/run/docker.sock
unset DOCKER_CONTEXT DOCKER_TLS_VERIFY DOCKER_CERT_PATH DOCKER_API_VERSION

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
[ "$ROOT" = "$PROJECT_DIR" ] || die 'raiz canônica divergiu do kit selado'
DOCKER_CONFIG="$ROOT/deploy/docker-client"
DOCKER_CONFIG_FILE="$DOCKER_CONFIG/config.json"
[ -d "$DOCKER_CONFIG" ] && [ ! -L "$DOCKER_CONFIG" ] && [ -f "$DOCKER_CONFIG_FILE" ] && [ ! -L "$DOCKER_CONFIG_FILE" ] ||
  die 'configuração isolada do cliente Docker está ausente ou irregular'
[ "$(sha256sum -- "$DOCKER_CONFIG_FILE" | awk '{print $1}')" = ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356 ] ||
  die 'configuração isolada do cliente Docker diverge do objeto vazio selado'
export DOCKER_CONFIG
case "$ROOT" in
  /home | /home/* | /root | /root/* | /run/user | /run/user/* | /tmp | /tmp/* | /var/tmp | /var/tmp/*)
    die 'release shared precisa ficar fora de home/root/tmp'
    ;;
esac
cursor="$ROOT"
while :; do
  [ ! -e "$cursor/.git" ] || die 'uninstall de produção exige kit fora de Git'
  metadata="$(stat -c '%a:%u:%g' "$cursor" 2>/dev/null || true)"
  mode="${metadata%%:*}"
  [ "${metadata#*:}" = 0:0 ] && [[ "$mode" =~ ^[0-7]+$ ]] && (( (8#$mode & 022) == 0 )) ||
    die 'release e pais precisam ser root-owned e não graváveis por terceiros'
  parent="$(dirname -- "$cursor")"
  [ "$parent" != "$cursor" ] || break
  cursor="$parent"
done
case "$(stat -c '%a:%u:%g' "$ROOT" 2>/dev/null || true)" in
  700:0:0 | 500:0:0) ;;
  *) die 'diretório da release precisa ser 0700/0500 root:root' ;;
esac

MANIFEST="$ROOT/MANIFEST.sha256"
[ -f "$MANIFEST" ] && [ ! -L "$MANIFEST" ] || die 'MANIFEST.sha256 ausente ou irregular'
manifest_metadata="$(stat -c '%a:%u:%g' "$MANIFEST" 2>/dev/null || true)"
manifest_mode="${manifest_metadata%%:*}"
[ "${manifest_metadata#*:}" = 0:0 ] && [[ "$manifest_mode" =~ ^[0-7]+$ ]] &&
  (( (8#$manifest_mode & 022) == 0 )) || die 'MANIFEST.sha256 está inseguro'
if command -v sha256sum >/dev/null 2>&1; then
  (cd -- "$ROOT" && sha256sum -c MANIFEST.sha256 --quiet) || die 'kit diverge do MANIFEST.sha256'
else
  (cd -- "$ROOT" && shasum -a 256 -c MANIFEST.sha256 >/dev/null) || die 'kit diverge do MANIFEST.sha256'
fi

manifest_has() {
  local wanted="$1"
  awk -v wanted="$wanted" '
    { path=$2; sub(/^\.\//, "", path); if (path == wanted) count++ }
    END { exit count == 1 ? 0 : 1 }
  ' "$MANIFEST"
}

case "${MACHTYPE%%-*}" in
  x86_64) no_dump_runtime_relative=runtime/linux-amd64/kassinao-no-dump ;;
  aarch64 | arm64) no_dump_runtime_relative=runtime/linux-arm64/kassinao-no-dump ;;
  *) die 'arquitetura do host não possui runtime no-dump selado' ;;
esac

REQUIRED_SOURCES=(
  scripts/uninstall-shared-host-controls.sh
  scripts/audit-shared-vps-security.sh
  scripts/health-watch.sh
  scripts/verify-shared-luks-storage.sh
  scripts/check-shared-migration-rollback.sh
  scripts/harden-docker-egress.sh
  scripts/egress-fail-closed.sh
  scripts/no-dump-exec.py
  "$no_dump_runtime_relative"
  deploy/systemd/kassinao-health-watch.service
  deploy/systemd/kassinao-health-watch.timer
  deploy/systemd/kassinao-docker-egress.service
  deploy/systemd/kassinao-egress-fail-closed.service
  deploy/systemd/kassinao-rollback-clean.service.in
  deploy/systemd/kassinao-rollback-clean.timer
  deploy/tmpfiles.d/kassinao.conf
  deploy/tmpfiles.d/kassinao-rollback.conf.in
)
for relative in "${REQUIRED_SOURCES[@]}"; do
  source="$ROOT/$relative"
  manifest_has "$relative" || die "source não está exatamente uma vez no manifesto: $relative"
  [ -f "$source" ] && [ ! -L "$source" ] || die "source ausente ou symlink: $relative"
  metadata="$(stat -c '%a:%u:%g' "$source" 2>/dev/null || true)"
  mode="${metadata%%:*}"
  [ "${metadata#*:}" = 0:0 ] && [[ "$mode" =~ ^[0-7]+$ ]] && (( (8#$mode & 022) == 0 )) ||
    die "source inseguro: $relative"
done
SHARED_AUDITOR="$ROOT/scripts/audit-shared-vps-security.sh"
NO_DUMP_INSTALL_DIR=/usr/local/libexec/kassinao
NO_DUMP_INSTALLED="$NO_DUMP_INSTALL_DIR/kassinao-no-dump"

ENV_FILE="$ROOT/.env"
[ -f "$ENV_FILE" ] && [ ! -L "$ENV_FILE" ] &&
  [ "$(stat -c '%a:%u:%g' "$ENV_FILE" 2>/dev/null || true)" = 600:0:0 ] ||
  die '.env privado precisa ser arquivo 0600 root:root sem symlink'

env_value() {
  local key="$1" file="$2"
  awk -v key="$key" '
    index($0, key "=") == 1 { count++; value = substr($0, length(key) + 2) }
    END { if (count != 1) exit 2; print value }
  ' "$file" || die "$key precisa aparecer exatamente uma vez em $file"
}

file_matches_exact() {
  local file="$1" expected="$2" actual
  actual="$(cat -- "$file"; printf '\037')"
  [ "$actual" = "${expected}"$'\n\037' ]
}

[ "$(env_value KASSINAO_HOST_SCOPE "$ENV_FILE")" = shared ] ||
  die 'o kit precisa declarar KASSINAO_HOST_SCOPE=shared'
[ -z "$(env_value KASSINAO_DEDICATED_DOCKER_HOST_ACK "$ENV_FILE")" ] ||
  die 'adapter shared exige KASSINAO_DEDICATED_DOCKER_HOST_ACK vazio'
data_root="$(env_value KASSINAO_DATA_ROOT "$ENV_FILE")"
backing_file="$(env_value KASSINAO_SHARED_LUKS_BACKING_FILE "$ENV_FILE")"
retention_hours="$(env_value KASSINAO_ROLLBACK_RETENTION_HOURS "$ENV_FILE")"
profiles="$(env_value COMPOSE_PROFILES "$ENV_FILE")"
[[ "$data_root" =~ ^/[A-Za-z0-9._/-]+$ ]] || die 'KASSINAO_DATA_ROOT inválido'
case "$data_root" in
  / | /var | /var/lib | *//* | */./* | */../* | */. | */.. | */) die 'KASSINAO_DATA_ROOT não é canônico/dedicado' ;;
esac
[[ "$backing_file" =~ ^/[A-Za-z0-9._/-]+$ ]] || die 'backing file LUKS inválido'
case "$backing_file" in *//* | */./* | */../* | */. | */.. | */) die 'backing file LUKS não é canônico' ;; esac
[[ "$retention_hours" =~ ^[1-9][0-9]*$ ]] && [ "$retention_hours" -le 168 ] ||
  die 'retenção de rollback fora da faixa 1..168h'
case "$profiles" in split-public | tunnel,split-public) ;; *) die 'COMPOSE_PROFILES shared inválido' ;; esac
cleanup_age="$((retention_hours * 60 - 31))min"

SHARED_ENV_KEYS=(
  KASSINAO_DATA_ROOT
  KASSINAO_RECORDINGS_DIR
  KASSINAO_STATE_DIR
  KASSINAO_AUTH_DIR
  KASSINAO_MODEL_CACHE_DIR
  KASSINAO_UID
  KASSINAO_GID
  KASSINAO_SHARED_LUKS_BACKING_FILE
  KASSINAO_SHARED_LUKS_MAPPER
  KASSINAO_SHARED_LUKS_UUID
  KASSINAO_SHARED_APP_ENV_FILE
  KASSINAO_SHARED_TUNNEL_TOKEN_FILE
)
expected_shared_env=''
for key in "${SHARED_ENV_KEYS[@]}"; do
  line="$key=$(env_value "$key" "$ENV_FILE")"
  expected_shared_env+="${expected_shared_env:+$'\n'}$line"
done
expected_marker="$(printf 'KASSINAO_HOST_SCOPE=shared\nKASSINAO_DEPLOY_DIR=%s\nKASSINAO_DATA_ROOT=%s\nKASSINAO_ROLLBACK_RETENTION_HOURS=%s' \
  "$ROOT" "$data_root" "$retention_hours")"

ETC_KASSINAO=/etc/kassinao
for directory in /usr/local/sbin /etc/systemd/system /etc/tmpfiles.d; do
  [ -d "$directory" ] && [ ! -L "$directory" ] || die "diretório de controles ausente ou symlink: $directory"
  directory_metadata="$(stat -c '%a:%u:%g' "$directory" 2>/dev/null || true)"
  directory_mode="${directory_metadata%%:*}"
  [ "${directory_metadata#*:}" = 0:0 ] && [[ "$directory_mode" =~ ^[0-7]+$ ]] &&
    (( (8#$directory_mode & 022) == 0 )) || die "diretório de controles inseguro: $directory"
done
[ -d "$NO_DUMP_INSTALL_DIR" ] && [ ! -L "$NO_DUMP_INSTALL_DIR" ] &&
  [ "$(stat -c '%a:%u:%g' "$NO_DUMP_INSTALL_DIR" 2>/dev/null || true)" = 755:0:0 ] ||
  die 'diretório do launcher no-dump instalado está ausente ou inseguro'
mapfile -t no_dump_entries < <(find "$NO_DUMP_INSTALL_DIR" -mindepth 1 -maxdepth 1 -printf '%f\n' | sort)
[ "${#no_dump_entries[@]}" -eq 1 ] && [ "${no_dump_entries[0]}" = kassinao-no-dump ] ||
  die 'diretório do launcher no-dump contém entradas estranhas'
[ -f "$NO_DUMP_INSTALLED" ] && [ ! -L "$NO_DUMP_INSTALLED" ] &&
  [ "$(stat -c '%a:%u:%g:%h' "$NO_DUMP_INSTALLED" 2>/dev/null || true)" = 555:0:0:1 ] &&
  cmp -s "$ROOT/$no_dump_runtime_relative" "$NO_DUMP_INSTALLED" ||
  die 'launcher no-dump instalado diverge da release'
[ -d "$ETC_KASSINAO" ] && [ ! -L "$ETC_KASSINAO" ] || die '/etc/kassinao ausente ou symlink'
etc_metadata="$(stat -c '%a:%u:%g' "$ETC_KASSINAO" 2>/dev/null || true)"
etc_mode="${etc_metadata%%:*}"
[ "${etc_metadata#*:}" = 0:0 ] && [[ "$etc_mode" =~ ^[0-7]+$ ]] && (( (8#$etc_mode & 022) == 0 )) ||
  die '/etc/kassinao está inseguro'
mapfile -t etc_entries < <(find "$ETC_KASSINAO" -mindepth 1 -maxdepth 1 -printf '%f\n' | sort)
[ "${#etc_entries[@]}" -eq 2 ] && [ "${etc_entries[0]}" = host-controls.env ] &&
  [ "${etc_entries[1]}" = shared.env ] || die '/etc/kassinao contém artefatos fora do adapter shared'
for file in "$ETC_KASSINAO/host-controls.env" "$ETC_KASSINAO/shared.env"; do
  [ -f "$file" ] && [ ! -L "$file" ] && [ "$(stat -c '%a:%u:%g' "$file" 2>/dev/null || true)" = 600:0:0 ] ||
    die "configuração shared ausente, symlink ou insegura: $file"
done
file_matches_exact "$ETC_KASSINAO/host-controls.env" "$expected_marker" ||
  die 'marker shared possui chaves extras, formato ou release divergente'
[ "$(env_value KASSINAO_HOST_SCOPE "$ETC_KASSINAO/host-controls.env")" = shared ] ||
  die 'marker não pertence ao adapter shared'
file_matches_exact "$ETC_KASSINAO/shared.env" "$expected_shared_env" ||
  die 'shared.env diverge da allowlist exata desta release/storage'

SCRIPTS=(
  health-watch:scripts/health-watch.sh
  verify-shared-luks-storage:scripts/verify-shared-luks-storage.sh
  check-shared-migration-rollback:scripts/check-shared-migration-rollback.sh
  harden-docker-egress:scripts/harden-docker-egress.sh
  egress-fail-closed:scripts/egress-fail-closed.sh
)
for pair in "${SCRIPTS[@]}"; do
  name="${pair%%:*}"
  relative="${pair#*:}"
  destination="/usr/local/sbin/kassinao-$name"
  [ -f "$destination" ] && [ ! -L "$destination" ] &&
    [ "$(stat -c '%a:%u:%g' "$destination" 2>/dev/null || true)" = 755:0:0 ] &&
    cmp -s "$ROOT/$relative" "$destination" || die "script instalado ausente, divergente ou symlink: $destination"
done

UNITS=(
  kassinao-health-watch.service
  kassinao-health-watch.timer
  kassinao-docker-egress.service
  kassinao-egress-fail-closed.service
  kassinao-rollback-clean.service
  kassinao-rollback-clean.timer
)
for unit in "${UNITS[@]}"; do
  destination="/etc/systemd/system/$unit"
  [ -f "$destination" ] && [ ! -L "$destination" ] &&
    [ "$(stat -c '%a:%u:%g' "$destination" 2>/dev/null || true)" = 644:0:0 ] ||
    die "unit instalada ausente, insegura ou symlink: $unit"
  if [ "$unit" = kassinao-rollback-clean.service ]; then
    expected_unit="$(sed -e "s|@ROLLBACK_DIR@|$data_root/rollback|g" \
      -e "s|@RETENTION_HOURS@|$retention_hours|g" \
      -e "s|@CLEANUP_AGE@|$cleanup_age|g" "$ROOT/deploy/systemd/kassinao-rollback-clean.service.in")"
    file_matches_exact "$destination" "$expected_unit" || die 'unit de rollback instalada divergiu'
  elif [ "$unit" = kassinao-docker-egress.service ]; then
    expected_unit="$(sed \
      's|^ExecStart=/usr/local/sbin/kassinao-harden-docker-egress$|ExecStart=/usr/local/sbin/kassinao-harden-docker-egress --shared-host|' \
      "$ROOT/deploy/systemd/kassinao-docker-egress.service")"
    grep -Fqx 'ExecStart=/usr/local/sbin/kassinao-harden-docker-egress --shared-host' <<<"$expected_unit" ||
      die 'unit de egress esperada não recebeu o modo shared isolado'
    file_matches_exact "$destination" "$expected_unit" || die 'unit shared de egress instalada divergiu'
  else
    cmp -s "$ROOT/deploy/systemd/$unit" "$destination" || die "unit instalada divergiu: $unit"
  fi
done

HEALTH_DROPIN_DIR=/etc/systemd/system/kassinao-health-watch.service.d
HEALTH_DROPIN="$HEALTH_DROPIN_DIR/10-shared-host.conf"
[ -d "$HEALTH_DROPIN_DIR" ] && [ ! -L "$HEALTH_DROPIN_DIR" ] &&
  [ "$(stat -c '%a:%u:%g' "$HEALTH_DROPIN_DIR" 2>/dev/null || true)" = 755:0:0 ] ||
  die 'diretório do drop-in shared ausente, inseguro ou symlink'
mapfile -t dropin_entries < <(find "$HEALTH_DROPIN_DIR" -mindepth 1 -maxdepth 1 -printf '%f\n' | sort)
[ "${#dropin_entries[@]}" -eq 1 ] && [ "${dropin_entries[0]}" = 10-shared-host.conf ] ||
  die 'health-watch possui drop-in fora do adapter shared'
[ -f "$HEALTH_DROPIN" ] && [ ! -L "$HEALTH_DROPIN" ] &&
  [ "$(stat -c '%a:%u:%g' "$HEALTH_DROPIN" 2>/dev/null || true)" = 644:0:0 ] ||
  die 'drop-in shared ausente, inseguro ou symlink'
expected_health_dropin="$(printf '%s\n' \
  '[Service]' \
  'ExecStartPre=/usr/local/sbin/kassinao-check-shared-migration-rollback' \
  'PrivateDevices=false' \
  'CapabilityBoundingSet=CAP_SYS_ADMIN CAP_NET_ADMIN CAP_NET_RAW' \
  "ReadOnlyPaths=/etc/kassinao/shared.env $ENV_FILE $SHARED_AUDITOR $data_root $backing_file")"
[ "$(grep -c '^Environment=' <<<"$expected_health_dropin" || true)" -eq 0 ] ||
  die 'drop-in shared não pode conter configuração derivada no ambiente privilegiado do health-watch'
file_matches_exact "$HEALTH_DROPIN" "$expected_health_dropin" || die 'drop-in shared divergiu'
for unit in "${UNITS[@]}"; do
  [ "$unit" = kassinao-health-watch.service ] && continue
  [ ! -e "/etc/systemd/system/$unit.d" ] && [ ! -L "/etc/systemd/system/$unit.d" ] ||
    die "drop-in não auditado para $unit"
done

TMPFILES=/etc/tmpfiles.d/kassinao.conf
ROLLBACK_TMPFILES=/etc/tmpfiles.d/kassinao-rollback.conf
for file in "$TMPFILES" "$ROLLBACK_TMPFILES"; do
  [ -f "$file" ] && [ ! -L "$file" ] && [ "$(stat -c '%a:%u:%g' "$file" 2>/dev/null || true)" = 644:0:0 ] ||
    die "tmpfiles instalado ausente, inseguro ou symlink: $file"
done
cmp -s "$ROOT/deploy/tmpfiles.d/kassinao.conf" "$TMPFILES" || die 'tmpfiles do runtime divergiu'
expected_rollback_tmpfiles="$(sed -e "s|@ROLLBACK_DIR@|$data_root/rollback|g" \
  -e "s|@CLEANUP_AGE@|$cleanup_age|g" "$ROOT/deploy/tmpfiles.d/kassinao-rollback.conf.in")"
file_matches_exact "$ROLLBACK_TMPFILES" "$expected_rollback_tmpfiles" || die 'tmpfiles de rollback divergiu'

RUNTIME_DIR=/run/lock/kassinao
[ -d "$RUNTIME_DIR" ] && [ ! -L "$RUNTIME_DIR" ] &&
  [ "$(stat -c '%a:%u:%g' "$RUNTIME_DIR" 2>/dev/null || true)" = 700:0:0 ] ||
  die 'runtime de locks shared ausente, inseguro ou symlink'
mapfile -t runtime_entries < <(find "$RUNTIME_DIR" -mindepth 1 -maxdepth 1 -printf '%f\n' | sort)
for entry in "${runtime_entries[@]}"; do
  case "$entry" in backup.lock | backup-retention.lock | docker-egress.lock | maintenance.lock) ;; *) die "runtime contém artefato desconhecido: $entry" ;; esac
  lock_file="$RUNTIME_DIR/$entry"
  [ -f "$lock_file" ] && [ ! -L "$lock_file" ] &&
    [ "$(stat -c '%a:%u:%g' "$lock_file" 2>/dev/null || true)" = 600:0:0 ] || die "lock irregular: $lock_file"
done
[ -f "$RUNTIME_DIR/maintenance.lock" ] && [ ! -L "$RUNTIME_DIR/maintenance.lock" ] ||
  die 'maintenance.lock shared ausente ou symlink'
exec 9<>"$RUNTIME_DIR/maintenance.lock"
flock -w 120 9 || die 'deploy, backup ou watchdog não liberou a instância em 120 segundos'

rollback_dir="$data_root/rollback"
[ -d "$rollback_dir" ] && [ ! -L "$rollback_dir" ] &&
  [ "$(stat -c '%a:%u:%g' "$rollback_dir" 2>/dev/null || true)" = 700:0:0 ] ||
  die 'diretório de rollback shared ausente, inseguro ou symlink'
if find "$rollback_dir" -mindepth 1 -print -quit | grep -q .; then
  die 'ainda há snapshot de rollback pendente; o uninstall nunca apaga snapshots'
fi

env -i "PATH=$PATH" "HOME=${HOME:-/root}" "KASSINAO_ENV_FILE=$ETC_KASSINAO/shared.env" \
  /usr/local/sbin/kassinao-check-shared-migration-rollback >/dev/null ||
  die 'estado do rollback plaintext inválido ou expirado; remoção recusada antes de qualquer mutação'
pending_marker="$data_root/.kassinao-plaintext-rollback.pending"
if [ -e "$pending_marker" ] || [ -L "$pending_marker" ]; then
  die 'rollback plaintext ainda está pending; finalize antes de remover os controles shared'
fi

docker_main_pid_before="$(systemctl show docker.service -p MainPID --value 2>/dev/null || true)"
[[ "$docker_main_pid_before" =~ ^[1-9][0-9]*$ ]] || die 'docker.service precisa estar ativo'
systemctl is-active --quiet docker.service || die 'docker.service precisa estar active'
docker info >/dev/null 2>&1 || die 'daemon Docker local indisponível'
containers="$(docker ps -a --format '{{.Names}}')" || die 'não foi possível enumerar containers'
for pair in \
  kassinao:kassinao \
  kassinao-router:kassinao-router \
  kassinao-public:kassinao-public \
  kassinao-tunnel:cloudflared; do
  container="${pair%%:*}"
  service="${pair#*:}"
  grep -Fqx "$container" <<<"$containers" || continue
  [ "$(docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null || true)" = false ] ||
    die "$container precisa estar parado; o uninstall nunca para containers"
  [ "$(docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' "$container" 2>/dev/null || true)" = no ] ||
    die "$container precisa usar restart=no antes do uninstall"
  [ "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$container" 2>/dev/null || true)" = kassinao ] &&
    [ "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$container" 2>/dev/null || true)" = "$service" ] ||
    die "$container não pertence ao projeto/serviço shared esperado"
done

# Prova que a policy é exatamente a instalada antes de desativar qualquer unit.
env -i "PATH=$PATH" "HOME=${HOME:-/root}" /usr/local/sbin/kassinao-harden-docker-egress --shared-host --check ||
  die 'policy Kassinão divergiu; remoção automática recusada antes de qualquer mutação'

env -i "PATH=$PATH" "HOME=${HOME:-/root}" "KASSINAO_ENV_FILE=$ENV_FILE" \
  "$SHARED_AUDITOR" --uninstall-preflight ||
  die 'preflight de uninstall recusou firewall, topologia ou workload vizinho antes de qualquer mutação'

# A partir daqui começam as mutações, após todos os gates fail-closed.
systemctl disable --now kassinao-health-watch.timer kassinao-docker-egress.service kassinao-rollback-clean.timer >/dev/null
systemctl stop kassinao-health-watch.service kassinao-egress-fail-closed.service kassinao-rollback-clean.service >/dev/null
for unit in "${UNITS[@]}"; do
  systemctl is-active --quiet "$unit" && die "$unit continuou ativo após stop"
done
for unit in kassinao-health-watch.timer kassinao-docker-egress.service kassinao-rollback-clean.timer; do
  systemctl is-enabled --quiet "$unit" && die "$unit continuou enabled"
done

env -i "PATH=$PATH" "HOME=${HOME:-/root}" /usr/local/sbin/kassinao-harden-docker-egress --shared-host --remove
for tool in iptables ip6tables; do
  ! "$tool" -S 2>/dev/null | grep -Fq 'KASSINAO-' || die "policy Kassinão permaneceu em $tool"
done

rm -f -- "$HEALTH_DROPIN"
rmdir -- "$HEALTH_DROPIN_DIR"
for unit in "${UNITS[@]}"; do rm -f -- "/etc/systemd/system/$unit"; done
rm -f -- "$TMPFILES" "$ROLLBACK_TMPFILES"
for pair in "${SCRIPTS[@]}"; do
  name="${pair%%:*}"
  rm -f -- "/usr/local/sbin/kassinao-$name"
done
rm -f -- "$NO_DUMP_INSTALLED"
rmdir -- "$NO_DUMP_INSTALL_DIR"
rm -f -- "$ETC_KASSINAO/shared.env" "$ETC_KASSINAO/host-controls.env"
rmdir -- "$ETC_KASSINAO"
for lock in backup.lock backup-retention.lock docker-egress.lock; do rm -f -- "$RUNTIME_DIR/$lock"; done
chmod 0600 "$RUNTIME_DIR/maintenance.lock"
[ -f "$RUNTIME_DIR/maintenance.lock" ] && [ ! -L "$RUNTIME_DIR/maintenance.lock" ] &&
  [ "$(stat -c '%a:%u:%g' "$RUNTIME_DIR/maintenance.lock" 2>/dev/null || true)" = 600:0:0 ] ||
  die 'tombstone maintenance.lock ficou ausente ou inseguro'
mapfile -t tombstone_entries < <(find "$RUNTIME_DIR" -mindepth 1 -maxdepth 1 -printf '%f\n' | sort)
[ "${#tombstone_entries[@]}" -eq 1 ] && [ "${tombstone_entries[0]}" = maintenance.lock ] ||
  die 'runtime tombstone contém artefato inesperado'

systemctl daemon-reload
systemctl reset-failed "${UNITS[@]}" 2>/dev/null || true

for removed in \
  "$HEALTH_DROPIN_DIR" "$TMPFILES" "$ROLLBACK_TMPFILES" \
  "$ETC_KASSINAO/shared.env" "$ETC_KASSINAO/host-controls.env" \
  /usr/local/sbin/kassinao-health-watch \
  /usr/local/sbin/kassinao-verify-shared-luks-storage \
  /usr/local/sbin/kassinao-check-shared-migration-rollback \
  /usr/local/sbin/kassinao-harden-docker-egress \
  /usr/local/sbin/kassinao-egress-fail-closed; do
  [ ! -e "$removed" ] && [ ! -L "$removed" ] || die "artefato shared permaneceu: $removed"
done
[ ! -e "$NO_DUMP_INSTALL_DIR" ] && [ ! -L "$NO_DUMP_INSTALL_DIR" ] ||
  die 'launcher no-dump instalado permaneceu após uninstall'
for unit in "${UNITS[@]}"; do
  [ ! -e "/etc/systemd/system/$unit" ] && [ ! -L "/etc/systemd/system/$unit" ] ||
    die "unit shared permaneceu: $unit"
done
docker_main_pid_after="$(systemctl show docker.service -p MainPID --value 2>/dev/null || true)"
[ "$docker_main_pid_after" = "$docker_main_pid_before" ] || die 'docker.service reiniciou durante o uninstall shared'
systemctl is-active --quiet docker.service || die 'docker.service deixou de estar active'

printf 'Controles shared-host removidos sem reiniciar Docker ou apagar release, storage e segredos.\n'
