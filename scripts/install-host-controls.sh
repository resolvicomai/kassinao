#!/bin/bash -p
# Atualiza os controles root do host a partir do kit operacional verificado.
# Rode antes de cada deploy: a bridge estável já fica protegida no primeiro start.
set -Eeuo pipefail
umask 077

die() { printf 'ERRO: %s\n' "$*" >&2; exit 1; }

_saved_no_dump_marker="${KASSINAO_NO_DUMP_ACTIVE-}"
_saved_no_dump_preload="${LD_PRELOAD-}"
_forbidden_docker_environment=''
for _name in DOCKER_HOST DOCKER_CONTEXT DOCKER_CONFIG DOCKER_TLS_VERIFY DOCKER_CERT_PATH DOCKER_API_VERSION; do
  if declare -p "$_name" >/dev/null 2>&1; then _forbidden_docker_environment="$_name"; break; fi
done
[ -r "/proc/$$/environ" ] || die '/proc é obrigatório para limpar o ambiente do installer dedicated'
while IFS='=' read -r -d '' _name _value; do unset "$_name" 2>/dev/null || true; done < "/proc/$$/environ"
unset _name _value
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/root LC_ALL=C
[ -z "$_forbidden_docker_environment" ] || die "$_forbidden_docker_environment não pode vir do ambiente"

_script_path="${BASH_SOURCE[0]}"
case "$_script_path" in /*) ;; ./*) _script_path="$PWD/${_script_path#./}" ;; *) _script_path="$PWD/$_script_path" ;; esac
case "$_script_path" in *//* | */./* | */../* | */. | */.. | */) die 'caminho do installer dedicated não é canônico' ;; esac
_script_dir="${_script_path%/*}"
case "$_script_dir" in */scripts) PROJECT_DIR="${_script_dir%/scripts}" ;; *) die 'installer dedicated precisa executar do kit selado' ;; esac
case "${MACHTYPE%%-*}" in x86_64) _no_dump_arch=amd64 ;; aarch64 | arm64) _no_dump_arch=arm64 ;; *) die 'arquitetura sem runtime no-dump' ;; esac
_no_dump_preload="$PROJECT_DIR/runtime/linux-$_no_dump_arch/libkassinao-no-dump.so"
# KASSINAO_HOST_NO_DUMP_BEGIN
if [ "$_saved_no_dump_marker" != "prctl-v1:$$" ] || [ "$_saved_no_dump_preload" != "$_no_dump_preload" ]; then
  exec /usr/bin/python3 "$PROJECT_DIR/scripts/no-dump-exec.py" \
    --bundle-root "$PROJECT_DIR" --script-relative scripts/install-host-controls.sh --arch "$_no_dump_arch" -- \
    "$_script_path" "$@"
fi
LD_PRELOAD="$_no_dump_preload"
export LD_PRELOAD
[ "$(ulimit -Sc)" = 0 ] && [ "$(ulimit -Hc)" = 0 ] || die 'core limit do installer dedicated não ficou selado'
IFS= read -r _no_dump_filter < "/proc/$$/coredump_filter" || _no_dump_filter=''
[ "$_no_dump_filter" = 0 ] || die 'coredump_filter do installer dedicated não ficou selado'
# KASSINAO_HOST_NO_DUMP_END
unset _saved_no_dump_marker _saved_no_dump_preload _no_dump_filter _no_dump_arch _no_dump_preload _script_path _script_dir

