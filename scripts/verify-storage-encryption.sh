#!/bin/bash -p
# Proves that every path containing instance data is backed by a dm-crypt/LUKS
# device. This is a host control: container flags and encrypted backups do not
# prove encryption of active data. Swap must also be disabled or encrypted.
set -euo pipefail
umask 077

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

_saved_no_dump_marker="${KASSINAO_NO_DUMP_ACTIVE-}"
_saved_no_dump_preload="${LD_PRELOAD-}"
[ -r "/proc/$$/environ" ] || die '/proc is required to sanitize the storage verifier environment'
while IFS='=' read -r -d '' _name _value; do unset "$_name" 2>/dev/null || true; done < "/proc/$$/environ"
unset _name _value
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/root LC_ALL=C

_script_path="${BASH_SOURCE[0]}"
case "$_script_path" in /*) ;; ./*) _script_path="$PWD/${_script_path#./}" ;; *) _script_path="$PWD/$_script_path" ;; esac
case "$_script_path" in *//* | */./* | */../* | */. | */.. | */) die 'storage verifier path is not canonical' ;; esac
_script_dir="${_script_path%/*}"
case "$_script_dir" in
  */scripts) PROJECT_DIR="${_script_dir%/scripts}" ;;
  /usr/local/sbin)
    marker=/etc/kassinao/host-controls.env
    [ -f "$marker" ] && [ ! -L "$marker" ] && [ "$(stat -c '%a:%u:%g:%h' "$marker" 2>/dev/null || true)" = 600:0:0:1 ] ||
      die 'sealed host-control marker is missing or irregular'
    PROJECT_DIR="$(awk -F= '$1 == "KASSINAO_DEPLOY_DIR" { if (seen++) exit 2; print substr($0, index($0,"=")+1) } END { if (seen != 1) exit 2 }' "$marker")" ||
      die 'sealed host-control marker does not contain one deploy directory'
    _script_path="$PROJECT_DIR/scripts/verify-storage-encryption.sh"
    ;;
  *) die 'storage verifier must run from the sealed kit or installed entrypoint' ;;
esac
case "${MACHTYPE%%-*}" in x86_64) _no_dump_arch=amd64 ;; aarch64 | arm64) _no_dump_arch=arm64 ;; *) die 'unsupported no-dump architecture' ;; esac
_no_dump_preload="$PROJECT_DIR/runtime/linux-$_no_dump_arch/libkassinao-no-dump.so"
# KASSINAO_HOST_NO_DUMP_BEGIN
if [ "$_saved_no_dump_marker" != "prctl-v1:$$" ] || [ "$_saved_no_dump_preload" != "$_no_dump_preload" ]; then
  exec /usr/bin/python3 "$PROJECT_DIR/scripts/no-dump-exec.py" \
    --bundle-root "$PROJECT_DIR" --script-relative scripts/verify-storage-encryption.sh --arch "$_no_dump_arch" -- \
    "$_script_path" "$@"
fi
LD_PRELOAD="$_no_dump_preload"
export LD_PRELOAD
[ "$(ulimit -Sc)" = 0 ] && [ "$(ulimit -Hc)" = 0 ] || die 'storage verifier core limit is not sealed'
IFS= read -r _no_dump_filter < "/proc/$$/coredump_filter" || _no_dump_filter=''
[[ "$_no_dump_filter" =~ ^0+$ ]] || die 'storage verifier coredump filter is not sealed'
# KASSINAO_HOST_NO_DUMP_END
unset _saved_no_dump_marker _saved_no_dump_preload _no_dump_filter _no_dump_arch _no_dump_preload _script_path _script_dir

if [ "$#" -eq 0 ]; then
  config_file=/etc/kassinao/storage-paths
  [ -f "$config_file" ] && [ ! -L "$config_file" ] || die "storage path file is missing or irregular: $config_file"
  metadata="$(stat -c '%a:%u:%g' "$config_file" 2>/dev/null || true)"
  [ "$metadata" = '600:0:0' ] || die 'storage path file must be mode 0600 and owned by root:root'
  mapfile -t configured_paths < "$config_file"
  [ "${#configured_paths[@]}" -ge 1 ] || die 'storage path file is empty'
  for configured_path in "${configured_paths[@]}"; do
    case "$configured_path" in /*) ;; *) die 'storage path file contains a non-absolute path' ;; esac
    [[ "$configured_path" =~ ^/[A-Za-z0-9._/-]+$ ]] || die 'storage path file contains an invalid path'
  done
  set -- "${configured_paths[@]}"
fi
for command in findmnt lsblk readlink stat; do
  command -v "$command" >/dev/null 2>&1 || die "$command is required to verify storage encryption"
done

crypt_chain_for_device() {
  local device="$1" canonical types
  case "$device" in /dev/*) ;; *) return 1 ;; esac
  canonical="$(readlink -f -- "$device")" || return 1
  [ -b "$canonical" ] || return 1
  types="$(lsblk -s -n -o TYPE -- "$canonical" 2>/dev/null)" || return 1
  grep -Fxq crypt <<<"$types"
}

crypt_chain_for_path() {
  local path="$1" canonical source device
  [ -e "$path" ] && [ ! -L "$path" ] || die "data path is missing or is a symlink: $path"
  canonical="$(readlink -f -- "$path")" || die "cannot resolve data path: $path"
  source="$(findmnt -n -o SOURCE -T "$canonical" 2>/dev/null)" || die "cannot resolve mount source for: $canonical"
  # findmnt may append a btrfs/subvolume suffix such as [/subvolume].
  device="${source%%\[*}"
  crypt_chain_for_device "$device" || \
    die "active data is not proven to be on dm-crypt/LUKS storage: $canonical"
  printf 'encrypted storage verified: %s\n' "$canonical"
}

for path in "$@"; do
  crypt_chain_for_path "$path"
done

if command -v swapon >/dev/null 2>&1; then
  while IFS= read -r swap; do
    [ -n "$swap" ] || continue
    if [ -b "$swap" ]; then
      crypt_chain_for_device "$swap" || die "active swap is not backed by dm-crypt/LUKS: $swap"
    elif [ -f "$swap" ]; then
      crypt_chain_for_path "$swap"
    else
      die "cannot verify active swap: $swap"
    fi
  done < <(swapon --noheadings --show=NAME 2>/dev/null || true)
fi

printf 'active instance storage and swap passed the dm-crypt/LUKS gate\n'
