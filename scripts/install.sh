#!/usr/bin/env bash
# Instalador de Pendientes para un VPS con Ubuntu o Debian (por ejemplo Hostinger).
# Instala Docker si falta, descarga la imagen ya construida y arranca el dashboard.
#
# Uso (como root, por ejemplo en la terminal del navegador de hPanel):
#   curl -fsSL https://raw.githubusercontent.com/MarianaFlash/Whastapp/claude/sleepy-johnson-mx3qyu/scripts/install.sh | bash
#
# Opcional, antes de "bash":  DASHBOARD_PASSWORD='mi-clave'  (si no, se genera una y se muestra al final)
set -euo pipefail

BRANCH="${PENDIENTES_BRANCH:-claude/sleepy-johnson-mx3qyu}"
DIR="${PENDIENTES_DIR:-/opt/pendientes}"
RAW="https://raw.githubusercontent.com/MarianaFlash/Whastapp/${BRANCH}"
ZONA="${PENDIENTES_TZ:-America/Bogota}"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

if [ "$(id -u)" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1; then
    say "→ Se necesita root, reintentando con sudo…"
    exec sudo -E bash -c "$(curl -fsSL "${RAW}/scripts/install.sh")"
  fi
  echo "✖ Ejecuta este instalador como root." >&2
  exit 1
fi

say "→ Pendientes · instalador"

# ---------- Docker ----------
if ! command -v docker >/dev/null 2>&1; then
  say "→ Instalando Docker (puede tardar un par de minutos)…"
  if command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    if ! apt-get install -y -qq docker.io docker-compose-v2 curl ca-certificates >/dev/null; then
      curl -fsSL https://get.docker.com | sh
    fi
  else
    curl -fsSL https://get.docker.com | sh
  fi
  systemctl enable --now docker >/dev/null 2>&1 || true
fi

if ! docker compose version >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    apt-get install -y -qq docker-compose-v2 >/dev/null || true
  fi
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "✖ Docker está instalado pero falta 'docker compose'. Instálalo y vuelve a ejecutar." >&2
  exit 1
fi
say "✓ Docker $(docker --version | sed 's/Docker version //; s/,.*//') listo"

# ---------- puerto libre ----------
HOST_PORT="${PENDIENTES_PORT:-3000}"
port_busy() { ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$1\$"; }
if [ ! -f "${DIR}/.env" ]; then
  for p in "$HOST_PORT" 3001 3002 3003 3004 3005; do
    if ! port_busy "$p"; then HOST_PORT="$p"; break; fi
  done
fi

# ---------- archivos ----------
mkdir -p "$DIR"
cd "$DIR"
curl -fsSL "${RAW}/docker-compose.hostinger.yml" -o docker-compose.yml

IP="$(curl -fsSL --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"

NEW=0
if [ ! -f .env ]; then
  NEW=1
  PASS="${DASHBOARD_PASSWORD:-$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 20)}"
  umask 077
  cat > .env <<EOF
DASHBOARD_PASSWORD=${PASS}
PUBLIC_URL=http://${IP}:${HOST_PORT}
HOST_PORT=${HOST_PORT}
TZ=${ZONA}
EOF
else
  HOST_PORT="$(grep -E '^HOST_PORT=' .env | cut -d= -f2- || echo 3000)"
  HOST_PORT="${HOST_PORT:-3000}"
fi

# ---------- arrancar ----------
say "→ Descargando la imagen y arrancando…"
docker compose pull -q
docker compose up -d

for _ in $(seq 1 40); do
  if curl -fs -o /dev/null "http://127.0.0.1:${HOST_PORT}/login.html"; then break; fi
  sleep 2
done

if curl -fs -o /dev/null "http://127.0.0.1:${HOST_PORT}/login.html"; then
  say "✓ Pendientes está corriendo"
else
  say "⚠ El contenedor arrancó pero aún no responde. Revisa: cd ${DIR} && docker compose logs"
fi

echo
echo "  Dashboard:   http://${IP}:${HOST_PORT}"
if [ "$NEW" = 1 ]; then
  echo "  Contraseña:  ${PASS}"
else
  echo "  Contraseña:  la guardada en ${DIR}/.env"
fi
echo
echo "  Siguiente paso: abre esa dirección, entra con la contraseña y escanea el QR"
echo "  desde WhatsApp → Dispositivos vinculados → Vincular un dispositivo."
echo
echo "  Para actualizar más adelante: vuelve a ejecutar este mismo comando."
