#!/bin/bash -p
# Instala uma política mínima de contenção lateral para a rede privada do
# Kassinão. A atualização usa policies A/B: a policy ativa nunca é esvaziada
# enquanto a substituta está sendo construída.
set -Eeuo pipefail
umask 077

die() {
  printf 'ERRO: %s\n' "$*" >&2
  exit 1
}

# KASSINAO_HOST_ENV_SCRUB_BEGIN
_saved_no_dump_marker="${KASSINAO_NO_DUMP_ACTIVE-}"
_saved_no_dump_preload="${LD_PRELOAD-}"
_forbidden_override=''
for _name in DOCKER_HOST DOCKER_CONTEXT DOCKER_CONFIG DOCKER_TLS_VERIFY DOCKER_CERT_PATH DOCKER_API_VERSION \
  KASSINAO_CONTAINER KASSINAO_TUNNEL_CONTAINER KASSINAO_PUBLIC_CONTAINER KASSINAO_RUNTIME_DIR; do
  if declare -p "$_name" >/dev/null 2>&1; then _forbidden_override="$_name"; break; fi
done
[ -r "/proc/$$/environ" ] || die '/proc é obrigatório para limpar o ambiente do firewall'
while IFS='=' read -r -d '' _name _value; do unset "$_name" 2>/dev/null || true; done < "/proc/$$/environ"
unset _name _value
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/root LC_ALL=C
[ -z "$_forbidden_override" ] || die "$_forbidden_override não pode vir do ambiente do firewall"
# KASSINAO_HOST_ENV_SCRUB_END

_script_path="${BASH_SOURCE[0]}"
case "$_script_path" in /*) ;; ./*) _script_path="$PWD/${_script_path#./}" ;; *) _script_path="$PWD/$_script_path" ;; esac
case "$_script_path" in *//* | */./* | */../* | */. | */.. | */) die 'caminho do firewall não é canônico' ;; esac
_script_dir="${_script_path%/*}"
case "$_script_dir" in
  */scripts) PROJECT_DIR="${_script_dir%/scripts}" ;;
  /usr/local/sbin)
    marker=/etc/kassinao/host-controls.env
    [ -f "$marker" ] && [ ! -L "$marker" ] && [ "$(stat -c '%a:%u:%g:%h' "$marker" 2>/dev/null || true)" = 600:0:0:1 ] ||
      die 'marker do kit operacional está ausente ou irregular'
    PROJECT_DIR="$(awk -F= '$1 == "KASSINAO_DEPLOY_DIR" { if (seen++) exit 2; print substr($0, index($0,"=")+1) } END { if (seen != 1) exit 2 }' "$marker")" ||
      die 'marker do kit não contém deploy dir único'
    _script_path="$PROJECT_DIR/scripts/harden-docker-egress.sh"
    ;;
  *) die 'firewall precisa executar do kit ou do entrypoint instalado' ;;
esac
case "${MACHTYPE%%-*}" in x86_64) _no_dump_arch=amd64 ;; aarch64 | arm64) _no_dump_arch=arm64 ;; *) die 'arquitetura sem runtime no-dump' ;; esac
_no_dump_preload="$PROJECT_DIR/runtime/linux-$_no_dump_arch/libkassinao-no-dump.so"
# KASSINAO_HOST_NO_DUMP_BEGIN
if [ "$_saved_no_dump_marker" != "prctl-v1:$$" ] || [ "$_saved_no_dump_preload" != "$_no_dump_preload" ]; then
  exec /usr/bin/python3 "$PROJECT_DIR/scripts/no-dump-exec.py" \
    --bundle-root "$PROJECT_DIR" --script-relative scripts/harden-docker-egress.sh --arch "$_no_dump_arch" -- \
    "$_script_path" "$@"
fi
LD_PRELOAD="$_no_dump_preload"
export LD_PRELOAD
[ "$(ulimit -Sc)" = 0 ] && [ "$(ulimit -Hc)" = 0 ] || die 'core limit do firewall não ficou selado'
IFS= read -r _no_dump_filter < "/proc/$$/coredump_filter" || _no_dump_filter=''
[ "$_no_dump_filter" = 0 ] || die 'coredump_filter do firewall não ficou selado'
# KASSINAO_HOST_NO_DUMP_END
unset _saved_no_dump_marker _saved_no_dump_preload _no_dump_filter _no_dump_arch _no_dump_preload _script_path _script_dir

