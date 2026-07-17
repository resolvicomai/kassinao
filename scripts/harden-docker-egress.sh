#!/bin/bash -p
# Instala uma política mínima de contenção lateral para as duas saídas
# independentes do Kassinão. A atualização usa policies A/B: a policy ativa
# nunca é esvaziada enquanto a substituta está sendo construída.
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
  KASSINAO_CONTAINER KASSINAO_ROUTER_CONTAINER KASSINAO_TUNNEL_CONTAINER KASSINAO_PUBLIC_CONTAINER \
  KASSINAO_RUNTIME_DIR; do
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
[[ "$_no_dump_filter" =~ ^0+$ ]] || die 'coredump_filter do firewall não ficou selado'
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
  --removal-state) [ "$#" -eq 1 ] || { echo 'ERRO: argumentos inválidos' >&2; exit 1; }; MODE=removal-state ;;
  --remove) [ "$#" -eq 1 ] || { echo 'ERRO: argumentos inválidos' >&2; exit 1; }; MODE=remove ;;
  --legacy-removal-state) [ "$#" -eq 1 ] || { echo 'ERRO: argumentos inválidos' >&2; exit 1; }; MODE=legacy-removal-state ;;
  --remove-legacy-policy) [ "$#" -eq 1 ] || { echo 'ERRO: argumentos inválidos' >&2; exit 1; }; MODE=remove-legacy-policy ;;
  *)
    echo 'ERRO: uso: harden-docker-egress.sh [--shared-host] [--preload|--check|--offline-preload|--removal-state|--remove|--legacy-removal-state|--remove-legacy-policy]' >&2
    exit 1
    ;;
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
if [ "$OFFLINE" != true ] && [ "$MODE" != removal-state ] && [ "$MODE" != legacy-removal-state ]; then
  command -v docker >/dev/null 2>&1 || { echo 'ERRO: docker não encontrado' >&2; exit 1; }
fi
command -v flock >/dev/null 2>&1 || { echo 'ERRO: flock não encontrado' >&2; exit 1; }
command -v stat >/dev/null 2>&1 || { echo 'ERRO: stat não encontrado' >&2; exit 1; }
command -v sed >/dev/null 2>&1 || { echo 'ERRO: sed não encontrado' >&2; exit 1; }
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
ROUTER_CONTAINER=kassinao-router
TUNNEL_CONTAINER=kassinao-tunnel
PUBLIC_CONTAINER=kassinao-public
EDGE_INGRESS_BRIDGE=kas-edge0
CORE_LINK_BRIDGE=kas-core0
PUBLIC_LINK_BRIDGE=kas-public0
CORE_EGRESS_BRIDGE=kas-core-eg0
TUNNEL_EGRESS_BRIDGE=kas-tunnel-eg0
case "$CORE_CONTAINER" in '' | *[!A-Za-z0-9_.-]*) echo 'ERRO: nome de container inválido' >&2; exit 1 ;; esac
case "$ROUTER_CONTAINER" in '' | *[!A-Za-z0-9_.-]*) echo 'ERRO: nome do router inválido' >&2; exit 1 ;; esac
case "$TUNNEL_CONTAINER" in '' | *[!A-Za-z0-9_.-]*) echo 'ERRO: nome do túnel inválido' >&2; exit 1 ;; esac
case "$PUBLIC_CONTAINER" in '' | *[!A-Za-z0-9_.-]*) echo 'ERRO: nome público inválido' >&2; exit 1 ;; esac
case "$EDGE_INGRESS_BRIDGE:$CORE_LINK_BRIDGE:$PUBLIC_LINK_BRIDGE:$CORE_EGRESS_BRIDGE:$TUNNEL_EGRESS_BRIDGE" in
  *[!A-Za-z0-9_.:-]*) echo 'ERRO: nome de bridge inválido' >&2; exit 1 ;;
esac
[ "$(printf '%s\n' \
  "$EDGE_INGRESS_BRIDGE" "$CORE_LINK_BRIDGE" "$PUBLIC_LINK_BRIDGE" \
  "$CORE_EGRESS_BRIDGE" "$TUNNEL_EGRESS_BRIDGE" | sort -u | wc -l | tr -d ' ')" -eq 5 ] ||
  die 'bridges da topologia precisam ser distintas'

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

assert_removal_container_gate() {
  local identity container expected_service cid restart_policy inventory line
  local listed_id listed_name extra
  # A remoção das regras só é segura quando nenhum componente desta instância
  # pode voltar pelo restart policy. O uninstall faz a mesma prova antes de
  # desabilitar units; repetir imediatamente antes da mutação fecha também a
  # janela entre o preflight e a remoção.
  inventory="$(
    docker container ls --all --no-trunc --format '{{.ID}}|{{.Names}}'
  )" || {
    echo 'ERRO: daemon Docker indisponível; remoção do firewall recusada' >&2
    return 1
  }
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    IFS='|' read -r listed_id listed_name extra <<<"$line"
    [[ "$listed_id" =~ ^[0-9a-f]{64}$ ]] &&
      [[ "$listed_name" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] &&
      [ -z "$extra" ] || {
      echo 'ERRO: inventário Docker retornou identidade ambígua' >&2
      return 1
    }
  done <<<"$inventory"
  for identity in \
    "$CORE_CONTAINER:kassinao" \
    "$ROUTER_CONTAINER:kassinao-router" \
    "$TUNNEL_CONTAINER:cloudflared" \
    "$PUBLIC_CONTAINER:kassinao-public"; do
    container="${identity%%:*}"
    expected_service="${identity#*:}"
    cid=''
    line="$(printf '%s\n' "$inventory" | awk -F'|' -v name="$container" '$2 == name {print}')"
    [ "$(printf '%s\n' "$line" | awk 'NF {count++} END {print count + 0}')" -le 1 ] || {
      echo "ERRO: inventário Docker duplicou o nome reservado $container" >&2
      return 1
    }
    if [ -n "$line" ]; then
      cid="${line%%|*}"
      [ "$(managed_container_id "$cid" "$container" "$expected_service")" = "$cid" ] || {
        echo "ERRO: $container não passou na prova de identidade durante a remoção" >&2
        return 1
      }
    fi
    [ -n "$cid" ] || continue
    [ "$(docker inspect -f '{{.State.Running}}' "$cid" 2>/dev/null || true)" = false ] || {
      echo "ERRO: $container precisa estar parado antes de remover o firewall" >&2
      return 1
    }
    restart_policy="$(docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' "$cid" 2>/dev/null || true)"
    [ "$restart_policy" = no ] || {
      echo "ERRO: desative o restart policy de $container antes de remover o firewall" >&2
      return 1
    }
  done
}

# As bridges têm nomes fixos no Compose. Assim as regras podem existir antes da
# primeira criação dos containers, eliminando a janela de primeiro boot.
if [ "$MODE" = remove ] || [ "$MODE" = remove-legacy-policy ]; then
  assert_removal_container_gate || exit 1
  PRELOAD=true
elif [ "$MODE" = removal-state ] || [ "$MODE" = legacy-removal-state ]; then
  PRELOAD=true
