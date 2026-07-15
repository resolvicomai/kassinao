#!/bin/bash -p
# Instala somente controles escopados ao Kassinão em um daemon Docker
# compartilhado. Não altera o lifecycle/configuração do docker.service, SSH,
# firewall de entrada ou outros workloads do host.
set -Eeuo pipefail
umask 077

die() { printf 'ERRO: %s\n' "$*" >&2; exit 1; }
[ "$EUID" -eq 0 ] || die 'execute como root'

_saved_no_dump_marker="${KASSINAO_NO_DUMP_ACTIVE-}"
_saved_no_dump_preload="${LD_PRELOAD-}"
inherited_docker_environment_name=''
for _inherited_name in DOCKER_HOST DOCKER_CONTEXT DOCKER_CONFIG DOCKER_TLS_VERIFY DOCKER_CERT_PATH DOCKER_API_VERSION; do
  if declare -p "$_inherited_name" >/dev/null 2>&1; then inherited_docker_environment_name="$_inherited_name"; break; fi
done
[ -r "/proc/$$/environ" ] || die '/proc é obrigatório para limpar o ambiente do installer shared'
while IFS='=' read -r -d '' _inherited_name _inherited_value; do
  unset "$_inherited_name" 2>/dev/null || true
done < "/proc/$$/environ"
unset _inherited_name _inherited_value
SAFE_SYSTEM_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH="$SAFE_SYSTEM_PATH" HOME=/root LC_ALL=C

_script_path="${BASH_SOURCE[0]}"
case "$_script_path" in /*) ;; ./*) _script_path="$PWD/${_script_path#./}" ;; *) _script_path="$PWD/$_script_path" ;; esac
case "$_script_path" in *//* | */./* | */../* | */. | */.. | */) die 'caminho do installer shared não é canônico' ;; esac
_script_dir="${_script_path%/*}"
case "$_script_dir" in */scripts) PROJECT_DIR="${_script_dir%/scripts}" ;; *) die 'installer shared precisa executar do kit selado' ;; esac
case "${MACHTYPE%%-*}" in x86_64) _no_dump_arch=amd64 ;; aarch64 | arm64) _no_dump_arch=arm64 ;; *) die 'arquitetura sem runtime no-dump' ;; esac
_no_dump_preload="$PROJECT_DIR/runtime/linux-$_no_dump_arch/libkassinao-no-dump.so"
# KASSINAO_HOST_NO_DUMP_BEGIN
if [ "$_saved_no_dump_marker" != "prctl-v1:$$" ] || [ "$_saved_no_dump_preload" != "$_no_dump_preload" ]; then
  exec /usr/bin/python3 "$PROJECT_DIR/scripts/no-dump-exec.py" \
    --bundle-root "$PROJECT_DIR" --script-relative scripts/install-shared-host-controls.sh --arch "$_no_dump_arch" -- \
    "$_script_path" "$@"
fi
LD_PRELOAD="$_no_dump_preload"
export LD_PRELOAD
[ "$(ulimit -Sc)" = 0 ] && [ "$(ulimit -Hc)" = 0 ] || die 'core limit do installer shared não ficou selado'
IFS= read -r _no_dump_filter < "/proc/$$/coredump_filter" || _no_dump_filter=''
[[ "$_no_dump_filter" =~ ^0+$ ]] || die 'coredump_filter do installer shared não ficou selado'
# KASSINAO_HOST_NO_DUMP_END
unset _saved_no_dump_marker _saved_no_dump_preload _no_dump_filter _no_dump_arch _no_dump_preload _script_path _script_dir

[ "$(id -u)" -eq 0 ] || die 'identidade root mudou durante o bootstrap'
for command in awk cat chmod chown cmp dirname docker env find flock grep id install mktemp mv rm sed sort stat systemctl systemd-tmpfiles; do
  command -v "$command" >/dev/null 2>&1 || die "$command não encontrado"
done
[ -n "$(command -v sha256sum 2>/dev/null || command -v shasum 2>/dev/null || true)" ] ||
  die 'sha256sum ou shasum é obrigatório'

systemd_version="$(systemctl --version 2>/dev/null | awk 'NR == 1 && $1 == "systemd" { print $2 }')"
[[ "$systemd_version" =~ ^[0-9]+$ ]] && [ "$systemd_version" -ge 249 ] ||
  die 'controles de retenção exigem systemd >= 249'

[ -z "$inherited_docker_environment_name" ] ||
  die "$inherited_docker_environment_name não pode vir do ambiente; o installer usa somente o daemon local da VPS"
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
case "${MACHTYPE%%-*}" in
  x86_64) no_dump_arch=linux-amd64 ;;
  aarch64 | arm64) no_dump_arch=linux-arm64 ;;
  *) die 'arquitetura do host não possui runtime no-dump selado' ;;