HOST_SCOPE=dedicated
if [ "${1:-}" = --shared-host ]; then
  HOST_SCOPE=shared
  shift
fi

MODE=apply
OFFLINE=false
case "${1:-}" in
  '') ;;
  --preload) [ "$#" -eq 1 ] || { echo 'ERRO: argumentos inválidos' >&2; exit 1; } ;;
  --check) [ "$#" -eq 1 ] || { echo 'ERRO: argumentos inválidos' >&2; exit 1; }; MODE=check ;;
  --offline-preload) [ "$#" -eq 1 ] || { echo 'ERRO: argumentos inválidos' >&2; exit 1; }; OFFLINE=true ;;
  --remove) [ "$#" -eq 1 ] || { echo 'ERRO: argumentos inválidos' >&2; exit 1; }; MODE=remove ;;
  *) echo 'ERRO: uso: harden-docker-egress.sh [--shared-host] [--preload|--check|--offline-preload|--remove]' >&2; exit 1 ;;
esac
[ "$HOST_SCOPE" != shared ] || [ "$OFFLINE" != true ] || {
  echo 'ERRO: --offline-preload pertence somente ao adapter dedicated' >&2
  exit 1
}

[ "$(id -u)" -eq 0 ] || { echo 'ERRO: execute como root' >&2; exit 1; }
export DOCKER_HOST=unix:///var/run/docker.sock
unset DOCKER_CONTEXT DOCKER_TLS_VERIFY DOCKER_CERT_PATH DOCKER_API_VERSION
DOCKER_CONFIG="$PROJECT_DIR/deploy/docker-client"
DOCKER_CONFIG_FILE="$DOCKER_CONFIG/config.json"
[ -d "$DOCKER_CONFIG" ] && [ ! -L "$DOCKER_CONFIG" ] && [ -f "$DOCKER_CONFIG_FILE" ] && [ ! -L "$DOCKER_CONFIG_FILE" ] ||
  die 'configuração isolada do cliente Docker está ausente ou irregular'
[ "$(sha256sum -- "$DOCKER_CONFIG_FILE" | awk '{print $1}')" = ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356 ] ||
  die 'configuração isolada do cliente Docker diverge do objeto vazio selado'
export DOCKER_CONFIG
if [ "$OFFLINE" != true ]; then
  command -v docker >/dev/null 2>&1 || { echo 'ERRO: docker não encontrado' >&2; exit 1; }
fi
command -v flock >/dev/null 2>&1 || { echo 'ERRO: flock não encontrado' >&2; exit 1; }
command -v stat >/dev/null 2>&1 || { echo 'ERRO: stat não encontrado' >&2; exit 1; }
for command in iptables ip6tables; do
  command -v "$command" >/dev/null 2>&1 || { echo "ERRO: $command não encontrado" >&2; exit 1; }
done

# Além do xtables lock, serialize a atualização completa. Sem isso, dois
# processos poderiam escolher e esvaziar a mesma policy inativa entre comandos.
LOCK_DIR=/run/lock/kassinao
[ -d "$LOCK_DIR" ] && [ ! -L "$LOCK_DIR" ] && \
  [ "$(readlink -f -- "$LOCK_DIR" 2>/dev/null || true)" = "$LOCK_DIR" ] && \
  [ "$(stat -c '%a:%u:%g' "$LOCK_DIR" 2>/dev/null || true)" = '700:0:0' ] || {
  echo 'ERRO: runtime do firewall precisa ser diretório 0700 root:root criado por tmpfiles' >&2
  exit 1
}
LOCK_FILE="$LOCK_DIR/docker-egress.lock"
[ -f "$LOCK_FILE" ] && [ ! -L "$LOCK_FILE" ] && \
  [ "$(readlink -f -- "$LOCK_FILE" 2>/dev/null || true)" = "$LOCK_FILE" ] && \
  [ "$(stat -c '%a:%u:%g:%h' "$LOCK_FILE" 2>/dev/null || true)" = '600:0:0:1' ] || {
  echo 'ERRO: docker-egress.lock precisa preexistir como regular 0600 root:root sem hardlink' >&2
  exit 1
}
exec 9<>"$LOCK_FILE"
# KASSINAO_LOCK_FD_PROOF_BEGIN
[ "$(stat -Lc '%a:%u:%g:%h' "/proc/$$/fd/9" 2>/dev/null || true)" = '600:0:0:1' ] && \
  [ "$(readlink -f -- "/proc/$$/fd/9" 2>/dev/null || true)" = "$LOCK_FILE" ] && \
  [ "$(stat -c '%d:%i' "$LOCK_FILE" 2>/dev/null || true)" = "$(stat -Lc '%d:%i' "/proc/$$/fd/9" 2>/dev/null || true)" ] || {
  echo 'ERRO: docker-egress.lock mudou durante a abertura' >&2
  exit 1
}
# KASSINAO_LOCK_FD_PROOF_END
flock -w 30 9 || { echo 'ERRO: outra atualização do firewall está em andamento' >&2; exit 1; }