elif [ "$OFFLINE" = true ]; then
  PRELOAD=true
else
  core_cid=''
  resolve_optional_container core_cid "$CORE_CONTAINER" kassinao || exit 1
  router_cid=''
  resolve_optional_container router_cid "$ROUTER_CONTAINER" kassinao-router || exit 1
  tunnel_cid=''
  resolve_optional_container tunnel_cid "$TUNNEL_CONTAINER" cloudflared || exit 1
  public_cid=''
  resolve_optional_container public_cid "$PUBLIC_CONTAINER" kassinao-public || exit 1
fi

container_networks() {
  docker inspect -f '{{range $name, $_ := .NetworkSettings.Networks}}{{printf "%s\n" $name}}{{end}}' "$1" |
    sed '/^$/d' | sort -u
}

network_metadata() {
  docker network inspect \
    -f '{{.Driver}}|{{.Internal}}|{{index .Options "com.docker.network.bridge.name"}}|{{index .Options "com.docker.network.bridge.gateway_mode_ipv4"}}|{{index .Options "com.docker.network.bridge.gateway_mode_ipv6"}}|{{index .Options "com.docker.network.bridge.enable_icc"}}' \
    "$1" 2>/dev/null
}

normalize_network_option() {
  case "$1" in
    '<no value>') printf '' ;;
    *) printf '%s' "$1" ;;
  esac
}

assert_network_metadata() {
  local network="$1" expected_bridge="$2" expected_kind="$3" role="$4"
  local metadata driver internal configured_bridge gateway4 gateway6 icc extra
  metadata="$(network_metadata "$network")" || {
    echo "ERRO: não foi possível inspecionar rede de $role" >&2
    return 1
  }
  IFS='|' read -r driver internal configured_bridge gateway4 gateway6 icc extra <<<"$metadata"
  [ -z "$extra" ] || {
    echo "ERRO: metadados de rede de $role são ambíguos" >&2
    return 1
  }
  gateway4="$(normalize_network_option "$gateway4")"
  gateway6="$(normalize_network_option "$gateway6")"
  icc="$(normalize_network_option "$icc")"
  [ "$driver" = bridge ] && [ "$configured_bridge" = "$expected_bridge" ] || {
    echo "ERRO: rede de $role não usa a bridge esperada $expected_bridge" >&2
    return 1
  }
  case "$expected_kind" in
    internal)
      [ "$internal" = true ] && [ "$gateway4" = isolated ] && [ "$gateway6" = isolated ] || {
        echo "ERRO: bridge interna $expected_bridge não está isolada" >&2
        return 1
      }
      # Docker pode materializar o default ou omiti-lo. `false` quebraria a
      # comunicação estritamente necessária entre os membros aprovados.
      [ -z "$icc" ] || [ "$icc" = true ] || {
        echo "ERRO: bridge interna $expected_bridge tem ICC incompatível" >&2
        return 1
      }
      ;;
    egress)
      [ "$internal" = false ] && [ -z "$gateway4" ] && [ -z "$gateway6" ] && [ "$icc" = false ] || {
        echo "ERRO: bridge de egress $expected_bridge não está selada com ICC=false" >&2
        return 1
      }
      ;;
    *)
      echo "ERRO: tipo de rede desconhecido para $role" >&2
      return 1
      ;;
  esac
}

# Emite um mapa estável bridge|network depois de provar que o container está
# ligado somente às redes aprovadas. Uma bridge externa adicional seria um
# bypass direto das regras presas a kas-core-eg0/kas-tunnel-eg0.
container_topology() {
  local cid="$1" role="$2" expected="$3"
  local network metadata driver internal configured_bridge gateway4 gateway6 icc extra
  local expected_bridge expected_kind matched_kind actual='' actual_bridges='' expected_bridges=''
  while IFS='|' read -r expected_bridge expected_kind; do
    [ -n "$expected_bridge" ] || continue
    expected_bridges="${expected_bridges}${expected_bridge}"$'\n'
  done <<<"$expected"

  while IFS= read -r network; do
    [ -n "$network" ] || continue
    metadata="$(network_metadata "$network")" || {
      echo "ERRO: não foi possível inspecionar rede de $role" >&2
      return 1
    }
    IFS='|' read -r driver internal configured_bridge gateway4 gateway6 icc extra <<<"$metadata"
    [ -z "$extra" ] && [ "$driver" = bridge ] && [ -n "$configured_bridge" ] || {
      echo "ERRO: $role participa de rede sem identidade bridge aprovada" >&2
      return 1
    }
    matched_kind=''
    while IFS='|' read -r expected_bridge expected_kind; do
      [ "$configured_bridge" = "$expected_bridge" ] || continue
      [ -z "$matched_kind" ] || {
        echo "ERRO: contrato de redes de $role contém bridge duplicada" >&2
        return 1
      }
      matched_kind="$expected_kind"
    done <<<"$expected"
    [ -n "$matched_kind" ] || {
      echo "ERRO: $role participa de rede não autorizada na bridge $configured_bridge" >&2
      return 1
    }
    case "$actual_bridges" in
      *$'\n'"$configured_bridge"$'\n'* | "$configured_bridge"$'\n'*)
        echo "ERRO: $role participa de mais de uma rede na bridge $configured_bridge" >&2
        return 1
        ;;
    esac
    assert_network_metadata "$network" "$configured_bridge" "$matched_kind" "$role" || return 1
    actual="${actual}${configured_bridge}|${network}"$'\n'
    actual_bridges="${actual_bridges}${configured_bridge}"$'\n'
  done < <(container_networks "$cid")

  [ "$(printf '%s' "$actual_bridges" | sed '/^$/d' | sort)" = \
    "$(printf '%s' "$expected_bridges" | sed '/^$/d' | sort)" ] || {
    echo "ERRO: topologia de redes de $role diverge do conjunto exato aprovado" >&2
    return 1
  }
  printf '%s' "$actual" | sed '/^$/d' | sort
}

network_for_bridge() {
  local topology="$1" bridge="$2"
  printf '%s\n' "$topology" | awk -F'|' -v bridge="$bridge" '$1 == bridge { print $2 }'
}

assert_network_members() {
  local network="$1" expected_bridge="$2" expected_kind="$3" role="$4" expected_members="$5"
  local actual_members
  assert_network_metadata "$network" "$expected_bridge" "$expected_kind" "$role" || return 1
  actual_members="$(
    docker network inspect \
      -f '{{range $id, $member := .Containers}}{{printf "%s|%s\n" $id $member.Name}}{{end}}' \
      "$network" 2>/dev/null | awk 'NF' | sort -u
  )" || {
    echo "ERRO: não foi possível validar membership de $role" >&2
    return 1
  }
  [ "$actual_members" = "$(printf '%s\n' "$expected_members" | awk 'NF' | sort -u)" ] || {
    echo "ERRO: membership da bridge $expected_bridge diverge da topologia aprovada" >&2
    return 1
  }
}

