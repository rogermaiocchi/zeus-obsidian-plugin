# Makefile — ZeusMarkdownImporter
#
# Build a macOS Spotlight metadata importer (.mdimporter) bundle that teaches
# the system how to extract Obsidian-flavored YAML frontmatter, wikilinks,
# tags, and headings from .md files.
#
# Targets:
#   make build     -> compile dylib at build/ZeusMarkdownImporter
#   make bundle    -> assemble build/ZeusMarkdownImporter.mdimporter/
#   make install   -> copy bundle into ~/Library/Spotlight/ and reindex
#   make uninstall -> remove bundle and reindex Spotlight
#   make clean     -> rm -rf build/
#   make verify    -> run plutil -lint on Info.plist
#
# No external deps — needs Xcode command-line tools (clang + xcrun + plutil).

BUNDLE_NAME    := ZeusMarkdownImporter
BUNDLE_ID      := com.maiocchi.zeus.MarkdownImporter
BUILD_DIR      := build
BUNDLE_DIR     := $(BUILD_DIR)/$(BUNDLE_NAME).mdimporter
CONTENTS_DIR   := $(BUNDLE_DIR)/Contents
MACOS_DIR      := $(CONTENTS_DIR)/MacOS
DYLIB          := $(MACOS_DIR)/$(BUNDLE_NAME)
INFO_PLIST     := Info.plist

INSTALL_DIR    := $(HOME)/Library/Spotlight
INSTALLED      := $(INSTALL_DIR)/$(BUNDLE_NAME).mdimporter

SOURCES        := main.c GetMetadataForFile.m

CLANG          := $(shell xcrun -find clang 2>/dev/null)
SDK_PATH       := $(shell xcrun --show-sdk-path 2>/dev/null)

# Universal binary by default (Apple Silicon + Intel). Override with
#   make build ARCHS="-arch arm64"
ARCHS          ?= -arch arm64 -arch x86_64

CFLAGS         := -O2 -fobjc-arc -fmodules -Wall -Wextra \
                  -mmacosx-version-min=11.0 \
                  -isysroot $(SDK_PATH) \
                  $(ARCHS)

LDFLAGS        := -dynamiclib \
                  -framework Foundation \
                  -framework CoreServices \
                  -framework CoreFoundation \
                  -isysroot $(SDK_PATH) \
                  $(ARCHS)

.PHONY: all build bundle install uninstall reindex verify clean help

all: bundle

help:
	@echo "Targets: build bundle install uninstall reindex verify clean"

# -----------------------------------------------------------------------------
# verify — quick sanity check on Info.plist before anything else
# -----------------------------------------------------------------------------
verify:
	@if [ -z "$(CLANG)" ]; then \
		echo "error: xcrun -find clang failed. Install Xcode command-line tools."; \
		exit 1; \
	fi
	@plutil -lint $(INFO_PLIST)

# -----------------------------------------------------------------------------
# build — compile the bundle binary
# -----------------------------------------------------------------------------
build: $(DYLIB)

$(DYLIB): $(SOURCES) | $(MACOS_DIR)
	@if [ -z "$(CLANG)" ]; then \
		echo "error: clang not found via xcrun. Install Xcode command-line tools."; \
		exit 1; \
	fi
	$(CLANG) $(CFLAGS) $(LDFLAGS) -o $@ $(SOURCES)

$(MACOS_DIR):
	mkdir -p $(MACOS_DIR)

# -----------------------------------------------------------------------------
# bundle — assemble the .mdimporter directory tree
# -----------------------------------------------------------------------------
bundle: verify $(DYLIB) $(CONTENTS_DIR)/Info.plist

$(CONTENTS_DIR)/Info.plist: $(INFO_PLIST) | $(CONTENTS_DIR)
	cp $(INFO_PLIST) $(CONTENTS_DIR)/Info.plist
	@plutil -lint $(CONTENTS_DIR)/Info.plist

$(CONTENTS_DIR):
	mkdir -p $(CONTENTS_DIR)

# -----------------------------------------------------------------------------
# install — drop bundle into ~/Library/Spotlight and ask Spotlight to reindex
# -----------------------------------------------------------------------------
install: bundle
	mkdir -p $(INSTALL_DIR)
	rm -rf $(INSTALLED)
	cp -R $(BUNDLE_DIR) $(INSTALLED)
	@echo
	@echo "Installed: $(INSTALLED)"
	@echo "Asking mdimport to register and reindex..."
	mdimport -r $(INSTALLED)
	@echo
	@echo "Verify with: mdimport -L | grep -i zeus"
	@echo "Debug a single file with: mdimport -d4 /path/to/note.md"

# -----------------------------------------------------------------------------
# uninstall — remove and reindex
# -----------------------------------------------------------------------------
uninstall:
	rm -rf $(INSTALLED)
	@echo "Removed: $(INSTALLED)"
	@echo "Re-registering remaining importers..."
	mdimport -r $(INSTALL_DIR) || true

# -----------------------------------------------------------------------------
# reindex — force Spotlight to reprocess markdown content with our importer
# -----------------------------------------------------------------------------
reindex:
	@echo "Reindexing markdown files under \$$HOME (this may take a few minutes)..."
	find $(HOME) -name "*.md" -not -path "*/node_modules/*" -not -path "*/.git/*" -print0 \
		| xargs -0 -n 50 mdimport

# -----------------------------------------------------------------------------
# clean
# -----------------------------------------------------------------------------
clean:
	rm -rf $(BUILD_DIR)