[ "$(id -u)" -eq 0 ] || { echo 'ERRO: execute como root' >&2; exit 1; }
command -v systemctl >/dev/null 2>&1 || { echo 'ERRO: systemd não encontrado' >&2; exit 1; }
command -v systemd-tmpfiles >/dev/null 2>&1 || { echo 'ERRO: systemd-tmpfiles não encontrado' >&2; exit 1; }
command -v flock >/dev/null 2>&1 || { echo 'ERRO: flock não encontrado' >&2; exit 1; }
command -v stat >/dev/null 2>&1 || { echo 'ERRO: stat não encontrado' >&2; exit 1; }
command -v sha256sum >/dev/null 2>&1 || { echo 'ERRO: sha256sum não encontrado' >&2; exit 1; }
systemd_version="$(systemctl --version 2>/dev/null | awk 'NR == 1 && $1 == "systemd" { print $2 }')"
[[ "$systemd_version" =~ ^[0-9]+$ ]] && [ "$systemd_version" -ge 249 ] || {
  echo 'ERRO: controles de retenção exigem systemd >= 249' >&2
  exit 1
}

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
[ "$ROOT" = "$PROJECT_DIR" ] || die 'raiz canônica divergiu do kit selado'
export DOCKER_HOST=unix:///var/run/docker.sock
unset DOCKER_CONTEXT DOCKER_TLS_VERIFY DOCKER_CERT_PATH DOCKER_API_VERSION
DOCKER_CONFIG="$ROOT/deploy/docker-client"
DOCKER_CONFIG_FILE="$DOCKER_CONFIG/config.json"
[ -d "$DOCKER_CONFIG" ] && [ ! -L "$DOCKER_CONFIG" ] && [ -f "$DOCKER_CONFIG_FILE" ] && [ ! -L "$DOCKER_CONFIG_FILE" ] ||
  die 'configuração isolada do cliente Docker está ausente ou irregular'
[ "$(sha256sum -- "$DOCKER_CONFIG_FILE" | awk '{print $1}')" = ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356 ] ||
  die 'configuração isolada do cliente Docker diverge do objeto vazio selado'
export DOCKER_CONFIG
cursor="$ROOT"
while :; do
  [ ! -e "$cursor/.git" ] || { echo 'ERRO: controles de produção exigem o kit fora de qualquer Git' >&2; exit 1; }
  parent="$(dirname -- "$cursor")"
  [ "$parent" != "$cursor" ] || break
  cursor="$parent"
done

for directory in \
  "$ROOT/scripts" "$ROOT/deploy" "$ROOT/deploy/systemd" "$ROOT/deploy/systemd/docker.service.d" \
  "$ROOT/deploy/tmpfiles.d" \
  /usr/local/sbin /etc/systemd/system; do
  [ -d "$directory" ] && [ ! -L "$directory" ] || {
    echo "ERRO: diretório de controles ausente ou symlink: $directory" >&2
    exit 1
  }
done

[ -f "$ROOT/MANIFEST.sha256" ] && [ ! -L "$ROOT/MANIFEST.sha256" ] || {
  echo 'ERRO: MANIFEST.sha256 do kit ausente ou irregular' >&2
  exit 1
}
if command -v sha256sum >/dev/null 2>&1; then
  (cd -- "$ROOT" && sha256sum -c MANIFEST.sha256 --quiet)
else
  (cd -- "$ROOT" && shasum -a 256 -c MANIFEST.sha256 >/dev/null)
fi

# O manifesto detecta drift; root ownership impede que a conta operacional
# regrave script + manifesto entre a verificação e a instalação privilegiada.
root_mode="$(stat -c '%a:%u:%g' "$ROOT" 2>/dev/null || true)"
case "$root_mode" in
  700:0:0 | 500:0:0) ;;
  *) echo 'ERRO: diretório da release precisa ser 0700/0500 root:root' >&2; exit 1 ;;