CORE_CONTAINER=kassinao
TUNNEL_CONTAINER=kassinao-tunnel
PUBLIC_CONTAINER=kassinao-public
BRIDGE_NAME=kas-private0
case "$CORE_CONTAINER" in '' | *[!A-Za-z0-9_.-]*) echo 'ERRO: nome de container inválido' >&2; exit 1 ;; esac
case "$TUNNEL_CONTAINER" in '' | *[!A-Za-z0-9_.-]*) echo 'ERRO: nome do túnel inválido' >&2; exit 1 ;; esac
case "$PUBLIC_CONTAINER" in '' | *[!A-Za-z0-9_.-]*) echo 'ERRO: nome público inválido' >&2; exit 1 ;; esac

# Nomes são apenas pontos de descoberta. Um container só participa da prova de
# topologia (ou da remoção das regras) depois que seu ID completo, nome e labels
# Compose são revalidados. Status 1 significa ausente; status 2, identidade
# divergente. Em nenhum dos dois casos há mutação do container.
managed_container_id() {
  local reference="$1" container="$2" expected_service="$3" candidate identity
  local actual_id actual_name actual_project actual_service extra
  candidate="$(docker inspect --format '{{.Id}}' "$reference" 2>/dev/null)" || return 1
  [[ "$candidate" =~ ^[0-9a-f]{64}$ ]] || return 2
  identity="$(
    docker inspect \
      --format '{{.Id}}|{{.Name}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}' \
      "$candidate" 2>/dev/null
  )" || return 2
  IFS='|' read -r actual_id actual_name actual_project actual_service extra <<<"$identity"
  [ -z "$extra" ] && [ "$actual_id" = "$candidate" ] && [ "$actual_name" = "/$container" ] && \
    [ "$actual_project" = kassinao ] && [ "$actual_service" = "$expected_service" ] || return 2
  printf '%s\n' "$candidate"
}

resolve_optional_container() {
  local variable="$1" container="$2" expected_service="$3" candidate status
  if candidate="$(managed_container_id "$container" "$container" "$expected_service")"; then
    printf -v "$variable" '%s' "$candidate"
    return 0
  else
    status=$?
  fi
  [ "$status" -eq 1 ] || {
    echo "ERRO: $container ocupa nome reservado sem identidade Compose aprovada" >&2
    return 2
  }
  printf -v "$variable" '%s' ''
}

# A bridge tem nome fixo no Compose. Assim as regras podem existir antes da
# primeira criação do container, eliminando a janela de primeiro boot.
if [ "$MODE" = remove ]; then
  # A remoção das regras só é segura quando nenhum componente desta instância
  # pode voltar pelo restart policy. O uninstall faz a mesma prova antes de
  # desabilitar units; repetir aqui mantém este entrypoint fail-closed.
  for identity in \
    "$CORE_CONTAINER:kassinao" \
    "$TUNNEL_CONTAINER:cloudflared" \
    "$PUBLIC_CONTAINER:kassinao-public"; do
    container="${identity%%:*}"
    expected_service="${identity#*:}"
    cid=''
    resolve_optional_container cid "$container" "$expected_service" || exit 1
    [ -n "$cid" ] || continue
    [ "$(docker inspect -f '{{.State.Running}}' "$cid" 2>/dev/null || true)" = false ] || {
      echo "ERRO: $container precisa estar parado antes de remover o firewall" >&2
      exit 1
    }
    restart_policy="$(docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' "$cid" 2>/dev/null || true)"
    [ -z "$restart_policy" ] || [ "$restart_policy" = no ] || {
      echo "ERRO: desative o restart policy de $container antes de remover o firewall" >&2
      exit 1
    }
  done
  PRELOAD=true