assert_container_identity_stable() {
  local expected_cid="$1" container="$2" service="$3" role="$4" actual
  actual="$(managed_container_id "$container" "$container" "$service")" || {
    echo "ERRO: identidade de $role mudou durante a validação" >&2
    return 1
  }
  [ "$actual" = "$expected_cid" ] || {
    echo "ERRO: ID de $role mudou durante a validação" >&2
    return 1
  }
}

if [ "$MODE" != remove ] &&
   [ "$MODE" != remove-legacy-policy ] &&
   [ "$MODE" != removal-state ] &&
   [ "$MODE" != legacy-removal-state ] &&
   [ "$OFFLINE" != true ]; then
  if [ -z "$core_cid" ] && [ -z "$router_cid" ] && [ -z "$public_cid" ] && [ -z "$tunnel_cid" ]; then
    PRELOAD=true
  else
    [ -n "$core_cid" ] && [ -n "$router_cid" ] && [ -n "$public_cid" ] || {
      echo 'ERRO: topologia parcial; core, router e público precisam existir juntos' >&2
      exit 1
    }

    core_expected="${CORE_LINK_BRIDGE}|internal"$'\n'"${CORE_EGRESS_BRIDGE}|egress"
    router_expected="${EDGE_INGRESS_BRIDGE}|internal"$'\n'"${CORE_LINK_BRIDGE}|internal"$'\n'"${PUBLIC_LINK_BRIDGE}|internal"
    public_expected="${PUBLIC_LINK_BRIDGE}|internal"
    tunnel_expected="${EDGE_INGRESS_BRIDGE}|internal"$'\n'"${TUNNEL_EGRESS_BRIDGE}|egress"

    core_topology="$(container_topology "$core_cid" core "$core_expected")" || exit 1
    router_topology="$(container_topology "$router_cid" router "$router_expected")" || exit 1
    public_topology="$(container_topology "$public_cid" público "$public_expected")" || exit 1
    tunnel_topology=''
    if [ -n "$tunnel_cid" ]; then
      tunnel_topology="$(container_topology "$tunnel_cid" túnel "$tunnel_expected")" || exit 1
    fi

    core_link_network="$(network_for_bridge "$core_topology" "$CORE_LINK_BRIDGE")"
    core_egress_network="$(network_for_bridge "$core_topology" "$CORE_EGRESS_BRIDGE")"
    router_edge_network="$(network_for_bridge "$router_topology" "$EDGE_INGRESS_BRIDGE")"
    router_core_network="$(network_for_bridge "$router_topology" "$CORE_LINK_BRIDGE")"
    router_public_network="$(network_for_bridge "$router_topology" "$PUBLIC_LINK_BRIDGE")"
    public_link_network="$(network_for_bridge "$public_topology" "$PUBLIC_LINK_BRIDGE")"
    [ "$core_link_network" = "$router_core_network" ] &&
      [ "$router_public_network" = "$public_link_network" ] || die 'links internos não são compartilhados pelos membros esperados'

    core_members="${core_cid}|${CORE_CONTAINER}"$'\n'"${router_cid}|${ROUTER_CONTAINER}"
    public_members="${router_cid}|${ROUTER_CONTAINER}"$'\n'"${public_cid}|${PUBLIC_CONTAINER}"
    edge_members="${router_cid}|${ROUTER_CONTAINER}"
    [ -z "$tunnel_cid" ] || edge_members="${edge_members}"$'\n'"${tunnel_cid}|${TUNNEL_CONTAINER}"
    assert_network_members "$core_link_network" "$CORE_LINK_BRIDGE" internal core-link "$core_members" || exit 1
    assert_network_members "$core_egress_network" "$CORE_EGRESS_BRIDGE" egress core-egress \
      "${core_cid}|${CORE_CONTAINER}" || exit 1
    assert_network_members "$router_public_network" "$PUBLIC_LINK_BRIDGE" internal public-link "$public_members" || exit 1
    assert_network_members "$router_edge_network" "$EDGE_INGRESS_BRIDGE" internal edge-ingress "$edge_members" || exit 1

    if [ -n "$tunnel_cid" ]; then
      tunnel_edge_network="$(network_for_bridge "$tunnel_topology" "$EDGE_INGRESS_BRIDGE")"
      tunnel_egress_network="$(network_for_bridge "$tunnel_topology" "$TUNNEL_EGRESS_BRIDGE")"
      [ "$router_edge_network" = "$tunnel_edge_network" ] || die 'router e túnel não compartilham o edge interno'
      [ "$core_egress_network" != "$tunnel_egress_network" ] || die 'core e túnel não podem compartilhar egress'
      assert_network_members "$tunnel_egress_network" "$TUNNEL_EGRESS_BRIDGE" egress tunnel-egress \
        "${tunnel_cid}|${TUNNEL_CONTAINER}" || exit 1
    fi

    # Fecha trocas de network/ID entre a descoberta e a aplicação da policy.
    [ "$core_topology" = "$(container_topology "$core_cid" core "$core_expected")" ] &&
      [ "$router_topology" = "$(container_topology "$router_cid" router "$router_expected")" ] &&
      [ "$public_topology" = "$(container_topology "$public_cid" público "$public_expected")" ] || \
      die 'topologia mudou durante a validação'
    if [ -n "$tunnel_cid" ]; then
      [ "$tunnel_topology" = "$(container_topology "$tunnel_cid" túnel "$tunnel_expected")" ] ||
        die 'topologia do túnel mudou durante a validação'
    fi
    assert_network_members "$core_link_network" "$CORE_LINK_BRIDGE" internal core-link "$core_members" || exit 1
    assert_network_members "$core_egress_network" "$CORE_EGRESS_BRIDGE" egress core-egress \
      "${core_cid}|${CORE_CONTAINER}" || exit 1
    assert_network_members "$router_public_network" "$PUBLIC_LINK_BRIDGE" internal public-link "$public_members" || exit 1
    assert_network_members "$router_edge_network" "$EDGE_INGRESS_BRIDGE" internal edge-ingress "$edge_members" || exit 1
    if [ -n "$tunnel_cid" ]; then
      assert_network_members "$tunnel_egress_network" "$TUNNEL_EGRESS_BRIDGE" egress tunnel-egress \
        "${tunnel_cid}|${TUNNEL_CONTAINER}" || exit 1
    fi
    assert_container_identity_stable "$core_cid" "$CORE_CONTAINER" kassinao core || exit 1
    assert_container_identity_stable "$router_cid" "$ROUTER_CONTAINER" kassinao-router router || exit 1
    assert_container_identity_stable "$public_cid" "$PUBLIC_CONTAINER" kassinao-public público || exit 1
    [ -z "$tunnel_cid" ] ||
      assert_container_identity_stable "$tunnel_cid" "$TUNNEL_CONTAINER" cloudflared túnel || exit 1
  fi
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
        if (($i == "-j" || $i == "-g") && $(i + 1) == target) found = 1
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
        if (($i == "-j" || $i == "-g") && $(i + 1) == target) count++
      }
    }
    END { print count + 0 }
  '
}

