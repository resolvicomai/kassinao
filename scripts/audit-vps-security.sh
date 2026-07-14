#!/usr/bin/env bash
# Read-only VPS security gate. It prints env key names, never values, and exits
# non-zero whenever the host fails a required launch invariant.
set -uo pipefail
export LC_ALL=C

FAILURES=0
WARNINGS=0
ALLOWED_PUBLIC_TCP_PORTS="${KASSINAO_ALLOWED_PUBLIC_TCP_PORTS:-22}"
ALLOWED_PUBLIC_UDP_PORTS="${KASSINAO_ALLOWED_PUBLIC_UDP_PORTS:-}"

pass() {
  printf 'PASS  %s\n' "$1"
}

fail() {
  printf 'FAIL  %s\n' "$1"
  FAILURES=$((FAILURES + 1))
}

warn() {
  printf 'WARN  %s\n' "$1"
  WARNINGS=$((WARNINGS + 1))
}

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
SSHD_EFFECTIVE="$(sshd -T 2>/dev/null || true)"
if [ -z "$SSHD_EFFECTIVE" ]; then
  fail 'não foi possível ler a configuração efetiva do sshd'
else
  check_sshd() {
    local key="$1" expected="$2" actual
    actual="$(awk -v key="$key" '$1 == key { print $2; exit }' <<<"$SSHD_EFFECTIVE")"
    if [ "$actual" = "$expected" ]; then
      pass "sshd $key=$expected"
    else
      fail "sshd $key=${actual:-ausente}; esperado $expected"
    fi
  }
  check_sshd permitrootlogin no
  check_sshd passwordauthentication no
  check_sshd kbdinteractiveauthentication no
  check_sshd pubkeyauthentication yes
  MAX_AUTH_TRIES="$(awk '$1 == "maxauthtries" { print $2; exit }' <<<"$SSHD_EFFECTIVE")"
  if [ -n "$MAX_AUTH_TRIES" ] && [ "$MAX_AUTH_TRIES" -le 4 ] 2>/dev/null; then
    pass "sshd maxauthtries=$MAX_AUTH_TRIES"
  else
    fail "sshd maxauthtries=${MAX_AUTH_TRIES:-ausente}; esperado <= 4"
  fi
fi

section LISTEN
ss -lntup

section PUBLIC_TCP_GATE
PUBLIC_LISTENERS=0
while IFS= read -r local_address; do
  [ -n "$local_address" ] || continue
  case "$local_address" in
    127.*:* | \[::1\]:* | ::1:*) continue ;;
  esac
  PUBLIC_LISTENERS=$((PUBLIC_LISTENERS + 1))
  port="${local_address##*:}"
  case ",${ALLOWED_PUBLIC_TCP_PORTS// /,}," in
    *",$port,"*) pass "listener não-loopback autorizado em $local_address" ;;
    *) fail "listener TCP não autorizado em $local_address" ;;
  esac
done < <(ss -H -lnt 2>/dev/null | awk '{print $4}' | sort -u)
if [ "$PUBLIC_LISTENERS" -eq 0 ]; then
  warn 'nenhum listener TCP não-loopback encontrado; confirme como o SSH é acessado'
fi

section PUBLIC_UDP_GATE
PUBLIC_UDP_LISTENERS=0
while IFS= read -r local_address; do
  [ -n "$local_address" ] || continue
  case "$local_address" in
    127.*:* | \[::1\]:* | ::1:*) continue ;;
  esac
  PUBLIC_UDP_LISTENERS=$((PUBLIC_UDP_LISTENERS + 1))
  port="${local_address##*:}"
  case ",${ALLOWED_PUBLIC_UDP_PORTS// /,}," in
    *",$port,"*) pass "listener UDP não-loopback autorizado em $local_address" ;;
    *) fail "listener UDP não autorizado em $local_address" ;;
  esac
done < <(ss -H -lnu 2>/dev/null | awk '{print $4}' | sort -u)
if [ "$PUBLIC_UDP_LISTENERS" -eq 0 ]; then
  pass 'nenhum listener UDP não-loopback encontrado'
fi

section UFW
UFW_STATUS="$(ufw status verbose 2>&1 || true)"
printf '%s\n' "$UFW_STATUS"

section NFTABLES
NFT_RULESET="$(nft list ruleset 2>&1 || true)"
printf '%s\n' "$NFT_RULESET"

section FIREWALL_GATE
if grep -qi '^Status: active' <<<"$UFW_STATUS" && grep -Eqi '^Default: (deny|reject) \(incoming\)' <<<"$UFW_STATUS"; then
  pass 'UFW ativo com política padrão de entrada deny/reject'
elif grep -Eqi 'hook input[^}]*policy (drop|reject)' <<<"$NFT_RULESET"; then
  pass 'nftables possui política de entrada drop/reject'
else
  fail 'nenhum firewall de entrada com política padrão deny/reject foi confirmado'
fi