esac
NO_DUMP_RELATIVE="runtime/$no_dump_arch/kassinao-no-dump"
NO_DUMP_PRELOAD_RELATIVE="runtime/$no_dump_arch/libkassinao-no-dump.so"
NO_DUMP_SOURCE="$ROOT/$NO_DUMP_RELATIVE"
NO_DUMP_PRELOAD_SOURCE="$ROOT/$NO_DUMP_PRELOAD_RELATIVE"
NO_DUMP_INSTALL_DIR=/usr/local/libexec/kassinao
NO_DUMP_INSTALLED="$NO_DUMP_INSTALL_DIR/kassinao-no-dump"
case "$ROOT" in
  /home | /home/* | /root | /root/* | /run/user | /run/user/* | /tmp | /tmp/* | /var/tmp | /var/tmp/*)
    die 'release shared precisa ficar fora de home/root/tmp para as units protegidas'
    ;;
esac
cursor="$ROOT"
while :; do
  [ ! -e "$cursor/.git" ] || die "controles de produção exigem kit fora de Git: $cursor"
  metadata="$(stat -c '%a:%u:%g' "$cursor" 2>/dev/null || true)"
  mode="${metadata%%:*}"
  owner_group="${metadata#*:}"
  [ "$owner_group" = 0:0 ] && [[ "$mode" =~ ^[0-7]+$ ]] && (( (8#$mode & 022) == 0 )) ||
    die "release e pais precisam ser root-owned e não graváveis por terceiros: $cursor"
  parent="$(dirname -- "$cursor")"
  [ "$parent" != "$cursor" ] || break
  cursor="$parent"
done
case "$(stat -c '%a:%u:%g' "$ROOT" 2>/dev/null || true)" in
  700:0:0 | 500:0:0) ;;
  *) die 'diretório da release precisa ser 0700/0500 root:root' ;;
esac

for directory in "$ROOT/scripts" "$ROOT/deploy/systemd" "$ROOT/deploy/tmpfiles.d" /usr/local/sbin /etc/systemd/system; do
  [ -d "$directory" ] && [ ! -L "$directory" ] || die "diretório obrigatório ausente ou symlink: $directory"
done
for directory in /usr/local/sbin /etc/systemd/system; do
  metadata="$(stat -c '%a:%u:%g' "$directory" 2>/dev/null || true)"
  mode="${metadata%%:*}"
  [ "${metadata#*:}" = 0:0 ] && [[ "$mode" =~ ^[0-7]+$ ]] && (( (8#$mode & 022) == 0 )) ||
    die "diretório de controles precisa ser root-owned e não gravável por terceiros: $directory"
done
if [ -e /etc/tmpfiles.d ] || [ -L /etc/tmpfiles.d ]; then
  [ -d /etc/tmpfiles.d ] && [ ! -L /etc/tmpfiles.d ] || die '/etc/tmpfiles.d precisa ser diretório real'
  metadata="$(stat -c '%a:%u:%g' /etc/tmpfiles.d 2>/dev/null || true)"
  mode="${metadata%%:*}"
  [ "${metadata#*:}" = 0:0 ] && [[ "$mode" =~ ^[0-7]+$ ]] && (( (8#$mode & 022) == 0 )) ||
    die '/etc/tmpfiles.d precisa ser root-owned e não gravável por terceiros'
fi

MANIFEST="$ROOT/MANIFEST.sha256"
[ -f "$MANIFEST" ] && [ ! -L "$MANIFEST" ] || die 'MANIFEST.sha256 ausente ou irregular'
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

CONTROL_PATHS=(
  scripts/install-shared-host-controls.sh
  scripts/audit-shared-vps-security.sh
  scripts/health-watch.sh
  scripts/verify-shared-luks-storage.sh
  scripts/check-shared-migration-rollback.sh
  scripts/harden-docker-egress.sh
  scripts/egress-fail-closed.sh
  scripts/no-dump-exec.py
  "$NO_DUMP_RELATIVE"
  "$NO_DUMP_PRELOAD_RELATIVE"
  deploy/systemd/kassinao-health-watch.service
  deploy/systemd/kassinao-health-watch.timer
  deploy/systemd/kassinao-docker-egress.service
  deploy/systemd/kassinao-egress-fail-closed.service
  deploy/systemd/kassinao-rollback-clean.service.in
  deploy/systemd/kassinao-rollback-clean.timer
  deploy/tmpfiles.d/kassinao.conf
  deploy/tmpfiles.d/kassinao-rollback.conf.in
)
for relative in "${CONTROL_PATHS[@]}"; do
  source="$ROOT/$relative"
  manifest_has "$relative" || die "controle não está selado no manifesto: $relative"
  [ -f "$source" ] && [ ! -L "$source" ] || die "controle ausente ou symlink: $relative"
  metadata="$(stat -c '%a:%u:%g' "$source" 2>/dev/null || true)"
  mode="${metadata%%:*}"
  [ "${metadata#*:}" = 0:0 ] && [[ "$mode" =~ ^[0-7]+$ ]] && (( (8#$mode & 022) == 0 )) ||
    die "controle precisa ser root-owned e não gravável por terceiros: $relative"
done

ENV_FILE="$ROOT/.env"
[ -f "$ENV_FILE" ] && [ ! -L "$ENV_FILE" ] || die '.env privado ausente ou symlink'
[ "$(stat -c '%a:%u:%g' "$ENV_FILE" 2>/dev/null || true)" = 600:0:0 ] ||
  die '.env privado precisa ser 0600 root:root'

env_value() {
  local key="$1" file="${2:-$ENV_FILE}"
  awk -v key="$key" '
    index($0, key "=") == 1 { count++; value = substr($0, length(key) + 2) }
    END { if (count != 1) exit 2; print value }
  ' "$file" || die "$key precisa aparecer exatamente uma vez em $file"
}

[ "$(env_value KASSINAO_HOST_SCOPE)" = shared ] || die 'KASSINAO_HOST_SCOPE precisa ser shared'
[ -z "$(env_value KASSINAO_DEDICATED_DOCKER_HOST_ACK)" ] ||
  die 'KASSINAO_DEDICATED_DOCKER_HOST_ACK precisa permanecer vazio no host shared'

rollback_retention_hours="$(env_value KASSINAO_ROLLBACK_RETENTION_HOURS)"
[[ "$rollback_retention_hours" =~ ^[1-9][0-9]*$ ]] && [ "$rollback_retention_hours" -le 168 ] ||
  die 'KASSINAO_ROLLBACK_RETENTION_HOURS precisa ficar entre 1 e 168'
rollback_cleanup_age="$((rollback_retention_hours * 60 - 31))min"

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
declare -A SHARED_VALUES=()
for key in "${SHARED_ENV_KEYS[@]}"; do SHARED_VALUES["$key"]="$(env_value "$key")"; done
data_root="${SHARED_VALUES[KASSINAO_DATA_ROOT]}"
rollback_dir="$data_root/rollback"
recordings="${SHARED_VALUES[KASSINAO_RECORDINGS_DIR]}"
state="${SHARED_VALUES[KASSINAO_STATE_DIR]}"
auth="${SHARED_VALUES[KASSINAO_AUTH_DIR]}"
cache="${SHARED_VALUES[KASSINAO_MODEL_CACHE_DIR]}"
backing_file="${SHARED_VALUES[KASSINAO_SHARED_LUKS_BACKING_FILE]}"
app_env="${SHARED_VALUES[KASSINAO_SHARED_APP_ENV_FILE]}"
tunnel_token_file="${SHARED_VALUES[KASSINAO_SHARED_TUNNEL_TOKEN_FILE]}"

for definition in \
  "KASSINAO_DATA_ROOT:$data_root" \
  "KASSINAO_RECORDINGS_DIR:$recordings" \
  "KASSINAO_STATE_DIR:$state" \
  "KASSINAO_AUTH_DIR:$auth" \
  "KASSINAO_MODEL_CACHE_DIR:$cache" \
  "KASSINAO_SHARED_APP_ENV_FILE:$app_env" \
  "KASSINAO_SHARED_TUNNEL_TOKEN_FILE:$tunnel_token_file" \
  "KASSINAO_SHARED_LUKS_BACKING_FILE:$backing_file"; do
  key="${definition%%:*}"
  value="${definition#*:}"
  [[ "$value" =~ ^/[A-Za-z0-9._/-]+$ ]] || die "$key precisa ser caminho absoluto simples"
  case "$value" in *//* | */./* | */../* | */. | */.. | */) die "$key precisa ser canônico" ;; esac