elif [ "$OFFLINE" = true ]; then
  PRELOAD=true
else
  core_cid=''
  resolve_optional_container core_cid "$CORE_CONTAINER" kassinao || exit 1
  tunnel_cid=''
  resolve_optional_container tunnel_cid "$TUNNEL_CONTAINER" cloudflared || exit 1
fi

if [ "$MODE" != remove ] && [ -n "${core_cid:-}" ]; then
  networks="$(docker inspect -f '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}' "$core_cid" | sort -u)"
  [ "$(grep -cve '^$' <<<"$networks")" -eq 1 ] || { echo 'ERRO: core precisa usar exatamente uma rede' >&2; exit 1; }
  network_name="$(grep -ve '^$' <<<"$networks")"
  read -r driver configured_bridge < <(
    docker network inspect -f '{{.Driver}} {{index .Options "com.docker.network.bridge.name"}}' "$network_name"
  )
  [ "$driver" = bridge ] || { echo 'ERRO: a rede privada precisa usar driver bridge' >&2; exit 1; }
  [ "$configured_bridge" = "$BRIDGE_NAME" ] || {
    echo "ERRO: a rede privada precisa usar a bridge fixa $BRIDGE_NAME" >&2
    exit 1
  }

  # O retorno intra-bridge existe apenas para core <-> cloudflared. Um terceiro
  # endpoint transformaria essa exceção em movimento lateral.
  actual_members="$(
    docker network inspect \
      -f '{{range $id, $member := .Containers}}{{printf "%s|%s\n" $id $member.Name}}{{end}}' \
      "$network_name" | awk 'NF' | sort -u
  )"
  tunnel_attached=false
  if [ -n "$tunnel_cid" ] && \
     docker inspect -f '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}' "$tunnel_cid" | grep -Fqx "$network_name"; then
    tunnel_attached=true
  fi
  while IFS= read -r member; do
    [ -z "$member" ] && continue
    [ "$member" = "$core_cid|$CORE_CONTAINER" ] || \
      { [ "$tunnel_attached" = true ] && [ "$member" = "$tunnel_cid|$TUNNEL_CONTAINER" ]; } || {
      echo 'ERRO: a rede privada contém endpoint inesperado' >&2
      exit 1
    }
  done <<<"$actual_members"
  # Docker pode remover o endpoint da network inspect quando um container é
  # parado pelo fail-closed. Exija presença apenas dos componentes running;
  # assim a policy pode ser restaurada antes de o watchdog religá-los.
  if [ "$(docker inspect -f '{{.State.Running}}' "$core_cid")" = true ]; then
    grep -Fqx "$core_cid|$CORE_CONTAINER" <<<"$actual_members" || {
      echo 'ERRO: endpoint running do core está ausente da rede privada' >&2
      exit 1
    }
  fi
  if [ "$tunnel_attached" = true ] && \
     [ "$(docker inspect -f '{{.State.Running}}' "$tunnel_cid")" = true ]; then
    grep -Fqx "$tunnel_cid|$TUNNEL_CONTAINER" <<<"$actual_members" || {
      echo 'ERRO: endpoint running do túnel está ausente da rede privada' >&2
      exit 1
    }
  fi
elif [ "$MODE" != remove ] && [ -n "${tunnel_cid:-}" ]; then
  echo 'ERRO: túnel existe sem o core; recusando preload ambíguo' >&2
  exit 1
elif [ "$MODE" != remove ]; then
  PRELOAD=true
fi

# Todo comando espera o xtables lock. O lock de processo acima protege também
# a escolha da policy A/B entre chamadas individuais.
ipt() { command iptables -w 10 "$@"; }
ip6t() { command ip6tables -w 10 "$@"; }

ensure_chain() {
  local tool="$1" chain="$2"
  if ! "$tool" -S "$chain" >/dev/null 2>&1; then
    "$tool" -N "$chain"
  fi
  "$tool" -S "$chain" >/dev/null
}

