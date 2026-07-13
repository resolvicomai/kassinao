#!/usr/bin/env bash
# Read-only VPS security inventory. It deliberately prints env key names, never values.
set -uo pipefail

SEARCH_ROOTS=()
for root in /opt /srv /root /home; do
  [ ! -d "$root" ] || SEARCH_ROOTS+=("$root")
done

section() {
  printf '\n=== %s ===\n' "$1"
}

section TIME
date -Is

section OS
hostnamectl

section SSHD
sshd -T | grep -E '^(permitrootlogin|passwordauthentication|kbdinteractiveauthentication|pubkeyauthentication|maxauthtries|allowusers|allowgroups) ' || true

section LISTEN
ss -lntup

section UFW
ufw status verbose 2>&1 || true

section NFTABLES
nft list ruleset 2>&1 || true

section SECURITY_SERVICES
for service in ssh fail2ban unattended-upgrades docker; do
  printf '%-24s %s\n' "$service" "$(systemctl is-active "$service" 2>&1 || true)"
done

section PENDING_UPDATES
apt-get -s upgrade 2>/dev/null | awk '/^Inst /{print}' | head -80

section DOCKER
docker version --format 'server={{.Server.Version}}' 2>&1 || true
docker compose version 2>&1 || true
docker ps -a --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}' 2>&1 || true

section COMPOSE_FILES
find "${SEARCH_ROOTS[@]}" -maxdepth 5 -type f \
  \( -name docker-compose.yml -o -name compose.yml -o -name compose.yaml \) \
  -printf '%M %u:%g %p\n' 2>/dev/null || true

section KASSINAO_PATHS
find "${SEARCH_ROOTS[@]}" -maxdepth 5 -iname '*kassinao*' \
  -printf '%y %M %u:%g %p\n' 2>/dev/null | head -160 || true

section ENV_FILE_MODES_AND_KEY_NAMES
while IFS= read -r -d '' file; do
  stat -c '%a %U:%G %n' "$file"
  sed -n 's/^[[:space:]]*\([A-Za-z_][A-Za-z0-9_]*\)[[:space:]]*=.*/  \1/p' "$file" | sort -u
done < <(find "${SEARCH_ROOTS[@]}" -maxdepth 5 -type f -name '.env*' -print0 2>/dev/null)

section FAIL2BAN
fail2ban-client status 2>&1 || true