done
case "$data_root" in
  /home | /home/* | /root | /root/* | /run/user | /run/user/* | /tmp | /tmp/* | /var/tmp | /var/tmp/*)
    die 'KASSINAO_DATA_ROOT precisa ficar acessível às units com ProtectHome/PrivateTmp'
    ;;
esac
case "$backing_file" in
  /home | /home/* | /root | /root/* | /run/user | /run/user/* | /tmp | /tmp/* | /var/tmp | /var/tmp/*)
    die 'backing file LUKS precisa ficar acessível ao verifier instalado'
    ;;
esac
[ "$recordings" = "$data_root/recordings" ] && [ "$state" = "$data_root/state" ] &&
  [ "$auth" = "$data_root/auth" ] && [ "$cache" = "$data_root/cache" ] &&
  [ "$app_env" = "$data_root/config/app.env" ] &&
  [ "$tunnel_token_file" = "$data_root/config/cloudflared-token" ] ||
  die 'mounts privados precisam ser filhos exatos de KASSINAO_DATA_ROOT'
profiles="$(env_value COMPOSE_PROFILES)"
case "$profiles" in
  split-public | tunnel,split-public) ;;
  *) die 'COMPOSE_PROFILES shared precisa ser split-public ou tunnel,split-public' ;;
esac

SHARED_VERIFIER_SOURCE="$ROOT/scripts/verify-shared-luks-storage.sh"
SHARED_ROLLBACK_CHECKER_SOURCE="$ROOT/scripts/check-shared-migration-rollback.sh"
SHARED_AUDIT_SOURCE="$ROOT/scripts/audit-shared-vps-security.sh"

# O adapter shared nunca pode coexistir com o pre-hook dedicado do daemon.
DEDICATED_DROPIN=/etc/systemd/system/docker.service.d/kassinao-egress.conf
for path in \
  "$DEDICATED_DROPIN" \
  /run/systemd/system/docker.service.d/kassinao-egress.conf \
  /usr/lib/systemd/system/docker.service.d/kassinao-egress.conf \
  /lib/systemd/system/docker.service.d/kassinao-egress.conf; do
  [ ! -e "$path" ] && [ ! -L "$path" ] ||
    die "controle dedicado antigo ainda existe; use remove-legacy-dedicated-host-controls.sh na migração v1.4.9 ou o uninstall dedicated moderno: $path"
done
for path in \
  /usr/local/sbin/kassinao-verify-storage-encryption \
  /etc/kassinao/storage-paths; do
  [ ! -e "$path" ] && [ ! -L "$path" ] ||
    die "artefato do adapter dedicated ainda existe; use remove-legacy-dedicated-host-controls.sh na migração v1.4.9 ou o uninstall dedicated moderno: $path"
done
docker_dropins="$(systemctl show docker.service -p DropInPaths --value 2>/dev/null || true)"
case "$docker_dropins" in
  *kassinao-egress.conf*) die 'docker.service ainda carrega o drop-in dedicado do Kassinão; conclua remove-legacy-dedicated-host-controls.sh ou o uninstall dedicated moderno' ;;
esac
docker_pre="$(systemctl show docker.service -p ExecStartPre --value 2>/dev/null || true)"
case "$docker_pre" in
  *kassinao-harden-docker-egress* | *kassinao-verify-storage-encryption* | *kassinao-verify-shared-luks-storage*)
    die 'docker.service ainda carrega pre-hook do Kassinão; conclua remove-legacy-dedicated-host-controls.sh ou o uninstall dedicated moderno'
    ;;
esac

docker_main_pid_before="$(systemctl show docker.service -p MainPID --value 2>/dev/null || true)"
[[ "$docker_main_pid_before" =~ ^[1-9][0-9]*$ ]] || die 'docker.service precisa estar ativo sem restart pelo installer'
systemctl is-active --quiet docker.service || die 'docker.service precisa estar active'
docker info >/dev/null 2>&1 || die 'daemon Docker local indisponível'

# Containers já existentes só podem ser uma instalação shared válida, incapaz
# de voltar sozinha enquanto storage/egress ainda não foram revalidados.
containers="$(docker ps -a --format '{{.Names}}')" || die 'não foi possível enumerar containers'
instance_present=false
for pair in kassinao:kassinao kassinao-public:kassinao-public kassinao-tunnel:cloudflared; do
  container="${pair%%:*}"
  service="${pair#*:}"
  grep -Fqx "$container" <<<"$containers" || continue
  instance_present=true
  restart_policy="$(docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' "$container" 2>/dev/null || true)"
  [ -z "$restart_policy" ] || [ "$restart_policy" = no ] ||
    die "$container precisa usar restart=no antes de instalar controles shared"
  project_label="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$container" 2>/dev/null || true)"
  service_label="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$container" 2>/dev/null || true)"
  [ "$project_label" = kassinao ] && [ "$service_label" = "$service" ] ||
    die "$container não pertence ao projeto/serviço Compose shared esperado"
done
if ! grep -Fqx kassinao <<<"$containers"; then
  for orphan in kassinao-public kassinao-tunnel; do
    ! grep -Fqx "$orphan" <<<"$containers" || die "$orphan existe sem o core kassinao"
  done
fi

RUNTIME_DIR=/run/lock/kassinao
maintenance_locked=false
validate_runtime_dir() {
  [ -d "$RUNTIME_DIR" ] && [ ! -L "$RUNTIME_DIR" ] &&
    [ "$(readlink -f -- "$RUNTIME_DIR" 2>/dev/null || true)" = "$RUNTIME_DIR" ] &&
    [ "$(stat -c '%a:%u:%g' "$RUNTIME_DIR" 2>/dev/null || true)" = 700:0:0 ] ||
    die 'runtime precisa ser diretório canônico 0700 root:root sem symlink'
}
lock_maintenance() {
  local lock_file="$RUNTIME_DIR/maintenance.lock"
  validate_runtime_dir
  [ -f "$lock_file" ] && [ ! -L "$lock_file" ] &&
    [ "$(readlink -f -- "$lock_file" 2>/dev/null || true)" = "$lock_file" ] &&
    [ "$(stat -c '%a:%u:%g:%h' "$lock_file" 2>/dev/null || true)" = 600:0:0:1 ] ||
    die 'maintenance.lock precisa preexistir como regular 0600 root:root sem hardlink'
  exec 9<>"$lock_file"
  [ "$(stat -Lc '%a:%u:%g:%h' "/proc/$$/fd/9" 2>/dev/null || true)" = 600:0:0:1 ] &&
    [ "$(readlink -f -- "/proc/$$/fd/9" 2>/dev/null || true)" = "$lock_file" ] &&
    [ "$(stat -c '%d:%i' "$lock_file" 2>/dev/null || true)" = "$(stat -Lc '%d:%i' "/proc/$$/fd/9" 2>/dev/null || true)" ] ||
    die 'maintenance.lock mudou durante a abertura'
  flock -w 120 9 || die 'outra manutenção não liberou a instância em 120 segundos'
  maintenance_locked=true
}
if [ -e "$RUNTIME_DIR" ] || [ -L "$RUNTIME_DIR" ]; then
  lock_maintenance
elif [ "$instance_present" = true ]; then
  die 'containers shared existentes exigem runtime /run/lock/kassinao já provisionado'
fi

expected_shared_env=''
for key in "${SHARED_ENV_KEYS[@]}"; do
  line="$key=${SHARED_VALUES[$key]}"
  expected_shared_env+="${expected_shared_env:+$'\n'}$line"
done
expected_host_controls="$(printf 'KASSINAO_HOST_SCOPE=shared\nKASSINAO_DEPLOY_DIR=%s\nKASSINAO_DATA_ROOT=%s\nKASSINAO_ROLLBACK_RETENTION_HOURS=%s' \
  "$ROOT" "$data_root" "$rollback_retention_hours")"
installed_deploy_dir="$ROOT"
installed_rollback_retention_hours="$rollback_retention_hours"
shared_marker_present=false

ETC_KASSINAO=/etc/kassinao
if [ -e "$ETC_KASSINAO" ] || [ -L "$ETC_KASSINAO" ]; then
  [ -d "$ETC_KASSINAO" ] && [ ! -L "$ETC_KASSINAO" ] || die '/etc/kassinao precisa ser diretório real'
  etc_metadata="$(stat -c '%a:%u:%g' "$ETC_KASSINAO" 2>/dev/null || true)"
  etc_mode="${etc_metadata%%:*}"
  [ "${etc_metadata#*:}" = 0:0 ] && (( (8#$etc_mode & 022) == 0 )) ||
    die '/etc/kassinao precisa ser root-owned e não gravável por terceiros'
fi
for existing in "$ETC_KASSINAO/shared.env" "$ETC_KASSINAO/host-controls.env"; do
  [ ! -L "$existing" ] || die "configuração instalada não pode ser symlink: $existing"
done
if [ -e "$ETC_KASSINAO/shared.env" ]; then
  [ -f "$ETC_KASSINAO/shared.env" ] &&
    [ "$(stat -c '%a:%u:%g' "$ETC_KASSINAO/shared.env" 2>/dev/null || true)" = 600:0:0 ] &&
    [ "$(cat "$ETC_KASSINAO/shared.env")" = "$expected_shared_env" ] ||
    die 'shared.env existente pertence a outro storage/escopo ou está inseguro'
fi
if [ -e "$ETC_KASSINAO/host-controls.env" ]; then
  shared_marker_present=true
  [ -f "$ETC_KASSINAO/host-controls.env" ] &&
    [ "$(stat -c '%a:%u:%g' "$ETC_KASSINAO/host-controls.env" 2>/dev/null || true)" = 600:0:0 ] ||
    die 'marker de controles instalado está inseguro'
  [ "$(env_value KASSINAO_HOST_SCOPE "$ETC_KASSINAO/host-controls.env")" = shared ] ||
    die 'controles dedicados antigos ainda estão instalados; use remove-legacy-dedicated-host-controls.sh para o legado v1.4.9'
  installed_deploy_dir="$(env_value KASSINAO_DEPLOY_DIR "$ETC_KASSINAO/host-controls.env")"
  installed_data_root="$(env_value KASSINAO_DATA_ROOT "$ETC_KASSINAO/host-controls.env")"
  installed_rollback_retention_hours="$(env_value KASSINAO_ROLLBACK_RETENTION_HOURS "$ETC_KASSINAO/host-controls.env")"
  [[ "$installed_deploy_dir" =~ ^/[A-Za-z0-9._/-]+$ ]] || die 'marker shared possui deploy dir inválido'
  case "$installed_deploy_dir" in
    *//* | */./* | */../* | */. | */.. | */ | /home | /home/* | /root | /root/* | /run/user | /run/user/* | /tmp | /tmp/* | /var/tmp | /var/tmp/*)
      die 'marker shared possui deploy dir não canônico ou incompatível com as units'
      ;;
  esac
  [ "$installed_data_root" = "$data_root" ] || die 'marker shared pertence a outro storage'
  [[ "$installed_rollback_retention_hours" =~ ^[1-9][0-9]*$ ]] &&
    [ "$installed_rollback_retention_hours" -le 168 ] ||
    die 'marker shared possui retenção inválida'
  expected_installed_host_controls="$(printf 'KASSINAO_HOST_SCOPE=shared\nKASSINAO_DEPLOY_DIR=%s\nKASSINAO_DATA_ROOT=%s\nKASSINAO_ROLLBACK_RETENTION_HOURS=%s' \
    "$installed_deploy_dir" "$data_root" "$installed_rollback_retention_hours")"
  [ "$(cat "$ETC_KASSINAO/host-controls.env")" = "$expected_installed_host_controls" ] ||
    die 'marker shared possui chaves extras ou formato divergente'
fi

# O verifier shared prova mount, mapper/UUID, sentinel e ownership dos filhos.
# Ele roda antes da primeira escrita em /etc, /usr/local ou systemd e, numa
# reinstalação, sob o mesmo maintenance lock usado por deploy/backup/watchdog.
env -i "PATH=$PATH" "HOME=${HOME:-/root}" "KASSINAO_ENV_FILE=$ENV_FILE" "$SHARED_VERIFIER_SOURCE"
env -i "PATH=$PATH" "HOME=${HOME:-/root}" "KASSINAO_ENV_FILE=$ENV_FILE" "$SHARED_ROLLBACK_CHECKER_SOURCE" >/dev/null ||
  die 'estado do rollback plaintext inválido ou expirado; nenhum controle foi alterado'

UNIT_NAMES=(
  kassinao-health-watch.service
  kassinao-health-watch.timer
  kassinao-docker-egress.service
  kassinao-egress-fail-closed.service
  kassinao-rollback-clean.service
  kassinao-rollback-clean.timer
)
HEALTH_DROPIN_DIR=/etc/systemd/system/kassinao-health-watch.service.d
HEALTH_DROPIN="$HEALTH_DROPIN_DIR/10-shared-host.conf"
expected_health_dropin="$(printf '%s\n' \
  '[Service]' \
  'ExecStartPre=/usr/local/sbin/kassinao-check-shared-migration-rollback' \
  'PrivateDevices=false' \
  'CapabilityBoundingSet=CAP_SYS_ADMIN CAP_NET_ADMIN CAP_NET_RAW' \
  "ReadOnlyPaths=/etc/kassinao/shared.env $ENV_FILE $SHARED_AUDIT_SOURCE $data_root $backing_file")"
[ "$(grep -c '^Environment=' <<<"$expected_health_dropin" || true)" -eq 0 ] ||
  die 'drop-in shared não pode injetar configuração derivada no ambiente privilegiado do health-watch'
installed_env_file="$installed_deploy_dir/.env"
expected_installed_health_dropin="$(printf '%s\n' \
  '[Service]' \
  'Environment=KASSINAO_STORAGE_VERIFIER=/usr/local/sbin/kassinao-verify-shared-luks-storage' \
  "Environment=KASSINAO_ENV_FILE=$installed_env_file" \
  'PrivateDevices=false' \
  'CapabilityBoundingSet=CAP_SYS_ADMIN CAP_NET_ADMIN CAP_NET_RAW' \
  "ReadOnlyPaths=$installed_env_file /etc/kassinao/shared.env $data_root $backing_file")"
# Compatibilidade de upgrade somente com a primeira revisão conhecida do
# adapter shared, que ainda não concedia CAP_SYS_ADMIN ao verifier read-only.
expected_legacy_health_dropin="$(printf '%s\n' \
  '[Service]' \
  'Environment=KASSINAO_STORAGE_VERIFIER=/usr/local/sbin/kassinao-verify-shared-luks-storage' \
  "Environment=KASSINAO_ENV_FILE=$installed_env_file" \
  'PrivateDevices=false' \
  "ReadOnlyPaths=$installed_env_file /etc/kassinao/shared.env $data_root $backing_file")"
expected_previous_shared_dropin_split="$(printf '%s\n' \
  '[Service]' \
  'Environment=KASSINAO_STORAGE_VERIFIER=/usr/local/sbin/kassinao-verify-shared-luks-storage' \
  'Environment=KASSINAO_ENV_FILE=/etc/kassinao/shared.env' \
  'Environment=COMPOSE_PROFILES=split-public' \
  'PrivateDevices=false' \
  'CapabilityBoundingSet=CAP_SYS_ADMIN CAP_NET_ADMIN CAP_NET_RAW' \
  "ReadOnlyPaths=/etc/kassinao/shared.env $data_root $backing_file")"
expected_previous_shared_dropin_tunnel="$(printf '%s\n' \
  '[Service]' \
  'Environment=KASSINAO_STORAGE_VERIFIER=/usr/local/sbin/kassinao-verify-shared-luks-storage' \
  'Environment=KASSINAO_ENV_FILE=/etc/kassinao/shared.env' \
  'Environment=COMPOSE_PROFILES=tunnel,split-public' \
  'PrivateDevices=false' \
  'CapabilityBoundingSet=CAP_SYS_ADMIN CAP_NET_ADMIN CAP_NET_RAW' \
  "ReadOnlyPaths=/etc/kassinao/shared.env $data_root $backing_file")"
HEALTH_UNIT_SOURCE="$ROOT/deploy/systemd/kassinao-health-watch.service"
EGRESS_UNIT_SOURCE="$ROOT/deploy/systemd/kassinao-docker-egress.service"
expected_shared_egress_unit="$(sed \
  's|^ExecStart=/usr/local/sbin/kassinao-harden-docker-egress$|ExecStart=/usr/local/sbin/kassinao-harden-docker-egress --shared-host|' \
  "$EGRESS_UNIT_SOURCE")"
grep -Fqx 'ExecStart=/usr/local/sbin/kassinao-harden-docker-egress --shared-host' <<<"$expected_shared_egress_unit" ||
  die 'unit shared de egress não recebeu o modo isolado'
grep -Fqx 'ProtectSystem=strict' "$HEALTH_UNIT_SOURCE" || die 'health-watch precisa manter ProtectSystem=strict'
grep -Fqx 'ReadWritePaths=/run/lock/kassinao' "$HEALTH_UNIT_SOURCE" ||
  die 'health-watch só pode escrever no runtime escopado'

# Nunca transforme um arquivo homônimo preexistente em "nosso" por simples
# overwrite. Em upgrade, a proveniência vem do marker shared e da release
# anterior ainda selada; numa instalação nova, todos os destinos precisam
# estar ausentes. Isso também impede misturar controles legacy/dedicated.
if [ "$shared_marker_present" = true ]; then
  [ -d "$installed_deploy_dir" ] && [ ! -L "$installed_deploy_dir" ] ||
    die 'release registrada pelos controles shared está ausente ou é symlink'
  case "$(stat -c '%a:%u:%g' "$installed_deploy_dir" 2>/dev/null || true)" in
    700:0:0 | 500:0:0) ;;
    *) die 'release registrada pelos controles shared está insegura' ;;
  esac
  [ ! -e "$installed_deploy_dir/.git" ] || die 'release registrada não pode ser checkout Git'
  installed_manifest="$installed_deploy_dir/MANIFEST.sha256"
  [ -f "$installed_manifest" ] && [ ! -L "$installed_manifest" ] ||
    die 'release registrada não possui MANIFEST.sha256 regular'
  if command -v sha256sum >/dev/null 2>&1; then
    (cd -- "$installed_deploy_dir" && sha256sum -c MANIFEST.sha256 --quiet) ||
      die 'release registrada diverge do próprio manifesto'
  else
    (cd -- "$installed_deploy_dir" && shasum -a 256 -c MANIFEST.sha256 >/dev/null) ||
      die 'release registrada diverge do próprio manifesto'
  fi
fi

assert_existing_control_source() {
  local destination="$1" relative="$2" source
  [ ! -e "$destination" ] && [ ! -L "$destination" ] && return 0
  [ "$shared_marker_present" = true ] ||
    die "controle homônimo sem marker shared recusado: $destination"
  [ -f "$destination" ] && [ ! -L "$destination" ] ||
    die "controle instalado irregular: $destination"
  source="$installed_deploy_dir/$relative"
  [ -f "$source" ] && [ ! -L "$source" ] && cmp -s "$source" "$destination" ||
    die "controle instalado não pertence à release shared registrada: $destination"
}

assert_existing_control_content() {
  local destination="$1" expected="$2"
  [ ! -e "$destination" ] && [ ! -L "$destination" ] && return 0
  [ "$shared_marker_present" = true ] ||
    die "controle homônimo sem marker shared recusado: $destination"
  [ -f "$destination" ] && [ ! -L "$destination" ] && [ "$(cat "$destination")" = "$expected" ] ||
    die "controle gerado não pertence à release shared registrada: $destination"
}

for mapping in \
  "$NO_DUMP_INSTALLED:$NO_DUMP_RELATIVE" \
  '/usr/local/sbin/kassinao-health-watch:scripts/health-watch.sh' \
  '/usr/local/sbin/kassinao-verify-shared-luks-storage:scripts/verify-shared-luks-storage.sh' \
  '/usr/local/sbin/kassinao-check-shared-migration-rollback:scripts/check-shared-migration-rollback.sh' \
  '/usr/local/sbin/kassinao-harden-docker-egress:scripts/harden-docker-egress.sh' \
  '/usr/local/sbin/kassinao-egress-fail-closed:scripts/egress-fail-closed.sh' \
  '/etc/systemd/system/kassinao-health-watch.service:deploy/systemd/kassinao-health-watch.service' \
  '/etc/systemd/system/kassinao-health-watch.timer:deploy/systemd/kassinao-health-watch.timer' \
  '/etc/systemd/system/kassinao-egress-fail-closed.service:deploy/systemd/kassinao-egress-fail-closed.service' \
  '/etc/systemd/system/kassinao-rollback-clean.timer:deploy/systemd/kassinao-rollback-clean.timer' \
  '/etc/tmpfiles.d/kassinao.conf:deploy/tmpfiles.d/kassinao.conf'; do
  assert_existing_control_source "${mapping%%:*}" "${mapping#*:}"
done

if [ "$shared_marker_present" = true ]; then
  installed_cleanup_age="$((installed_rollback_retention_hours * 60 - 31))min"
  installed_rollback_tmpfiles="$(sed -e "s|@ROLLBACK_DIR@|$rollback_dir|g" \
    -e "s|@CLEANUP_AGE@|$installed_cleanup_age|g" \
    "$installed_deploy_dir/deploy/tmpfiles.d/kassinao-rollback.conf.in")"
  installed_rollback_service="$(sed -e "s|@ROLLBACK_DIR@|$rollback_dir|g" \
    -e "s|@RETENTION_HOURS@|$installed_rollback_retention_hours|g" \
    -e "s|@CLEANUP_AGE@|$installed_cleanup_age|g" \
    "$installed_deploy_dir/deploy/systemd/kassinao-rollback-clean.service.in")"
  installed_egress_unit="$(sed \
    's|^ExecStart=/usr/local/sbin/kassinao-harden-docker-egress$|ExecStart=/usr/local/sbin/kassinao-harden-docker-egress --shared-host|' \
    "$installed_deploy_dir/deploy/systemd/kassinao-docker-egress.service")"
else
  installed_rollback_tmpfiles=''
  installed_rollback_service=''
  installed_egress_unit=''
fi
assert_existing_control_content /etc/tmpfiles.d/kassinao-rollback.conf "$installed_rollback_tmpfiles"
assert_existing_control_content /etc/systemd/system/kassinao-rollback-clean.service "$installed_rollback_service"
assert_existing_control_content /etc/systemd/system/kassinao-docker-egress.service "$installed_egress_unit"

for unit in "${UNIT_NAMES[@]}"; do
  destination="/etc/systemd/system/$unit"
  [ ! -L "$destination" ] || die "unit instalada não pode ser symlink: $unit"
  dropin="$destination.d"
  if [ "$dropin" = "$HEALTH_DROPIN_DIR" ]; then
    if [ -e "$dropin" ] || [ -L "$dropin" ]; then
      [ "$shared_marker_present" = true ] ||
        die 'drop-in homônimo do health-watch existe sem marker shared'
      [ -d "$dropin" ] && [ ! -L "$dropin" ] || die 'drop-in do health-watch precisa ser diretório real'
      [ "$(stat -c '%a:%u:%g' "$dropin" 2>/dev/null || true)" = 755:0:0 ] ||
        die 'diretório do drop-in shared precisa ser 0755 root:root'
      mapfile -t dropin_entries < <(find "$dropin" -mindepth 1 -maxdepth 1 -printf '%f\n' | sort)
      [ "${#dropin_entries[@]}" -eq 1 ] && [ "${dropin_entries[0]}" = 10-shared-host.conf ] ||
        die 'health-watch possui drop-in diferente do adapter shared'
      [ -f "$HEALTH_DROPIN" ] && [ ! -L "$HEALTH_DROPIN" ] &&
        [ "$(stat -c '%a:%u:%g' "$HEALTH_DROPIN" 2>/dev/null || true)" = 644:0:0 ] ||
        die 'drop-in shared existente está inseguro ou divergente'
      actual_health_dropin="$(cat "$HEALTH_DROPIN")"
      [ "$actual_health_dropin" = "$expected_health_dropin" ] ||
        [ "$actual_health_dropin" = "$expected_installed_health_dropin" ] ||
        [ "$actual_health_dropin" = "$expected_legacy_health_dropin" ] ||
        [ "$actual_health_dropin" = "$expected_previous_shared_dropin_split" ] ||
        [ "$actual_health_dropin" = "$expected_previous_shared_dropin_tunnel" ] ||
        die 'drop-in shared existente está inseguro ou divergente'
    fi
  else
    [ ! -e "$dropin" ] && [ ! -L "$dropin" ] || die "drop-in não auditado para $unit"
  fi
done

for destination in \
  "$NO_DUMP_INSTALLED" \
  /usr/local/sbin/kassinao-health-watch \
  /usr/local/sbin/kassinao-verify-shared-luks-storage \
  /usr/local/sbin/kassinao-check-shared-migration-rollback \
  /usr/local/sbin/kassinao-harden-docker-egress \
  /usr/local/sbin/kassinao-egress-fail-closed \
  /etc/tmpfiles.d/kassinao.conf \
  /etc/tmpfiles.d/kassinao-rollback.conf; do
  [ ! -L "$destination" ] || die "destino de controle não pode ser symlink: $destination"
done

ROLLBACK_TMPFILES_TEMPLATE="$ROOT/deploy/tmpfiles.d/kassinao-rollback.conf.in"
ROLLBACK_SERVICE_TEMPLATE="$ROOT/deploy/systemd/kassinao-rollback-clean.service.in"
expected_rollback_tmpfiles="$(sed -e "s|@ROLLBACK_DIR@|$rollback_dir|g" \
  -e "s|@CLEANUP_AGE@|$rollback_cleanup_age|g" "$ROLLBACK_TMPFILES_TEMPLATE")"
expected_rollback_service="$(sed -e "s|@ROLLBACK_DIR@|$rollback_dir|g" \
  -e "s|@RETENTION_HOURS@|$rollback_retention_hours|g" \
  -e "s|@CLEANUP_AGE@|$rollback_cleanup_age|g" "$ROLLBACK_SERVICE_TEMPLATE")"
grep -Fqx "d $rollback_dir 0700 root root mM:$rollback_cleanup_age -" <<<"$expected_rollback_tmpfiles" ||
  die 'regra de retenção shared gerada ficou inválida'
grep -Fqx "ReadWritePaths=$rollback_dir" <<<"$expected_rollback_service" ||
  die 'unit de rollback shared escapou do DATA_ROOT'

# Último gate antes de instalar/ativar qualquer controle ou tocar a policy de
# egress. O audit preflight inventaria todos os workloads no daemon local e
# rejeita colisões de projeto, container, bridge ou fronteira privada.
env -i "PATH=$PATH" "HOME=${HOME:-/root}" "$SHARED_AUDIT_SOURCE" --preflight ||
  die 'preflight shared reprovou o host; nenhum controle de egress foi instalado ou ativado'

# A partir daqui começam as mutações, depois de todos os gates de escopo,
# storage, daemon, containers e arquivos existentes passarem.
install -d -o root -g root -m 0755 "$ETC_KASSINAO" /etc/tmpfiles.d "$HEALTH_DROPIN_DIR"
if [ -e "$NO_DUMP_INSTALL_DIR" ] || [ -L "$NO_DUMP_INSTALL_DIR" ]; then
  [ "$shared_marker_present" = true ] || \
    die 'diretório homônimo do launcher no-dump existe sem marker shared'
  [ -d "$NO_DUMP_INSTALL_DIR" ] && [ ! -L "$NO_DUMP_INSTALL_DIR" ] || \
    die 'diretório instalado do launcher no-dump é irregular'
  mapfile -t no_dump_entries < <(find "$NO_DUMP_INSTALL_DIR" -mindepth 1 -maxdepth 1 -printf '%f\n' | sort)
  [ "${#no_dump_entries[@]}" -eq 1 ] && [ "${no_dump_entries[0]}" = kassinao-no-dump ] || \
    die 'diretório instalado do launcher no-dump contém artefatos estranhos'
fi
install -d -o root -g root -m 0755 "$NO_DUMP_INSTALL_DIR"
SHARED_ENV_TMP="$(mktemp "$ETC_KASSINAO/.shared-env.XXXXXX")"
HOST_CONTROLS_TMP="$(mktemp "$ETC_KASSINAO/.host-controls.XXXXXX")"
HEALTH_DROPIN_TMP="$(mktemp "$HEALTH_DROPIN_DIR/.10-shared-host.conf.XXXXXX")"
ROLLBACK_TMPFILES_TMP="$(mktemp "$ETC_KASSINAO/.rollback-tmpfiles.XXXXXX")"
ROLLBACK_SERVICE_TMP="$(mktemp "$ETC_KASSINAO/.rollback-service.XXXXXX")"
EGRESS_UNIT_TMP="$(mktemp "$ETC_KASSINAO/.egress-unit.XXXXXX")"
trap 'rm -f -- "${SHARED_ENV_TMP:-}" "${HOST_CONTROLS_TMP:-}" "${HEALTH_DROPIN_TMP:-}" "${ROLLBACK_TMPFILES_TMP:-}" "${ROLLBACK_SERVICE_TMP:-}" "${EGRESS_UNIT_TMP:-}"' EXIT
printf '%s\n' "$expected_shared_env" > "$SHARED_ENV_TMP"
printf '%s\n' "$expected_host_controls" > "$HOST_CONTROLS_TMP"
printf '%s\n' "$expected_health_dropin" > "$HEALTH_DROPIN_TMP"
printf '%s\n' "$expected_rollback_tmpfiles" > "$ROLLBACK_TMPFILES_TMP"
printf '%s\n' "$expected_rollback_service" > "$ROLLBACK_SERVICE_TMP"
printf '%s\n' "$expected_shared_egress_unit" > "$EGRESS_UNIT_TMP"

install -o root -g root -m 0600 "$SHARED_ENV_TMP" "$ETC_KASSINAO/shared.env"
install -o root -g root -m 0600 "$HOST_CONTROLS_TMP" "$ETC_KASSINAO/host-controls.env"
chmod 0644 "$HEALTH_DROPIN_TMP"
chown root:root "$HEALTH_DROPIN_TMP"
mv -f -- "$HEALTH_DROPIN_TMP" "$HEALTH_DROPIN"
HEALTH_DROPIN_TMP=''
install -o root -g root -m 0644 "$ROLLBACK_TMPFILES_TMP" /etc/tmpfiles.d/kassinao-rollback.conf
install -o root -g root -m 0644 "$ROLLBACK_SERVICE_TMP" /etc/systemd/system/kassinao-rollback-clean.service
install -o root -g root -m 0644 "$EGRESS_UNIT_TMP" /etc/systemd/system/kassinao-docker-egress.service
rm -f -- "$SHARED_ENV_TMP" "$HOST_CONTROLS_TMP" "$ROLLBACK_TMPFILES_TMP" "$ROLLBACK_SERVICE_TMP" "$EGRESS_UNIT_TMP"
SHARED_ENV_TMP=''; HOST_CONTROLS_TMP=''; HEALTH_DROPIN_TMP=''; ROLLBACK_TMPFILES_TMP=''; ROLLBACK_SERVICE_TMP=''; EGRESS_UNIT_TMP=''

install -o root -g root -m 0755 "$ROOT/scripts/health-watch.sh" /usr/local/sbin/kassinao-health-watch
install -o root -g root -m 0555 "$NO_DUMP_SOURCE" "$NO_DUMP_INSTALLED"
install -o root -g root -m 0755 "$SHARED_VERIFIER_SOURCE" /usr/local/sbin/kassinao-verify-shared-luks-storage
install -o root -g root -m 0755 "$SHARED_ROLLBACK_CHECKER_SOURCE" /usr/local/sbin/kassinao-check-shared-migration-rollback
install -o root -g root -m 0755 "$ROOT/scripts/harden-docker-egress.sh" /usr/local/sbin/kassinao-harden-docker-egress
install -o root -g root -m 0755 "$ROOT/scripts/egress-fail-closed.sh" /usr/local/sbin/kassinao-egress-fail-closed
install -o root -g root -m 0644 "$ROOT/deploy/systemd/kassinao-health-watch.service" /etc/systemd/system/kassinao-health-watch.service
install -o root -g root -m 0644 "$ROOT/deploy/systemd/kassinao-health-watch.timer" /etc/systemd/system/kassinao-health-watch.timer
install -o root -g root -m 0644 "$ROOT/deploy/systemd/kassinao-egress-fail-closed.service" /etc/systemd/system/kassinao-egress-fail-closed.service
install -o root -g root -m 0644 "$ROOT/deploy/systemd/kassinao-rollback-clean.timer" /etc/systemd/system/kassinao-rollback-clean.timer
install -o root -g root -m 0644 "$ROOT/deploy/tmpfiles.d/kassinao.conf" /etc/tmpfiles.d/kassinao.conf

systemd-tmpfiles --create /etc/tmpfiles.d/kassinao.conf
systemd-tmpfiles --create /etc/tmpfiles.d/kassinao-rollback.conf
[ -d "$RUNTIME_DIR" ] && [ ! -L "$RUNTIME_DIR" ] &&
  [ "$(stat -c '%a:%u:%g' "$RUNTIME_DIR" 2>/dev/null || true)" = 700:0:0 ] ||
  die 'tmpfiles não materializou runtime 0700 root:root'
for runtime_lock in maintenance.lock backup.lock backup-retention.lock docker-egress.lock; do
  [ -f "$RUNTIME_DIR/$runtime_lock" ] && [ ! -L "$RUNTIME_DIR/$runtime_lock" ] &&
    [ "$(readlink -f -- "$RUNTIME_DIR/$runtime_lock" 2>/dev/null || true)" = "$RUNTIME_DIR/$runtime_lock" ] &&
    [ "$(stat -c '%a:%u:%g:%h' "$RUNTIME_DIR/$runtime_lock" 2>/dev/null || true)" = 600:0:0:1 ] ||
    die "tmpfiles não materializou $runtime_lock como regular 0600 root:root sem hardlink"
done
[ -d "$rollback_dir" ] && [ ! -L "$rollback_dir" ] &&
  [ "$(stat -c '%a:%u:%g' "$rollback_dir" 2>/dev/null || true)" = 700:0:0 ] ||
  die 'tmpfiles não materializou rollback privado'

if [ "$maintenance_locked" != true ]; then
  lock_maintenance
fi

env -i "PATH=$PATH" "HOME=${HOME:-/root}" /usr/local/sbin/kassinao-verify-shared-luks-storage
env -i "PATH=$PATH" "HOME=${HOME:-/root}" "KASSINAO_ENV_FILE=$ETC_KASSINAO/shared.env" \
  /usr/local/sbin/kassinao-check-shared-migration-rollback >/dev/null ||
  die 'checker instalado reprovou o estado do rollback plaintext'

systemctl daemon-reload
docker_dropins="$(systemctl show docker.service -p DropInPaths --value 2>/dev/null || true)"
case "$docker_dropins" in *kassinao-egress.conf*) die 'daemon-reload encontrou drop-in dedicado no docker.service' ;; esac
docker_pre="$(systemctl show docker.service -p ExecStartPre --value 2>/dev/null || true)"
case "$docker_pre" in
  *kassinao-harden-docker-egress* | *kassinao-verify-storage-encryption* | *kassinao-verify-shared-luks-storage*)
    die 'docker.service recebeu pre-hook do Kassinão durante a instalação shared'
    ;;
esac
health_private_devices="$(systemctl show kassinao-health-watch.service -p PrivateDevices --value 2>/dev/null || true)"
[ "$health_private_devices" = no ] || die 'drop-in shared não desativou PrivateDevices no health-watch efetivo'
health_environment="$(systemctl show kassinao-health-watch.service -p Environment --value 2>/dev/null || true)"
[ -z "$health_environment" ] ||
  die 'health-watch efetivo não pode receber Environment; toda configuração precisa ser derivada da release selada'
health_capabilities="$(systemctl show kassinao-health-watch.service -p CapabilityBoundingSet --value 2>/dev/null || true)"
case " $health_capabilities " in
  *' cap_sys_admin '*) ;;
  *) die 'health-watch efetivo não recebeu CAP_SYS_ADMIN para provar o mapper dm-crypt' ;;
esac
health_exec_start_pre="$(systemctl show kassinao-health-watch.service -p ExecStartPre --value 2>/dev/null || true)"
case "$health_exec_start_pre" in
  *'/usr/local/sbin/kassinao-check-shared-migration-rollback'*) ;;
  *) die 'health-watch efetivo não executa o checker de rollback antes da recuperação' ;;
esac
egress_exec_start="$(systemctl show kassinao-docker-egress.service -p ExecStart --value 2>/dev/null || true)"
grep -Fq 'path=/usr/local/sbin/kassinao-harden-docker-egress ;' <<<"$egress_exec_start" &&
  grep -Fq 'argv[]=/usr/local/sbin/kassinao-harden-docker-egress --shared-host ;' <<<"$egress_exec_start" ||
  die 'unit de egress efetiva não usa o modo shared isolado'

systemctl enable kassinao-docker-egress.service kassinao-health-watch.timer kassinao-rollback-clean.timer >/dev/null
systemctl reset-failed kassinao-docker-egress.service kassinao-egress-fail-closed.service 2>/dev/null || true
systemctl restart kassinao-docker-egress.service
systemctl restart kassinao-health-watch.timer
systemctl restart kassinao-rollback-clean.timer
systemctl start kassinao-rollback-clean.service

systemctl is-enabled --quiet kassinao-docker-egress.service
systemctl is-enabled --quiet kassinao-health-watch.timer
systemctl is-enabled --quiet kassinao-rollback-clean.timer
systemctl is-active --quiet kassinao-docker-egress.service
systemctl is-active --quiet kassinao-health-watch.timer
systemctl is-active --quiet kassinao-rollback-clean.timer

docker_main_pid_after="$(systemctl show docker.service -p MainPID --value 2>/dev/null || true)"
[ "$docker_main_pid_after" = "$docker_main_pid_before" ] || die 'docker.service reiniciou durante o installer shared'

env -i "PATH=$PATH" "HOME=${HOME:-/root}" "KASSINAO_ENV_FILE=$ENV_FILE" \
  "$SHARED_AUDIT_SOURCE" --preflight >/dev/null ||
  die 'contrato estático shared divergiu antes de ativar o health-watch'

flock -u 9
maintenance_locked=false
if grep -Fqx kassinao <<<"$containers"; then systemctl start kassinao-health-watch.service; fi

cmp -s "$ROOT/scripts/health-watch.sh" /usr/local/sbin/kassinao-health-watch
cmp -s "$NO_DUMP_SOURCE" "$NO_DUMP_INSTALLED"
cmp -s "$SHARED_VERIFIER_SOURCE" /usr/local/sbin/kassinao-verify-shared-luks-storage
cmp -s "$SHARED_ROLLBACK_CHECKER_SOURCE" /usr/local/sbin/kassinao-check-shared-migration-rollback
cmp -s "$ROOT/scripts/harden-docker-egress.sh" /usr/local/sbin/kassinao-harden-docker-egress
cmp -s "$ROOT/scripts/egress-fail-closed.sh" /usr/local/sbin/kassinao-egress-fail-closed
cmp -s "$ROOT/deploy/systemd/kassinao-health-watch.service" /etc/systemd/system/kassinao-health-watch.service
cmp -s "$ROOT/deploy/systemd/kassinao-health-watch.timer" /etc/systemd/system/kassinao-health-watch.timer
[ "$(cat /etc/systemd/system/kassinao-docker-egress.service)" = "$expected_shared_egress_unit" ]
cmp -s "$ROOT/deploy/systemd/kassinao-egress-fail-closed.service" /etc/systemd/system/kassinao-egress-fail-closed.service
cmp -s "$ROOT/deploy/systemd/kassinao-rollback-clean.timer" /etc/systemd/system/kassinao-rollback-clean.timer
cmp -s "$ROOT/deploy/tmpfiles.d/kassinao.conf" /etc/tmpfiles.d/kassinao.conf
[ "$(cat "$HEALTH_DROPIN")" = "$expected_health_dropin" ]
[ "$(cat /etc/tmpfiles.d/kassinao-rollback.conf)" = "$expected_rollback_tmpfiles" ]
[ "$(cat /etc/systemd/system/kassinao-rollback-clean.service)" = "$expected_rollback_service" ]

for installed in \
  /usr/local/sbin/kassinao-health-watch \
  /usr/local/sbin/kassinao-verify-shared-luks-storage \
  /usr/local/sbin/kassinao-check-shared-migration-rollback \
  /usr/local/sbin/kassinao-harden-docker-egress \
  /usr/local/sbin/kassinao-egress-fail-closed; do
  [ "$(stat -c '%a:%u:%g' "$installed" 2>/dev/null || true)" = 755:0:0 ] || die "script instalado inseguro: $installed"
done
[ "$(stat -c '%a:%u:%g' "$NO_DUMP_INSTALL_DIR" 2>/dev/null || true)" = 755:0:0 ] || \
  die 'diretório do launcher no-dump instalado está inseguro'
mapfile -t no_dump_entries < <(find "$NO_DUMP_INSTALL_DIR" -mindepth 1 -maxdepth 1 -printf '%f\n' | sort)
[ "${#no_dump_entries[@]}" -eq 1 ] && [ "${no_dump_entries[0]}" = kassinao-no-dump ] ||
  die 'diretório do launcher no-dump instalado contém entradas extras'
[ "$(stat -c '%a:%u:%g:%h' "$NO_DUMP_INSTALLED" 2>/dev/null || true)" = 555:0:0:1 ] || \
  die 'launcher no-dump instalado está inseguro'
[ "$(stat -c '%a:%u:%g' "$ETC_KASSINAO/shared.env")" = 600:0:0 ]
[ "$(stat -c '%a:%u:%g' "$ETC_KASSINAO/host-controls.env")" = 600:0:0 ]
[ "$(stat -c '%a:%u:%g' "$HEALTH_DROPIN")" = 644:0:0 ]

echo 'Controles shared-host do Kassinão instalados sem alterar ou reiniciar o daemon Docker.'