chain_is_referenced() {
  local tool="$1" target="$2"
  "$tool" -S | awk -v target="$target" '
    $1 == "-A" {
      for (i = 1; i < NF; i++) {
        if ($i == "-j" && $(i + 1) == target) found = 1
      }
    }
    END { exit found ? 0 : 1 }
  '
}

first_rule() {
  local tool="$1" chain="$2"
  "$tool" -S "$chain" | awk -v chain="$chain" '$1 == "-A" && $2 == chain {print; exit}'
}

rule_count() {
  local tool="$1" chain="$2"
  "$tool" -S "$chain" | awk -v chain="$chain" '$1 == "-A" && $2 == chain {count++} END {print count + 0}'
}

chain_reference_count() {
  local tool="$1" target="$2"
  "$tool" -S 2>/dev/null | awk -v target="$target" '
    $1 == "-A" {
      for (i = 1; i < NF; i++) {
        if ($i == "-j" && $(i + 1) == target) count++
      }
    }
    END { print count + 0 }
  '
}

check_anchor_reference_scope() {
  local tool="$1" target="$2" expected
  shift 2
  expected="$*"
  "$tool" -S 2>/dev/null | awk -v target="$target" -v expected="$expected" '
    $1 == "-A" {
      for (i = 1; i < NF; i++) {
        if ($i == "-j" && $(i + 1) == target) {
          count++
          if ($0 != expected) invalid = 1
        }
      }
    }
    END { exit (!invalid && count <= 1) ? 0 : 1 }
  '
}

check_anchor_reference_scopes() {
  local tool="$1"
  check_anchor_reference_scope "$tool" KASSINAO-EGRESS \
    -A DOCKER-USER -i "$BRIDGE_NAME" -j KASSINAO-EGRESS &&
    check_anchor_reference_scope "$tool" KASSINAO-HOST \
      -A INPUT -i "$BRIDGE_NAME" -j KASSINAO-HOST
}

check_unique_first_rule() {
  local tool="$1" chain="$2"
  shift 2
  local argument expected first exact_count
  expected="-A $chain"
  for argument in "$@"; do expected+=" $argument"; done
  first="$(first_rule "$tool" "$chain" 2>/dev/null)" || return 1
  [ "$first" = "$expected" ] || return 1
  exact_count="$("$tool" -S "$chain" 2>/dev/null | awk -v expected="$expected" '$0 == expected {count++} END {print count + 0}')" || return 1
  [ "$exact_count" -eq 1 ]
}

check_shared_global_hooks() {
  # O adapter shared não é dono de FORWARD nem do jump criado pelo Docker.
  # Ele só pode anexar sua policy escopada quando o hook global já está exato,
  # único e na primeira posição. Divergência falha antes de qualquer mutação.
  check_unique_first_rule ipt FORWARD -j DOCKER-USER &&
    check_unique_first_rule ip6t FORWARD -j DOCKER-USER
}

