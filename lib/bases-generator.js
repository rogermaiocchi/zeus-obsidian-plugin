/*
 * BasesGenerator — regenerates Obsidian Bases UI view from passports.jsonl
 *
 * IMPORTANT: Bases is a UI DERIVATIVE, NOT canonical.
 *   - Canonical source: data/passports.jsonl
 *   - Derivative output: data/zeus-cards.base
 *
 * The .base file is human-readable YAML that Obsidian Bases plugin renders as a
 * table/cards view. We regenerate it on every passport rebuild to keep UI in
 * sync with the canonical JSONL. Users MUST NOT hand-edit zeus-cards.base —
 * changes will be overwritten.
 *
 * Schema reference: https://help.obsidian.md/bases/syntax
 *
 * v0.11 — universal Mac+iOS: substituído fs/path por lib/universal-fs + vault.adapter.
 * regenerate / generateBase agora são async.
 *
 * Reference: ADR-018, PIA architecture (2026-05-14).
 */

'use strict';

const universal = require('./universal-fs');

const DATA_DIR_NAME = 'data';
const BASE_FILE = 'zeus-cards.base';
const PASSPORTS_FILE = 'passports.jsonl';

class BasesGenerator {
  constructor(plugin) {
    this.plugin = plugin;
  }

  get _adapter() {
    return this.plugin.app.vault.adapter;
  }

  get dataPath() {
    return universal.joinPath(this.plugin.manifest.dir, DATA_DIR_NAME);
  }

  get basePath() {
    return universal.joinPath(this.dataPath, BASE_FILE);
  }

  get jsonlPath() {
    return universal.joinPath(this.dataPath, PASSPORTS_FILE);
  }

  /**
   * Regenerate zeus-cards.base from the canonical passports.jsonl in the data dir.
   * Convenience wrapper used by plugin onload + commands.
   */
  async regenerate() {
    return await this.generateBase(this.jsonlPath, this.basePath);
  }

  /**
   * Convert passports.jsonl into a YAML .base file.
   *
   * @param {string} jsonlPath
   * @param {string} outputPath
   * @returns {{written: boolean, count: number, path: string}}
   */
  async generateBase(jsonlPath, outputPath) {
    if (!(await universal.adapterExists(this._adapter, jsonlPath))) {
      console.warn('[zeus][bases] passports.jsonl missing — skipping .base regen');
      return { written: false, count: 0, path: outputPath };
    }
    const raw = await universal.adapterRead(this._adapter, jsonlPath);
    const lines = raw.split('\n').filter(l => l.trim());
    let count = 0;
    for (const ln of lines) {
      try {
        const obj = JSON.parse(ln);
        if (obj && obj.path) count++;
      } catch { /* skip bad line */ }
    }

    const generatedAt = new Date().toISOString();
    const yaml = this._renderYaml(count, generatedAt);

    await universal.adapterWriteAtomic(this._adapter, outputPath, yaml);

    return { written: true, count, path: outputPath };
  }

  _renderYaml(count, generatedAt) {
    // Obsidian Bases YAML schema. The Bases plugin reads file frontmatter, but
    // here we surface fields that PIA populates in note frontmatter (we mirror
    // passport fields into frontmatter via NativeGraph in v0.8). When passport
    // fields are not yet mirrored, Bases will simply show empty cells.
    return [
      '# zeus-cards.base — auto-generated from passports.jsonl',
      '# DO NOT EDIT MANUALLY — regenerated on each passport rebuild.',
      `# generated_at: ${generatedAt}`,
      `# passport_count: ${count}`,
      '#',
      '# Bases is a UI DERIVATIVE. Canonical source: data/passports.jsonl.',
      '',
      'filters:',
      '  and:',
      '    - file.ext == "md"',
      '',
      'properties:',
      '  file.path:',
      '    displayName: Note',
      '  zeus_concepts:',
      '    displayName: Atomic concepts',
      '  zeus_summary:',
      '    displayName: Summary',
      '  zeus_domain:',
      '    displayName: Domain',
      '  zeus_difficulty:',
      '    displayName: Difficulty',
      '',
      'views:',
      '  - type: table',
      '    name: All passports',
      '    order:',
      '      - file.path',
      '      - zeus_summary',
      '      - zeus_concepts',
      '      - zeus_domain',
      '      - zeus_difficulty',
      '    sort:',
      '      - property: file.path',
      '        direction: ASC',
      '  - type: cards',
      '    name: Cards by domain',
      '    order:',
      '      - zeus_summary',
      '      - zeus_concepts',
      '      - zeus_difficulty',
      '    groupBy: zeus_domain',
      '',
    ].join('\n');
  }
}

module.exports = BasesGenerator;