esac
cursor="$ROOT"
while :; do
  metadata="$(stat -c '%a:%u:%g' "$cursor" 2>/dev/null || true)"
  mode="${metadata%%:*}"; owner_group="${metadata#*:}"
  [ "$owner_group" = '0:0' ] && (( (8#$mode & 022) == 0 )) || {
    echo "ERRO: release e diretórios pais precisam ser root-owned e não graváveis: $cursor" >&2
    exit 1
  }
  parent="$(dirname -- "$cursor")"
  [ "$parent" != "$cursor" ] || break
  cursor="$parent"
done
manifest_metadata="$(stat -c '%a:%u:%g' "$ROOT/MANIFEST.sha256" 2>/dev/null || true)"
manifest_mode="${manifest_metadata%%:*}"
[ "${manifest_metadata#*:}" = '0:0' ] && (( (8#$manifest_mode & 022) == 0 )) || {
  echo 'ERRO: MANIFEST.sha256 precisa ser root-owned e não gravável por grupo/outros' >&2
  exit 1
}
while IFS= read -r source; do
  [ -f "$source" ] && [ ! -L "$source" ] || { echo 'ERRO: arquivo do manifesto ausente ou symlink' >&2; exit 1; }
  metadata="$(stat -c '%a:%u:%g' "$source" 2>/dev/null || true)"
  mode="${metadata%%:*}"; owner_group="${metadata#*:}"
  [ "$owner_group" = '0:0' ] || { echo 'ERRO: kit precisa ser integralmente root-owned' >&2; exit 1; }
  (( (8#$mode & 022) == 0 )) || { echo 'ERRO: arquivo do kit gravável por grupo/outros' >&2; exit 1; }
done < <(awk '{path=$2; sub(/^\.\//, "", path); print "'"$ROOT"'/" path}' "$ROOT/MANIFEST.sha256")

SCRIPT_SOURCES=(
  "$ROOT/scripts/health-watch.sh"
  "$ROOT/scripts/verify-storage-encryption.sh"
  "$ROOT/scripts/harden-docker-egress.sh"
  "$ROOT/scripts/egress-fail-closed.sh"
)
UNIT_NAMES=(
  kassinao-health-watch.service
  kassinao-health-watch.timer
  kassinao-docker-egress.service
  kassinao-egress-fail-closed.service
  kassinao-rollback-clean.service
  kassinao-rollback-clean.timer
)

for source in "${SCRIPT_SOURCES[@]}"; do
  [ -f "$source" ] && [ ! -L "$source" ] || { echo 'ERRO: controle do host ausente ou symlink' >&2; exit 1; }
done
for unit in "${UNIT_NAMES[@]}"; do
  if [ "$unit" = kassinao-rollback-clean.service ]; then
    source="$ROOT/deploy/systemd/kassinao-rollback-clean.service.in"
  else
    source="$ROOT/deploy/systemd/$unit"
  fi
  destination="/etc/systemd/system/$unit"
  dropin="$destination.d"
  [ -f "$source" ] && [ ! -L "$source" ] || { echo 'ERRO: unit do host ausente ou symlink' >&2; exit 1; }
  [ ! -L "$destination" ] || { echo "ERRO: unit instalada $unit não pode ser symlink" >&2; exit 1; }
  [ ! -e "$dropin" ] && [ ! -L "$dropin" ] || {
    echo "ERRO: drop-in não auditado para $unit" >&2
    exit 1
  }
done
for destination in \
  /usr/local/sbin/kassinao-health-watch \
  /usr/local/sbin/kassinao-verify-storage-encryption \
  /usr/local/sbin/kassinao-harden-docker-egress \
  /usr/local/sbin/kassinao-egress-fail-closed; do
  [ ! -L "$destination" ] || { echo "ERRO: controle instalado $destination não pode ser symlink" >&2; exit 1; }
done
DOCKER_DROPIN_SOURCE="$ROOT/deploy/systemd/docker.service.d/kassinao-egress.conf"
DOCKER_DROPIN_DIR=/etc/systemd/system/docker.service.d
DOCKER_DROPIN_DESTINATION="$DOCKER_DROPIN_DIR/kassinao-egress.conf"
[ -f "$DOCKER_DROPIN_SOURCE" ] && [ ! -L "$DOCKER_DROPIN_SOURCE" ] || {
  echo 'ERRO: drop-in Docker do egress ausente ou symlink' >&2
  exit 1
}
[ ! -L "$DOCKER_DROPIN_DIR" ] && [ ! -L "$DOCKER_DROPIN_DESTINATION" ] || {
  echo 'ERRO: drop-in Docker instalado não pode usar symlink' >&2
  exit 1
}
TMPFILES_SOURCE="$ROOT/deploy/tmpfiles.d/kassinao.conf"
TMPFILES_DESTINATION=/etc/tmpfiles.d/kassinao.conf
ROLLBACK_TMPFILES_TEMPLATE="$ROOT/deploy/tmpfiles.d/kassinao-rollback.conf.in"
ROLLBACK_TMPFILES_DESTINATION=/etc/tmpfiles.d/kassinao-rollback.conf
ROLLBACK_SERVICE_TEMPLATE="$ROOT/deploy/systemd/kassinao-rollback-clean.service.in"
ROLLBACK_SERVICE_DESTINATION=/etc/systemd/system/kassinao-rollback-clean.service
[ -f "$TMPFILES_SOURCE" ] && [ ! -L "$TMPFILES_SOURCE" ] || {
  echo 'ERRO: regra tmpfiles ausente ou symlink' >&2
  exit 1
}
[ -f "$ROLLBACK_TMPFILES_TEMPLATE" ] && [ ! -L "$ROLLBACK_TMPFILES_TEMPLATE" ] || {
  echo 'ERRO: template tmpfiles de rollback ausente ou symlink' >&2
  exit 1
}
[ -f "$ROLLBACK_SERVICE_TEMPLATE" ] && [ ! -L "$ROLLBACK_SERVICE_TEMPLATE" ] || {
  echo 'ERRO: template da unit de rollback ausente ou symlink' >&2
  exit 1
}
[ ! -L /etc/tmpfiles.d ] || { echo 'ERRO: /etc/tmpfiles.d não pode ser symlink' >&2; exit 1; }
install -d -o root -g root -m 0755 /etc/tmpfiles.d
[ -d /etc/tmpfiles.d ] && [ ! -L /etc/tmpfiles.d ] || {
  echo 'ERRO: /etc/tmpfiles.d precisa ser diretório real' >&2
  exit 1
}
[ ! -L "$TMPFILES_DESTINATION" ] || { echo 'ERRO: regra tmpfiles instalada não pode ser symlink' >&2; exit 1; }
[ ! -L "$ROLLBACK_TMPFILES_DESTINATION" ] || { echo 'ERRO: regra tmpfiles de rollback não pode ser symlink' >&2; exit 1; }
[ ! -L /run/lock/kassinao ] || { echo 'ERRO: diretório de locks não pode ser symlink' >&2; exit 1; }

env_value() {
  local key="$1" file="$2"
  awk -v key="$key" '
    index($0, key "=") == 1 { count++; value = substr($0, length(key) + 2) }
    END { if (count > 1) exit 2; print value }
  ' "$file" || { echo "ERRO: $key aparece mais de uma vez em $file" >&2; exit 1; }
}

ENV_FILE="$ROOT/.env"
[ -f "$ENV_FILE" ] && [ ! -L "$ENV_FILE" ] || { echo 'ERRO: .env privado ausente no kit' >&2; exit 1; }
host_scope="$(env_value KASSINAO_HOST_SCOPE "$ENV_FILE")"
[ "$host_scope" = dedicated ] || {
  echo 'ERRO: install-host-controls.sh pertence somente ao adapter dedicated; use install-shared-host-controls.sh no adapter shared' >&2
  exit 1
}
dedicated_host_ack="$(env_value KASSINAO_DEDICATED_DOCKER_HOST_ACK "$ENV_FILE")"
[ "$dedicated_host_ack" = I_UNDERSTAND_THIS_VPS_MUST_RUN_ONLY_KASSINAO ] || {
  echo 'ERRO: o drop-in afeta o docker.service inteiro; use VPS dedicada e defina KASSINAO_DEDICATED_DOCKER_HOST_ACK=I_UNDERSTAND_THIS_VPS_MUST_RUN_ONLY_KASSINAO' >&2
  exit 1
}
rollback_retention_hours="$(env_value KASSINAO_ROLLBACK_RETENTION_HOURS "$ENV_FILE")"
[[ "$rollback_retention_hours" =~ ^[1-9][0-9]*$ ]] && \
  [ "$rollback_retention_hours" -le 168 ] || {
  echo 'ERRO: KASSINAO_ROLLBACK_RETENTION_HOURS precisa ficar entre 1 e 168' >&2
  exit 1
}
# O timer roda a cada 30 minutos. Antecipar o limiar em 31 minutos mantém a
# remoção abaixo do máximo declarado sem transformar retenção de 1h em age=0.
rollback_cleanup_age="$((rollback_retention_hours * 60 - 31))min"
STORAGE_PATHS=()
for key in KASSINAO_DATA_ROOT KASSINAO_RECORDINGS_DIR KASSINAO_STATE_DIR KASSINAO_AUTH_DIR KASSINAO_MODEL_CACHE_DIR; do
  value="$(env_value "$key" "$ENV_FILE")"
  [[ "$value" =~ ^/[A-Za-z0-9._/-]+$ ]] || { echo "ERRO: $key precisa ser caminho absoluto simples" >&2; exit 1; }
  STORAGE_PATHS+=("$value")
done
data_root="${STORAGE_PATHS[0]}"
[ "$data_root" != / ] && [ "$data_root" != /var ] && [ "$data_root" != /var/lib ] || {
  echo 'ERRO: KASSINAO_DATA_ROOT precisa ser um diretório dedicado' >&2
  exit 1
}
case "$data_root" in *//* | */./* | */../* | */. | */.. | */) echo 'ERRO: KASSINAO_DATA_ROOT precisa ser canônico' >&2; exit 1 ;; esac
case "$data_root" in
  /home | /home/* | /root | /root/* | /run/user | /run/user/* | /tmp | /tmp/* | /var/tmp | /var/tmp/*)
    echo 'ERRO: KASSINAO_DATA_ROOT não pode ficar em área isolada por ProtectHome/PrivateTmp' >&2
    exit 1
    ;;
esac
[ -d "$data_root" ] && [ ! -L "$data_root" ] && [ "$(cd -- "$data_root" && pwd -P)" = "$data_root" ] || {
  echo 'ERRO: KASSINAO_DATA_ROOT precisa existir como diretório canônico, sem symlink' >&2
  exit 1
}
[ "${STORAGE_PATHS[1]}" = "$data_root/recordings" ] && \
  [ "${STORAGE_PATHS[2]}" = "$data_root/state" ] && \
  [ "${STORAGE_PATHS[3]}" = "$data_root/auth" ] && \
  [ "${STORAGE_PATHS[4]}" = "$data_root/cache" ] || {
  echo 'ERRO: mounts privados precisam ser filhos exatos de KASSINAO_DATA_ROOT' >&2
  exit 1
}
for path_name in "${STORAGE_PATHS[@]}"; do
  [ -d "$path_name" ] && [ ! -L "$path_name" ] && [ "$(cd -- "$path_name" && pwd -P)" = "$path_name" ] || {
    echo "ERRO: caminho de storage precisa existir e ser canônico: $path_name" >&2
    exit 1
  }
done
rollback_dir="$data_root/rollback"
[ ! -L "$rollback_dir" ] || { echo 'ERRO: diretório de rollback não pode ser symlink' >&2; exit 1; }
# Faça a prova antes de gravar qualquer controle no host. A cópia instalada é
# executada novamente abaixo para provar também o artefato privilegiado.
env -i "PATH=$PATH" "HOME=${HOME:-/root}" "$ROOT/scripts/verify-storage-encryption.sh" "${STORAGE_PATHS[@]}"
[ ! -L /etc/kassinao ] || { echo 'ERRO: /etc/kassinao não pode ser symlink' >&2; exit 1; }
install -d -o root -g root -m 0755 /etc/kassinao
STORAGE_PATHS_TMP="$(mktemp /etc/kassinao/.storage-paths.XXXXXX)"
ROLLBACK_TMPFILES_TMP="$(mktemp /etc/kassinao/.rollback-tmpfiles.XXXXXX)"
ROLLBACK_SERVICE_TMP="$(mktemp /etc/kassinao/.rollback-service.XXXXXX)"
HOST_CONTROLS_TMP="$(mktemp /etc/kassinao/.host-controls.XXXXXX)"
trap 'rm -f -- "${STORAGE_PATHS_TMP:-}" "${ROLLBACK_TMPFILES_TMP:-}" "${ROLLBACK_SERVICE_TMP:-}" "${HOST_CONTROLS_TMP:-}"' EXIT
printf '%s\n' "${STORAGE_PATHS[@]}" > "$STORAGE_PATHS_TMP"
install -o root -g root -m 0600 "$STORAGE_PATHS_TMP" /etc/kassinao/storage-paths
rm -f -- "$STORAGE_PATHS_TMP"; STORAGE_PATHS_TMP=''
printf 'KASSINAO_DEPLOY_DIR=%s\nKASSINAO_DATA_ROOT=%s\nKASSINAO_ROLLBACK_RETENTION_HOURS=%s\n' \
  "$ROOT" "$data_root" "$rollback_retention_hours" > "$HOST_CONTROLS_TMP"
install -o root -g root -m 0600 "$HOST_CONTROLS_TMP" /etc/kassinao/host-controls.env
rm -f -- "$HOST_CONTROLS_TMP"; HOST_CONTROLS_TMP=''
sed -e "s|@ROLLBACK_DIR@|$rollback_dir|g" \
  -e "s|@CLEANUP_AGE@|$rollback_cleanup_age|g" \
  "$ROLLBACK_TMPFILES_TEMPLATE" > "$ROLLBACK_TMPFILES_TMP"
grep -Fqx "d $rollback_dir 0700 root root mM:$rollback_cleanup_age -" "$ROLLBACK_TMPFILES_TMP" || {
  echo 'ERRO: regra tmpfiles de rollback gerada ficou inválida' >&2
  exit 1
}
install -o root -g root -m 0644 "$ROLLBACK_TMPFILES_TMP" "$ROLLBACK_TMPFILES_DESTINATION"
rm -f -- "$ROLLBACK_TMPFILES_TMP"; ROLLBACK_TMPFILES_TMP=''
sed -e "s|@ROLLBACK_DIR@|$rollback_dir|g" \
  -e "s|@RETENTION_HOURS@|$rollback_retention_hours|g" \
  -e "s|@CLEANUP_AGE@|$rollback_cleanup_age|g" \
  "$ROLLBACK_SERVICE_TEMPLATE" > "$ROLLBACK_SERVICE_TMP"
grep -Fqx "ReadWritePaths=$rollback_dir" "$ROLLBACK_SERVICE_TMP" || {
  echo 'ERRO: unit de rollback gerada ficou inválida' >&2
  exit 1
}
grep -Fqx "Environment=KASSINAO_ROLLBACK_RETENTION_HOURS=$rollback_retention_hours KASSINAO_ROLLBACK_CLEANUP_AGE=$rollback_cleanup_age" \
  "$ROLLBACK_SERVICE_TMP" || {
  echo 'ERRO: contrato de retenção da unit gerada ficou inválido' >&2
  exit 1
}
install -o root -g root -m 0644 "$ROLLBACK_SERVICE_TMP" "$ROLLBACK_SERVICE_DESTINATION"
rm -f -- "$ROLLBACK_SERVICE_TMP"; ROLLBACK_SERVICE_TMP=''

install -o root -g root -m 0755 "$ROOT/scripts/health-watch.sh" /usr/local/sbin/kassinao-health-watch
install -o root -g root -m 0755 "$ROOT/scripts/verify-storage-encryption.sh" /usr/local/sbin/kassinao-verify-storage-encryption
install -o root -g root -m 0755 "$ROOT/scripts/harden-docker-egress.sh" /usr/local/sbin/kassinao-harden-docker-egress
install -o root -g root -m 0755 "$ROOT/scripts/egress-fail-closed.sh" /usr/local/sbin/kassinao-egress-fail-closed
env -i "PATH=$PATH" "HOME=${HOME:-/root}" /usr/local/sbin/kassinao-verify-storage-encryption
install -o root -g root -m 0644 "$ROOT/deploy/systemd/kassinao-health-watch.service" /etc/systemd/system/
install -o root -g root -m 0644 "$ROOT/deploy/systemd/kassinao-health-watch.timer" /etc/systemd/system/
install -o root -g root -m 0644 "$ROOT/deploy/systemd/kassinao-docker-egress.service" /etc/systemd/system/
install -o root -g root -m 0644 "$ROOT/deploy/systemd/kassinao-egress-fail-closed.service" /etc/systemd/system/
install -o root -g root -m 0644 "$ROOT/deploy/systemd/kassinao-rollback-clean.timer" /etc/systemd/system/
install -d -o root -g root -m 0755 "$DOCKER_DROPIN_DIR"
install -o root -g root -m 0644 "$DOCKER_DROPIN_SOURCE" "$DOCKER_DROPIN_DESTINATION"
install -o root -g root -m 0644 "$TMPFILES_SOURCE" "$TMPFILES_DESTINATION"
systemd-tmpfiles --create "$TMPFILES_DESTINATION"
systemd-tmpfiles --create "$ROLLBACK_TMPFILES_DESTINATION"
[ -d /run/lock/kassinao ] && [ ! -L /run/lock/kassinao ] && \
  [ "$(stat -c '%a:%u:%g' /run/lock/kassinao)" = '700:0:0' ] || {
  echo 'ERRO: tmpfiles não materializou /run/lock/kassinao com segurança' >&2
  exit 1
}
[ -d "$rollback_dir" ] && [ ! -L "$rollback_dir" ] && \
  [ "$(stat -c '%a:%u:%g' "$rollback_dir")" = '700:0:0' ] || {
  echo 'ERRO: tmpfiles não materializou o diretório privado de rollback' >&2
  exit 1
}

systemctl daemon-reload

# O arquivo no disco não basta: prove que o manager carregou o pre-hook que
# fecha a janela entre o start do dockerd e as restart policies dos containers.
docker_dropins="$(systemctl show docker.service -p DropInPaths --value 2>/dev/null || true)"
tr ' ' '\n' <<<"$docker_dropins" | grep -Fqx -- "$DOCKER_DROPIN_DESTINATION" || {
  echo 'ERRO: systemd não carregou o drop-in de egress do Docker' >&2
  exit 1
}
docker_pre="$(systemctl show docker.service -p ExecStartPre --value 2>/dev/null || true)"
grep -Fq 'path=/usr/local/sbin/kassinao-harden-docker-egress ;' <<<"$docker_pre" && \
  grep -Fq 'argv[]=/usr/local/sbin/kassinao-harden-docker-egress --offline-preload ;' <<<"$docker_pre" && \
  grep -Fq 'path=/usr/local/sbin/kassinao-verify-storage-encryption ;' <<<"$docker_pre" || {
  echo 'ERRO: pre-hooks de storage/egress não estão efetivos no Docker' >&2
  exit 1
}
[ "$(systemctl show docker.service -p NeedDaemonReload --value 2>/dev/null || true)" = no ] || {
  echo 'ERRO: systemd ainda exige daemon-reload para o Docker' >&2
  exit 1
}
systemctl enable kassinao-health-watch.timer kassinao-docker-egress.service kassinao-rollback-clean.timer >/dev/null
systemctl reset-failed kassinao-docker-egress.service kassinao-egress-fail-closed.service 2>/dev/null || true
systemctl restart kassinao-docker-egress.service
systemctl restart kassinao-health-watch.timer
systemctl restart kassinao-rollback-clean.timer
# Executa uma limpeza já na instalação; o timer persistente garante a mesma
# janela mesmo quando nenhum deploy futuro acontece.
systemctl start kassinao-rollback-clean.service
if docker --host unix:///var/run/docker.sock inspect kassinao >/dev/null 2>&1; then
  systemctl start kassinao-health-watch.service
fi
systemctl is-active --quiet kassinao-docker-egress.service
systemctl is-active --quiet kassinao-health-watch.timer
systemctl is-active --quiet kassinao-rollback-clean.timer

cmp -s "$ROOT/scripts/health-watch.sh" /usr/local/sbin/kassinao-health-watch
cmp -s "$ROOT/scripts/verify-storage-encryption.sh" /usr/local/sbin/kassinao-verify-storage-encryption
cmp -s "$ROOT/scripts/harden-docker-egress.sh" /usr/local/sbin/kassinao-harden-docker-egress
cmp -s "$ROOT/scripts/egress-fail-closed.sh" /usr/local/sbin/kassinao-egress-fail-closed
cmp -s "$ROOT/deploy/systemd/kassinao-health-watch.service" /etc/systemd/system/kassinao-health-watch.service
cmp -s "$ROOT/deploy/systemd/kassinao-health-watch.timer" /etc/systemd/system/kassinao-health-watch.timer
cmp -s "$ROOT/deploy/systemd/kassinao-docker-egress.service" /etc/systemd/system/kassinao-docker-egress.service
cmp -s "$ROOT/deploy/systemd/kassinao-egress-fail-closed.service" /etc/systemd/system/kassinao-egress-fail-closed.service
[ "$(cat "$ROLLBACK_SERVICE_DESTINATION")" = "$(sed \
  -e "s|@ROLLBACK_DIR@|$rollback_dir|g" \
  -e "s|@RETENTION_HOURS@|$rollback_retention_hours|g" \
  -e "s|@CLEANUP_AGE@|$rollback_cleanup_age|g" \
  "$ROLLBACK_SERVICE_TEMPLATE")" ]
cmp -s "$ROOT/deploy/systemd/kassinao-rollback-clean.timer" /etc/systemd/system/kassinao-rollback-clean.timer
cmp -s "$DOCKER_DROPIN_SOURCE" "$DOCKER_DROPIN_DESTINATION"
cmp -s "$TMPFILES_SOURCE" "$TMPFILES_DESTINATION"
[ "$(cat "$ROLLBACK_TMPFILES_DESTINATION")" = "$(sed \
  -e "s|@ROLLBACK_DIR@|$rollback_dir|g" \
  -e "s|@CLEANUP_AGE@|$rollback_cleanup_age|g" \
  "$ROLLBACK_TMPFILES_TEMPLATE")" ]

[ "$(stat -c '%a:%u:%g' /usr/local/sbin/kassinao-health-watch)" = '755:0:0' ]
[ "$(stat -c '%a:%u:%g' /usr/local/sbin/kassinao-verify-storage-encryption)" = '755:0:0' ]
[ "$(stat -c '%a:%u:%g' /etc/kassinao/storage-paths)" = '600:0:0' ]
[ "$(stat -c '%a:%u:%g' /etc/kassinao/host-controls.env)" = '600:0:0' ]
[ "$(stat -c '%a:%u:%g' /usr/local/sbin/kassinao-harden-docker-egress)" = '755:0:0' ]
[ "$(stat -c '%a:%u:%g' /usr/local/sbin/kassinao-egress-fail-closed)" = '755:0:0' ]
for unit in "${UNIT_NAMES[@]}"; do
  [ "$(stat -c '%a:%u:%g' "/etc/systemd/system/$unit")" = '644:0:0' ]
done
[ "$(stat -c '%a:%u:%g' "$TMPFILES_DESTINATION")" = '644:0:0' ]
[ "$(stat -c '%a:%u:%g' "$ROLLBACK_TMPFILES_DESTINATION")" = '644:0:0' ]
[ "$(stat -c '%a:%u:%g' "$DOCKER_DROPIN_DESTINATION")" = '644:0:0' ]

echo 'Controles do host atualizados, persistentes e ativos.'