check_reference_scope() {
  local tool="$1" target="$2" expected_one="$3" expected_two="${4:-}"
  "$tool" -S 2>/dev/null | awk \
    -v target="$target" -v expected_one="$expected_one" -v expected_two="$expected_two" '
    $1 == "-A" {
      for (i = 1; i < NF; i++) {
        if (($i == "-j" || $i == "-g") && $(i + 1) == target) {
          if ($0 == expected_one) {
            one++
          } else if (expected_two != "" && $0 == expected_two) {
            two++
          } else {
            invalid = 1
          }
        }
      }
    }
    END { exit (!invalid && one <= 1 && two <= 1) ? 0 : 1 }
  '
}

check_anchor_reference_scopes() {
  local tool="$1"
  check_reference_scope "$tool" KASSINAO-EGRESS \
    "-A DOCKER-USER -i $CORE_EGRESS_BRIDGE -j KASSINAO-EGRESS" \
    "-A DOCKER-USER -i $TUNNEL_EGRESS_BRIDGE -j KASSINAO-EGRESS" &&
    check_reference_scope "$tool" KASSINAO-HOST \
      "-A INPUT -i $CORE_EGRESS_BRIDGE -j KASSINAO-HOST" \
      "-A INPUT -i $TUNNEL_EGRESS_BRIDGE -j KASSINAO-HOST"
}

check_policy_reference_scopes() {
  local tool="$1"
  check_reference_scope "$tool" KASSINAO-EGRESS-A '-A KASSINAO-EGRESS -j KASSINAO-EGRESS-A' &&
    check_reference_scope "$tool" KASSINAO-EGRESS-B '-A KASSINAO-EGRESS -j KASSINAO-EGRESS-B' &&
    check_reference_scope "$tool" KASSINAO-HOST-A '-A KASSINAO-HOST -j KASSINAO-HOST-A' &&
    check_reference_scope "$tool" KASSINAO-HOST-B '-A KASSINAO-HOST -j KASSINAO-HOST-B'
}

check_reserved_chain_inventory() {
  local tool="$1"
  "$tool" -S 2>/dev/null | awk '
    $1 == "-N" && $2 ~ /^KASSINAO-/ {
      if ($2 != "KASSINAO-EGRESS" &&
          $2 != "KASSINAO-EGRESS-A" &&
          $2 != "KASSINAO-EGRESS-B" &&
          $2 != "KASSINAO-HOST" &&
          $2 != "KASSINAO-HOST-A" &&
          $2 != "KASSINAO-HOST-B") invalid = 1
    }
    END { exit invalid ? 1 : 0 }
  '
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

rule_at_position() {
  local tool="$1" chain="$2" position="$3"
  "$tool" -S "$chain" 2>/dev/null |
    awk -v chain="$chain" -v wanted="$position" '
      $1 == "-A" && $2 == chain {
        position++
        if (position == wanted) { print; exit }
      }
    '
}

check_unique_positioned_rule() {
  local tool="$1" chain="$2" position="$3"
  shift 3
  local argument expected actual exact_count
  expected="-A $chain"
  for argument in "$@"; do expected+=" $argument"; done
  actual="$(rule_at_position "$tool" "$chain" "$position")" || return 1
  [ "$actual" = "$expected" ] || return 1
  exact_count="$("$tool" -S "$chain" 2>/dev/null |
    awk -v expected="$expected" '$0 == expected {count++} END {print count + 0}')" || return 1
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
  local tool="$1" destination index egress_chain egress_inactive host_chain host_inactive inactive_count references
  shift
  local -a anchor_rules egress_rules host_rules

  check_unique_first_rule "$tool" FORWARD -j DOCKER-USER || return 1
  check_unique_positioned_rule \
    "$tool" DOCKER-USER 1 -i "$CORE_EGRESS_BRIDGE" -j KASSINAO-EGRESS || return 1
  check_unique_positioned_rule \
    "$tool" DOCKER-USER 2 -i "$TUNNEL_EGRESS_BRIDGE" -j KASSINAO-EGRESS || return 1
  check_unique_positioned_rule \
    "$tool" INPUT 1 -i "$CORE_EGRESS_BRIDGE" -j KASSINAO-HOST || return 1
  check_unique_positioned_rule \
    "$tool" INPUT 2 -i "$TUNNEL_EGRESS_BRIDGE" -j KASSINAO-HOST || return 1
  [ "$(chain_reference_count "$tool" KASSINAO-EGRESS)" -eq 2 ] || return 1
  [ "$(chain_reference_count "$tool" KASSINAO-HOST)" -eq 2 ] || return 1

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
  [ "${#egress_rules[@]}" -eq "$(( $# + 1 ))" ] || return 1
  index=0
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
  [ "${host_rules[2]}" = "-A $host_chain -j RETURN" ] || return 1

  inactive_count="$(rule_count "$tool" "$egress_inactive")" || return 1
  case "$inactive_count" in
    0) ;;
    "$(( $# + 1 ))") check_egress_removal_shape "$tool" "$egress_inactive" "$@" || return 1 ;;
    *) return 1 ;;
  esac
  inactive_count="$(rule_count "$tool" "$host_inactive")" || return 1
  case "$inactive_count" in
    0) ;;
    3) check_host_removal_shape "$tool" "$host_inactive" || return 1 ;;
    *) return 1 ;;
  esac
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
    if [ "$family" = 4 ]; then
      for destination in 127.0.0.0/8 10.0.0.0/8 100.64.0.0/10 169.254.0.0/16 172.16.0.0/12 192.168.0.0/16; do
        "$tool" -A "$inactive" -d "$destination" -j REJECT
      done
      expected_count=7
    else
      for destination in ::1/128 fc00::/7 fe80::/10; do
        "$tool" -A "$inactive" -d "$destination" -j REJECT
      done
      expected_count=4
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

canonicalize_positioned_rule() {
  local tool="$1" chain="$2" position="$3"
  shift 3
  local argument expected actual duplicate_position
  expected="-A $chain"
  for argument in "$@"; do expected+=" $argument"; done
  actual="$(rule_at_position "$tool" "$chain" "$position")"
  if [ "$actual" != "$expected" ]; then
    "$tool" -I "$chain" "$position" "$@"
  fi
  # Preserve a regra pronta na posição contratada e remova somente cópias
  # exatas inferiores ou superiores. Regras de workloads vizinhos ficam
  # intactas e abaixo do prefixo fail-closed do Kassinão.
  while :; do
    duplicate_position="$("$tool" -S "$chain" |
      awk -v chain="$chain" -v expected="$expected" -v keep="$position" '
        $1 == "-A" && $2 == chain {
          position++
          if (position != keep && $0 == expected) { print position; exit }
        }
      ')"
    [ -n "$duplicate_position" ] || break
    "$tool" -D "$chain" "$duplicate_position"
  done
  check_unique_positioned_rule "$tool" "$chain" "$position" "$@"
}

chain_exists() {
  local tool="$1" chain="$2"
  "$tool" -S "$chain" >/dev/null 2>&1
}

