#!/bin/bash -p
# Remove somente os controles de host instalados pelo kit atual. Não para
# containers, não apaga dados da instância e recusa qualquer arquivo divergente.
set -Eeuo pipefail
umask 077

CONFIRMATION=--confirm-remove-kassinao-host-controls
[ "${1:-}" = "$CONFIRMATION" ] && [ "$#" -eq 1 ] || {
  echo "ERRO: uso: uninstall-host-controls.sh $CONFIRMATION" >&2
  exit 1
}
die() { printf 'ERRO: %s\n' "$*" >&2; exit 1; }
_saved_no_dump_marker="${KASSINAO_NO_DUMP_ACTIVE-}"
_saved_no_dump_preload="${LD_PRELOAD-}"
_forbidden_docker_environment=''
for _name in DOCKER_HOST DOCKER_CONTEXT DOCKER_CONFIG DOCKER_TLS_VERIFY DOCKER_CERT_PATH DOCKER_API_VERSION; do
  if declare -p "$_name" >/dev/null 2>&1; then _forbidden_docker_environment="$_name"; break; fi
done
[ -r "/proc/$$/environ" ] || die '/proc é obrigatório para limpar o ambiente do uninstall dedicated'
while IFS='=' read -r -d '' _name _value; do unset "$_name" 2>/dev/null || true; done < "/proc/$$/environ"
unset _name _value
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/root LC_ALL=C
[ -z "$_forbidden_docker_environment" ] || die "$_forbidden_docker_environment não pode vir do ambiente"

_script_path="${BASH_SOURCE[0]}"
case "$_script_path" in /*) ;; ./*) _script_path="$PWD/${_script_path#./}" ;; *) _script_path="$PWD/$_script_path" ;; esac
case "$_script_path" in *//* | */./* | */../* | */. | */.. | */) die 'caminho do uninstall dedicated não é canônico' ;; esac
_script_dir="${_script_path%/*}"
case "$_script_dir" in */scripts) PROJECT_DIR="${_script_dir%/scripts}" ;; *) die 'uninstall dedicated precisa executar do kit selado' ;; esac
case "${MACHTYPE%%-*}" in x86_64) _no_dump_arch=amd64 ;; aarch64 | arm64) _no_dump_arch=arm64 ;; *) die 'arquitetura sem runtime no-dump' ;; esac
_no_dump_preload="$PROJECT_DIR/runtime/linux-$_no_dump_arch/libkassinao-no-dump.so"
# KASSINAO_HOST_NO_DUMP_BEGIN
if [ "$_saved_no_dump_marker" != "prctl-v1:$$" ] || [ "$_saved_no_dump_preload" != "$_no_dump_preload" ]; then
  exec /usr/bin/python3 "$PROJECT_DIR/scripts/no-dump-exec.py" \
    --bundle-root "$PROJECT_DIR" --script-relative scripts/uninstall-host-controls.sh --arch "$_no_dump_arch" -- \
    "$_script_path" "$@"
fi
LD_PRELOAD="$_no_dump_preload"
export LD_PRELOAD
[ "$(ulimit -Sc)" = 0 ] && [ "$(ulimit -Hc)" = 0 ] || die 'core limit do uninstall dedicated não ficou selado'
IFS= read -r _no_dump_filter < "/proc/$$/coredump_filter" || _no_dump_filter=''
[[ "$_no_dump_filter" =~ ^0+$ ]] || die 'coredump_filter do uninstall dedicated não ficou selado'
# KASSINAO_HOST_NO_DUMP_END
unset _saved_no_dump_marker _saved_no_dump_preload _no_dump_filter _no_dump_arch _no_dump_preload _script_path _script_dir
[ "$(id -u)" -eq 0 ] || { echo 'ERRO: execute como root' >&2; exit 1; }
for command in cmp docker flock sha256sum systemctl stat; do
  command -v "$command" >/dev/null 2>&1 || { echo "ERRO: $command não encontrado" >&2; exit 1; }
done
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
cursor="$ROOT"
while :; do
  [ ! -e "$cursor/.git" ] || { echo 'ERRO: uninstall de produção exige o kit fora de Git' >&2; exit 1; }
  parent="$(dirname -- "$cursor")"
  [ "$parent" != "$cursor" ] || break
  cursor="$parent"
done
MANIFEST="$ROOT/MANIFEST.sha256"
[ -f "$MANIFEST" ] && [ ! -L "$MANIFEST" ] || { echo 'ERRO: MANIFEST.sha256 ausente ou irregular' >&2; exit 1; }
if command -v sha256sum >/dev/null 2>&1; then
  (cd -- "$ROOT" && sha256sum -c MANIFEST.sha256 --quiet)