section SECURITY_SERVICES
for service in ssh fail2ban unattended-upgrades docker; do
  state="$(systemctl is-active "$service" 2>&1 || true)"
  printf '%-24s %s\n' "$service" "$state"
  if [ "$state" = active ]; then
    pass "$service ativo"
  else
    fail "$service não está ativo"
  fi
done

section PENDING_UPDATES
apt-get -s upgrade 2>/dev/null | awk '/^Inst /{print}' | head -80

section DOCKER
docker version --format 'server={{.Server.Version}}' 2>&1 || true
docker compose version 2>&1 || true
docker ps -a --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}' 2>&1 || true

section KASSINAO_CONTAINER_GATE
if ! docker inspect kassinao >/dev/null 2>&1; then
  fail 'container kassinao não encontrado'
else
  CONTAINER_USER="$(docker inspect -f '{{.Config.User}}' kassinao 2>/dev/null || true)"
  PRIVILEGED="$(docker inspect -f '{{.HostConfig.Privileged}}' kassinao 2>/dev/null || true)"
  READONLY_ROOTFS="$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}}' kassinao 2>/dev/null || true)"
  CAP_DROP="$(docker inspect -f '{{json .HostConfig.CapDrop}}' kassinao 2>/dev/null || true)"
  SECURITY_OPT="$(docker inspect -f '{{json .HostConfig.SecurityOpt}}' kassinao 2>/dev/null || true)"
  NETWORK_MODE="$(docker inspect -f '{{.HostConfig.NetworkMode}}' kassinao 2>/dev/null || true)"
  PID_MODE="$(docker inspect -f '{{.HostConfig.PidMode}}' kassinao 2>/dev/null || true)"
  IPC_MODE="$(docker inspect -f '{{.HostConfig.IpcMode}}' kassinao 2>/dev/null || true)"

  case "$CONTAINER_USER" in
    '' | 0 | root | 0:0 | root:root) fail "container roda como usuário inseguro (${CONTAINER_USER:-vazio})" ;;
    *) pass "container roda como usuário não-root ($CONTAINER_USER)" ;;
  esac
  [ "$PRIVILEGED" = false ] && pass 'container não é privilegiado' || fail "Privileged=$PRIVILEGED"
  [ "$READONLY_ROOTFS" = true ] && pass 'root filesystem do container é read-only' || fail "ReadonlyRootfs=$READONLY_ROOTFS"
  grep -q 'ALL' <<<"$CAP_DROP" && pass 'container remove todas as capabilities' || fail "CapDrop não contém ALL ($CAP_DROP)"
  grep -q 'no-new-privileges' <<<"$SECURITY_OPT" && pass 'no-new-privileges ativo' || fail 'no-new-privileges ausente'
  [ "$NETWORK_MODE" != host ] && pass "rede do container isolada ($NETWORK_MODE)" || fail 'container usa rede do host'
  [ -z "$PID_MODE" ] && pass 'namespace de processos isolado' || fail "PidMode=$PID_MODE"
  [ -z "$IPC_MODE" ] || [ "$IPC_MODE" = private ] \
    && pass 'namespace IPC isolado' \
    || fail "IpcMode=$IPC_MODE"

  BAD_PORT_BINDINGS="$(docker port kassinao 2>/dev/null | awk '$3 !~ /^127\.0\.0\.1:/ && $3 !~ /^\[::1\]:/ {print}' || true)"
  if [ -z "$BAD_PORT_BINDINGS" ]; then
    pass 'portas publicadas do container estão em loopback'
  else
    printf '%s\n' "$BAD_PORT_BINDINGS"
    fail 'container possui porta publicada fora de loopback'
  fi

  MOUNTS="$(docker inspect -f '{{range .Mounts}}{{println .Source "|" .Destination}}{{end}}' kassinao 2>/dev/null || true)"
  while IFS='|' read -r source destination; do
    source="$(xargs <<<"$source")"
    destination="$(xargs <<<"$destination")"
    [ -n "$destination" ] || continue
    case "$source" in
      /var/run/docker.sock | /run/docker.sock | /var/lib/docker | / | /etc | /proc | /sys | /dev | /root | /home)
        fail "mount sensível no container: $source -> $destination"
        continue
        ;;
    esac
    case "$destination" in
      /app/recordings | /home/node/.cache) pass "mount esperado: $destination" ;;
      *) fail "mount inesperado no container: $source -> $destination" ;;
    esac
  done <<<"$MOUNTS"
fi

section CLOUDFLARED_CONTAINER_GATE
if ! docker inspect kassinao-tunnel >/dev/null 2>&1; then
  warn 'container kassinao-tunnel não encontrado; aceitável apenas se outro proxy HTTPS privado estiver configurado'