check_policy_family() {
  local tool="$1" destination index egress_chain egress_inactive host_chain host_inactive references
  shift
  local -a anchor_rules egress_rules host_rules

  check_unique_first_rule "$tool" FORWARD -j DOCKER-USER || return 1
  check_unique_first_rule "$tool" DOCKER-USER -i "$BRIDGE_NAME" -j KASSINAO-EGRESS || return 1
  check_unique_first_rule "$tool" INPUT -i "$BRIDGE_NAME" -j KASSINAO-HOST || return 1
  [ "$(chain_reference_count "$tool" KASSINAO-EGRESS)" -eq 1 ] || return 1
  [ "$(chain_reference_count "$tool" KASSINAO-HOST)" -eq 1 ] || return 1

  mapfile -t anchor_rules < <("$tool" -S KASSINAO-EGRESS 2>/dev/null | awk '$1 == "-A" {print}')
  [ "${#anchor_rules[@]}" -eq 1 ] || return 1
  case "${anchor_rules[0]}" in
    '-A KASSINAO-EGRESS -j KASSINAO-EGRESS-A') egress_chain=KASSINAO-EGRESS-A; egress_inactive=KASSINAO-EGRESS-B ;;
    '-A KASSINAO-EGRESS -j KASSINAO-EGRESS-B') egress_chain=KASSINAO-EGRESS-B; egress_inactive=KASSINAO-EGRESS-A ;;
    *) return 1 ;;
  esac
  mapfile -t anchor_rules < <("$tool" -S KASSINAO-HOST 2>/dev/null | awk '$1 == "-A" {print}')
  [ "${#anchor_rules[@]}" -eq 1 ] || return 1
  case "${anchor_rules[0]}" in
    '-A KASSINAO-HOST -j KASSINAO-HOST-A') host_chain=KASSINAO-HOST-A; host_inactive=KASSINAO-HOST-B ;;
    '-A KASSINAO-HOST -j KASSINAO-HOST-B') host_chain=KASSINAO-HOST-B; host_inactive=KASSINAO-HOST-A ;;
    *) return 1 ;;
  esac

  references="$(chain_reference_count "$tool" "$egress_chain")" || return 1
  [ "$references" -eq 1 ] || return 1
  references="$(chain_reference_count "$tool" "$host_chain")" || return 1
  [ "$references" -eq 1 ] || return 1
  references="$(chain_reference_count "$tool" "$egress_inactive")" || return 1
  [ "$references" -eq 0 ] || return 1
  references="$(chain_reference_count "$tool" "$host_inactive")" || return 1
  [ "$references" -eq 0 ] || return 1

  mapfile -t egress_rules < <("$tool" -S "$egress_chain" 2>/dev/null | awk '$1 == "-A" {print}')
  [ "${#egress_rules[@]}" -eq "$(( $# + 2 ))" ] || return 1
  [ "${egress_rules[0]}" = "-A $egress_chain -o $BRIDGE_NAME -j RETURN" ] || return 1
  index=1
  for destination in "$@"; do
    [ "${egress_rules[$index]}" = "-A $egress_chain -d $destination -j REJECT" ] || return 1
    index=$((index + 1))
  done
  [ "${egress_rules[$index]}" = "-A $egress_chain -j RETURN" ] || return 1

  mapfile -t host_rules < <("$tool" -S "$host_chain" 2>/dev/null | awk '$1 == "-A" {print}')
  [ "${#host_rules[@]}" -eq 3 ] || return 1
  [[ "${host_rules[0]}" == "-A $host_chain -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN" || \
     "${host_rules[0]}" == "-A $host_chain -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN" ]] || return 1
  [ "${host_rules[1]}" = "-A $host_chain -m addrtype --dst-type LOCAL -j REJECT" ] || return 1
  [ "${host_rules[2]}" = "-A $host_chain -j RETURN" ]
}

prepare_policy() {
  local tool="$1" family="$2" anchor="$3" policy_a="$4" policy_b="$5" kind="$6"
  local current inactive destination expected_count
  ensure_chain "$tool" "$anchor"
  ensure_chain "$tool" "$policy_a"
  ensure_chain "$tool" "$policy_b"

  current="$(first_rule "$tool" "$anchor")"
  case "$current" in
    "-A $anchor -j $policy_a") inactive="$policy_b" ;;
    "-A $anchor -j $policy_b") inactive="$policy_a" ;;
    *) inactive="$policy_a" ;;
  esac

  # Nunca esvazie uma chain ainda referenciada. Estado inesperado falha antes
  # de tocar a policy que continua protegendo containers em execução.
  if chain_is_referenced "$tool" "$inactive"; then
    echo "ERRO: policy inativa $inactive ainda está referenciada" >&2
    return 1
  fi
  "$tool" -F "$inactive"

  if [ "$kind" = egress ]; then
    "$tool" -A "$inactive" -o "$BRIDGE_NAME" -j RETURN
    if [ "$family" = 4 ]; then
      for destination in 127.0.0.0/8 10.0.0.0/8 100.64.0.0/10 169.254.0.0/16 172.16.0.0/12 192.168.0.0/16; do
        "$tool" -A "$inactive" -d "$destination" -j REJECT
      done
      expected_count=8
    else
      for destination in ::1/128 fc00::/7 fe80::/10; do
        "$tool" -A "$inactive" -d "$destination" -j REJECT
      done
      expected_count=5
    fi
    "$tool" -A "$inactive" -j RETURN
  else
    "$tool" -A "$inactive" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
    "$tool" -A "$inactive" -m addrtype --dst-type LOCAL -j REJECT
    "$tool" -A "$inactive" -j RETURN
    expected_count=3
  fi

  [ "$(rule_count "$tool" "$inactive")" -eq "$expected_count" ] || {
    echo "ERRO: policy $inactive ficou incompleta" >&2
    return 1
  }
  printf '%s\n' "$inactive"
}

