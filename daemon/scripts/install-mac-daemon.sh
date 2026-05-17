#!/usr/bin/env bash
# install-mac-daemon.sh — Build + instalar ZeusDaemonMac como LaunchAgent.
#
# Roda como usuário comum (sem sudo). Coloca:
#   binário → ~/.local/bin/zeusdaemon-mac
#   plist   → ~/Library/LaunchAgents/com.maiocchi.zeusdaemon.plist
#   logs    → /tmp/zeusdaemon.{out,err}.log
#
# Aderente à doutrina Zeus tier 6 (on-device, sem nuvem) — ver
# CLAUDE.md §5.2 e ADR-012.

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.maiocchi.zeusdaemon"
BIN_DIR="${HOME}/.local/bin"
BIN_PATH="${BIN_DIR}/zeusdaemon-mac"
PLIST_SRC="${PROJECT_ROOT}/scripts/com.maiocchi.zeusdaemon.plist"
PLIST_DST="${HOME}/Library/LaunchAgents/${LABEL}.plist"

say() { printf '[install-mac-daemon] %s\n' "$*"; }
die() { printf '[install-mac-daemon] FATAL: %s\n' "$*" >&2; exit 1; }

[[ -d "${PROJECT_ROOT}" ]] || die "project root não encontrado: ${PROJECT_ROOT}"
[[ -f "${PLIST_SRC}" ]] || die "plist template não encontrado: ${PLIST_SRC}"

# Scratch path FORA do iCloud: swift build gera ~500MB; dentro do vault sincronizado polui o iCloud em todos os devices.
SCRATCH_DIR="${HOME}/Library/Caches/com.maiocchi.zeusdaemon/build"
mkdir -p "${SCRATCH_DIR}"

say "1/6 — swift build -c release --product ZeusDaemonMac (cwd=${PROJECT_ROOT}, scratch=${SCRATCH_DIR})"
cd "${PROJECT_ROOT}"
swift build -c release --product ZeusDaemonMac --scratch-path "${SCRATCH_DIR}"

BUILT_BIN="${SCRATCH_DIR}/release/ZeusDaemonMac"
[[ -x "${BUILT_BIN}" ]] || die "binário esperado não encontrado: ${BUILT_BIN}"

say "2/6 — instalando binário em ${BIN_PATH}"
mkdir -p "${BIN_DIR}"
install -m 0755 "${BUILT_BIN}" "${BIN_PATH}"

say "3/6 — gerando plist em ${PLIST_DST}"
mkdir -p "${HOME}/Library/LaunchAgents"
sed "s|__ZEUSDAEMON_BINARY__|${BIN_PATH}|g" "${PLIST_SRC}" > "${PLIST_DST}"
chmod 0644 "${PLIST_DST}"

UID_NUM="$(id -u)"
DOMAIN="gui/${UID_NUM}"
TARGET="${DOMAIN}/${LABEL}"

# Bootout idempotente: se o agent já existe, descarrega antes de re-carregar.
if launchctl print "${TARGET}" >/dev/null 2>&1; then
    say "4/6 — agent existente detectado, bootout antes de re-carregar"
    launchctl bootout "${TARGET}" 2>/dev/null || true
    sleep 1
fi

say "4/6 — launchctl bootstrap ${DOMAIN} ${PLIST_DST}"
launchctl bootstrap "${DOMAIN}" "${PLIST_DST}"

say "5/6 — launchctl enable ${TARGET}"
launchctl enable "${TARGET}" || true
launchctl kickstart -k "${TARGET}" || true

say "6/6 — aguardando 2s e verificando health"
sleep 2
if curl --silent --fail --max-time 5 http://127.0.0.1:2223/v1/health > /tmp/zeusdaemon.health.json; then
    say "OK — health respondeu:"
    cat /tmp/zeusdaemon.health.json
    printf '\n'
    say "logs: tail -f /tmp/zeusdaemon.out.log /tmp/zeusdaemon.err.log"
    say "stop: launchctl bootout ${TARGET}"
else
    say "AVISO — curl health falhou. Inspecione: cat /tmp/zeusdaemon.err.log"
    say "estado do agent:"
    launchctl print "${TARGET}" | head -40 || true
    exit 3
fi
