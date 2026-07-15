#!/usr/bin/env bash
# Proves that every path containing instance data is backed by a dm-crypt/LUKS
# device. This is a host control: container flags and encrypted backups do not
# prove encryption of active data. Swap must also be disabled or encrypted.
set -euo pipefail

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

if [ "$#" -eq 0 ]; then
  config_file="${KASSINAO_STORAGE_PATHS_FILE:-/etc/kassinao/storage-paths}"
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