activate_policy() {
  local tool="$1" anchor="$2" replacement="$3" current count
  current="$(first_rule "$tool" "$anchor")"
  case "$current" in
    "-A $anchor -j "*) "$tool" -R "$anchor" 1 -j "$replacement" ;;
    *) "$tool" -I "$anchor" 1 -j "$replacement" ;;
  esac
  # Depois do switch, remova policy legacy/duplicada sem jamais remover o
  # primeiro jump que agora aponta para a policy pronta.
  count="$(rule_count "$tool" "$anchor")"
  while [ "$count" -gt 1 ]; do
    "$tool" -D "$anchor" 2
    count=$((count - 1))
  done
  [ "$(first_rule "$tool" "$anchor")" = "-A $anchor -j $replacement" ]
}

canonicalize_first_rule() {
  local tool="$1" chain="$2"
  shift 2
  local argument expected first duplicate_position
  expected="-A $chain"
  for argument in "$@"; do expected+=" $argument"; done
  first="$(first_rule "$tool" "$chain")"
  if [ "$first" != "$expected" ]; then
    "$tool" -I "$chain" 1 "$@"
  fi
  # A nova regra já está na posição 1. Remover duplicatas inferiores por
  # número mantém a proteção durante toda a normalização do hook.
  while :; do
    duplicate_position="$("$tool" -S "$chain" | awk -v chain="$chain" -v expected="$expected" '
      $1 == "-A" && $2 == chain {
        position++
        if (position > 1 && $0 == expected) { print position; exit }
      }
    ')"
    [ -n "$duplicate_position" ] || break
    "$tool" -D "$chain" "$duplicate_position"
  done
  [ "$(first_rule "$tool" "$chain")" = "$expected" ]
}

remove_policy_family() {
  local tool="$1" chain

  # check_policy_family provou que estes hooks são exatos e únicos. Não toque
  # em FORWARD -> DOCKER-USER, que pertence ao Docker e pode servir outras
  # regras do host.
  "$tool" -D DOCKER-USER -i "$BRIDGE_NAME" -j KASSINAO-EGRESS
  "$tool" -D INPUT -i "$BRIDGE_NAME" -j KASSINAO-HOST

  for chain in KASSINAO-EGRESS KASSINAO-HOST; do
    [ "$(chain_reference_count "$tool" "$chain")" -eq 0 ] || {
      echo "ERRO: $chain ainda tem referência externa; remoção recusada" >&2
      return 1
    }
    "$tool" -F "$chain"
  done
  for chain in KASSINAO-EGRESS-A KASSINAO-EGRESS-B KASSINAO-HOST-A KASSINAO-HOST-B; do
    [ "$(chain_reference_count "$tool" "$chain")" -eq 0 ] || {
      echo "ERRO: $chain ainda tem referência externa; remoção recusada" >&2
      return 1
    }
    "$tool" -F "$chain"
    "$tool" -X "$chain"
  done
  "$tool" -X KASSINAO-EGRESS
  "$tool" -X KASSINAO-HOST
  ! "$tool" -S | grep -Fq KASSINAO-
}

if [ "$MODE" = check ]; then
  if check_policy_family ipt 127.0.0.0/8 10.0.0.0/8 100.64.0.0/10 169.254.0.0/16 172.16.0.0/12 192.168.0.0/16 && \
     check_policy_family ip6t ::1/128 fc00::/7 fe80::/10; then
    echo "Política de egress/host válida em $BRIDGE_NAME."
    exit 0
  fi
  echo 'ERRO: política de egress/host ausente, incompleta ou desviada' >&2
  exit 1
fi

if [ "$MODE" = remove ]; then
  check_policy_family ipt 127.0.0.0/8 10.0.0.0/8 100.64.0.0/10 169.254.0.0/16 172.16.0.0/12 192.168.0.0/16 && \
    check_policy_family ip6t ::1/128 fc00::/7 fe80::/10 || {
    echo 'ERRO: regras Kassinão divergiram; remoção automática recusada' >&2
    exit 1
  }
  remove_policy_family ipt
  remove_policy_family ip6t
  echo "Regras exclusivas do Kassinão removidas de $BRIDGE_NAME; hooks do Docker preservados."
  exit 0
