# Makefile — ZeusMarkdownQuickLook.qlgenerator
# =============================================================================
# Constrói bundle .qlgenerator (CFPlugIn) standalone para macOS 10.15+.
#
# Targets:
#   make build    — compila objects + linka bundle em build/
#   make bundle   — alias para build
#   make install  — copia para ~/Library/QuickLook/ e roda qlmanage -r
#   make verify   — invoca qlmanage -m para listar generators ativos
#   make smoke    — dry-run (make -n) das compilações sem executar
#   make clean    — remove build/
#
# Requisitos: Xcode Command Line Tools (clang + libtool + lipo) presentes.
# Não exige Xcode IDE completo; basta `xcode-select --install`.
# =============================================================================

BUNDLE_NAME    := ZeusMarkdownQuickLook
BUNDLE_EXT     := qlgenerator
BUILD_DIR      := build
BUNDLE_DIR     := $(BUILD_DIR)/$(BUNDLE_NAME).$(BUNDLE_EXT)
CONTENTS_DIR   := $(BUNDLE_DIR)/Contents
MACOS_DIR      := $(CONTENTS_DIR)/MacOS
INSTALL_DIR    := $(HOME)/Library/QuickLook

CC             := clang
ARCHS          := -arch arm64 -arch x86_64
MIN_OS         := -mmacosx-version-min=10.15

# QLGenerator é Carbon-style CFPlugIn — requer Cocoa para NSImage no thumbnail
# e CoreServices/QuickLook para a API. ObjC + ObjC fabric ARC habilitado por arquivo.
CFLAGS_BASE    := $(ARCHS) $(MIN_OS) -Wall -Wextra -Wno-unused-parameter -O2 -fPIC
CFLAGS_C       := $(CFLAGS_BASE)
CFLAGS_OBJC    := $(CFLAGS_BASE) -fobjc-arc -fobjc-weak

LDFLAGS        := $(ARCHS) $(MIN_OS) -bundle -framework Cocoa -framework CoreServices \
                  -framework QuickLook -framework CoreFoundation -framework CoreGraphics

SRCS_C         := main.c
SRCS_OBJC      := GeneratePreviewForURL.m GenerateThumbnailForURL.m
OBJS           := $(SRCS_C:%.c=$(BUILD_DIR)/%.o) $(SRCS_OBJC:%.m=$(BUILD_DIR)/%.o)

EXECUTABLE     := $(MACOS_DIR)/$(BUNDLE_NAME)
PLIST_SRC      := Info.plist
PLIST_DST      := $(CONTENTS_DIR)/Info.plist

.PHONY: all build bundle install uninstall verify smoke clean lint help

all: build

help:
	@echo "Targets disponíveis:"
	@echo "  build / bundle  — compila .qlgenerator em $(BUNDLE_DIR)/"
	@echo "  install         — instala em $(INSTALL_DIR)/ e reinicia QL"
	@echo "  uninstall       — remove do diretório de QL do usuário"
	@echo "  verify          — qlmanage -m para listar generators ativos"
	@echo "  smoke           — dry-run da compilação (make -n)"
	@echo "  lint            — plutil -lint Info.plist"
	@echo "  clean           — remove $(BUILD_DIR)/"

build bundle: $(EXECUTABLE) $(PLIST_DST)

$(BUILD_DIR)/.dir:
	@mkdir -p $(BUILD_DIR)
	@touch $@

$(MACOS_DIR)/.dir:
	@mkdir -p $(MACOS_DIR)
	@touch $@

$(BUILD_DIR)/%.o: %.c $(BUILD_DIR)/.dir
	@echo "  CC   $<"
	$(CC) $(CFLAGS_C) -c $< -o $@

$(BUILD_DIR)/%.o: %.m $(BUILD_DIR)/.dir
	@echo "  CC   $<"
	$(CC) $(CFLAGS_OBJC) -c $< -o $@

$(EXECUTABLE): $(OBJS) $(MACOS_DIR)/.dir
	@echo "  LINK $@"
	$(CC) $(LDFLAGS) $(OBJS) -o $@

$(PLIST_DST): $(PLIST_SRC) $(MACOS_DIR)/.dir
	@echo "  COPY Info.plist"
	@cp $(PLIST_SRC) $(PLIST_DST)

install: build
	@echo "  INST $(INSTALL_DIR)/"
	@mkdir -p $(INSTALL_DIR)
	@rm -rf $(INSTALL_DIR)/$(BUNDLE_NAME).$(BUNDLE_EXT)
	@cp -R $(BUNDLE_DIR) $(INSTALL_DIR)/
	@echo "  RST  qlmanage -r"
	@qlmanage -r
	@qlmanage -r cache
	@echo "Instalação concluída. Teste com: qlmanage -p /caminho/para/nota.md"

uninstall:
	@echo "  UN   $(INSTALL_DIR)/$(BUNDLE_NAME).$(BUNDLE_EXT)"
	@rm -rf $(INSTALL_DIR)/$(BUNDLE_NAME).$(BUNDLE_EXT)
	@qlmanage -r
	@qlmanage -r cache
	@echo "Removido. Reinicie Finder se ícones persistirem (killall Finder)."

verify:
	@echo "Generators QuickLook ativos:"
	@qlmanage -m generators 2>&1 | grep -i zeus || echo "(zeus generator não encontrado — rode make install)"

smoke:
	@echo "=== Dry-run da compilação (make -n build) ==="
	@$(MAKE) -n build
	@echo ""
	@echo "=== plutil lint ==="
	@plutil -lint $(PLIST_SRC) || true

lint:
	@plutil -lint $(PLIST_SRC)

clean:
	@echo "  CLN  $(BUILD_DIR)/"
	@rm -rf $(BUILD_DIR)
