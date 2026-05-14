#!/bin/bash
# install-afm.sh — copia o binary metafm do Metassistema para bin/afm dentro do plugin
# Uso: bash scripts/install-afm.sh
#
# Para distribuição via GitHub: rode este script para gerar bin/afm antes de
# committar/zipar o plugin. O plugin resolve afm binary em ordem:
#   1. settings.afmPath explícito
#   2. <plugin-dir>/bin/afm (este script popula)
#   3. <plugin-dir>/bin/metafm
#   4. ~/.local/bin/metafm
#   5. metafm in $PATH

set -e

PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BIN_DIR="$PLUGIN_DIR/bin"

# Candidatos comuns para metafm source
METAFM_SOURCES=(
  "$HOME/Metassistema/50_Ferramentas/apple-intelligence"
  "$HOME/Library/Mobile Documents/iCloud~md~obsidian/Documents/.obsidian/.tools/apple-intelligence"
  "$HOME/dev/apple-intelligence"
)

# 1. Tenta achar o source dir
SOURCE_DIR=""
for candidate in "${METAFM_SOURCES[@]}"; do
  if [ -f "$candidate/Package.swift" ]; then
    SOURCE_DIR="$candidate"
    break
  fi
done

if [ -z "$SOURCE_DIR" ]; then
  echo "❌ Não encontrei metafm Package.swift em nenhum dos paths esperados:"
  printf '   %s\n' "${METAFM_SOURCES[@]}"
  echo ""
  echo "Opções:"
  echo "  1. Clone Metassistema/50_Ferramentas/apple-intelligence em um desses paths"
  echo "  2. Edite METAFM_SOURCES neste script com o seu path"
  echo "  3. Use o binary global em ~/.local/bin/metafm (o plugin detecta automaticamente)"
  exit 1
fi

echo "✓ Encontrado source em: $SOURCE_DIR"

# 2. Build em release mode
echo "→ swift build -c release …"
cd "$SOURCE_DIR"
swift build -c release

# 3. Localiza o binary
BUILD_BIN="$SOURCE_DIR/.build/release/metafm"
if [ ! -f "$BUILD_BIN" ]; then
  echo "❌ Build OK mas binary não encontrado em $BUILD_BIN"
  exit 1
fi

# 4. Copia para bin/afm do plugin
mkdir -p "$BIN_DIR"
cp -f "$BUILD_BIN" "$BIN_DIR/afm"
chmod +x "$BIN_DIR/afm"

# 5. Remove quarantine attribute (Gatekeeper) se presente
xattr -d com.apple.quarantine "$BIN_DIR/afm" 2>/dev/null || true

# 6. Verificação
echo ""
echo "=== Instalação concluída ==="
ls -lh "$BIN_DIR/afm"
echo ""
"$BIN_DIR/afm" --version
echo ""
echo "✓ Plugin agora usa: $BIN_DIR/afm"
echo "→ Reabra Obsidian para recarregar o plugin"