fi

if [ "$HOST_SCOPE" = shared ] && ! check_shared_global_hooks; then
  echo 'ERRO: host shared exige FORWARD -> DOCKER-USER exato e já provisionado pelo Docker; nenhuma regra foi alterada' >&2
  exit 1
fi

# Antes da primeira criação/flush de chain, prove que nenhum workload vizinho
# usa os anchors reservados. Zero referências é o bootstrap; uma referência é
# aceita somente no hook e bridge exatos da instância.
for tool in ipt ip6t; do
  check_anchor_reference_scopes "$tool" || {
    echo "ERRO: referência externa/duplicada aos anchors KASSINAO em $tool; nenhuma regra foi alterada" >&2
    exit 1
  }
done

for tool in ipt ip6t; do
  ensure_chain "$tool" KASSINAO-EGRESS
  ensure_chain "$tool" KASSINAO-EGRESS-A
  ensure_chain "$tool" KASSINAO-EGRESS-B
  ensure_chain "$tool" KASSINAO-HOST
  ensure_chain "$tool" KASSINAO-HOST-A
  ensure_chain "$tool" KASSINAO-HOST-B
  if [ "$OFFLINE" = true ]; then
    ensure_chain "$tool" DOCKER-USER
  else
    "$tool" -S DOCKER-USER >/dev/null
  fi
done

# Construa e valide as quatro policies inativas antes de trocar qualquer uma.
v4_egress="$(prepare_policy ipt 4 KASSINAO-EGRESS KASSINAO-EGRESS-A KASSINAO-EGRESS-B egress)"
v4_host="$(prepare_policy ipt 4 KASSINAO-HOST KASSINAO-HOST-A KASSINAO-HOST-B host)"
v6_egress="$(prepare_policy ip6t 6 KASSINAO-EGRESS KASSINAO-EGRESS-A KASSINAO-EGRESS-B egress)"
v6_host="$(prepare_policy ip6t 6 KASSINAO-HOST KASSINAO-HOST-A KASSINAO-HOST-B host)"

activate_policy ipt KASSINAO-EGRESS "$v4_egress"
activate_policy ipt KASSINAO-HOST "$v4_host"
activate_policy ip6t KASSINAO-EGRESS "$v6_egress"
activate_policy ip6t KASSINAO-HOST "$v6_host"

# Os anchors são estáveis; somente os seus jumps internos alternam entre A/B.
# O adapter dedicated pode reparar o hook global durante o bootstrap exclusivo.
# Em shared, a prova anterior é apenas read-only: não reposicione nem recrie
# FORWARD -> DOCKER-USER, pois a ordem pertence ao daemon e aos workloads do host.
if [ "$HOST_SCOPE" = dedicated ]; then
  canonicalize_first_rule ipt FORWARD -j DOCKER-USER
  canonicalize_first_rule ip6t FORWARD -j DOCKER-USER
fi
canonicalize_first_rule ipt DOCKER-USER -i "$BRIDGE_NAME" -j KASSINAO-EGRESS
canonicalize_first_rule ipt INPUT -i "$BRIDGE_NAME" -j KASSINAO-HOST
canonicalize_first_rule ip6t DOCKER-USER -i "$BRIDGE_NAME" -j KASSINAO-EGRESS
canonicalize_first_rule ip6t INPUT -i "$BRIDGE_NAME" -j KASSINAO-HOST

# A aplicação só é concluída depois de provar novamente anchors, policies e
# referências em ambas as famílias contra o contrato completo.
check_policy_family ipt 127.0.0.0/8 10.0.0.0/8 100.64.0.0/10 169.254.0.0/16 172.16.0.0/12 192.168.0.0/16 &&
  check_policy_family ip6t ::1/128 fc00::/7 fe80::/10 || {
  echo 'ERRO: policy aplicada não passou na revalidação final' >&2
  exit 1
}

if [ "$OFFLINE" = true ]; then
  echo "Política de egress/host pré-carregada antes do daemon Docker em $BRIDGE_NAME."
elif [ "${PRELOAD:-false}" = true ]; then
  echo "Política de egress/host pré-carregada em $BRIDGE_NAME; core ainda não existe."
else
  echo "Política de egress/host aplicada e membership validado em $BRIDGE_NAME."
fi
