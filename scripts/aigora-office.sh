#!/usr/bin/env bash
# aigora-office.sh up|down|status - runs the ONLYOFFICE Document Server for Aigora co-editing.
#
# Host networking (docker port publishing is unavailable on this host): a user-defined bridge
# "aigora-office" (default 10.77.77.0/24, bridge br-aigora-oo), DS at the fixed address .10 of it.
# Aigora reaches DS at http://<DS ip> straight from the host; DS calls Aigora back only on
# <gateway>:25891 (a second listener, never 25808 and never 0.0.0.0). No ports are published.
# The same addresses go into daemon.json office.dsUrl / office.callbackHost (docs/office-coediting.md).
#
#   up            create the network if missing, generate the JWT secret file if missing (0600,
#                 never printed), (re)create and start the container
#   down          stop and remove the container (volumes and the network stay)
#   down --purge  also remove the volumes and the network
#   status        container state, bridge, health probe and the callback-listener reachability hint
#
# Env: AIGORA_HOME (config home, default ~/.aigora; the secret lives in <home>/console/),
#      AIGORA_OFFICE_SECRET_FILE (override the secret path), AIGORA_OFFICE_MEM / AIGORA_OFFICE_CPUS,
#      AIGORA_OFFICE_SUBNET (default 10.77.77.0/24), AIGORA_OFFICE_GATEWAY (default: .1 of the subnet),
#      AIGORA_OFFICE_DS_IP (default: .10 of the subnet), AIGORA_OFFICE_BRIDGE (default br-aigora-oo,
#      max 15 chars), AIGORA_OFFICE_CB_PORT (default 25891). Set the same values on every call
#      (up/down/status): a network that already exists keeps the addresses it was created with.
set -euo pipefail

IMAGE="onlyoffice/documentserver:9.3.0.1"
NAME="aigora-office"
NET="aigora-office"
SUBNET="${AIGORA_OFFICE_SUBNET:-10.77.77.0/24}"
case "$SUBNET" in
  *.*.*.0/24) SUBNET_PREFIX="${SUBNET%.0/24}" ;;
  *) echo "AIGORA_OFFICE_SUBNET must look like A.B.C.0/24, got: $SUBNET" >&2; exit 2 ;;
esac
GATEWAY="${AIGORA_OFFICE_GATEWAY:-$SUBNET_PREFIX.1}"
BRIDGE="${AIGORA_OFFICE_BRIDGE:-br-aigora-oo}"
DS_IP="${AIGORA_OFFICE_DS_IP:-$SUBNET_PREFIX.10}"
CB_PORT="${AIGORA_OFFICE_CB_PORT:-25891}"
if [ -n "${AIGORA_HOME:-}" ]; then HOME_DIR="$AIGORA_HOME"; else HOME_DIR="$HOME/.aigora"; fi
SECRET_FILE="${AIGORA_OFFICE_SECRET_FILE:-$HOME_DIR/console/office-jwt.secret}"
MEM="${AIGORA_OFFICE_MEM:-6g}"
CPUS="${AIGORA_OFFICE_CPUS:-4}"
VOLUMES=(aigora-office-data aigora-office-lib aigora-office-log)

have_net() { docker network inspect "$NET" >/dev/null 2>&1; }

ensure_net() {
  if have_net; then return 0; fi
  docker network create --driver bridge --subnet "$SUBNET" --gateway "$GATEWAY" \
    -o "com.docker.network.bridge.name=$BRIDGE" "$NET" >/dev/null
  echo "created network $NET ($SUBNET, bridge $BRIDGE)"
}

ensure_secret() {
  if [ -s "$SECRET_FILE" ]; then
    chmod 0600 "$SECRET_FILE"
    return 0
  fi
  mkdir -p "$(dirname "$SECRET_FILE")"
  ( umask 077; head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$SECRET_FILE" )
  chmod 0600 "$SECRET_FILE"
  echo "generated JWT secret file $SECRET_FILE (mode 0600, not shown)"
}

cmd_up() {
  ensure_net
  ensure_secret
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  # The secret reaches the container through an env file on a pipe, never argv (ps) or this output.
  docker run -d --name "$NAME" --restart unless-stopped \
    --network "$NET" --ip "$DS_IP" \
    --memory "$MEM" --cpus "$CPUS" --pids-limit 2048 --security-opt no-new-privileges:true \
    --env-file <(printf 'JWT_SECRET=%s\n' "$(cat "$SECRET_FILE")") \
    -e JWT_ENABLED=true -e JWT_HEADER=Authorization -e JWT_IN_BODY=true \
    -e ALLOW_PRIVATE_IP_ADDRESS=true \
    -v aigora-office-data:/var/www/onlyoffice/Data \
    -v aigora-office-lib:/var/lib/onlyoffice \
    -v aigora-office-log:/var/log/onlyoffice \
    "$IMAGE" >/dev/null
  echo "started $NAME at http://$DS_IP (first start takes about 70 s; run: $0 status)"
}

cmd_down() {
  docker rm -f "$NAME" >/dev/null 2>&1 && echo "removed container $NAME" || echo "no container $NAME"
  if [ "${1:-}" = "--purge" ]; then
    for v in "${VOLUMES[@]}"; do docker volume rm "$v" >/dev/null 2>&1 || true; done
    if have_net; then docker network rm "$NET" >/dev/null && echo "removed network $NET"; fi
  fi
}

cmd_status() {
  local state
  state="$(docker inspect -f '{{.State.Status}}' "$NAME" 2>/dev/null || echo absent)"
  echo "container: $state"
  if have_net; then echo "network:   $NET present"; else echo "network:   $NET missing"; fi
  if [ -s "$SECRET_FILE" ]; then echo "secret:    $SECRET_FILE present"; else echo "secret:    $SECRET_FILE missing (run up)"; fi
  if [ "$state" = "running" ]; then
    local up
    up=$(( $(date +%s) - $(date -d "$(docker inspect -f '{{.State.StartedAt}}' "$NAME")" +%s) ))
    if [ "$(curl -fsS -m 3 "http://$DS_IP/healthcheck" 2>/dev/null || true)" = "true" ]; then
      echo "health:    ok (http://$DS_IP/healthcheck)"
      # /healthcheck turns true on the first docservice start; the image restarts docservice about 20 s later
      # and that drops open editors, so a cold start is settled only after about 70 s.
      if [ "$up" -lt 70 ]; then echo "           (up ${up}s: still settling, open editors may reconnect once until 70 s)"; fi
    else
      echo "health:    not ready yet (DS needs about 70 s after start)"
    fi
    # Callback path: DS container -> $GATEWAY:$CB_PORT (needs the ufw rule and Aigora's office listener).
    if docker exec "$NAME" bash -c "timeout 3 bash -c '</dev/tcp/$GATEWAY/$CB_PORT'" >/dev/null 2>&1; then
      echo "callback:  DS can reach $GATEWAY:$CB_PORT"
    else
      echo "callback:  DS cannot reach $GATEWAY:$CB_PORT (Aigora office listener not running, or ufw rule missing)"
    fi
  fi
}

case "${1:-}" in
  up) cmd_up ;;
  down) shift; cmd_down "$@" ;;
  status) cmd_status ;;
  *) echo "usage: $0 up|down [--purge]|status" >&2; exit 2 ;;
esac
