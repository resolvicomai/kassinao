#!/bin/bash -p
# Remove somente o health-watch de uma instalação anterior ao marker de host.
# A proveniência é provada pelo runtime legado e por byte-match com CURRENT_ROOT.
set -Eeuo pipefail
umask 077

die() { printf 'ERRO: %s\n' "$*" >&2; exit 1; }

[ "$#" -eq 2 ] ||
  die 'uso: remove-legacy-health-watch.sh CURRENT_ROOT --confirm-remove-exact-legacy-health-watch'
CURRENT_ROOT="$1"
[ "$2" = --confirm-remove-exact-legacy-health-watch ] || die 'confirmação explícita ausente'

__kassinao_current_root="$CURRENT_ROOT"
_saved_no_dump_marker="${KASSINAO_NO_DUMP_ACTIVE-}"
_saved_no_dump_preload="${LD_PRELOAD-}"
SAFE_SYSTEM_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
[ -r "/proc/$$/environ" ] || die '/proc é obrigatório para limpar o ambiente da remoção legada'
while IFS='=' read -r -d '' inherited_name inherited_value; do unset "$inherited_name" 2>/dev/null || true; done < "/proc/$$/environ"
unset inherited_name inherited_value
export PATH="$SAFE_SYSTEM_PATH" HOME=/root LC_ALL=C
CURRENT_ROOT="$__kassinao_current_root"
unset __kassinao_current_root

_script_path="${BASH_SOURCE[0]}"
case "$_script_path" in /*) ;; ./*) _script_path="$PWD/${_script_path#./}" ;; *) _script_path="$PWD/$_script_path" ;; esac
case "$_script_path" in *//* | */./* | */../* | */. | */.. | */) die 'caminho da remoção legada não é canônico' ;; esac
_script_dir="${_script_path%/*}"
case "$_script_dir" in */scripts) PROJECT_DIR="${_script_dir%/scripts}" ;; *) die 'remoção legada precisa executar do kit selado' ;; esac
case "${MACHTYPE%%-*}" in x86_64) _no_dump_arch=amd64 ;; aarch64 | arm64) _no_dump_arch=arm64 ;; *) die 'arquitetura sem runtime no-dump' ;; esac
_no_dump_preload="$PROJECT_DIR/runtime/linux-$_no_dump_arch/libkassinao-no-dump.so"
# KASSINAO_HOST_NO_DUMP_BEGIN
if [ "$_saved_no_dump_marker" != "prctl-v1:$$" ] || [ "$_saved_no_dump_preload" != "$_no_dump_preload" ]; then
  exec /usr/bin/python3 "$PROJECT_DIR/scripts/no-dump-exec.py" \
    --bundle-root "$PROJECT_DIR" --script-relative scripts/remove-legacy-health-watch.sh --arch "$_no_dump_arch" -- \
    "$_script_path" "$@"
fi
LD_PRELOAD="$_no_dump_preload"
export LD_PRELOAD
[ "$(ulimit -Sc)" = 0 ] && [ "$(ulimit -Hc)" = 0 ] || die 'core limit da remoção legada não ficou selado'
IFS= read -r _no_dump_filter < "/proc/$$/coredump_filter" || _no_dump_filter=''
[ "$_no_dump_filter" = 0 ] || die 'coredump_filter da remoção legada não ficou selado'
# KASSINAO_HOST_NO_DUMP_END
unset _saved_no_dump_marker _saved_no_dump_preload _no_dump_filter _no_dump_arch _no_dump_preload _script_path _script_dir

[ "$(id -u)" -eq 0 ] || die 'execute como root'
for command in awk cmp dirname env id readlink rm sha256sum stat systemctl; do
  command -v "$command" >/dev/null 2>&1 || die "$command é obrigatório"
done

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
[ "$ROOT" = "$PROJECT_DIR" ] || die 'raiz canônica divergiu do kit selado'
MANIFEST="$ROOT/MANIFEST.sha256"
LEGACY_VALIDATOR="$ROOT/scripts/validate-legacy-dedicated-installation.sh"

[ -d "$ROOT" ] && [ ! -L "$ROOT" ] && [ "$(readlink -f -- "$ROOT")" = "$ROOT" ] ||
  die 'kit operacional ausente ou irregular'
[ "$(stat -c '%a:%u:%g' "$ROOT" 2>/dev/null || true)" = 700:0:0 ] ||
  die 'kit operacional precisa ser 0700 root:root'
