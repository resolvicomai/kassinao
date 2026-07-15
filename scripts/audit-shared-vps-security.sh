#!/bin/bash -p
# Auditoria read-only do adapter shared. Este controle nunca instala units,
# altera o daemon/firewall nem muda o lifecycle de containers.
set -Eeuo pipefail
umask 077
die() { printf 'ERRO: %s\n' "$*" >&2; exit 1; }

# Preserve somente o seletor explícito do .env desta release. O restante do
# ambiente privilegiado, inclusive PATH e HOME herdados pelo sudo, é negado
# antes da primeira resolução de executável.
env_file_override_set=false
env_file_override=''
if [ "${KASSINAO_ENV_FILE+x}" = x ]; then
  env_file_override_set=true
  env_file_override="$KASSINAO_ENV_FILE"
fi
inherited_docker_environment_name=''
for inherited_name in DOCKER_HOST DOCKER_CONTEXT DOCKER_CONFIG DOCKER_TLS_VERIFY DOCKER_CERT_PATH DOCKER_API_VERSION; do
  if declare -p "$inherited_name" >/dev/null 2>&1; then
    inherited_docker_environment_name="$inherited_name"
    break
  fi
done
_saved_no_dump_marker="${KASSINAO_NO_DUMP_ACTIVE-}"
_saved_no_dump_preload="${LD_PRELOAD-}"
SAFE_SYSTEM_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
[ -r "/proc/$$/environ" ] || die '/proc é obrigatório para limpar o ambiente do audit shared'
while IFS='=' read -r -d '' inherited_name inherited_value; do
  unset "$inherited_name" 2>/dev/null || true
done < "/proc/$$/environ"
unset inherited_name inherited_value
export PATH="$SAFE_SYSTEM_PATH" HOME=/root LC_ALL=C
if [ "$env_file_override_set" = true ]; then export KASSINAO_ENV_FILE="$env_file_override"; fi
[ -z "$inherited_docker_environment_name" ] || \
  die "$inherited_docker_environment_name não pode vir do ambiente; o audit exige o daemon local da VPS"

_script_path="${BASH_SOURCE[0]}"
case "$_script_path" in /*) ;; ./*) _script_path="$PWD/${_script_path#./}" ;; *) _script_path="$PWD/$_script_path" ;; esac
case "$_script_path" in *//* | */./* | */../* | */. | */.. | */) die 'caminho do audit shared não é canônico' ;; esac
_script_dir="${_script_path%/*}"
case "$_script_dir" in */scripts) PROJECT_DIR="${_script_dir%/scripts}" ;; *) die 'audit shared precisa executar do kit selado' ;; esac
case "${MACHTYPE%%-*}" in x86_64) _no_dump_arch=amd64 ;; aarch64 | arm64) _no_dump_arch=arm64 ;; *) die 'arquitetura sem runtime no-dump' ;; esac
_no_dump_preload="$PROJECT_DIR/runtime/linux-$_no_dump_arch/libkassinao-no-dump.so"
# KASSINAO_HOST_NO_DUMP_BEGIN
if [ "$_saved_no_dump_marker" != "prctl-v1:$$" ] || [ "$_saved_no_dump_preload" != "$_no_dump_preload" ]; then
  exec /usr/bin/python3 "$PROJECT_DIR/scripts/no-dump-exec.py" \
    --bundle-root "$PROJECT_DIR" --script-relative scripts/audit-shared-vps-security.sh --arch "$_no_dump_arch" -- \
    "$_script_path" "$@"
fi
LD_PRELOAD="$_no_dump_preload"
export LD_PRELOAD
[ "$(ulimit -Sc)" = 0 ] && [ "$(ulimit -Hc)" = 0 ] || die 'core limit do audit shared não ficou selado'
IFS= read -r _no_dump_filter < "/proc/$$/coredump_filter" || _no_dump_filter=''
[[ "$_no_dump_filter" =~ ^0+$ ]] || die 'coredump_filter do audit shared não ficou selado'
# KASSINAO_HOST_NO_DUMP_END
unset _saved_no_dump_marker _saved_no_dump_preload _no_dump_filter _no_dump_arch _no_dump_preload _script_path _script_dir

ulimit -c 0 2>/dev/null || die 'não foi possível desabilitar core dumps do audit'
[ "$(ulimit -c)" = 0 ] || die 'core dump ulimit do audit não ficou em zero'

audit_mode=full
expected_existing_image=''
require_current_images=false
case "${1:-}" in
  '') ;;
  --preflight) audit_mode=preflight; shift ;;
  --neighbors-only) audit_mode=neighbors-only; shift ;;
  --uninstall-preflight) audit_mode=uninstall-preflight; shift ;;
  *) die 'uso: audit-shared-vps-security.sh [--preflight|--neighbors-only|--uninstall-preflight]' ;;
esac
while [ "$#" -gt 0 ]; do
  case "$1" in
    --require-current-images)
      [ "$audit_mode" = preflight ] || die '--require-current-images exige --preflight'
      require_current_images=true
      shift
      ;;
    --expected-existing-image)
      [ "$audit_mode" = preflight ] && [ "$#" -ge 2 ] || \
        die '--expected-existing-image exige --preflight e um digest'
      expected_existing_image="$2"
      shift 2
      ;;
    *) die 'uso: audit-shared-vps-security.sh [modo] [--require-current-images|--expected-existing-image IMAGE]'
      ;;
  esac
done
[ "$require_current_images" != true ] || [ -z "$expected_existing_image" ] || \
  die '--require-current-images e --expected-existing-image são mutuamente exclusivos'
[ "$(id -u)" -eq 0 ] || die 'execute o audit shared como root'
for command in awk cmp docker env find findmnt getconf getent grep ip iptables-save ip6tables-save lsblk python3 readlink sha256sum sort stat; do
  command -v "$command" >/dev/null 2>&1 || die "$command é obrigatório"
done

# O inventário precisa vir do daemon local da VPS. Contextos/configuração
# herdados já foram detectados e apagados antes do primeiro command lookup.
export DOCKER_HOST=unix:///var/run/docker.sock
unset DOCKER_CONTEXT DOCKER_TLS_VERIFY DOCKER_CERT_PATH DOCKER_API_VERSION

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
[ "$ROOT" = "$PROJECT_DIR" ] || die 'raiz canônica divergiu do kit selado'
DOCKER_CONFIG="$ROOT/deploy/docker-client"
DOCKER_CONFIG_FILE="$DOCKER_CONFIG/config.json"
[ -d "$DOCKER_CONFIG" ] && [ ! -L "$DOCKER_CONFIG" ] && \
  [ -f "$DOCKER_CONFIG_FILE" ] && [ ! -L "$DOCKER_CONFIG_FILE" ] || \
  die 'configuração isolada do cliente Docker está ausente ou irregular'
[ "$(sha256sum -- "$DOCKER_CONFIG_FILE" | awk '{print $1}')" = ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356 ] || \
  die 'configuração isolada do cliente Docker diverge do objeto vazio selado'
export DOCKER_CONFIG
ENV_FILE="${KASSINAO_ENV_FILE:-$ROOT/.env}"
[ "$ENV_FILE" = "$ROOT/.env" ] || die 'KASSINAO_ENV_FILE precisa apontar para o .env selado desta release'
COMPOSE_FILE="$ROOT/docker-compose.yml"
SHARED_COMPOSE_FILE="$ROOT/docker-compose.shared.yml"
HARDENER="$ROOT/scripts/harden-docker-egress.sh"
STORAGE_VERIFIER="$ROOT/scripts/verify-shared-luks-storage.sh"
ROLLBACK_CHECKER="$ROOT/scripts/check-shared-migration-rollback.sh"
DEDICATED_DROPIN=/etc/systemd/system/docker.service.d/kassinao-egress.conf
MANIFEST="$ROOT/MANIFEST.sha256"
case "${MACHTYPE%%-*}" in
  x86_64) no_dump_arch=linux-amd64 ;;
  aarch64 | arm64) no_dump_arch=linux-arm64 ;;
  *) die 'arquitetura do host não possui runtime no-dump selado' ;;
esac
no_dump_relative="runtime/$no_dump_arch/kassinao-no-dump"
no_dump_source="$ROOT/$no_dump_relative"
NO_DUMP_INSTALLED_DIR=/usr/local/libexec/kassinao
no_dump_installed="$NO_DUMP_INSTALLED_DIR/kassinao-no-dump"

[ -f "$ENV_FILE" ] && [ ! -L "$ENV_FILE" ] || die '.env privado ausente ou symlink'
[ -f "$COMPOSE_FILE" ] && [ ! -L "$COMPOSE_FILE" ] || die 'docker-compose.yml selado ausente ou symlink'
[ -f "$SHARED_COMPOSE_FILE" ] && [ ! -L "$SHARED_COMPOSE_FILE" ] || \
  die 'docker-compose.shared.yml selado ausente ou symlink'
for control in "$HARDENER" "$STORAGE_VERIFIER" "$ROLLBACK_CHECKER"; do
  [ -f "$control" ] && [ ! -L "$control" ] && [ -x "$control" ] || \
    die "controle ausente, sem execução ou symlink: $control"
done
[ -f "$MANIFEST" ] && [ ! -L "$MANIFEST" ] || die 'MANIFEST.sha256 ausente ou symlink'
[ -f "$no_dump_source" ] && [ ! -L "$no_dump_source" ] || \
  die "launcher no-dump da arquitetura do host ausente ou symlink: $no_dump_source"
