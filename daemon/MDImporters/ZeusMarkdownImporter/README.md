# ZeusMarkdownImporter

Spotlight metadata importer (`.mdimporter`) for Obsidian-flavored Markdown.

Teaches macOS Spotlight to extract YAML frontmatter, wikilinks, headings,
aliases, and `#tags` from `.md` files so `mdfind` (and `Cmd-Space`) can find
your notes by their **semantic metadata**, not only raw text.

Companion to the in-app `CSSearchableIndex` integration (v1.7) exposed via
`POST /v1/spotlight/index` in `zeusdaemon-mac`: this importer covers Spotlight
**globally** (any `.md` on disk), the daemon endpoint covers **app-scoped**
deep-linkable items. See `docs/ADR-006-Spotlight-MDImporter-Companion.md`.

## What it indexes

| Spotlight attribute   | Source in the note |
|-----------------------|--------------------|
| `kMDItemTextContent`  | Body (frontmatter stripped) |
| `kMDItemTitle`        | `title:` → first `# H1` → filename stem |
| `kMDItemKeywords`     | `tags`, `aliases`, `zeus_concepts`, `zeus_related`, `tipo:<x>`, `status:<x>`, `domain:<x>`, H1/H2/H3, inline `#tags`, wikilink targets |
| `kMDItemAuthors`      | `authors:` or `author:` |
| `kMDItemDescription`  | `zeus_summary` or `description` |

Wikilink parser handles `[[target]]`, `[[target|alias]]`, `[[target#heading]]`.
Inline tag parser captures `#kebab-case`, `#nested/tag`, etc.

## Build

Requires Xcode command-line tools (`xcode-select --install`).

```bash
cd daemon/MDImporters/ZeusMarkdownImporter
make verify   # plutil -lint on Info.plist
make bundle   # produces build/ZeusMarkdownImporter.mdimporter/
```

Builds a universal binary (arm64 + x86_64) by default. Override with
`make build ARCHS="-arch arm64"` for Apple Silicon only.

## Install

```bash
make install
```

Copies `build/ZeusMarkdownImporter.mdimporter` to
`~/Library/Spotlight/ZeusMarkdownImporter.mdimporter` and runs
`mdimport -r` to register and reindex.

System-wide install (all users) would target `/Library/Spotlight/` and
requires `sudo` — not the default.

## Verify

```bash
# List all registered importers — ours should appear.
mdimport -L 2>&1 | grep -i zeus

# Run the importer in debug mode against a single file.
# Shows the full kMDItem* dictionary it would write to Spotlight.
mdimport -d4 /path/to/your-vault/some-note.md

# Search Spotlight for a tag stored in frontmatter:
mdfind 'kMDItemKeywords == "tipo:adr"'
mdfind 'kMDItemKeywords == "zeus"'
mdfind 'kMDItemDescription == "*Gemma4*"c'
```

If `mdimport -L` does not show the importer, check:

1. `~/Library/Spotlight/ZeusMarkdownImporter.mdimporter/Contents/Info.plist`
   exists and `plutil -lint` is happy with it.
2. The binary inside `Contents/MacOS/ZeusMarkdownImporter` is executable
   and matches your architecture (`file` it).
3. Console.app filtered for `mds` and `mdimport` — Spotlight logs rejection
   reasons there.

## Uninstall

```bash
make uninstall
```

Or manually:

```bash
rm -rf ~/Library/Spotlight/ZeusMarkdownImporter.mdimporter
mdimport -r ~/Library/Spotlight/
```

## Force reindex

After install, Spotlight reindexes lazily — only files touched after install
get the rich metadata. To rebuild metadata for every `.md` in your home dir:

```bash
make reindex
```

This walks `$HOME` for `*.md` (skipping `node_modules` and `.git`) and runs
`mdimport` on each. On a large vault this can take several minutes; you can
narrow it manually:

```bash
find ~/Metassistema ~/Estudo ~/Escritorio ~/Clientes -name '*.md' -print0 \
  | xargs -0 -n 50 mdimport
```

## Caveats

- **First-time indexing is slow.** Spotlight may take several minutes to
  reprocess your notes after install. Subsequent edits are picked up
  incrementally.
- **No notarization.** Local install works without code signing or
  notarization. Distributing the bundle to other machines via download
  requires signing + notarization to avoid Gatekeeper rejection.
- **Frontmatter parser is intentionally minimal.** Handles the YAML subset
  used in Zeus vaults (scalars, inline lists `[a, b]`, block lists `- x`).
  Nested maps and multi-line scalars are not extracted — by design, since
  Spotlight attributes are flat.
- **Privacy.** This importer runs locally on the user's Mac. Frontmatter and
  body never leave the device. Notes in `Clientes/**` (`sigiloso`) are
  indexed only into the local Spotlight DB — no cloud sync, no LLM call.
  Same trust boundary as the rest of Spotlight on your machine.

## File layout

```
ZeusMarkdownImporter/
├── Info.plist                   bundle metadata + Spotlight schema
├── GetMetadataForFile.m         frontmatter + body parser (~230 LOC)
├── main.c                       CFPlugIn factory boilerplate (~120 LOC)
├── Makefile                     build / install / verify / clean
└── README.md                    this file
```