else
  (cd -- "$ROOT" && shasum -a 256 -c MANIFEST.sha256 >/dev/null)
fi
root_mode="$(stat -c '%a:%u:%g' "$ROOT" 2>/dev/null || true)"
case "$root_mode" in 700:0:0 | 500:0:0) ;; *) echo 'ERRO: kit precisa ser 0700/0500 root:root' >&2; exit 1 ;; esac
manifest_mode="$(stat -c '%a:%u:%g' "$MANIFEST" 2>/dev/null || true)"
case "$manifest_mode" in *:0:0) ;; *) echo 'ERRO: MANIFEST.sha256 precisa pertencer a root:root' >&2; exit 1 ;; esac
manifest_permissions="${manifest_mode%%:*}"
(( (8#$manifest_permissions & 022) == 0 )) || { echo 'ERRO: MANIFEST.sha256 não pode ser gravável por grupo/outros' >&2; exit 1; }
while IFS= read -r source; do
  [ -f "$source" ] && [ ! -L "$source" ] && [ "$(stat -c '%u:%g' "$source" 2>/dev/null || true)" = '0:0' ] || {
    echo 'ERRO: arquivo do kit ausente, symlink ou não-root' >&2
    exit 1
  }
  mode="$(stat -c '%a' "$source" 2>/dev/null || true)"
  (( (8#$mode & 022) == 0 )) || { echo 'ERRO: arquivo do kit gravável por grupo/outros' >&2; exit 1; }
done < <(awk '{path=$2; sub(/^\.\//, "", path); print "'"$ROOT"'/" path}' "$MANIFEST")
ENV_FILE="$ROOT/.env"
[ -f "$ENV_FILE" ] && [ ! -L "$ENV_FILE" ] || { echo 'ERRO: .env do kit ausente ou symlink' >&2; exit 1; }

env_value() {
  local key="$1" file="$2"
  awk -v key="$key" '
    index($0, key "=") == 1 { count++; value = substr($0, length(key) + 2) }
    END { if (count > 1) exit 2; print value }
  ' "$file" || { echo "ERRO: $key aparece mais de uma vez em $file" >&2; exit 1; }
}

data_root="$(env_value KASSINAO_DATA_ROOT "$ENV_FILE")"
retention_hours="$(env_value KASSINAO_ROLLBACK_RETENTION_HOURS "$ENV_FILE")"
[[ "$data_root" =~ ^/[A-Za-z0-9._/-]+$ ]] && [ "$data_root" != / ] && \
  [ "$data_root" != /var ] && [ "$data_root" != /var/lib ] || {
  echo 'ERRO: KASSINAO_DATA_ROOT não é um diretório dedicado válido' >&2
  exit 1
}
case "$data_root" in *//* | */./* | */../* | */. | */.. | */) echo 'ERRO: KASSINAO_DATA_ROOT precisa ser canônico' >&2; exit 1 ;; esac
[ -d "$data_root" ] && [ ! -L "$data_root" ] && [ "$(cd -- "$data_root" && pwd -P)" = "$data_root" ] || {
  echo 'ERRO: KASSINAO_DATA_ROOT precisa existir como diretório canônico, sem symlink' >&2
  exit 1
}
[[ "$retention_hours" =~ ^[1-9][0-9]*$ ]] && [ "$retention_hours" -le 168 ] || {
  echo 'ERRO: retenção de rollback fora da faixa 1..168h' >&2
  exit 1
}
cleanup_age="$((retention_hours * 60 - 31))min"

RUNTIME_DIR=/run/lock/kassinao
[ -d "$RUNTIME_DIR" ] && [ ! -L "$RUNTIME_DIR" ] && \
  [ "$(stat -c '%a:%u:%g' "$RUNTIME_DIR" 2>/dev/null || true)" = '700:0:0' ] || {
  echo 'ERRO: diretório de locks instalado está ausente ou inseguro' >&2
  exit 1
}
DEPLOY_LOCK="$ROOT/.deploy.lock"
[ ! -L "$DEPLOY_LOCK" ] || { echo 'ERRO: .deploy.lock não pode ser symlink' >&2; exit 1; }
exec 6>"$DEPLOY_LOCK"
chmod 600 "$DEPLOY_LOCK"
flock -n 6 || { echo 'ERRO: deploy ainda usa este kit operacional' >&2; exit 1; }
[ ! -L "$RUNTIME_DIR/maintenance.lock" ] || { echo 'ERRO: maintenance.lock não pode ser symlink' >&2; exit 1; }
exec 8>"$RUNTIME_DIR/maintenance.lock"
flock -n 8 || { echo 'ERRO: deploy, backup ou watchdog ainda usa a instância' >&2; exit 1; }

containers="$(docker ps -a --format '{{.Names}}')" || {
  echo 'ERRO: não foi possível enumerar o daemon Docker local' >&2
  exit 1
}
for container in kassinao kassinao-router kassinao-public kassinao-tunnel; do
  grep -Fqx "$container" <<<"$containers" || continue
  running="$(docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null || true)"
  restart_policy="$(docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' "$container" 2>/dev/null || true)"
  [ "$running" = false ] || {
    echo "ERRO: pare $container antes do uninstall; este script nunca para containers" >&2
    exit 1
  }
  [ -z "$restart_policy" ] || [ "$restart_policy" = no ] || {
    echo "ERRO: desative o restart policy de $container ou remova-o com Compose antes do uninstall" >&2
    exit 1
  }
done

SCRIPTS=(
  health-watch
  verify-storage-encryption
  harden-docker-egress
  egress-fail-closed
)
UNITS=(
  kassinao-health-watch.service
  kassinao-health-watch.timer
  kassinao-docker-egress.service
  kassinao-egress-fail-closed.service
  kassinao-rollback-clean.service
  kassinao-rollback-clean.timer
)
for name in "${SCRIPTS[@]}"; do
  source="$ROOT/scripts/$name.sh"
  destination="/usr/local/sbin/kassinao-$name"
  [ -f "$source" ] && [ ! -L "$source" ] && [ -f "$destination" ] && [ ! -L "$destination" ] && \
    cmp -s "$source" "$destination" || {
    echo "ERRO: controle instalado ausente ou divergente: $destination" >&2
    exit 1
  }
done
for unit in "${UNITS[@]}"; do
  destination="/etc/systemd/system/$unit"
  unit_matches=false
  if [ "$unit" = kassinao-rollback-clean.service ]; then
    source="$ROOT/deploy/systemd/kassinao-rollback-clean.service.in"
    expected_unit="$(sed -e "s|@ROLLBACK_DIR@|$data_root/rollback|g" \
      -e "s|@RETENTION_HOURS@|$retention_hours|g" \
      -e "s|@CLEANUP_AGE@|$cleanup_age|g" "$source" 2>/dev/null || true)"
    if [ -f "$source" ] && [ ! -L "$source" ] && [ -f "$destination" ] && [ ! -L "$destination" ] && \
       [ "$(cat "$destination")" = "$expected_unit" ]; then
      unit_matches=true
    fi
  else
    source="$ROOT/deploy/systemd/$unit"
    if [ -f "$source" ] && [ ! -L "$source" ] && [ -f "$destination" ] && [ ! -L "$destination" ] && \
       cmp -s "$source" "$destination"; then
      unit_matches=true
    fi
  fi
  [ ! -e "$destination.d" ] && [ ! -L "$destination.d" ] && [ "$unit_matches" = true ] || {
    echo "ERRO: unit instalada ausente, divergente ou com drop-in: $unit" >&2
    exit 1
  }
done

DOCKER_DROPIN_SOURCE="$ROOT/deploy/systemd/docker.service.d/kassinao-egress.conf"
DOCKER_DROPIN_DESTINATION=/etc/systemd/system/docker.service.d/kassinao-egress.conf
TMPFILES_SOURCE="$ROOT/deploy/tmpfiles.d/kassinao.conf"
TMPFILES_DESTINATION=/etc/tmpfiles.d/kassinao.conf
ROLLBACK_TMPFILES_TEMPLATE="$ROOT/deploy/tmpfiles.d/kassinao-rollback.conf.in"
ROLLBACK_TMPFILES_DESTINATION=/etc/tmpfiles.d/kassinao-rollback.conf
for pair in \
  "$DOCKER_DROPIN_SOURCE:$DOCKER_DROPIN_DESTINATION" \
  "$TMPFILES_SOURCE:$TMPFILES_DESTINATION"; do
  source="${pair%%:*}"; destination="${pair#*:}"
  [ -f "$source" ] && [ ! -L "$source" ] && [ -f "$destination" ] && [ ! -L "$destination" ] && \
    cmp -s "$source" "$destination" || {
    echo "ERRO: controle instalado ausente ou divergente: $destination" >&2
    exit 1
  }
done
expected_rollback_rule="$(sed -e "s|@ROLLBACK_DIR@|$data_root/rollback|g" \
  -e "s|@CLEANUP_AGE@|$cleanup_age|g" "$ROLLBACK_TMPFILES_TEMPLATE")"
[ -f "$ROLLBACK_TMPFILES_DESTINATION" ] && [ ! -L "$ROLLBACK_TMPFILES_DESTINATION" ] && \
  [ "$(cat "$ROLLBACK_TMPFILES_DESTINATION")" = "$expected_rollback_rule" ] || {
  echo 'ERRO: regra de rollback instalada está ausente ou divergente' >&2
  exit 1
}
expected_storage_paths="$(for key in KASSINAO_DATA_ROOT KASSINAO_RECORDINGS_DIR KASSINAO_STATE_DIR KASSINAO_AUTH_DIR KASSINAO_MODEL_CACHE_DIR; do env_value "$key" "$ENV_FILE"; done)"
[ -f /etc/kassinao/storage-paths ] && [ ! -L /etc/kassinao/storage-paths ] && \
  [ "$(cat /etc/kassinao/storage-paths)" = "$expected_storage_paths" ] || {
  echo 'ERRO: allowlist instalada de storage divergiu' >&2
  exit 1
}
expected_host_controls="$(printf 'KASSINAO_DEPLOY_DIR=%s\nKASSINAO_DATA_ROOT=%s\nKASSINAO_ROLLBACK_RETENTION_HOURS=%s' "$ROOT" "$data_root" "$retention_hours")"
[ -f /etc/kassinao/host-controls.env ] && [ ! -L /etc/kassinao/host-controls.env ] && \
  [ "$(cat /etc/kassinao/host-controls.env)" = "$expected_host_controls" ] || {
  echo 'ERRO: registro instalado dos controles do host divergiu' >&2
  exit 1
}

# Não retire o único mecanismo que ainda expira snapshots recentes. Este
# uninstall nunca apaga dados: se restar algo, o operador espera o timer ou
# trata os dados explicitamente antes de tentar de novo.
rollback_dir="$data_root/rollback"
if [ -d "$rollback_dir" ] && find "$rollback_dir" -mindepth 1 -print -quit | grep -q .; then
  echo "ERRO: ainda há snapshot dentro da janela de ${retention_hours}h; retenção não será desinstalada" >&2
  exit 1
fi
for lock in backup.lock docker-egress.lock maintenance.lock; do
  lock_file="$RUNTIME_DIR/$lock"
  [ ! -L "$lock_file" ] || { echo "ERRO: lock residual irregular: $lock_file" >&2; exit 1; }
  [ ! -e "$lock_file" ] || [ -f "$lock_file" ] || { echo "ERRO: lock residual não é arquivo: $lock_file" >&2; exit 1; }
done

systemctl disable --now kassinao-health-watch.timer kassinao-docker-egress.service kassinao-rollback-clean.timer >/dev/null
systemctl stop kassinao-health-watch.service kassinao-egress-fail-closed.service kassinao-rollback-clean.service >/dev/null
for unit in kassinao-health-watch.timer kassinao-docker-egress.service kassinao-rollback-clean.timer; do
  systemctl is-active --quiet "$unit" && { echo "ERRO: $unit continuou ativo" >&2; exit 1; }
done

env -i "PATH=$PATH" "HOME=${HOME:-/root}" /usr/local/sbin/kassinao-harden-docker-egress --remove

for unit in "${UNITS[@]}"; do rm -f -- "/etc/systemd/system/$unit"; done
rm -f -- "$DOCKER_DROPIN_DESTINATION" "$TMPFILES_DESTINATION" "$ROLLBACK_TMPFILES_DESTINATION"
for name in "${SCRIPTS[@]}"; do rm -f -- "/usr/local/sbin/kassinao-$name"; done
rm -f -- /etc/kassinao/storage-paths /etc/kassinao/host-controls.env
rmdir /etc/kassinao 2>/dev/null || true
for lock in backup.lock docker-egress.lock maintenance.lock; do
  lock_file="$RUNTIME_DIR/$lock"
  rm -f -- "$lock_file"
done
rmdir "$RUNTIME_DIR" 2>/dev/null || true
systemctl daemon-reload
systemctl reset-failed "${UNITS[@]}" 2>/dev/null || true

docker_dropins="$(systemctl show docker.service -p DropInPaths --value 2>/dev/null || true)"
if tr ' ' '\n' <<<"$docker_dropins" | grep -Fqx -- "$DOCKER_DROPIN_DESTINATION"; then
  echo 'ERRO: systemd ainda carrega o drop-in Kassinão do Docker' >&2
  exit 1
fi

echo 'Controles exclusivos do Kassinão removidos. Docker não foi reiniciado e os dados da instância não foram apagados.'
echo 'As obrigações de retenção e exclusão continuam valendo enquanto o DATA_ROOT existir.'