no_dump_manifest_digest="$(awk -v wanted="$no_dump_relative" '
  { path=$2; sub(/^\.\//, "", path); if (path == wanted) { count++; digest=$1 } }
  END { if (count != 1 || digest !~ /^[0-9a-f]{64}$/) exit 2; print digest }
' "$MANIFEST")" || die 'launcher no-dump precisa aparecer exatamente uma vez no manifesto'
no_dump_source_digest="$(sha256sum -- "$no_dump_source" | awk '{ print $1 }')" || \
  die 'não foi possível calcular o hash do launcher no-dump do kit'
[ "$no_dump_source_digest" = "$no_dump_manifest_digest" ] || \
  die 'launcher no-dump do kit diverge do MANIFEST.sha256'
no_dump_helper_state=absent
if [ -e "$NO_DUMP_INSTALLED_DIR" ] || [ -L "$NO_DUMP_INSTALLED_DIR" ]; then
  [ -d "$NO_DUMP_INSTALLED_DIR" ] && [ ! -L "$NO_DUMP_INSTALLED_DIR" ] || \
    die 'diretório instalado do launcher no-dump é irregular'
  [ -f "$no_dump_installed" ] && [ ! -L "$no_dump_installed" ] || \
    die 'launcher no-dump instalado ausente ou irregular'
  [ "$(stat -c '%a:%u:%g' -- "$NO_DUMP_INSTALLED_DIR" 2>/dev/null || true)" = 755:0:0 ] || \
    die 'diretório instalado do launcher no-dump precisa ser 0755 root:root'
  mapfile -t no_dump_installed_entries < <(find "$NO_DUMP_INSTALLED_DIR" -mindepth 1 -maxdepth 1 -printf '%f\n' | sort)
  [ "${#no_dump_installed_entries[@]}" -eq 1 ] && \
    [ "${no_dump_installed_entries[0]}" = kassinao-no-dump ] || \
    die 'diretório instalado do launcher no-dump contém entradas extras'
  [ "$(stat -c '%a:%u:%g:%h' -- "$no_dump_installed" 2>/dev/null || true)" = 555:0:0:1 ] || \
    die 'launcher no-dump instalado precisa ser 0555 root:root sem hardlink'
  cmp -s -- "$no_dump_source" "$no_dump_installed" || \
    die 'launcher no-dump instalado diverge do runtime manifestado desta release'
  no_dump_helper_state=owned
fi
[ ! -e "$DEDICATED_DROPIN" ] || \
  die 'drop-in dedicado do docker.service presente no host compartilhado'

env_value() {
  local key="$1"
  awk -v key="$key" '
    index($0, key "=") == 1 { count++; value = substr($0, length(key) + 2) }
    END { if (count != 1) exit 2; print value }
  ' "$ENV_FILE" || die "$key precisa aparecer exatamente uma vez em .env"
}

[ "$(env_value KASSINAO_HOST_SCOPE)" = shared ] || \
  die 'KASSINAO_HOST_SCOPE precisa ser shared'
[ -z "$(env_value KASSINAO_DEDICATED_DOCKER_HOST_ACK)" ] || \
  die 'KASSINAO_DEDICATED_DOCKER_HOST_ACK precisa permanecer vazio no host shared'

image="$(env_value KASSINAO_IMAGE)"
[[ "$image" =~ ^ghcr\.io/[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$ ]] || \
  die 'KASSINAO_IMAGE precisa usar o digest OCI exato'
if [ -n "$expected_existing_image" ]; then
  [[ "$expected_existing_image" =~ ^ghcr\.io/[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$ ]] || \
    die '--expected-existing-image precisa usar digest OCI exato do app'
fi
cloudflared_image="$(awk '
  /^  cloudflared:$/ { in_service=1; next }
  in_service && /^    image: / { sub(/^    image: /, ""); print; exit }
  in_service && /^  [A-Za-z0-9_.-]+:$/ { exit }
' "$COMPOSE_FILE")"
[[ "$cloudflared_image" =~ ^cloudflare/cloudflared:[0-9][0-9A-Za-z._-]*@sha256:[0-9a-f]{64}$ ]] || \
  die 'imagem cloudflared selada não pôde ser derivada do Compose'

data_root="$(env_value KASSINAO_DATA_ROOT)"
recordings="$(env_value KASSINAO_RECORDINGS_DIR)"
state="$(env_value KASSINAO_STATE_DIR)"
auth="$(env_value KASSINAO_AUTH_DIR)"
cache="$(env_value KASSINAO_MODEL_CACHE_DIR)"
app_env="$(env_value KASSINAO_SHARED_APP_ENV_FILE)"
tunnel_token_file="$(env_value KASSINAO_SHARED_TUNNEL_TOKEN_FILE)"
backing_file="$(env_value KASSINAO_SHARED_LUKS_BACKING_FILE)"
uid="$(env_value KASSINAO_UID)"
gid="$(env_value KASSINAO_GID)"
for value in "$data_root" "$recordings" "$state" "$auth" "$cache" "$app_env" "$tunnel_token_file" "$backing_file"; do
  [[ "$value" =~ ^/[A-Za-z0-9._/-]+$ ]] || die 'paths privados precisam ser absolutos e simples'
done
[ "$recordings" = "$data_root/recordings" ] && \
  [ "$state" = "$data_root/state" ] && \
  [ "$auth" = "$data_root/auth" ] && \
  [ "$cache" = "$data_root/cache" ] && \
  [ "$app_env" = "$data_root/config/app.env" ] && \
  [ "$tunnel_token_file" = "$data_root/config/cloudflared-token" ] || \
  die 'mounts privados precisam ser filhos exatos de KASSINAO_DATA_ROOT'
[[ "$uid" =~ ^[0-9]+$ ]] && [ "$uid" -ge 61000 ] && [ "$uid" -le 61183 ] ||
  die 'KASSINAO_UID shared precisa ser explícito e ficar na faixa privada 61000..61183'
[[ "$gid" =~ ^[0-9]+$ ]] && [ "$gid" -ge 61000 ] && [ "$gid" -le 61183 ] ||
  die 'KASSINAO_GID shared precisa ser explícito e ficar na faixa privada 61000..61183'

assert_identity_database_absent() {
  local database="$1" value="$2" status
  if getent "$database" "$value" >/dev/null 2>&1; then
    die 'UID/GID shared colide com identidade já registrada no host'
  else
    status=$?
    [ "$status" -eq 2 ] || die 'não foi possível provar ausência de UID/GID no NSS do host'
  fi
}
for identity_value in "$uid" "$gid"; do
  assert_identity_database_absent passwd "$identity_value"
  assert_identity_database_absent group "$identity_value"
done
assert_subid_absent() {
  local file="$1" value="$2" status
  [ ! -e "$file" ] && [ ! -L "$file" ] && return 0
  [ -f "$file" ] && [ ! -L "$file" ] || die 'mapa subordinate-id do host é irregular'
  if awk -F: -v value="$value" '
    NF == 0 { next }
    NF != 3 || $2 !~ /^[0-9]+$/ || $3 !~ /^[1-9][0-9]*$/ { exit 3 }
    { start=$2 + 0; count=$3 + 0; if (value >= start && value < start + count) exit 2 }
  ' "$file"; then
    return 0
  else
    status=$?
    [ "$status" -ne 2 ] || die 'UID/GID shared colide com faixa subordinate-id já reservada no host'
    die 'mapa subordinate-id do host não pôde ser validado'
  fi
}
for identity_value in "$uid" "$gid"; do
  assert_subid_absent /etc/subuid "$identity_value"
  assert_subid_absent /etc/subgid "$identity_value"
done
PROC_ROOT=/proc
[ -d "$PROC_ROOT" ] && [ ! -L "$PROC_ROOT" ] || die '/proc é obrigatório para provar a exclusividade do UID/GID shared'

host_port="$(env_value KASSINAO_HOST_PORT)"
public_host_port="$(env_value KASSINAO_PUBLIC_HOST_PORT)"
[[ "$host_port" =~ ^[0-9]+$ ]] && [ "$host_port" -ge 1 ] && [ "$host_port" -le 65535 ] || \
  die 'KASSINAO_HOST_PORT inválida'
[[ "$public_host_port" =~ ^[0-9]+$ ]] && [ "$public_host_port" -ge 1 ] && [ "$public_host_port" -le 65535 ] || \
  die 'KASSINAO_PUBLIC_HOST_PORT inválida'

profiles="$(env_value COMPOSE_PROFILES)"
profile_enabled() { case ",$profiles," in *",$1,"*) return 0 ;; *) return 1 ;; esac; }
expected_services=kassinao
profile_enabled split-public && expected_services+=,kassinao-public
profile_enabled tunnel && expected_services+=,cloudflared

# O overlay selado precisa consumir cada limite explícito exatamente onde o
# contrato espera. O inventário abaixo compara depois os bytes/NanoCPUs reais
# do daemon com estes mesmos valores do compose.env.
for resource_line in \
  '    mem_limit: ${KASSINAO_CORE_MEMORY_LIMIT:?Defina KASSINAO_CORE_MEMORY_LIMIT no compose.env}' \
  '    memswap_limit: ${KASSINAO_CORE_MEMORY_LIMIT:?Defina KASSINAO_CORE_MEMORY_LIMIT no compose.env}' \
  '    cpus: ${KASSINAO_CORE_CPUS:?Defina KASSINAO_CORE_CPUS no compose.env}' \
  '    mem_limit: ${KASSINAO_PUBLIC_MEMORY_LIMIT:?Defina KASSINAO_PUBLIC_MEMORY_LIMIT no compose.env}' \
  '    memswap_limit: ${KASSINAO_PUBLIC_MEMORY_LIMIT:?Defina KASSINAO_PUBLIC_MEMORY_LIMIT no compose.env}' \
  '    cpus: ${KASSINAO_PUBLIC_CPUS:?Defina KASSINAO_PUBLIC_CPUS no compose.env}' \
  '    mem_limit: ${KASSINAO_TUNNEL_MEMORY_LIMIT:?Defina KASSINAO_TUNNEL_MEMORY_LIMIT no compose.env}' \
  '    memswap_limit: ${KASSINAO_TUNNEL_MEMORY_LIMIT:?Defina KASSINAO_TUNNEL_MEMORY_LIMIT no compose.env}' \
  '    cpus: ${KASSINAO_TUNNEL_CPUS:?Defina KASSINAO_TUNNEL_CPUS no compose.env}'
do
  [ "$(grep -Fxc -- "$resource_line" "$SHARED_COMPOSE_FILE")" -eq 1 ] || \
    die 'docker-compose.shared.yml diverge do contrato explícito de CPU/RAM'
done
for resource_key in mem_limit memswap_limit cpus; do
  [ "$(grep -Ec "^    ${resource_key}:" "$SHARED_COMPOSE_FILE")" -eq 3 ] || \
    die 'docker-compose.shared.yml contém limite de CPU/RAM extra ou ausente'
done
runtime_identity_line="    user: '\${KASSINAO_UID:?Defina um UID privado do adapter shared}:\${KASSINAO_GID:?Defina um GID privado do adapter shared}'"
[ "$(grep -Fxc -- "$runtime_identity_line" "$SHARED_COMPOSE_FILE")" -eq 2 ] ||
  die 'docker-compose.shared.yml precisa exigir UID/GID privados nos dois serviços da aplicação'
[ "$(grep -Fxc -- "    user: '65532:65532'" "$SHARED_COMPOSE_FILE")" -eq 1 ] ||
  die 'docker-compose.shared.yml precisa selar cloudflared como 65532:65532'
core_memory_limit="$(env_value KASSINAO_CORE_MEMORY_LIMIT)"
core_cpu_limit="$(env_value KASSINAO_CORE_CPUS)"
public_memory_limit="$(env_value KASSINAO_PUBLIC_MEMORY_LIMIT)"
public_cpu_limit="$(env_value KASSINAO_PUBLIC_CPUS)"
tunnel_memory_limit="$(env_value KASSINAO_TUNNEL_MEMORY_LIMIT)"
tunnel_cpu_limit="$(env_value KASSINAO_TUNNEL_CPUS)"

MEMINFO_FILE=/proc/meminfo
[ -r "$MEMINFO_FILE" ] || die 'não foi possível ler a memória física do host'
host_memory_kib="$(awk '$1 == "MemTotal:" && $2 ~ /^[0-9]+$/ { if (seen++) exit 2; value=$2 } END { if (seen != 1) exit 2; print value }' "$MEMINFO_FILE")" || \
  die 'MemTotal do host está ausente ou inválido'
host_cpu_count="$(getconf _NPROCESSORS_ONLN)" || die 'não foi possível ler CPUs online do host'
[[ "$host_cpu_count" =~ ^[1-9][0-9]*$ ]] || die 'quantidade de CPUs online do host é inválida'

# Processos host-side (injector, backup, auditor e migrador) também manipulam
# segredos. Swap plaintext invalidaria a garantia at-rest mesmo com DATA_ROOT
# em LUKS. File swap é recusado; device swap só é aceito quando a cadeia lsblk
# contém explicitamente um target dm-crypt.
SWAP_INVENTORY=/proc/swaps
[ -r "$SWAP_INVENTORY" ] || die 'não foi possível ler o inventário de swap ativo'
swap_entries="$(awk '
  NR == 1 { next }
  NF != 5 { exit 2 }
  { print $1 "|" $2 }
' "$SWAP_INVENTORY")" || die 'inventário de swap ativo inválido'
if [ -n "$swap_entries" ]; then
  while IFS='|' read -r swap_source swap_type; do
    [ "$swap_type" = partition ] && [[ "$swap_source" =~ ^/dev/[A-Za-z0-9._/+:-]+$ ]] ||
      die 'host shared possui swap ativo sem prova dm-crypt'
    canonical_swap="$(readlink -f -- "$swap_source" 2>/dev/null || true)"
    [[ "$canonical_swap" =~ ^/dev/[A-Za-z0-9._/+:-]+$ ]] ||
      die 'device de swap ativo não possui caminho canônico seguro'
    swap_types="$(lsblk -s -n -o TYPE -- "$canonical_swap" 2>/dev/null)" ||
      die 'não foi possível inventariar a cadeia do swap ativo'
    grep -Fxq crypt <<<"$swap_types" || die 'host shared possui swap ativo fora de dm-crypt'
  done <<<"$swap_entries"
fi

CORE_PATTERN_FILE=/proc/sys/kernel/core_pattern
[ -r "$CORE_PATTERN_FILE" ] || die 'não foi possível ler kernel.core_pattern'
IFS= read -r core_pattern < "$CORE_PATTERN_FILE" || die 'kernel.core_pattern inválido'
[ -n "$core_pattern" ] && [[ "$core_pattern" != *$'\n'* ]] || die 'kernel.core_pattern vazio ou inválido'
# O operador precisa avaliar os workloads vizinhos e aplicar/persistir o estado
# global pelo runbook privado antes dos controles públicos. neighbors-only
# tolera outro destino não-pipe apenas como compatibilidade de diagnóstico;
# preflight/full/uninstall detectam drift e exigem /dev/null exatamente.
if [ "$audit_mode" = neighbors-only ]; then
  [[ "$core_pattern" != '|'* ]] ||
    die 'kernel.core_pattern em pipe é incompatível com o isolamento process-scoped do host shared'
else
  [ "$core_pattern" = /dev/null ] || die 'host shared exige kernel.core_pattern=/dev/null'
fi
SUID_DUMPABLE_FILE=/proc/sys/fs/suid_dumpable
[ -r "$SUID_DUMPABLE_FILE" ] || die 'não foi possível ler fs.suid_dumpable'
IFS= read -r suid_dumpable < "$SUID_DUMPABLE_FILE" || die 'fs.suid_dumpable inválido'
[ "$suid_dumpable" = 0 ] || die 'host shared exige fs.suid_dumpable=0'
# Processos próprios mantêm
# RLIMIT_CORE hard/soft em zero e containers são auditados com core=0.

# Reserve estes nomes no kernel e no firewall antes do primeiro deploy. O
# preflight aceita somente o estado totalmente ausente ou a topologia oficial
# completa, permitindo upgrade sem transformar estado parcial em estado válido.
linux_links_json="$(ip -j -details link show)" || die 'não foi possível inventariar interfaces Linux'
ipv4_filter_rules="$(iptables-save -t filter)" || die 'não foi possível inventariar chains IPv4'
ipv6_filter_rules="$(ip6tables-save -t filter)" || die 'não foi possível inventariar chains IPv6'

docker_forward_hook_is_stable() {
  awk '
    $1 == "-A" && $2 == "FORWARD" {
      position++
      if ($0 == "-A FORWARD -j DOCKER-USER") {
        matches++
        if (position == 1) first = 1
      }
    }
    END { exit (matches == 1 && first == 1) ? 0 : 1 }
  ' <<<"$1"
}
docker_forward_hook_is_stable "$ipv4_filter_rules" &&
  docker_forward_hook_is_stable "$ipv6_filter_rules" ||
  die 'host shared exige FORWARD -> DOCKER-USER exato, único e já provisionado; o adapter não altera o hook global'

reserved_firewall_present=false
if [[ "$ipv4_filter_rules" == *KASSINAO-* || "$ipv6_filter_rules" == *KASSINAO-* ]]; then
  reserved_firewall_present=true
fi

# O migrador precisa provar a fronteira dos workloads vizinhos antes de montar
# ou copiar qualquer dado. Nesse modo, storage e policy próprios ainda não
# existem; os demais modos preservam a prova read-only do storage.
if [ "$audit_mode" != neighbors-only ]; then
  env -i "PATH=$PATH" HOME=/root "KASSINAO_ENV_FILE=$ENV_FILE" "$STORAGE_VERIFIER" >/dev/null || \
    die 'storage shared não passou na prova LUKS/sentinel'
fi
if [ "$audit_mode" = full ] || [ "$audit_mode" = uninstall-preflight ] || [ "$reserved_firewall_present" = true ]; then
  env -i "PATH=$PATH" HOME=/root "$HARDENER" --shared-host --check >/dev/null || \
    die 'policy de egress da kas-private0 está ausente ou divergente'
fi
if [ "$audit_mode" = full ]; then
  env -i "PATH=$PATH" HOME=/root "KASSINAO_ENV_FILE=$ENV_FILE" "$ROLLBACK_CHECKER" >/dev/null || \
    die 'ciclo de vida do rollback plaintext está inválido ou expirado'
fi

docker info --format '{{.ServerVersion}}' >/dev/null 2>&1 || \
  die 'daemon Docker local indisponível'

env -i "PATH=$PATH" HOME=/root LC_ALL=C "LD_PRELOAD=${LD_PRELOAD-}" \
  DOCKER_HOST=unix:///var/run/docker.sock "DOCKER_CONFIG=$DOCKER_CONFIG" python3 - \
  "$audit_mode" "$image" "$cloudflared_image" "$expected_services" "$expected_existing_image" "$require_current_images" \
  "$recordings" "$state" "$auth" "$cache" \
  "$app_env" "$tunnel_token_file" "$data_root/.kassinao-mounted" "$host_port" "$public_host_port" "$data_root" "$backing_file" \
  "$ROOT" \
  "$no_dump_installed" "$no_dump_helper_state" \
  "$core_memory_limit" "$core_cpu_limit" "$public_memory_limit" "$public_cpu_limit" \
  "$tunnel_memory_limit" "$tunnel_cpu_limit" "$host_memory_kib" "$host_cpu_count" \
  "$uid" "$gid" "$PROC_ROOT" \
  7<<<"$linux_links_json" 8<<<"$ipv4_filter_rules" 9<<<"$ipv6_filter_rules" <<'PY' || \
  die 'inventário Docker viola o contrato do adapter shared'
import json
import os
import re
import stat
import subprocess
import sys

(
    audit_mode,
    expected_image,
    expected_cloudflared_image,
    expected_services_raw,
    expected_existing_image,
    require_current_images_raw,
    recordings,
    state,
    auth,
    cache,
    app_env,
    tunnel_token_file,
    sentinel,
    host_port,
    public_host_port,
    data_root,
    backing_file,
    release_root,
    no_dump_installed,
    no_dump_helper_state,
    core_memory_limit,
    core_cpu_limit,
    public_memory_limit,
    public_cpu_limit,
    tunnel_memory_limit,
    tunnel_cpu_limit,
    host_memory_kib_raw,
    host_cpu_count_raw,
    runtime_uid_raw,
    runtime_gid_raw,
    proc_root,
) = sys.argv[1:]
require_current_images = require_current_images_raw == 'true'
runtime_uid, runtime_gid = int(runtime_uid_raw), int(runtime_gid_raw)


def fail(message):
    print(f'ERRO: {message}', file=sys.stderr)
    raise SystemExit(1)


def process_output(command, label, limit, environment):
    try:
        process = subprocess.Popen(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env=environment,
        )
        assert process.stdout is not None
        payload = process.stdout.read(limit + 1)
        if len(payload) > limit:
            process.kill()
            process.wait()
            fail(f'{label} excedeu o limite seguro')
        status = process.wait()
    except OSError:
        fail(f'{label} não pôde ser obtido')
    if status != 0:
        fail(f'{label} não pôde ser obtido')
    try:
        return payload.decode('utf-8')
    except UnicodeDecodeError:
        fail(f'{label} não retornou UTF-8 válido')


def docker_output(arguments, label, limit=64 * 1024 * 1024):
    environment = {
        key: value for key, value in os.environ.items()
        if key in {'PATH', 'HOME', 'LC_ALL', 'LD_PRELOAD', 'DOCKER_HOST', 'DOCKER_CONFIG'}
    }
    return process_output(['docker', *arguments], label, limit, environment)


def host_output(arguments, label, limit=8 * 1024 * 1024):
    environment = {
        key: value for key, value in os.environ.items()
        if key in {'PATH', 'HOME', 'LC_ALL', 'LD_PRELOAD'}
    }
    return process_output(arguments, label, limit, environment)


def docker_lines(arguments, label, pattern):
    raw = docker_output(arguments, label, 8 * 1024 * 1024)
    result = [line for line in raw.splitlines() if line]
    if any(re.fullmatch(pattern, line) is None for line in result) or len(result) != len(set(result)):
        fail(f'{label} retornou identificador inválido ou duplicado')
    return result


def docker_json(arguments, label):
    try:
        value = json.loads(docker_output(arguments, label))
    except (TypeError, ValueError):
        fail(f'{label} não retornou JSON válido')
    if not isinstance(value, list):
        fail(f'{label} não retornou uma lista JSON')
    return value


def docker_json_lines(arguments, label):
    raw = docker_output(arguments, label)
    result = []
    try:
        for line in raw.splitlines():
            if line:
                result.append(json.loads(line))
    except (TypeError, ValueError):
        fail(f'{label} não retornou JSON line-delimited válido')
    return result


def host_mount_targets():
    try:
        inventory = json.loads(host_output(
            ['findmnt', '--json', '--output', 'TARGET'],
            'inventário de mountpoints do host',
        ))
    except (TypeError, ValueError):
        fail('inventário de mountpoints do host não retornou JSON válido')
    if not isinstance(inventory, dict) or set(inventory) != {'filesystems'}:
        fail('inventário de mountpoints do host possui estrutura inválida')
    roots = inventory.get('filesystems')
    if not isinstance(roots, list):
        fail('inventário de mountpoints do host possui raiz inválida')
    targets = set()
    pending = list(roots)
    visited = 0
    while pending:
        node = pending.pop()
        visited += 1
        if visited > 131072 or not isinstance(node, dict) or set(node) - {'target', 'children'}:
            fail('inventário de mountpoints do host possui entrada inválida')
        target = node.get('target')
        if (
            not isinstance(target, str)
            or not target.startswith('/')
            or any(ord(character) < 32 or ord(character) == 127 for character in target)
        ):
            fail('inventário de mountpoints do host possui target inválido')
        targets.add(os.path.realpath(os.path.normpath(target)))
        children = node.get('children', [])
        if not isinstance(children, list):
            fail('inventário de mountpoints do host possui children inválido')
        pending.extend(children)
    return targets


docker_root_dir_raw = docker_output(['info', '--format', '{{.DockerRootDir}}'], 'DockerRootDir efetivo', 64 * 1024).strip()
if not docker_root_dir_raw.startswith('/') or '\n' in docker_root_dir_raw or '\x00' in docker_root_dir_raw:
    fail('DockerRootDir efetivo precisa ser caminho absoluto único')
docker_root_dir = os.path.realpath(os.path.normpath(docker_root_dir_raw))
container_ids = docker_lines(['ps', '-aq', '--no-trunc'], 'inventário de IDs de containers', r'[0-9a-f]{64}')
container_projection = (
    r'{"Id":{{json .Id}},"Name":{{json .Name}},"Config":{"User":{{json .Config.User}},"Labels":{'
    r'"com.docker.compose.project":{{json (index .Config.Labels "com.docker.compose.project")}},'
    r'"com.docker.compose.service":{{json (index .Config.Labels "com.docker.compose.service")}}}},'
    r'"HostConfig":{"Privileged":{{json .HostConfig.Privileged}},'
    r'"NetworkMode":{{json .HostConfig.NetworkMode}},"PidMode":{{json .HostConfig.PidMode}},'
    r'"IpcMode":{{json .HostConfig.IpcMode}},"UTSMode":{{json .HostConfig.UTSMode}},'
    r'"HasDevices":{{if .HostConfig.Devices}}true{{else}}false{{end}},'
    r'"HasDeviceCgroupRules":{{if .HostConfig.DeviceCgroupRules}}true{{else}}false{{end}},'
    r'"HasDeviceRequests":{{if .HostConfig.DeviceRequests}}true{{else}}false{{end}},'
    r'"CapAdd":{{json .HostConfig.CapAdd}},'
    r'"HasVolumesFrom":{{if .HostConfig.VolumesFrom}}true{{else}}false{{end}}},'
    r'"Mounts":[{{range $index, $mount := .Mounts}}{{if $index}},{{end}}{'
    r'"Type":{{json $mount.Type}},"Name":{{json $mount.Name}},"Driver":{{json $mount.Driver}},'
    r'"Source":{{json $mount.Source}},"Destination":{{json $mount.Destination}},'
    r'"RW":{{json $mount.RW}},"Propagation":{{json $mount.Propagation}}}{{end}}],'
    r'"State":{"Running":{{json .State.Running}},"Pid":{{json .State.Pid}}},"NetworkAttachments":['
    r'{{$first := true}}{{range $name, $network := .NetworkSettings.Networks}}'
    r'{{if not $first}},{{end}}{{$first = false}}{'
    r'"Name":{{json $name}},"NetworkID":{{json $network.NetworkID}},'
    r'"EndpointID":{{json $network.EndpointID}},"Gateway":{{json $network.Gateway}},'
    r'"IPAddress":{{json $network.IPAddress}},"GlobalIPv6Address":{{json $network.GlobalIPv6Address}}}'
    r'{{end}}]}'
)
items = docker_json_lines(
    ['inspect', '--format', container_projection, *container_ids],
    'projeção sanitizada de containers',
) if container_ids else []
if len(items) != len(container_ids):
    fail('projeção sanitizada de containers retornou cardinalidade divergente')
expected_project_names = {
    'kassinao': '/kassinao',
    'kassinao-public': '/kassinao-public',
    'cloudflared': '/kassinao-tunnel',
}
container_ids_set = set(container_ids)
if any(not isinstance(item, dict) for item in items):
    fail('entrada de container Docker inválida')
project_identity = {}
for item in items:
    item_id = item.get('Id')
    if not isinstance(item_id, str) or item_id not in container_ids_set:
        fail('projeção de container retornou ID ausente ou inesperado')
    attachments = item.pop('NetworkAttachments', None)
    if not isinstance(attachments, list):
        fail('projeção de redes do container é inválida')
    networks_by_name = {}
    for attachment in attachments:
        if not isinstance(attachment, dict):
            fail('attachment de rede do container é inválido')
        network_name = attachment.pop('Name', None)
        if not isinstance(network_name, str) or not network_name or network_name in networks_by_name:
            fail('attachment de rede do container tem nome ausente ou duplicado')
        networks_by_name[network_name] = attachment
    item['NetworkSettings'] = {'Networks': networks_by_name}
    labels = ((item.get('Config') or {}).get('Labels') or {})
    project_label = labels.get('com.docker.compose.project')
    service = labels.get('com.docker.compose.service')
    name = item.get('Name')
    if project_label == 'kassinao':
        if service not in expected_project_names or name != expected_project_names[service]:
            fail('identidade reservada do projeto kassinao é inválida')
        if service in project_identity:
            fail('identidade reservada do projeto kassinao está duplicada')
        project_identity[service] = item_id
    elif isinstance(name, str) and name in expected_project_names.values():
        fail('nome reservado do kassinao pertence a outro projeto')

project_detail_projection = (
    r'{"Id":{{json .Id}},"Config":{"Image":{{json .Config.Image}},'
    r'"User":{{json .Config.User}},"Env":{{json .Config.Env}},'
    r'"Entrypoint":{{json .Config.Entrypoint}},"Cmd":{{json .Config.Cmd}}},'
    r'"HostConfig":{"CapDrop":{{json .HostConfig.CapDrop}},'
    r'"SecurityOpt":{{json .HostConfig.SecurityOpt}},"ReadonlyRootfs":{{json .HostConfig.ReadonlyRootfs}},'
    r'"Memory":{{json .HostConfig.Memory}},"MemorySwap":{{json .HostConfig.MemorySwap}},'
    r'"MemorySwappiness":{{json .HostConfig.MemorySwappiness}},"NanoCpus":{{json .HostConfig.NanoCpus}},'
    r'"PidsLimit":{{json .HostConfig.PidsLimit}},"Ulimits":{{json .HostConfig.Ulimits}},'
    r'"LogConfig":{"Type":{{json .HostConfig.LogConfig.Type}},"Config":{{json .HostConfig.LogConfig.Config}}},'
    r'"RestartPolicy":{"Name":{{json .HostConfig.RestartPolicy.Name}}},'
    r'"PortBindings":{{json .HostConfig.PortBindings}}},'
    r'"State":{"Health":{"Status":{{if .State.Health}}{{json .State.Health.Status}}{{else}}null{{end}}}}}'
)
project_ids = [project_identity[service] for service in sorted(project_identity)]
project_details = docker_json_lines(
    ['inspect', '--format', project_detail_projection, *project_ids],
    'projeção privada dos containers Kassinão',
) if project_ids else []
if len(project_details) != len(project_ids):
    fail('projeção privada dos containers Kassinão retornou cardinalidade divergente')
details_by_id = {}
for detail in project_details:
    if not isinstance(detail, dict) or detail.get('Id') not in project_ids or detail.get('Id') in details_by_id:
        fail('projeção privada dos containers Kassinão retornou identidade inválida')
    details_by_id[detail['Id']] = detail
for item in items:
    detail = details_by_id.get(item['Id'])
    if detail is None:
        continue
    item['Config'].update(detail.get('Config') or {})
    item['HostConfig'].update(detail.get('HostConfig') or {})
    item['State'].update(detail.get('State') or {})
network_ids = docker_lines(['network', 'ls', '-q', '--no-trunc'], 'inventário de IDs de redes', r'[0-9a-f]{64}')
network_projection = (
    r'{"Id":{{json .Id}},"Name":{{json .Name}},"Driver":{{json .Driver}},'
    r'"Internal":{{json .Internal}},"IPAM":{"Driver":{{json .IPAM.Driver}},"Config":{{json .IPAM.Config}}},'
    r'"BridgeName":{{json (index .Options "com.docker.network.bridge.name")}},'
    r'"GatewayModeIPv4":{{json (index .Options "com.docker.network.bridge.gateway_mode_ipv4")}},'
    r'"GatewayModeIPv6":{{json (index .Options "com.docker.network.bridge.gateway_mode_ipv6")}},'
    r'"ComposeProject":{{json (index .Labels "com.docker.compose.project")}},'
    r'"ComposeNetwork":{{json (index .Labels "com.docker.compose.network")}},"Containers":['
    r'{{$first := true}}{{range $id, $member := .Containers}}{{if not $first}},{{end}}{{$first = false}}{'
    r'"Id":{{json $id}},"Name":{{json $member.Name}},"EndpointID":{{json $member.EndpointID}},'
    r'"IPv4Address":{{json $member.IPv4Address}},"IPv6Address":{{json $member.IPv6Address}}}{{end}}]}'
)
networks = docker_json_lines(
    ['network', 'inspect', '--format', network_projection, *network_ids],
    'projeção sanitizada de redes Docker',
) if network_ids else []
volume_names = docker_lines(['volume', 'ls', '-q'], 'inventário de nomes de volumes', r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}')
volume_projection = (
    r'{"Name":{{json .Name}},"Driver":{{json .Driver}},"Scope":{{json .Scope}},'
    r'"Mountpoint":{{json .Mountpoint}},"HasOptions":{{if .Options}}true{{else}}false{{end}},'
    r'"OptionType":{{if eq .Driver "local"}}{{json (index .Options "type")}}{{else}}null{{end}},'
    r'"OptionDevice":{{if eq .Driver "local"}}{{json (index .Options "device")}}{{else}}null{{end}}}'
)
raw_volumes = docker_json_lines(
    ['volume', 'inspect', '--format', volume_projection, *volume_names],
    'projeção sanitizada de volumes Docker',
) if volume_names else []

image_environment_map = {}
project_images = set()
for item in items:
    if not isinstance(item, dict):
        fail('entrada de container Docker inválida')
    config = item.get('Config') or {}
    labels = config.get('Labels') or {}
    if labels.get('com.docker.compose.project') == 'kassinao':
        service = labels.get('com.docker.compose.service')
        image_name = config.get('Image')
        if service in {'kassinao', 'kassinao-public', 'cloudflared'} and isinstance(image_name, str):
            project_images.add(image_name)
for image_name in project_images:
    if re.fullmatch(r'[a-z0-9][a-z0-9._/-]*(?::[0-9A-Za-z._-]+)?@sha256:[0-9a-f]{64}', image_name) is None:
        continue
    try:
        entries = json.loads(docker_output(
            ['image', 'inspect', image_name, '--format', '{{json .Config.Env}}'],
            'ambiente padrão de imagem',
            8 * 1024 * 1024,
        ))
    except (TypeError, ValueError):
        fail('ambiente padrão de imagem existente retornou JSON inválido')
    image_environment_map[image_name] = entries


def parse_memory_limit(raw, label):
    match = re.fullmatch(r'([1-9][0-9]*)([bkmg])', raw.lower())
    if match is None:
        fail(f'{label} precisa ser inteiro positivo com unidade b, k, m ou g; unlimited é proibido')
    multiplier = {'b': 1, 'k': 1024, 'm': 1024**2, 'g': 1024**3}[match.group(2)]
    return int(match.group(1)) * multiplier


def parse_cpu_limit(raw, label):
    match = re.fullmatch(r'(?:0|[1-9][0-9]*)(?:\.([0-9]{1,3}))?', raw)
    if match is None:
        fail(f'{label} precisa ser CPU decimal positiva com no máximo três casas')
    whole, dot, fraction = raw.partition('.')
    nanos = int(whole) * 1_000_000_000 + int((fraction + '000')[:3]) * 1_000_000
    if nanos <= 0:
        fail(f'{label} precisa ser maior que zero')
    return nanos


expected_resources = {
    'kassinao': {
        'memory': parse_memory_limit(core_memory_limit, 'KASSINAO_CORE_MEMORY_LIMIT'),
        'nano_cpus': parse_cpu_limit(core_cpu_limit, 'KASSINAO_CORE_CPUS'),
    },
    'kassinao-public': {
        'memory': parse_memory_limit(public_memory_limit, 'KASSINAO_PUBLIC_MEMORY_LIMIT'),
        'nano_cpus': parse_cpu_limit(public_cpu_limit, 'KASSINAO_PUBLIC_CPUS'),
    },
    'cloudflared': {
        'memory': parse_memory_limit(tunnel_memory_limit, 'KASSINAO_TUNNEL_MEMORY_LIMIT'),
        'nano_cpus': parse_cpu_limit(tunnel_cpu_limit, 'KASSINAO_TUNNEL_CPUS'),
    },
}
try:
    host_memory_bytes = int(host_memory_kib_raw) * 1024
    host_cpu_nanos = int(host_cpu_count_raw) * 1_000_000_000
except (TypeError, ValueError):
    fail('capacidade física do host é inválida')
if host_memory_bytes <= 0 or host_cpu_nanos <= 0:
    fail('capacidade física do host precisa ser positiva')
if sum(item['memory'] for item in expected_resources.values()) * 4 > host_memory_bytes * 3:
    fail('limites de RAM reservam menos de 25% da memória física para workloads vizinhos')
if sum(item['nano_cpus'] for item in expected_resources.values()) * 4 > host_cpu_nanos * 3:
    fail('limites de CPU reservam menos de 25% das CPUs online para workloads vizinhos')


volumes = {}
for volume in raw_volumes:
    if not isinstance(volume, dict):
        fail('entrada de volume Docker inválida')
    volume_name = volume.get('Name')
    if not isinstance(volume_name, str) or re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]+', volume_name) is None:
        fail('nome de volume Docker ausente ou inválido')
    if volume_name in volumes:
        fail(f'volume Docker duplicado no inventário: {volume_name}')
    volumes[volume_name] = volume


try:
    with os.fdopen(7, encoding='utf-8') as link_inventory:
        links = json.load(link_inventory)
except Exception:
    fail('inventário de interfaces Linux inválido')
if not isinstance(links, list):
    fail('inventário de interfaces Linux inválido')


def read_firewall_inventory(fd, label):
    try:
        with os.fdopen(fd, encoding='utf-8') as source:
            text = source.read()
    except Exception:
        fail(f'inventário de chains {label} inválido')
    definitions = set(re.findall(r'^:(KASSINAO-[A-Za-z0-9_-]+)\s', text, flags=re.MULTILINE))
    references = set(re.findall(r'\b(KASSINAO-[A-Za-z0-9_-]+)\b', text))
    return definitions, references


expected_firewall_chains = {
    'KASSINAO-EGRESS', 'KASSINAO-EGRESS-A', 'KASSINAO-EGRESS-B',
    'KASSINAO-HOST', 'KASSINAO-HOST-A', 'KASSINAO-HOST-B',
}
firewall_states = []
for label, fd in (('IPv4', 8), ('IPv6', 9)):
    definitions, references = read_firewall_inventory(fd, label)
    if not definitions and not references:
        firewall_states.append('absent')
    elif definitions == expected_firewall_chains and references == expected_firewall_chains:
        firewall_states.append('owned')
    else:
        fail(f'chains reservadas KASSINAO-* ausentes ou divergentes em {label}')
if audit_mode in ('full', 'uninstall-preflight'):
    if firewall_states != ['owned', 'owned']:
        fail(f'chains reservadas KASSINAO-* precisam estar owned no modo {audit_mode}')
elif firewall_states not in (['absent', 'absent'], ['owned', 'owned']):
    fail('chains reservadas KASSINAO-* estão em estado parcial entre IPv4 e IPv6')
firewall_state = firewall_states[0]


reserved_interfaces = {'kas-private0', 'kas-public0'}
interfaces = {}
for link in links:
    if not isinstance(link, dict):
        fail('entrada de interface Linux inválida')
    name = link.get('ifname')
    if not isinstance(name, str) or not name or name in interfaces:
        fail('nome de interface Linux ausente ou duplicado')
    interfaces[name] = link
present_reserved_interfaces = reserved_interfaces & set(interfaces)
for name in present_reserved_interfaces:
    link_kind = str(((interfaces[name].get('linkinfo') or {}).get('info_kind') or ''))
    if link_kind != 'bridge':
        fail(f'interface reservada {name} não é bridge própria')


def normalize_image_environment_map(raw):
    if not isinstance(raw, dict):
        fail('mapa de ambientes padrão das imagens inválido')
    result = {}
    for image_name, entries in raw.items():
        if not isinstance(image_name, str) or not isinstance(entries, list):
            fail('mapa de ambientes padrão das imagens inválido')
        environment = {}
        for entry in entries:
            if not isinstance(entry, str) or '=' not in entry:
                fail('ambiente padrão de imagem inválido')
            key, value = entry.split('=', 1)
            if not key or key in environment:
                fail('ambiente padrão de imagem duplicado')
            environment[key] = value
        result[image_name] = environment
    return result


image_environment_map = normalize_image_environment_map(image_environment_map)

expected_services = set(expected_services_raw.split(','))
expected_names = {
    'kassinao': 'kassinao',
    'kassinao-public': 'kassinao-public',
    'cloudflared': 'kassinao-tunnel',
}
reserved_names = set(expected_names.values())
project = []
foreign = []
for item in items:
    labels = (item.get('Config') or {}).get('Labels') or {}
    name = str(item.get('Name') or '').lstrip('/')
    if labels.get('com.docker.compose.project') == 'kassinao':
        project.append(item)
    else:
        if name in reserved_names:
            fail(f'nome reservado do kassinao pertence a outro projeto: {name}')
        foreign.append(item)
if audit_mode == 'full' and not project:
    fail('nenhum container do projeto kassinao encontrado')

by_service = {}
all_by_service = {}
seen_services = set()
for item in project:
    labels = (item.get('Config') or {}).get('Labels') or {}
    service = labels.get('com.docker.compose.service')
    if not isinstance(service, str) or service not in expected_names or service in seen_services:
        fail('label de serviço ausente ou duplicada no projeto kassinao')
    name = (item.get('Name') or '').lstrip('/')
    if name != expected_names[service]:
        fail('container com project label kassinao não pertence à instância reservada')
    seen_services.add(service)
    all_by_service[service] = item
    if service in expected_services:
        by_service[service] = item
        continue
    if audit_mode != 'preflight':
        fail(f'serviço desabilitado ainda existe no runtime: {service}')
    container_state = item.get('State') or {}
    restart = str((((item.get('HostConfig') or {}).get('RestartPolicy') or {}).get('Name') or 'no')).lower()
    if container_state.get('Running') is not False or restart != 'no':
        fail(f'serviço desabilitado não está inerte para remoção explícita: {service}')
project_owned = bool(project) and set(by_service) == expected_services
if audit_mode == 'full' and not project_owned:
    fail(f'serviços do projeto divergentes: {sorted(set(by_service) ^ expected_services)}')

# A identidade numérica não possui conta no host. Quando containers próprios já
# estão ativos, somente seus PIDs cgroup-scoped podem usá-la; qualquer PID do
# host ou de workload vizinho quebra a exclusividade do par privado.
project_container_ids = {str(item.get('Id') or '') for item in project}
proc_identities_by_pid = {}
proc_cgroups_by_pid = {}
for entry in os.scandir(proc_root):
    if not entry.name.isdecimal() or not entry.is_dir(follow_symlinks=False):
        continue
    try:
        with open(os.path.join(entry.path, 'status'), encoding='utf-8') as handle:
            status_lines = handle.read().splitlines()
        with open(os.path.join(entry.path, 'cgroup'), encoding='utf-8') as handle:
            cgroup = handle.read()
    except FileNotFoundError:
        continue
    except OSError:
        fail('não foi possível provar credenciais de processo do host')
    identities = []
    for line in status_lines:
        key, separator, raw = line.partition(':')
        if not separator or key not in {'Uid', 'Gid', 'Groups'}:
            continue
        try:
            identities.extend(int(value) for value in raw.split())
        except ValueError:
            fail('credenciais de processo do host são inválidas')
    proc_identities_by_pid[int(entry.name)] = tuple(identities)
    proc_cgroups_by_pid[int(entry.name)] = cgroup
    if runtime_uid not in identities and runtime_gid not in identities:
        continue
    if not any(
            container_id and re.search(
                rf'(?<![0-9a-f]){re.escape(container_id)}(?![0-9a-f])',
                cgroup,
            )
            for container_id in project_container_ids):
        fail('UID/GID privado do kassinao já está ativo fora dos containers próprios')

if audit_mode == 'uninstall-preflight' and project:
    if not project_owned:
        fail('topologia de containers Kassinão está parcial antes do uninstall')
    expected_networks_by_service = {
        'kassinao': {'kassinao_private'},
        'kassinao-public': {'kassinao_public'},
        'cloudflared': {'kassinao_private', 'kassinao_public'},
    }
    for service, item in by_service.items():
        config = item.get('Config') or {}
        host = item.get('HostConfig') or {}
        container_state = item.get('State') or {}
        image = str(config.get('Image') or '')
        expected_image_for_service = expected_cloudflared_image if service == 'cloudflared' else expected_image
        actual_networks = set((((item.get('NetworkSettings') or {}).get('Networks')) or {}).keys())
        restart = str(((host.get('RestartPolicy') or {}).get('Name') or 'no')).lower()
        if image != expected_image_for_service or actual_networks != expected_networks_by_service[service]:
            fail(f'{service}: identidade/rede diverge antes do uninstall')
        if container_state.get('Running') is not False or restart != 'no':
            fail(f'{service}: precisa estar parado e com restart=no antes do uninstall')

digest_pattern = re.compile(r'^[a-z0-9][a-z0-9._/-]*(?::[0-9A-Za-z._-]+)?@sha256:[0-9a-f]{64}$')


def image_repository(reference):
    name = reference.split('@', 1)[0]
    slash = name.rfind('/')
    colon = name.rfind(':')
    return name[:colon] if colon > slash else name


def image_matches_contract(service, actual):
    desired = expected_cloudflared_image if service == 'cloudflared' else expected_image
    if require_current_images:
        return actual == desired
    if expected_existing_image and service in ('kassinao', 'kassinao-public'):
        return actual == expected_existing_image
    if audit_mode == 'preflight':
        return digest_pattern.fullmatch(actual) is not None and image_repository(actual) == image_repository(desired)
    return actual == desired


def normalized_capabilities(host):
    result = set()
    for raw in host.get('CapAdd') or []:
        value = str(raw).upper()
        result.add(value.removeprefix('CAP_'))
    return result


def assert_namespace_isolated(name, host):
    if host.get('Privileged'):
        fail(f'{name}: privileged proibido')
    if host.get('NetworkMode') == 'host' or host.get('PidMode') == 'host' or host.get('IpcMode') == 'host':
        fail(f'{name}: namespace do host proibido')
    if host.get('HasDevices') or host.get('HasDeviceCgroupRules') or host.get('HasDeviceRequests'):
        fail(f'{name}: device do host proibido')
    if normalized_capabilities(host):
        fail(f'{name}: cap_add proibido')
    if 'ALL' not in {str(value).upper() for value in host.get('CapDrop') or []}:
        fail(f'{name}: cap_drop ALL ausente')
    security = {str(value).replace('=', ':').lower() for value in host.get('SecurityOpt') or []}
    if 'no-new-privileges:true' not in security or any('unconfined' in value for value in security):
        fail(f'{name}: no-new-privileges/perfil seguro ausente')
    if not host.get('ReadonlyRootfs'):
        fail(f'{name}: root filesystem precisa ser read-only')
    resources = expected_resources[name]
    memory = host.get('Memory')
    if type(memory) is not int or memory != resources['memory'] or host.get('MemorySwap') != memory:
        fail(f'{name}: Memory/MemorySwap divergem do limite explícito do compose.env')
    if host.get('MemorySwappiness') != 0:
        fail(f'{name}: MemorySwappiness precisa ser zero')
    nano_cpus = host.get('NanoCpus')
    if type(nano_cpus) is not int or nano_cpus != resources['nano_cpus']:
        fail(f'{name}: NanoCpus diverge do limite explícito do compose.env')
    if ((host.get('RestartPolicy') or {}).get('Name') or 'no').lower() not in ('no', 'none'):
        fail(f'{name}: restart policy precisa ser no')


def assert_liveness_contract(service, item):
    state = item.get('State') or {}
    if state.get('Running') is not True:
        fail(f'{service}: container precisa estar Running no audit full')

    if service in ('kassinao', 'kassinao-public'):
        health_status = str(((state.get('Health') or {}).get('Status') or ''))
        if health_status != 'healthy':
            fail(f'{service}: Health.Status precisa ser healthy no audit full')


def assert_static_runtime_contract(service, host):
    ulimits = host.get('Ulimits') or []
    if ulimits != [{'Name': 'core', 'Hard': 0, 'Soft': 0}]:
        fail(f'{service}: ulimit core 0 ausente ou divergente')

    expected_pids_limit = {
        'kassinao': 256,
        'kassinao-public': 128,
        'cloudflared': 64,
    }[service]
    actual_pids_limit = host.get('PidsLimit')
    if type(actual_pids_limit) is not int or actual_pids_limit != expected_pids_limit:
        fail(f'{service}: PidsLimit diverge do limite selado')

    expected_log_config = {
        'kassinao': {'max-size': '10m', 'max-file': '3'},
        'kassinao-public': {'max-size': '5m', 'max-file': '2'},
        'cloudflared': {'max-size': '5m', 'max-file': '2'},
    }[service]
    log_config = host.get('LogConfig') or {}
    if log_config.get('Type') != 'json-file' or log_config.get('Config') != expected_log_config:
        fail(f'{service}: LogConfig diverge da rotação json-file selada')


def assert_ports(name, host, expected_internal=None, expected_host=None):
    bindings = host.get('PortBindings') or {}
    actual = []
    for internal, values in bindings.items():
        for binding in values or []:
            host_ip = str((binding or {}).get('HostIp') or '')
            if host_ip not in ('127.0.0.1', '::1'):
                fail(f'{name}: porta publicada fora de loopback')
            actual.append((internal, str((binding or {}).get('HostPort') or '')))
    if expected_internal is None:
        if actual:
            fail(f'{name}: não deve publicar portas')
    elif actual != [(expected_internal, expected_host)]:
        fail(f'{name}: binding de porta divergente')


def mount_map(item):
    result = {}
    for mount in item.get('Mounts') or []:
        target = os.path.normpath(str(mount.get('Destination') or ''))
        if not target or target in result:
            fail('mount sem destino ou duplicado')
        result[target] = mount
    return result


def container_environment(config, name):
    raw = config.get('Env') or []
    if not isinstance(raw, list) or any(not isinstance(entry, str) or '=' not in entry for entry in raw):
        fail(f'{name}: Config.Env inválido')
    result = {}
    for entry in raw:
        key, value = entry.split('=', 1)
        if not key or key in result:
            fail(f'{name}: Config.Env contém chave vazia/duplicada')
        result[key] = value
    return result


contract_by_service = all_by_service
app_runtime_images = set()
app_fingerprints = set()
for service, item in contract_by_service.items():
    name = (item.get('Name') or '').lstrip('/')
    if name != expected_names[service]:
        fail(f'{service}: nome de container divergente')
    config = item.get('Config') or {}
    host = item.get('HostConfig') or {}
    image = str(config.get('Image') or '')
    if not digest_pattern.fullmatch(image):
        fail(f'{service}: imagem não está presa a digest')
    if not image_matches_contract(service, image):
        fail(f'{service}: imagem diverge do contrato selado para este modo')
    configured_user = str(config.get('User') or '')
    expected_user = '65532:65532' if service == 'cloudflared' else f'{runtime_uid}:{runtime_gid}'
    if configured_user != expected_user:
        fail(f'{service}: identidade runtime diverge do UID/GID privado selado')
    assert_namespace_isolated(service, host)
    assert_static_runtime_contract(service, host)
    if audit_mode == 'full':
        assert_liveness_contract(service, item)

    environment = container_environment(config, service)
    image_environment = image_environment_map.get(image)
    if image_environment is None:
        fail(f'{service}: ambiente padrão da imagem existente não foi provado por digest')
    if service == 'kassinao':
        additions = {
            'PORT', 'WEB_BIND_ADDRESS', 'RECORDINGS_DIR', 'STATE_DIR', 'AUTH_STATE_DIR',
            'KASSINAO_RELEASE_DIGEST', 'KASSINAO_DEPLOYMENT_FINGERPRINT', 'TUNNEL_TOKEN',
            'XDG_CACHE_HOME', 'DOTENV_CONFIG_PATH'
        }
        if set(environment) != set(image_environment) | additions:
            fail('kassinao: Config.Env saiu da allowlist positiva')
        fixed = {
            'PORT': '8080',
            'WEB_BIND_ADDRESS': '0.0.0.0',
            'RECORDINGS_DIR': '/app/recordings',
            'STATE_DIR': '/app/state',
            'AUTH_STATE_DIR': '/app/auth',
            'TUNNEL_TOKEN': '',
            'XDG_CACHE_HOME': '/home/node/.cache',
            'DOTENV_CONFIG_PATH': '/run/secrets/kassinao-app.env',
        }
        if any(environment.get(key) != value for key, value in fixed.items()):
            fail('kassinao: Config.Env fixo divergente ou contém token')
        app_runtime_images.add(image)
        if environment.get('KASSINAO_RELEASE_DIGEST') != image.rsplit('@', 1)[1]:
            fail('kassinao: release digest do ambiente não corresponde à imagem existente')
        fingerprint = environment.get('KASSINAO_DEPLOYMENT_FINGERPRINT') or ''
        if not re.fullmatch(r'[0-9a-f]{32}', fingerprint):
            fail('kassinao: deployment fingerprint inválido')
        app_fingerprints.add(fingerprint)
    elif service == 'kassinao-public':
        additions = {
            'NODE_ENV', 'PORT', 'WEB_BIND_ADDRESS', 'PUBLIC_URL', 'DOCS_URL', 'SOURCE_URL',
            'KASSINAO_RELEASE_DIGEST', 'KASSINAO_DEPLOYMENT_FINGERPRINT', 'TRUST_PROXY_HOPS', 'REPO_PUBLIC'
        }
        if set(environment) != set(image_environment) | additions:
            fail('kassinao-public: Config.Env saiu da allowlist positiva')
        if environment.get('PORT') != '8081' or environment.get('WEB_BIND_ADDRESS') != '0.0.0.0':
            fail('kassinao-public: Config.Env fixo divergente')
        app_runtime_images.add(image)
        if environment.get('KASSINAO_RELEASE_DIGEST') != image.rsplit('@', 1)[1]:
            fail('kassinao-public: release digest do ambiente não corresponde à imagem existente')
        fingerprint = environment.get('KASSINAO_DEPLOYMENT_FINGERPRINT') or ''
        if not re.fullmatch(r'[0-9a-f]{32}', fingerprint):
            fail('kassinao-public: deployment fingerprint inválido')
        app_fingerprints.add(fingerprint)
    elif environment != image_environment:
        fail('cloudflared: Config.Env diverge da imagem selada; token/override proibido')

    if service == 'cloudflared':
        if config.get('Entrypoint') != ['/usr/local/bin/kassinao-no-dump', '--', '/usr/local/bin/cloudflared']:
            fail('cloudflared: entrypoint no-dump divergente')
        if config.get('Cmd') != ['tunnel', '--no-autoupdate', 'run', '--token-file', '/run/secrets/kassinao-tunnel-token']:
            fail('cloudflared: command/token-file divergente')

    expected_networks = {
        'kassinao': {'kassinao_private'},
        'kassinao-public': {'kassinao_public'},
        'cloudflared': {'kassinao_private', 'kassinao_public'},
    }[service]
    actual_networks = set((((item.get('NetworkSettings') or {}).get('Networks')) or {}).keys())
    if actual_networks != expected_networks:
        fail(f'{service}: membership de redes divergente')

    mounts = mount_map(item)
    if service == 'kassinao':
        expected_mounts = {
            '/app/recordings': (recordings, True),
            '/app/state': (state, True),
            '/app/auth': (auth, True),
            '/home/node/.cache': (cache, True),
            '/run/secrets/kassinao-app.env': (app_env, False),
            '/run/kassinao/storage-mounted': (sentinel, False),
        }
        if set(mounts) != set(expected_mounts):
            fail('kassinao: mounts divergentes')
        for target, (source, writable) in expected_mounts.items():
            mount = mounts[target]
            if mount.get('Type') != 'bind' or os.path.realpath(str(mount.get('Source') or '')) != os.path.realpath(source):
                fail(f'kassinao: source divergente em {target}')
            if bool(mount.get('RW')) != writable:
                fail(f'kassinao: modo de escrita divergente em {target}')
        assert_ports(service, host, '8080/tcp', host_port)
    elif service == 'kassinao-public':
        if mounts:
            fail('kassinao-public: mounts proibidos')
        assert_ports(service, host, '8081/tcp', public_host_port)
    else:
        if no_dump_helper_state != 'owned':
            fail('cloudflared: launcher no-dump instalado não foi provado contra a release')
        expected_mounts = {
            '/usr/local/bin/kassinao-no-dump': (no_dump_installed, False),
            '/run/secrets/kassinao-tunnel-token': (tunnel_token_file, False),
        }
        if set(mounts) != set(expected_mounts):
            fail('cloudflared: mounts de launcher/token divergentes')
        for target, (source, writable) in expected_mounts.items():
            mount = mounts[target]
            if mount.get('Type') != 'bind' or os.path.realpath(str(mount.get('Source') or '')) != os.path.realpath(source):
                fail(f'cloudflared: source divergente em {target}')
            if bool(mount.get('RW')) != writable:
                fail(f'cloudflared: token precisa ser read-only em {target}')
        assert_ports(service, host)

if len(app_runtime_images) > 1:
    fail('core e superfície pública usam digests diferentes')
if len(app_fingerprints) > 1:
    fail('core e superfície pública usam deployment fingerprints diferentes')
if expected_existing_image and expected_existing_image not in app_runtime_images:
    fail('imagem anterior explícita não corresponde aos containers existentes')

project_networks = set()
for item in project:
    project_networks.update((((item.get('NetworkSettings') or {}).get('Networks')) or {}).keys())
if not project_networks:
    if audit_mode == 'full':
        fail('redes do projeto kassinao não puderam ser identificadas')

reserved_networks = {
    'kassinao_private': ('kas-private0', 'private'),
    'kassinao_public': ('kas-public0', 'public'),
}
owned_reserved_networks = set()
for network in networks:
    if not isinstance(network, dict):
        fail('entrada de rede Docker inválida')
    name = str(network.get('Name') or '')
    bridge = str(network.get('BridgeName') or '')
    candidate = name in reserved_networks or bridge in reserved_interfaces
    if not candidate:
        continue
    expected = reserved_networks.get(name)
    if expected is None:
        fail(f'bridge reservada {bridge or "sem-nome"} pertence a outra rede/workload')
    expected_bridge, expected_label = expected
    if (network.get('Driver') != 'bridge' or bridge != expected_bridge or
            network.get('ComposeProject') != 'kassinao' or
            network.get('ComposeNetwork') != expected_label):
        fail(f'bridge reservada {expected_bridge} pertence a outra rede/workload')
    gateway_ipv4 = network.get('GatewayModeIPv4')
    gateway_ipv6 = network.get('GatewayModeIPv6')
    if expected_label == 'private':
        if network.get('Internal') is not False or gateway_ipv4 not in (None, '') or gateway_ipv6 not in (None, ''):
            fail('rede privada reservada diverge do contrato de gateway externo')
    elif (network.get('Internal') is not True or gateway_ipv4 != 'isolated' or
            gateway_ipv6 != 'isolated'):
        fail('rede pública reservada precisa ser Internal=true com gateway IPv4/IPv6 isolated')
    if name in owned_reserved_networks:
        fail(f'rede reservada duplicada no inventário: {name}')
    owned_reserved_networks.add(name)

expected_reserved_networks = set(reserved_networks)
topology_absent = not present_reserved_interfaces and not owned_reserved_networks and not project
topology_owned = (
    present_reserved_interfaces == reserved_interfaces and
    owned_reserved_networks == expected_reserved_networks and
    project_owned
)
if audit_mode == 'full':
    if not topology_owned:
        fail('interfaces/redes reservadas do projeto estão ausentes ou divergentes')
elif audit_mode == 'uninstall-preflight':
    if not topology_absent and not topology_owned:
        fail('topologia Docker Kassinão precisa estar totalmente ausente ou owned antes do uninstall')
elif not topology_absent and not topology_owned:
    fail('interfaces/redes reservadas estão em estado parcial ou estranho')
topology_state = 'owned' if topology_owned else 'absent'
# No primeiro deploy, o installer sela e valida as chains antes de o Compose
# criar bridges/redes/containers. Somente --preflight pode observar essa janela
# owned+absent; o Bash já executou o hardener --check porque chains existem.
first_deploy_transition = audit_mode == 'preflight' and firewall_state == 'owned' and topology_state == 'absent'
if audit_mode != 'uninstall-preflight' and topology_state != firewall_state and not first_deploy_transition:
    fail('interfaces, redes e chains reservadas estão em estados incoerentes')

def canonical_host_path(raw_source):
    source = str(raw_source or '')
    if not os.path.isabs(source):
        return None
    return os.path.realpath(os.path.normpath(source))


def paths_overlap(source, protected_paths):
    for protected in protected_paths:
        try:
            common = os.path.commonpath([source, protected])
        except ValueError:
            continue
        if common == source or common == protected:
            return True
    return False


private_paths = [
    os.path.realpath(path) for path in (
        release_root,
        '/etc/kassinao',
        '/run/lock/kassinao',
        data_root,
        backing_file,
    )
]
write_control_paths = [
    os.path.realpath(path) for path in (
        '/etc',
        '/usr',
        '/bin',
        '/sbin',
        '/lib',
        '/lib64',
        '/boot',
        '/root',
        '/run',
        '/var/spool',
        '/var/lib/systemd',
        '/proc',
        '/sys',
        '/dev',
    )
]
read_credential_paths = [
    os.path.realpath(path) for path in (
        '/root',
        '/etc/shadow',
        '/etc/gshadow',
        '/etc/sudoers',
        '/etc/sudoers.d',
        '/etc/ssh',
        '/etc/ssl/private',
        '/etc/NetworkManager/system-connections',
        '/etc/wireguard',
        '/etc/openvpn',
        '/etc/systemd/system',
        '/proc',
        '/var/lib/cloud',
        '/var/lib/private',
        '/var/lib/sss',
        '/var/lib/systemd',
    )
]
docker_root = os.path.realpath(os.path.normpath(docker_root_dir))
docker_socket_paths = {
    os.path.realpath('/var/run/docker.sock'),
    os.path.realpath('/run/docker.sock'),
}
sbin_prefix = os.path.realpath('/usr/local/sbin') + os.sep + 'kassinao-'
sbin_root = os.path.realpath('/usr/local/sbin')


def reaches_kassinao_sbin(source):
    if source.startswith(sbin_prefix):
        return True
    try:
        return os.path.commonpath([source, sbin_root]) == source
    except ValueError:
        return False


deep_foreign_identity_scan = audit_mode in ('neighbors-only', 'preflight', 'uninstall-preflight')


def identity_collides(metadata):
    return metadata.st_uid in (runtime_uid, runtime_gid) or metadata.st_gid in (runtime_uid, runtime_gid)


def stable_metadata(first, second):
    return (
        first.st_dev, first.st_ino, first.st_mode, first.st_uid, first.st_gid, first.st_nlink
    ) == (
        second.st_dev, second.st_ino, second.st_mode, second.st_uid, second.st_gid, second.st_nlink
    )


def assert_foreign_tree_identity(container_name, source):
    """Prova ownership por descritores, sem seguir links e sem cruzar mounts.

    O health-watch usa audit full recorrentemente e limita esta prova à raiz. Os
    gates de mutação fazem a varredura metadata-only completa para não impor I/O
    host-wide a cada tick de saúde.
    """
    if not deep_foreign_identity_scan:
        return
    mount_targets_before = host_mount_targets()
    try:
        contains_nested_mount = any(
            target != source and os.path.commonpath([source, target]) == source
            for target in mount_targets_before
        )
    except ValueError:
        fail(f'{container_name}: source estrangeiro não pôde ser comparado ao inventário de mounts')
    if contains_nested_mount:
        fail(f'{container_name}: árvore estrangeira contém mount aninhado')
    try:
        root_metadata = os.lstat(source)
    except OSError:
        fail(f'{container_name}: source estrangeiro não pôde ser provado')
    if identity_collides(root_metadata):
        fail(f'{container_name}: ownership estrangeiro colide com UID/GID privado do kassinao')
    if not (stat.S_ISDIR(root_metadata.st_mode) or stat.S_ISREG(root_metadata.st_mode)):
        fail(f'{container_name}: source estrangeiro usa tipo especial ou link na raiz')
    if not stat.S_ISDIR(root_metadata.st_mode):
        return

    directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW
    try:
        root_fd = os.open(source, directory_flags)
    except OSError:
        fail(f'{container_name}: diretório estrangeiro não pôde ser aberto sem seguir links')
    try:
        opened_root = os.fstat(root_fd)
        if not stable_metadata(root_metadata, opened_root):
            fail(f'{container_name}: source estrangeiro mudou durante a auditoria')
        root_device = opened_root.st_dev

        def visit(directory_fd):
            try:
                names = sorted(os.listdir(directory_fd))
            except OSError:
                fail(f'{container_name}: árvore estrangeira não pôde ser inventariada')
            for child_name in names:
                try:
                    before = os.stat(child_name, dir_fd=directory_fd, follow_symlinks=False)
                except OSError:
                    fail(f'{container_name}: árvore estrangeira mudou durante a auditoria')
                if before.st_dev != root_device:
                    fail(f'{container_name}: árvore estrangeira contém mount aninhado')
                if identity_collides(before):
                    fail(f'{container_name}: ownership profundo colide com UID/GID privado do kassinao')
                child_mode = before.st_mode
                if stat.S_ISDIR(child_mode):
                    try:
                        child_fd = os.open(child_name, directory_flags, dir_fd=directory_fd)
                    except OSError:
                        fail(f'{container_name}: diretório estrangeiro mudou ou virou link')
                    try:
                        opened = os.fstat(child_fd)
                        if not stable_metadata(before, opened):
                            fail(f'{container_name}: árvore estrangeira mudou durante a auditoria')
                        visit(child_fd)
                    finally:
                        os.close(child_fd)
                else:
                    # Para descendentes não-diretório, a prova é somente de
                    # metadata/ownership. Não abra nem siga arquivo, symlink,
                    # socket, FIFO ou device de um workload vizinho legítimo.
                    try:
                        after = os.stat(child_name, dir_fd=directory_fd, follow_symlinks=False)
                    except OSError:
                        fail(f'{container_name}: entrada estrangeira mudou durante a auditoria')
                    if not stable_metadata(before, after):
                        fail(f'{container_name}: entrada estrangeira mudou durante a auditoria')

        visit(root_fd)
    finally:
        os.close(root_fd)
    if host_mount_targets() != mount_targets_before:
        fail(f'{container_name}: inventário de mounts mudou durante a auditoria')


def reject_foreign_bind(name, raw_source, writable):
    source = canonical_host_path(raw_source)
    if source is None:
        fail(f'{name}: bind estrangeiro possui source não absoluto')
    if source == '/dev' or source.startswith('/dev/'):
        fail(f'{name}: container estrangeiro monta device')
    if paths_overlap(source, docker_socket_paths):
        fail(f'{name}: container estrangeiro alcança docker.sock ou diretório pai')
    if paths_overlap(source, [docker_root]):
        fail(f'{name}: container estrangeiro faz bind do DockerRootDir efetivo')
    if paths_overlap(source, private_paths):
        fail(f'{name}: container estrangeiro alcança release, configuração, runtime ou storage privado')
    source_parts = source.split(os.sep)
    home_parts = [part for part in source_parts if part]
    contains_home_credentials = any(part in {
        '.ssh', '.aws', '.azure', '.docker', '.gnupg', '.kube', '.password-store'
    } for part in source_parts)
    contains_home_config_parent = '.config' in source_parts
    try:
        home_index = home_parts.index('home')
    except ValueError:
        home_index = -1
    is_home_root_or_user = home_index >= 0 and len(home_parts) - home_index <= 2
    if (paths_overlap(source, read_credential_paths) or contains_home_credentials or
            contains_home_config_parent or is_home_root_or_user):
        fail(f'{name}: bind estrangeiro alcança credenciais legíveis do host')
    if writable and (paths_overlap(source, write_control_paths) or reaches_kassinao_sbin(source) or
                     contains_home_credentials):
        fail(f'{name}: bind RW estrangeiro alcança controles privilegiados ou credenciais do host')


def validate_foreign_volume(container_name, mount):
    volume_name = mount.get('Name')
    if not isinstance(volume_name, str) or not volume_name:
        fail(f'{container_name}: volume estrangeiro sem nome verificável')
    volume = volumes.get(volume_name)
    if volume is None:
        fail(f'{container_name}: volume estrangeiro não apareceu no inventário do daemon')
    driver = volume.get('Driver')
    if driver != 'local' or volume.get('Scope') != 'local':
        fail(f'{container_name}: volume estrangeiro usa driver/plugin não permitido')
    mount_driver = mount.get('Driver')
    if mount_driver not in (None, '', 'local'):
        fail(f'{container_name}: driver do mount diverge do volume inventariado')

    mountpoint = canonical_host_path(volume.get('Mountpoint'))
    source = canonical_host_path(mount.get('Source'))
    if mountpoint is None or source is None or source != mountpoint:
        fail(f'{container_name}: source do volume estrangeiro diverge do inventário do daemon')
    expected_mountpoint = os.path.realpath(os.path.join(docker_root, 'volumes', volume_name, '_data'))
    if mountpoint != expected_mountpoint:
        fail(f'{container_name}: mountpoint de volume local saiu do DockerRootDir efetivo')
    assert_foreign_tree_identity(container_name, mountpoint)

    has_options = volume.get('HasOptions')
    if type(has_options) is not bool:
        fail(f'{container_name}: estado de opções do volume local é inválido')
    if not has_options:
        return
    # `.Options.o` pode conter credenciais de CIFS/NFS e jamais é solicitado
    # ao daemon. Sem ler esse campo não existe prova positiva de bind local
    # simples; portanto qualquer volume com opções falha fechado.
    option_type = volume.get('OptionType')
    option_device = volume.get('OptionDevice')
    if option_type is not None and not isinstance(option_type, str):
        fail(f'{container_name}: tipo de opção do volume local é inválido')
    if option_device is not None and not isinstance(option_device, str):
        fail(f'{container_name}: device do volume local é inválido')
    if isinstance(option_device, str) and option_device:
        reject_foreign_bind(container_name, option_device, mount.get('RW') is not False)
    fail(f'{container_name}: volume local com opções não é permitido no host compartilhado')

for item in foreign:
    name = (item.get('Name') or item.get('Id') or 'container-estrangeiro').lstrip('/')
    foreign_user = str((item.get('Config') or {}).get('User') or '')
    numeric_identity = re.fullmatch(r'([0-9]+):([0-9]+)', foreign_user)
    if numeric_identity is not None:
        if any(int(value) in (runtime_uid, runtime_gid) for value in numeric_identity.groups()):
            fail(f'{name}: identidade runtime estrangeira colide com UID/GID privado do kassinao')
    elif foreign_user:
        foreign_state = item.get('State') or {}
        if foreign_state.get('Running') is True:
            foreign_pid = foreign_state.get('Pid')
            if type(foreign_pid) is not int or foreign_pid <= 0 or foreign_pid not in proc_identities_by_pid:
                fail(f'{name}: Config.User ambíguo não possui PID/proc verificável')
            foreign_id = str(item.get('Id') or '')
            foreign_cgroup = proc_cgroups_by_pid.get(foreign_pid, '')
            if not foreign_id or re.search(
                    rf'(?<![0-9a-f]){re.escape(foreign_id)}(?![0-9a-f])', foreign_cgroup) is None:
                fail(f'{name}: PID de Config.User ambíguo não pertence ao container inventariado')
            if runtime_uid in proc_identities_by_pid[foreign_pid] or runtime_gid in proc_identities_by_pid[foreign_pid]:
                fail(f'{name}: identidade runtime estrangeira colide com UID/GID privado do kassinao')
        elif deep_foreign_identity_scan:
            fail(f'{name}: Config.User ambíguo de container parado não pode ser provado')
    host = item.get('HostConfig') or {}
    networks = set(((((item.get('NetworkSettings') or {}).get('Networks')) or {}).keys()))
    if networks & project_networks:
        fail(f'{name}: container estrangeiro anexado à rede do kassinao')
    if host.get('Privileged'):
        fail(f'{name}: container estrangeiro privileged')
    namespace_modes = [str(host.get(key) or '') for key in ('NetworkMode', 'PidMode', 'IpcMode', 'UTSMode')]
    if any(mode == 'host' or mode.startswith('container:') for mode in namespace_modes):
        fail(f'{name}: container estrangeiro compartilha namespace sensível')
    if normalized_capabilities(host):
        fail(f'{name}: container estrangeiro possui capability adicionada')
    if (host.get('HasDevices') or host.get('HasDeviceCgroupRules') or
            host.get('HasDeviceRequests') or host.get('HasVolumesFrom')):
        fail(f'{name}: container estrangeiro possui acesso indireto a device/volume')
    for mount in item.get('Mounts') or []:
        if not isinstance(mount, dict):
            fail(f'{name}: entrada de mount estrangeiro inválida')
        mount_type = str(mount.get('Type') or '')
        mount_source = canonical_host_path(mount.get('Source'))
        destination = os.path.normpath(str(mount.get('Destination') or ''))
        if destination.endswith('/docker.sock') or (
                mount_source is not None and paths_overlap(mount_source, docker_socket_paths)):
            fail(f'{name}: container estrangeiro monta docker.sock')
        if mount_type == 'bind':
            if mount_source is None:
                fail(f'{name}: source de bind estrangeiro inválido')
            reject_foreign_bind(name, mount.get('Source'), mount.get('RW') is not False)
            assert_foreign_tree_identity(name, mount_source)
        elif mount_type == 'volume':
            validate_foreign_volume(name, mount)
        elif mount_type != 'tmpfs':
            fail(f'{name}: tipo de mount estrangeiro não permitido')
PY

case "$audit_mode" in
  preflight)
    printf 'Preflight shared aprovado: workloads vizinhos respeitam a fronteira privada.\n'
    ;;
  neighbors-only)
    printf 'Audit neighbors-only aprovado: workloads vizinhos respeitam a fronteira privada.\n'
    ;;
  uninstall-preflight)
    printf 'Preflight de uninstall shared aprovado: policy owned e topologia ausente ou íntegra.\n'
    ;;
  *)
    printf 'Audit shared aprovado: storage, egress e containers permanecem fail-closed.\n'
    ;;
esac