else
  TUNNEL_USER="$(docker inspect -f '{{.Config.User}}' kassinao-tunnel 2>/dev/null || true)"
  TUNNEL_PRIVILEGED="$(docker inspect -f '{{.HostConfig.Privileged}}' kassinao-tunnel 2>/dev/null || true)"
  TUNNEL_READONLY="$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}}' kassinao-tunnel 2>/dev/null || true)"
  TUNNEL_CAP_DROP="$(docker inspect -f '{{json .HostConfig.CapDrop}}' kassinao-tunnel 2>/dev/null || true)"
  TUNNEL_SECURITY_OPT="$(docker inspect -f '{{json .HostConfig.SecurityOpt}}' kassinao-tunnel 2>/dev/null || true)"
  TUNNEL_NETWORK_MODE="$(docker inspect -f '{{.HostConfig.NetworkMode}}' kassinao-tunnel 2>/dev/null || true)"
  TUNNEL_MOUNTS="$(docker inspect -f '{{json .Mounts}}' kassinao-tunnel 2>/dev/null || true)"
  TUNNEL_PORTS="$(docker port kassinao-tunnel 2>/dev/null || true)"

  case "$TUNNEL_USER" in
    '' | 0 | root | 0:0 | root:root) fail "cloudflared roda como usuário inseguro (${TUNNEL_USER:-vazio})" ;;
    *) pass "cloudflared roda como usuário não-root ($TUNNEL_USER)" ;;
  esac
  [ "$TUNNEL_PRIVILEGED" = false ] && pass 'cloudflared não é privilegiado' || fail "cloudflared Privileged=$TUNNEL_PRIVILEGED"
  [ "$TUNNEL_READONLY" = true ] && pass 'root filesystem do cloudflared é read-only' || fail "cloudflared ReadonlyRootfs=$TUNNEL_READONLY"
  grep -q 'ALL' <<<"$TUNNEL_CAP_DROP" && pass 'cloudflared remove todas as capabilities' || fail "cloudflared CapDrop não contém ALL ($TUNNEL_CAP_DROP)"
  grep -q 'no-new-privileges' <<<"$TUNNEL_SECURITY_OPT" && pass 'cloudflared usa no-new-privileges' || fail 'cloudflared sem no-new-privileges'
  [ "$TUNNEL_NETWORK_MODE" != host ] && pass "rede do cloudflared isolada ($TUNNEL_NETWORK_MODE)" || fail 'cloudflared usa rede do host'
  [ "$TUNNEL_MOUNTS" = '[]' ] && pass 'cloudflared não possui mounts do host' || fail 'cloudflared possui mounts inesperados'
  [ -z "$TUNNEL_PORTS" ] && pass 'cloudflared não publica portas' || fail "cloudflared publica portas: $TUNNEL_PORTS"
fi

section COMPOSE_FILES
find "${SEARCH_ROOTS[@]}" -maxdepth 5 -type f \
  \( -name docker-compose.yml -o -name compose.yml -o -name compose.yaml \) \
  -printf '%M %u:%g %p\n' 2>/dev/null || true

section KASSINAO_PATHS
find "${SEARCH_ROOTS[@]}" -maxdepth 5 -iname '*kassinao*' \
  -printf '%y %M %u:%g %p\n' 2>/dev/null | head -160 || true

section ENV_FILE_MODES_AND_KEY_NAMES
while IFS= read -r -d '' file; do
  case "$file" in
    *.example | *.sample | *.template) continue ;;
  esac
  mode="$(stat -c '%a' "$file")"
  stat -c '%a %U:%G %n' "$file"
  sed -n 's/^[[:space:]]*\([A-Za-z_][A-Za-z0-9_]*\)[[:space:]]*=.*/  \1/p' "$file" | sort -u
  case "$mode" in
    600 | 400) pass "$file está restrito ($mode)" ;;
    *) fail "$file usa modo $mode; esperado 600 ou 400" ;;
  esac
done < <(find "${SEARCH_ROOTS[@]}" -maxdepth 5 -type f -name '.env*' -print0 2>/dev/null)

section FAIL2BAN
FAIL2BAN_STATUS="$(fail2ban-client status 2>&1 || true)"
printf '%s\n' "$FAIL2BAN_STATUS"
if grep -Eq 'Jail list:.*(^|[,[:space:]])sshd([,[:space:]]|$)' <<<"$FAIL2BAN_STATUS"; then
  SSHD_JAIL_STATUS="$(fail2ban-client status sshd 2>&1 || true)"
  printf '%s\n' "$SSHD_JAIL_STATUS"
  if grep -q 'Status for the jail: sshd' <<<"$SSHD_JAIL_STATUS"; then
    pass 'jail sshd do fail2ban está ativo'
  else
    fail 'jail sshd do fail2ban não respondeu corretamente'
  fi
else
  fail 'jail sshd do fail2ban não está habilitado'
fi

section SUMMARY
printf 'failures=%d warnings=%d allowed_public_tcp_ports=%s allowed_public_udp_ports=%s\n' \
  "$FAILURES" "$WARNINGS" "$ALLOWED_PUBLIC_TCP_PORTS" "${ALLOWED_PUBLIC_UDP_PORTS:-nenhuma}"
if [ "$FAILURES" -gt 0 ]; then
  exit 1
fi
pass 'VPS atende aos invariantes automatizados; revise também os WARN e o inventário acima'