chain_source_rule_count() {
  local tool="$1" chain="$2"
  "$tool" -S 2>/dev/null |
    awk -v chain="$chain" '$1 == "-A" && $2 == chain {count++} END {print count + 0}'
}

exact_rule_count() {
  local tool="$1" chain="$2"
  shift 2
  local argument expected
  expected="-A $chain"
  for argument in "$@"; do expected+=" $argument"; done
  "$tool" -S "$chain" 2>/dev/null |
    awk -v expected="$expected" '$0 == expected {count++} END {print count + 0}'
}

delete_exact_rule_if_present() {
  local tool="$1" chain="$2" count
  shift 2
  count="$(exact_rule_count "$tool" "$chain" "$@")" || return 1
  case "$count" in
    0) return 0 ;;
    1) "$tool" -D "$chain" "$@" ;;
    *) return 1 ;;
  esac
}

allowed_owned_inventory() {
  local chain destination
  for chain in \
    KASSINAO-EGRESS KASSINAO-EGRESS-A KASSINAO-EGRESS-B \
    KASSINAO-HOST KASSINAO-HOST-A KASSINAO-HOST-B; do
    printf '%s\n' "-N $chain"
  done
  printf '%s\n' \
    "-A DOCKER-USER -i $CORE_EGRESS_BRIDGE -j KASSINAO-EGRESS" \
    "-A DOCKER-USER -i $TUNNEL_EGRESS_BRIDGE -j KASSINAO-EGRESS" \
    "-A INPUT -i $CORE_EGRESS_BRIDGE -j KASSINAO-HOST" \
    "-A INPUT -i $TUNNEL_EGRESS_BRIDGE -j KASSINAO-HOST" \
    '-A KASSINAO-EGRESS -j KASSINAO-EGRESS-A' \
    '-A KASSINAO-EGRESS -j KASSINAO-EGRESS-B' \
    '-A KASSINAO-HOST -j KASSINAO-HOST-A' \
    '-A KASSINAO-HOST -j KASSINAO-HOST-B'
  for chain in KASSINAO-EGRESS-A KASSINAO-EGRESS-B; do
    for destination in "$@"; do
      printf '%s\n' "-A $chain -d $destination -j REJECT"
    done
    printf '%s\n' "-A $chain -j RETURN"
  done
  for chain in KASSINAO-HOST-A KASSINAO-HOST-B; do
    printf '%s\n' \
      "-A $chain -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN" \
      "-A $chain -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN" \
      "-A $chain -m addrtype --dst-type LOCAL -j REJECT" \
      "-A $chain -j RETURN"
  done
}

check_anchor_removal_shape() {
  local tool="$1" chain="$2" policy_a="$3" policy_b="$4" count first references source_rules
  if ! chain_exists "$tool" "$chain"; then
    references="$(chain_reference_count "$tool" "$chain")" || return 1
    source_rules="$(chain_source_rule_count "$tool" "$chain")" || return 1
    [ "$references" -eq 0 ] && [ "$source_rules" -eq 0 ]
    return
  fi
  count="$(rule_count "$tool" "$chain")" || return 1
  case "$count" in
    0) return 0 ;;
    1)
      first="$(first_rule "$tool" "$chain")" || return 1
      [ "$first" = "-A $chain -j $policy_a" ] || [ "$first" = "-A $chain -j $policy_b" ]
      ;;
    *) return 1 ;;
  esac
}