[ -f "$MANIFEST" ] && [ ! -L "$MANIFEST" ] || die 'MANIFEST.sha256 ausente ou irregular'
for required in scripts/remove-legacy-health-watch.sh scripts/validate-legacy-dedicated-installation.sh; do
  count="$(awk -v wanted="$required" '{ path=$2; sub(/^\.\//, "", path); if (path == wanted) count++ } END { print count + 0 }' "$MANIFEST")"
  [ "$count" -eq 1 ] || die "$required precisa aparecer exatamente uma vez no manifesto"
done
(cd -- "$ROOT" && sha256sum -c MANIFEST.sha256 --quiet) || die 'kit diverge do MANIFEST.sha256'
[ -x "$LEGACY_VALIDATOR" ] && [ ! -L "$LEGACY_VALIDATOR" ] || die 'validador legado ausente ou irregular'

env -i "PATH=$PATH" HOME=/root "$LEGACY_VALIDATOR" "$CURRENT_ROOT" >/dev/null ||
  die 'instalação anterior não passou na classificação legacy-dedicated'

assert_exact_file() {
  local path="$1" expected_mode="$2" description="$3" metadata
  [ -f "$path" ] && [ ! -L "$path" ] && [ "$(readlink -f -- "$path")" = "$path" ] ||
    die "$description ausente, irregular ou symlink"
  metadata="$(stat -c '%a:%u:%g:%h' "$path" 2>/dev/null || true)"
  [ "$metadata" = "$expected_mode:0:0:1" ] ||
    die "$description precisa ser $expected_mode root:root sem hardlinks"
}

sources=(
  "$CURRENT_ROOT/scripts/health-watch.sh"
  "$CURRENT_ROOT/deploy/systemd/kassinao-health-watch.service"
  "$CURRENT_ROOT/deploy/systemd/kassinao-health-watch.timer"
)
destinations=(
  /usr/local/sbin/kassinao-health-watch
  /etc/systemd/system/kassinao-health-watch.service
  /etc/systemd/system/kassinao-health-watch.timer
)
modes=(755 644 644)
units=(kassinao-health-watch.service kassinao-health-watch.timer)

for index in 0 1 2; do
  assert_exact_file "${sources[$index]}" "${modes[$index]}" 'controle legado na release atual'
  assert_exact_file "${destinations[$index]}" "${modes[$index]}" 'controle legado instalado'
  cmp -s -- "${sources[$index]}" "${destinations[$index]}" ||
    die 'controle legado instalado não corresponde byte a byte à release provada'
done

for unit in "${units[@]}"; do
  expected_fragment="/etc/systemd/system/$unit"
  [ "$(systemctl show "$unit" -p FragmentPath --value 2>/dev/null || true)" = "$expected_fragment" ] ||
    die 'unit legado efetiva não usa o fragmento exato em /etc/systemd/system'
  [ -z "$(systemctl show "$unit" -p DropInPaths --value 2>/dev/null || true)" ] ||
    die 'unit legado possui drop-in; remoção automática recusada'
done

# A mutação começa somente após validar simultaneamente os três arquivos e as
# duas units. Nenhum comando deste helper toca docker.service ou containers.
systemctl disable --now kassinao-health-watch.timer >/dev/null
systemctl stop kassinao-health-watch.service >/dev/null
systemctl is-active --quiet kassinao-health-watch.timer && die 'timer legado continuou ativo'
systemctl is-active --quiet kassinao-health-watch.service && die 'service legado continuou ativo'

# Feche a janela introduzida pelos comandos systemd: a remoção só ocorre se os
# mesmos três inodes continuarem regulares, root-only e byte a byte idênticos.
for index in 0 1 2; do
  assert_exact_file "${destinations[$index]}" "${modes[$index]}" 'controle legado instalado após stop'
  cmp -s -- "${sources[$index]}" "${destinations[$index]}" ||
    die 'controle legado mudou durante disable/stop; remoção recusada'
done

rm -- "${destinations[@]}"
systemctl daemon-reload
systemctl reset-failed kassinao-health-watch.service kassinao-health-watch.timer >/dev/null 2>&1 || true

for destination in "${destinations[@]}"; do
  [ ! -e "$destination" ] && [ ! -L "$destination" ] || die 'controle legado permaneceu após remoção'
done
systemctl is-enabled --quiet kassinao-health-watch.timer && die 'timer legado permaneceu enabled'
for unit in "${units[@]}"; do
  [ -z "$(systemctl show "$unit" -p FragmentPath --value 2>/dev/null || true)" ] ||
    die 'fragmento legado permaneceu carregado após daemon-reload'
  [ -z "$(systemctl show "$unit" -p DropInPaths --value 2>/dev/null || true)" ] ||
    die 'drop-in legado apareceu após daemon-reload'
done

printf 'Health-watch legado exato removido; Docker e workloads não foram alterados.\n'