check_egress_removal_shape() {
  local tool="$1" chain="$2" destination index references source_rules
  shift 2
  local -a rules expected
  if ! chain_exists "$tool" "$chain"; then
    references="$(chain_reference_count "$tool" "$chain")" || return 1
    source_rules="$(chain_source_rule_count "$tool" "$chain")" || return 1
    [ "$references" -eq 0 ] && [ "$source_rules" -eq 0 ]
    return
  fi
  mapfile -t rules < <("$tool" -S "$chain" 2>/dev/null | awk '$1 == "-A" {print}')
  for destination in "$@"; do
    expected+=("-A $chain -d $destination -j REJECT")
  done
  expected+=("-A $chain -j RETURN")
  [ "${#rules[@]}" -le "${#expected[@]}" ] || return 1
  references="$(chain_reference_count "$tool" "$chain")" || return 1
  if [ "$references" -ne 0 ]; then
    [ "$references" -eq 1 ] && [ "${#rules[@]}" -eq "${#expected[@]}" ] || return 1
  fi
  for ((index = 0; index < ${#rules[@]}; index++)); do
    [ "${rules[$index]}" = "${expected[$index]}" ] || return 1
  done
}

check_host_removal_shape() {
  local tool="$1" chain="$2" index references source_rules
  local -a rules expected
  if ! chain_exists "$tool" "$chain"; then
    references="$(chain_reference_count "$tool" "$chain")" || return 1
    source_rules="$(chain_source_rule_count "$tool" "$chain")" || return 1
    [ "$references" -eq 0 ] && [ "$source_rules" -eq 0 ]
    return
  fi
  mapfile -t rules < <("$tool" -S "$chain" 2>/dev/null | awk '$1 == "-A" {print}')
  expected=(
    "-A $chain -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN"
    "-A $chain -m addrtype --dst-type LOCAL -j REJECT"
    "-A $chain -j RETURN"
  )
  [ "${#rules[@]}" -le "${#expected[@]}" ] || return 1
  references="$(chain_reference_count "$tool" "$chain")" || return 1
  if [ "$references" -ne 0 ]; then
    [ "$references" -eq 1 ] && [ "${#rules[@]}" -eq "${#expected[@]}" ] || return 1
  fi
  for ((index = 0; index < ${#rules[@]}; index++)); do
    if [ "$index" -eq 0 ]; then
      [[ "${rules[0]}" == "${expected[0]}" || \
         "${rules[0]}" == "-A $chain -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN" ]] || return 1
    else
      [ "${rules[$index]}" = "${expected[$index]}" ] || return 1
    fi
  done
}

check_owned_reference_scope_family() {
  local tool="$1"
  check_reserved_chain_inventory "$tool" &&
    check_anchor_reference_scopes "$tool" &&
    check_policy_reference_scopes "$tool"
}

check_owned_removal_progress_family() {
  local tool="$1" actual_owned allowed duplicates line chain
  shift
  check_unique_first_rule "$tool" FORWARD -j DOCKER-USER || return 1
  check_owned_reference_scope_family "$tool" || return 1

  actual_owned="$("$tool" -S 2>/dev/null | grep -F 'KASSINAO-' || true)"
  allowed="$(allowed_owned_inventory "$@")" || return 1
  duplicates="$(printf '%s\n' "$actual_owned" | sed '/^$/d' | sort | uniq -d)"
  [ -z "$duplicates" ] || return 1
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    grep -Fqx -- "$line" <<<"$allowed" || return 1
  done <<<"$actual_owned"

  check_anchor_removal_shape \
    "$tool" KASSINAO-EGRESS KASSINAO-EGRESS-A KASSINAO-EGRESS-B || return 1
  check_anchor_removal_shape \
    "$tool" KASSINAO-HOST KASSINAO-HOST-A KASSINAO-HOST-B || return 1
  for chain in KASSINAO-EGRESS-A KASSINAO-EGRESS-B; do
    check_egress_removal_shape "$tool" "$chain" "$@" || return 1
  done
  for chain in KASSINAO-HOST-A KASSINAO-HOST-B; do
    check_host_removal_shape "$tool" "$chain" || return 1
  done
}

policy_family_absent() {
  local tool="$1" inventory
  inventory="$("$tool" -S 2>/dev/null)" || return 1
  ! grep -Fq 'KASSINAO-' <<<"$inventory"
}

classify_policy_family() {
  local tool="$1"
  shift
  if policy_family_absent "$tool"; then
    printf '%s\n' absent
  elif check_owned_removal_progress_family "$tool" "$@" &&
       check_policy_family "$tool" "$@"; then
    printf '%s\n' exact-present
  elif check_owned_removal_progress_family "$tool" "$@"; then
    printf '%s\n' owned-progress
  else
    return 1
  fi
}

check_legacy_anchor_reference_scopes() {
  local tool="$1"
  check_reference_scope "$tool" KASSINAO-EGRESS \
    '-A DOCKER-USER -i kas-private0 -j KASSINAO-EGRESS' &&
    check_reference_scope "$tool" KASSINAO-HOST \
      '-A INPUT -i kas-private0 -j KASSINAO-HOST'
}

check_legacy_owned_reference_scope_family() {
  local tool="$1"
  check_reserved_chain_inventory "$tool" &&
    check_legacy_anchor_reference_scopes "$tool" &&
    check_policy_reference_scopes "$tool"
}

legacy_allowed_owned_inventory() {
  local chain destination
  for chain in \
    KASSINAO-EGRESS KASSINAO-EGRESS-A KASSINAO-EGRESS-B \
    KASSINAO-HOST KASSINAO-HOST-A KASSINAO-HOST-B; do
    printf '%s\n' "-N $chain"
  done
  printf '%s\n' \
    '-A DOCKER-USER -i kas-private0 -j KASSINAO-EGRESS' \
    '-A INPUT -i kas-private0 -j KASSINAO-HOST' \
    '-A KASSINAO-EGRESS -j KASSINAO-EGRESS-A' \
    '-A KASSINAO-EGRESS -j KASSINAO-EGRESS-B' \
    '-A KASSINAO-HOST -j KASSINAO-HOST-A' \
    '-A KASSINAO-HOST -j KASSINAO-HOST-B'
  for chain in KASSINAO-EGRESS-A KASSINAO-EGRESS-B; do
    printf '%s\n' "-A $chain -o kas-private0 -j RETURN"
    for destination in "$@"; do
      printf '%s\n' "-A $chain -d $destination -j REJECT"
    done
    printf '%s\n' "-A $chain -j RETURN"
  done
  for chain in KASSINAO-HOST-A KASSINAO-HOST-B; do
    printf '%s\n' \
      "-A $chain -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN" \
      "-A $chain -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN" \
      "-A $chain -m addrtype --dst-type LOCAL -j REJECT" \
      "-A $chain -j RETURN"
  done
}

check_legacy_egress_removal_shape() {
  local tool="$1" chain="$2" destination index references source_rules
  shift 2
  local -a rules expected
  if ! chain_exists "$tool" "$chain"; then
    references="$(chain_reference_count "$tool" "$chain")" || return 1
    source_rules="$(chain_source_rule_count "$tool" "$chain")" || return 1
    [ "$references" -eq 0 ] && [ "$source_rules" -eq 0 ]
    return
  fi
  mapfile -t rules < <("$tool" -S "$chain" 2>/dev/null | awk '$1 == "-A" {print}')
  expected=("-A $chain -o kas-private0 -j RETURN")
  for destination in "$@"; do
    expected+=("-A $chain -d $destination -j REJECT")
  done
  expected+=("-A $chain -j RETURN")
  [ "${#rules[@]}" -le "${#expected[@]}" ] || return 1
  references="$(chain_reference_count "$tool" "$chain")" || return 1
  if [ "$references" -ne 0 ]; then
    [ "$references" -eq 1 ] && [ "${#rules[@]}" -eq "${#expected[@]}" ] || return 1
  fi
  for ((index = 0; index < ${#rules[@]}; index++)); do
    [ "${rules[$index]}" = "${expected[$index]}" ] || return 1
  done
}

check_legacy_owned_removal_progress_family() {
  local tool="$1" actual_owned allowed duplicates line chain
  shift
  check_unique_first_rule "$tool" FORWARD -j DOCKER-USER || return 1
  check_legacy_owned_reference_scope_family "$tool" || return 1

  actual_owned="$("$tool" -S 2>/dev/null | grep -F 'KASSINAO-' || true)"
  allowed="$(legacy_allowed_owned_inventory "$@")" || return 1
  duplicates="$(printf '%s\n' "$actual_owned" | sed '/^$/d' | sort | uniq -d)"
  [ -z "$duplicates" ] || return 1
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    grep -Fqx -- "$line" <<<"$allowed" || return 1
  done <<<"$actual_owned"

  check_anchor_removal_shape \
    "$tool" KASSINAO-EGRESS KASSINAO-EGRESS-A KASSINAO-EGRESS-B || return 1
  check_anchor_removal_shape \
    "$tool" KASSINAO-HOST KASSINAO-HOST-A KASSINAO-HOST-B || return 1
  for chain in KASSINAO-EGRESS-A KASSINAO-EGRESS-B; do
    check_legacy_egress_removal_shape "$tool" "$chain" "$@" || return 1
  done
  for chain in KASSINAO-HOST-A KASSINAO-HOST-B; do
    check_host_removal_shape "$tool" "$chain" || return 1
  done
}

check_legacy_policy_family() {
  local tool="$1" egress_chain egress_inactive host_chain host_inactive inactive_count references
  shift
  check_unique_first_rule "$tool" FORWARD -j DOCKER-USER || return 1
  check_unique_first_rule "$tool" DOCKER-USER -i kas-private0 -j KASSINAO-EGRESS || return 1
  check_unique_first_rule "$tool" INPUT -i kas-private0 -j KASSINAO-HOST || return 1
  [ "$(chain_reference_count "$tool" KASSINAO-EGRESS)" -eq 1 ] || return 1
  [ "$(chain_reference_count "$tool" KASSINAO-HOST)" -eq 1 ] || return 1

  case "$(first_rule "$tool" KASSINAO-EGRESS)" in
    '-A KASSINAO-EGRESS -j KASSINAO-EGRESS-A')
      egress_chain=KASSINAO-EGRESS-A
      egress_inactive=KASSINAO-EGRESS-B
      ;;
    '-A KASSINAO-EGRESS -j KASSINAO-EGRESS-B')
      egress_chain=KASSINAO-EGRESS-B
      egress_inactive=KASSINAO-EGRESS-A
      ;;
    *) return 1 ;;
  esac
  [ "$(rule_count "$tool" KASSINAO-EGRESS)" -eq 1 ] || return 1
  case "$(first_rule "$tool" KASSINAO-HOST)" in
    '-A KASSINAO-HOST -j KASSINAO-HOST-A')
      host_chain=KASSINAO-HOST-A
      host_inactive=KASSINAO-HOST-B
      ;;
    '-A KASSINAO-HOST -j KASSINAO-HOST-B')
      host_chain=KASSINAO-HOST-B
      host_inactive=KASSINAO-HOST-A
      ;;
    *) return 1 ;;
  esac
  [ "$(rule_count "$tool" KASSINAO-HOST)" -eq 1 ] || return 1

  references="$(chain_reference_count "$tool" "$egress_chain")" || return 1
  [ "$references" -eq 1 ] || return 1
  references="$(chain_reference_count "$tool" "$host_chain")" || return 1
  [ "$references" -eq 1 ] || return 1
  references="$(chain_reference_count "$tool" "$egress_inactive")" || return 1
  [ "$references" -eq 0 ] || return 1
  references="$(chain_reference_count "$tool" "$host_inactive")" || return 1
  [ "$references" -eq 0 ] || return 1
  [ "$(rule_count "$tool" "$egress_chain")" -eq "$(( $# + 2 ))" ] &&
    check_legacy_egress_removal_shape "$tool" "$egress_chain" "$@" || return 1
  [ "$(rule_count "$tool" "$host_chain")" -eq 3 ] &&
    check_host_removal_shape "$tool" "$host_chain" || return 1
  inactive_count="$(rule_count "$tool" "$egress_inactive")" || return 1
  case "$inactive_count" in
    0) ;;
    "$(( $# + 2 ))") check_legacy_egress_removal_shape "$tool" "$egress_inactive" "$@" || return 1 ;;
    *) return 1 ;;
  esac
  inactive_count="$(rule_count "$tool" "$host_inactive")" || return 1
  case "$inactive_count" in
    0) ;;
    3) check_host_removal_shape "$tool" "$host_inactive" || return 1 ;;
    *) return 1 ;;
  esac
}

classify_legacy_policy_family() {
  local tool="$1"
  shift
  if policy_family_absent "$tool"; then
    printf '%s\n' absent
  elif check_legacy_owned_removal_progress_family "$tool" "$@" &&
       check_legacy_policy_family "$tool" "$@"; then
    printf '%s\n' exact-present
  elif check_legacy_owned_removal_progress_family "$tool" "$@"; then
    printf '%s\n' owned-progress
  else
    return 1
  fi
}

flush_owned_chain_if_present() {
  local tool="$1" chain="$2"
  chain_exists "$tool" "$chain" || return 0
  [ "$(chain_reference_count "$tool" "$chain")" -eq 0 ] || return 1
  "$tool" -F "$chain"
}

delete_owned_chain_if_present() {
  local tool="$1" chain="$2"
  chain_exists "$tool" "$chain" || return 0
  [ "$(chain_reference_count "$tool" "$chain")" -eq 0 ] || return 1
  [ "$(rule_count "$tool" "$chain")" -eq 0 ] || return 1
  "$tool" -X "$chain"
}

remove_policy_family() {
  local tool="$1" chain bridge
  shift

  policy_family_absent "$tool" && return 0
  check_owned_removal_progress_family "$tool" "$@" || return 1

  # Cada mutação remove somente uma regra/chain exata já classificada como
  # própria. Falha antes ou depois de qualquer comando deixa um subconjunto
  # reconhecível, então a próxima execução continua sem tocar em policy alheia.
  for bridge in "$CORE_EGRESS_BRIDGE" "$TUNNEL_EGRESS_BRIDGE"; do
    delete_exact_rule_if_present "$tool" DOCKER-USER -i "$bridge" -j KASSINAO-EGRESS || return 1
    delete_exact_rule_if_present "$tool" INPUT -i "$bridge" -j KASSINAO-HOST || return 1
  done

  check_owned_removal_progress_family "$tool" "$@" || return 1
  for chain in KASSINAO-EGRESS KASSINAO-HOST; do
    flush_owned_chain_if_present "$tool" "$chain" || return 1
  done

  check_owned_removal_progress_family "$tool" "$@" || return 1
  for chain in KASSINAO-EGRESS-A KASSINAO-EGRESS-B KASSINAO-HOST-A KASSINAO-HOST-B; do
    flush_owned_chain_if_present "$tool" "$chain" || return 1
    delete_owned_chain_if_present "$tool" "$chain" || return 1
  done
  for chain in KASSINAO-EGRESS KASSINAO-HOST; do
    delete_owned_chain_if_present "$tool" "$chain" || return 1
  done
  policy_family_absent "$tool"
}

remove_legacy_policy_family() {
  local tool="$1" chain
  shift

  policy_family_absent "$tool" && return 0
  check_legacy_owned_removal_progress_family "$tool" "$@" || return 1
  delete_exact_rule_if_present \
    "$tool" DOCKER-USER -i kas-private0 -j KASSINAO-EGRESS || return 1
  delete_exact_rule_if_present \
    "$tool" INPUT -i kas-private0 -j KASSINAO-HOST || return 1

  check_legacy_owned_removal_progress_family "$tool" "$@" || return 1
  for chain in KASSINAO-EGRESS KASSINAO-HOST; do
    flush_owned_chain_if_present "$tool" "$chain" || return 1
  done

  check_legacy_owned_removal_progress_family "$tool" "$@" || return 1
  for chain in KASSINAO-EGRESS-A KASSINAO-EGRESS-B KASSINAO-HOST-A KASSINAO-HOST-B; do
    flush_owned_chain_if_present "$tool" "$chain" || return 1
    delete_owned_chain_if_present "$tool" "$chain" || return 1
  done
  for chain in KASSINAO-EGRESS KASSINAO-HOST; do
    delete_owned_chain_if_present "$tool" "$chain" || return 1
  done
  policy_family_absent "$tool"
}

check_owned_reference_scopes() {
  local tool
  for tool in ipt ip6t; do
    check_owned_reference_scope_family "$tool" || return 1
  done
}

combined_removal_state() {
  case "$1:$2" in
    exact-present:exact-present) printf '%s\n' present ;;
    absent:absent) printf '%s\n' absent ;;
    exact-present:absent | exact-present:owned-progress | \
      absent:exact-present | absent:owned-progress | \
      owned-progress:exact-present | owned-progress:absent | \
      owned-progress:owned-progress)
      printf '%s\n' owned-progress
      ;;
    *) return 1 ;;
  esac
}

v4_destinations=(127.0.0.0/8 10.0.0.0/8 100.64.0.0/10 169.254.0.0/16 172.16.0.0/12 192.168.0.0/16)
v6_destinations=(::1/128 fc00::/7 fe80::/10)

if [ "$MODE" = removal-state ]; then
  if ! v4_state="$(classify_policy_family ipt "${v4_destinations[@]}")" ||
     ! v6_state="$(classify_policy_family ip6t "${v6_destinations[@]}")" ||
     ! combined_removal_state "$v4_state" "$v6_state"; then
    echo 'ERRO: policy current não corresponde a estado removível próprio' >&2
    exit 1
  fi
  exit 0
fi

if [ "$MODE" = legacy-removal-state ]; then
  if ! v4_state="$(classify_legacy_policy_family ipt "${v4_destinations[@]}")" ||
     ! v6_state="$(classify_legacy_policy_family ip6t "${v6_destinations[@]}")" ||
     ! combined_removal_state "$v4_state" "$v6_state"; then
    echo 'ERRO: policy legacy não corresponde a estado removível próprio' >&2
    exit 1
  fi
  exit 0
fi

if [ "$MODE" = check ]; then
  if check_owned_reference_scopes && \
     check_policy_family ipt 127.0.0.0/8 10.0.0.0/8 100.64.0.0/10 169.254.0.0/16 172.16.0.0/12 192.168.0.0/16 && \
     check_policy_family ip6t ::1/128 fc00::/7 fe80::/10; then
    echo "Política de egress/host válida em $CORE_EGRESS_BRIDGE e $TUNNEL_EGRESS_BRIDGE."
    exit 0
  fi
  echo 'ERRO: política de egress/host ausente, incompleta ou desviada' >&2
  exit 1
fi

if [ "$MODE" = remove ]; then
  if ! v4_state="$(classify_policy_family ipt "${v4_destinations[@]}")" ||
     ! v6_state="$(classify_policy_family ip6t "${v6_destinations[@]}")"; then
    echo 'ERRO: regras Kassinão divergiram; remoção automática recusada' >&2
    exit 1
  fi
  assert_removal_container_gate || exit 1
  case "$v4_state" in
    exact-present | owned-progress)
      remove_policy_family ipt "${v4_destinations[@]}" || {
        echo 'ERRO: remoção IPv4 não concluiu; nova tentativa retomará apenas objetos próprios' >&2
        exit 1
      }
      ;;
    absent) ;;
    *) exit 1 ;;
  esac
  case "$v6_state" in
    exact-present | owned-progress)
      remove_policy_family ip6t "${v6_destinations[@]}" || {
        echo 'ERRO: remoção IPv6 não concluiu; nova tentativa retomará apenas objetos próprios' >&2
        exit 1
      }
      ;;
    absent) ;;
    *) exit 1 ;;
  esac
  [ "$(classify_policy_family ipt "${v4_destinations[@]}")" = absent ] &&
    [ "$(classify_policy_family ip6t "${v6_destinations[@]}")" = absent ] || {
    echo 'ERRO: remoção terminou em estado não ausente' >&2
    exit 1
  }
  echo "Regras exclusivas do Kassinão removidas de $CORE_EGRESS_BRIDGE e $TUNNEL_EGRESS_BRIDGE; hooks do Docker preservados."
  exit 0
fi

if [ "$MODE" = remove-legacy-policy ]; then
  if ! v4_state="$(classify_legacy_policy_family ipt "${v4_destinations[@]}")" ||
     ! v6_state="$(classify_legacy_policy_family ip6t "${v6_destinations[@]}")"; then
    echo 'ERRO: regras legacy Kassinão divergiram; remoção automática recusada' >&2
    exit 1
  fi
  assert_removal_container_gate || exit 1
  case "$v4_state" in
    exact-present | owned-progress)
      remove_legacy_policy_family ipt "${v4_destinations[@]}" || {
        echo 'ERRO: remoção legacy IPv4 não concluiu; nova tentativa retomará apenas objetos próprios' >&2
        exit 1
      }
      ;;
    absent) ;;
    *) exit 1 ;;
  esac
  case "$v6_state" in
    exact-present | owned-progress)
      remove_legacy_policy_family ip6t "${v6_destinations[@]}" || {
        echo 'ERRO: remoção legacy IPv6 não concluiu; nova tentativa retomará apenas objetos próprios' >&2
        exit 1
      }
      ;;
    absent) ;;
    *) exit 1 ;;
  esac
  [ "$(classify_legacy_policy_family ipt "${v4_destinations[@]}")" = absent ] &&
    [ "$(classify_legacy_policy_family ip6t "${v6_destinations[@]}")" = absent ] || {
    echo 'ERRO: remoção legacy terminou em estado não ausente' >&2
    exit 1
  }
  echo 'Regras exclusivas da policy legacy do Kassinão removidas de kas-private0; hooks do Docker preservados.'
  exit 0
fi

if [ "$HOST_SCOPE" = shared ] && ! check_shared_global_hooks; then
  echo 'ERRO: host shared exige FORWARD -> DOCKER-USER exato e já provisionado pelo Docker; nenhuma regra foi alterada' >&2
  exit 1
fi

# Antes da primeira criação/flush de chain, prove que nenhum workload vizinho
# usa os anchors reservados. Zero referências é o bootstrap; referências
# existentes são aceitas somente nos hooks e bridges exatos da instância.
check_owned_reference_scopes || {
  echo 'ERRO: referência externa/duplicada aos anchors KASSINAO; nenhuma regra foi alterada' >&2
  exit 1
}

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
canonicalize_positioned_rule \
  ipt DOCKER-USER 1 -i "$CORE_EGRESS_BRIDGE" -j KASSINAO-EGRESS
canonicalize_positioned_rule \
  ipt DOCKER-USER 2 -i "$TUNNEL_EGRESS_BRIDGE" -j KASSINAO-EGRESS
canonicalize_positioned_rule \
  ipt INPUT 1 -i "$CORE_EGRESS_BRIDGE" -j KASSINAO-HOST
canonicalize_positioned_rule \
  ipt INPUT 2 -i "$TUNNEL_EGRESS_BRIDGE" -j KASSINAO-HOST
canonicalize_positioned_rule \
  ip6t DOCKER-USER 1 -i "$CORE_EGRESS_BRIDGE" -j KASSINAO-EGRESS
canonicalize_positioned_rule \
  ip6t DOCKER-USER 2 -i "$TUNNEL_EGRESS_BRIDGE" -j KASSINAO-EGRESS
canonicalize_positioned_rule \
  ip6t INPUT 1 -i "$CORE_EGRESS_BRIDGE" -j KASSINAO-HOST
canonicalize_positioned_rule \
  ip6t INPUT 2 -i "$TUNNEL_EGRESS_BRIDGE" -j KASSINAO-HOST

# A aplicação só é concluída depois de provar novamente anchors, policies e
# referências em ambas as famílias contra o contrato completo.
check_policy_family ipt 127.0.0.0/8 10.0.0.0/8 100.64.0.0/10 169.254.0.0/16 172.16.0.0/12 192.168.0.0/16 &&
  check_policy_family ip6t ::1/128 fc00::/7 fe80::/10 || {
  echo 'ERRO: policy aplicada não passou na revalidação final' >&2
  exit 1
}

if [ "$OFFLINE" = true ]; then
  echo "Política de egress/host pré-carregada antes do daemon Docker nas duas bridges de saída."
elif [ "${PRELOAD:-false}" = true ]; then
  echo "Política de egress/host pré-carregada nas duas bridges; topologia ainda não existe."
else
  echo "Política de egress/host aplicada; saídas presentes têm membership exclusivo validado."
fi
