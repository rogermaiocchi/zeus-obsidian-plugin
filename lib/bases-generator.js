/*
 * BasesGenerator v1.7 — Obsidian Bases UI derivative enriquecido.
 *
 * CANÔNICO: data/passports.jsonl (escrito por PassportIndex).
 * DERIVATIVO: data/zeus-cards.base (regenerado a cada rebuild de passports).
 *
 * Mudanças v1.7 (proposta codex aprovada):
 *   - Schema dinâmico — colunas inferidas a partir dos próprios passports
 *     quando disponíveis (concepts/summary/domain/difficulty/sources).
 *   - density e freshness expressos como FORMULAS Bases (codex MED — evita
 *     mass-write em frontmatter; campos deriváveis a partir de file size +
 *     file.mtime ficam computados pelo Bases em query time).
 *   - Múltiplas views: All / Orphans (sem zeus_related) / Graph-rich
 *     (zeus_graph_related ≥ 5) / By domain (cards).
 *
 * Referência sintaxe: https://help.obsidian.md/bases/syntax
 *
 * Bases é UI derivativa, NÃO canônica. Usuário NÃO deve editar zeus-cards.base
 * manualmente — sobrescrito no próximo rebuild.
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

  async regenerate() {
    return await this.generateBase(this.jsonlPath, this.basePath);
  }

  async generateBase(jsonlPath, outputPath) {
    if (!(await universal.adapterExists(this._adapter, jsonlPath))) {
      console.warn('[zeus][bases] passports.jsonl missing — skipping .base regen');
      return { written: false, count: 0, path: outputPath };
    }
    const raw = await universal.adapterRead(this._adapter, jsonlPath);
    const lines = raw.split('\n').filter(l => l.trim());

    let count = 0;
    let withSummary = 0;
    let withConcepts = 0;
    let withDomain = 0;
    let withCornell = 0;
    let withLuhmann = 0;
    const domains = new Set();
    const noteTypes = { fleeting: 0, literature: 0, permanent: 0 };
    for (const ln of lines) {
      try {
        const obj = JSON.parse(ln);
        if (!obj || !obj.path) continue;
        count++;
        if (obj.one_line_summary || obj.summary) withSummary++;
        if (Array.isArray(obj.concepts) && obj.concepts.length) withConcepts++;
        if (obj.domain) {
          withDomain++;
          if (Array.isArray(obj.domain)) for (const d of obj.domain) domains.add(d);
          else domains.add(String(obj.domain));
        }
        if (Array.isArray(obj.cornell_cue) && obj.cornell_cue.length) withCornell++;
        if (obj.note_type) { withLuhmann++; if (noteTypes[obj.note_type] !== undefined) noteTypes[obj.note_type]++; }
      } catch { /* skip malformed */ }
    }

    const generatedAt = new Date().toISOString();
    const stats = { count, withSummary, withConcepts, withDomain, withCornell, withLuhmann, noteTypes, domainList: [...domains].sort() };
    const yaml = this._renderYaml(stats, generatedAt);
    await universal.adapterWriteAtomic(this._adapter, outputPath, yaml);
    return { written: true, count, stats, path: outputPath };
  }

  _renderYaml(stats, generatedAt) {
    // Schema completo v1.7. Bases reconhece file.size, file.mtime, file.ctime,
    // file.ext, file.name, file.path, file.tags como builtins. Frontmatter props
    // (zeus_concepts, zeus_summary, zeus_related, zeus_graph_related, etc.) são
    // referenciadas direto. Formulas usam expressões JS-like.
    //
    // density: heurística "tokens únicos ~ file.size / 6" (aproximação 1 token
    // por ~6 bytes em texto pt-BR/en). Não precisa de campo escrito.
    //
    // freshness_days: (now - file.mtime) / dias. Bases tem 'now()' helper.
    // codex HIGH #1: schema Bases oficial — formulas como mapa direto
    //   nome: "expressão" (string YAML), não { formula: "..." }.
    // codex HIGH #1: .length (sem parênteses), não .length() — sintaxe de campo.
    // codex HIGH #2: groupBy é objeto { property, direction }, e quando o campo
    //   pode ser array (zeus_domain), usa formula intermediária pra pegar o primeiro.
    const cornellStat = `cornell=${stats.withCornell}`;
    const luhmannStat = `luhmann=${stats.withLuhmann}(f=${stats.noteTypes.fleeting}/l=${stats.noteTypes.literature}/p=${stats.noteTypes.permanent})`;
    return [
      '# zeus-cards.base — auto-generated v1.8.0 (Cornell + Luhmann Zettelkasten)',
      '# DO NOT EDIT MANUALLY — regenerated on each passport rebuild.',
      `# generated_at: ${generatedAt}`,
      `# stats: ${stats.count} passports · summary=${stats.withSummary} · concepts=${stats.withConcepts} · domain=${stats.withDomain} · ${cornellStat} · ${luhmannStat}`,
      `# domains: ${stats.domainList.slice(0, 10).join(', ')}${stats.domainList.length > 10 ? ' …' : ''}`,
      '#',
      '# Canônico: data/passports.jsonl. Bases é UI derivativa.',
      '# Sintaxe: https://obsidian.md/help/bases/syntax',
      '',
      'filters:',
      '  and:',
      '    - file.ext == "md"',
      '',
      'formulas:',
      '  density_est: "file.size / 6"',
      '  freshness_days: "(now() - file.mtime) / 86400000"',
      '  has_graph: "list(zeus_graph_related).length > 0"',
      '  has_neighbors: "list(zeus_related).length > 0"',
      '  neighbor_count: "list(zeus_related).length"',
      '  graph_node_count: "list(zeus_graph_related).length"',
      '  domain_primary: "list(zeus_domain)[0]"',
      '  has_cornell: "list(zeus_cornell_cue).length > 0"',
      '  cue_count: "list(zeus_cornell_cue).length"',
      '  is_permanent: "zeus_note_type == \\"permanent\\""',
      '  is_literature: "zeus_note_type == \\"literature\\""',
      '  is_fleeting: "zeus_note_type == \\"fleeting\\""',
      '',
      'properties:',
      '  file.path:',
      '    displayName: Note',
      '  zeus_summary:',
      '    displayName: Summary',
      '  zeus_concepts:',
      '    displayName: Concepts',
      '  zeus_domain:',
      '    displayName: Domain',
      '  zeus_difficulty:',
      '    displayName: Difficulty',
      '  zeus_related:',
      '    displayName: Semantic neighbors',
      '  zeus_graph_related:',
      '    displayName: Graph entities',
      '  zeus_cornell_cue:',
      '    displayName: Cornell Cues',
      '  zeus_cornell_summary:',
      '    displayName: Cornell Summary',
      '  zeus_note_type:',
      '    displayName: Note type (Luhmann)',
      '  zeus_zettel_id:',
      '    displayName: Zettel ID',
      '  formula.density_est:',
      '    displayName: Density ~tokens',
      '  formula.freshness_days:',
      '    displayName: Days since edit',
      '  formula.neighbor_count:',
      '    displayName: "# neighbors"',
      '  formula.graph_node_count:',
      '    displayName: "# graph nodes"',
      '  formula.cue_count:',
      '    displayName: "# Cornell cues"',
      '',
      'views:',
      '  - type: table',
      '    name: All passports',
      '    order:',
      '      - file.path',
      '      - zeus_summary',
      '      - zeus_domain',
      '      - zeus_difficulty',
      '      - zeus_note_type',
      '      - formula.neighbor_count',
      '      - formula.graph_node_count',
      '      - formula.density_est',
      '      - formula.freshness_days',
      '    sort:',
      '      - property: formula.density_est',
      '        direction: DESC',
      '',
      '  - type: cards',
      '    name: Orphans (no semantic neighbors)',
      '    filters:',
      '      and:',
      '        - file.ext == "md"',
      '        - formula.has_neighbors == false',
      '    order:',
      '      - file.path',
      '      - zeus_summary',
      '      - formula.density_est',
      '',
      '  - type: table',
      '    name: Graph-rich (≥5 entities)',
      '    filters:',
      '      and:',
      '        - file.ext == "md"',
      '        - formula.graph_node_count >= 5',
      '    order:',
      '      - file.path',
      '      - zeus_summary',
      '      - formula.graph_node_count',
      '      - formula.neighbor_count',
      '    sort:',
      '      - property: formula.graph_node_count',
      '        direction: DESC',
      '',
      '  - type: cards',
      '    name: Cards by domain',
      '    order:',
      '      - zeus_summary',
      '      - zeus_concepts',
      '      - zeus_difficulty',
      '    groupBy:',
      '      property: formula.domain_primary',
      '      direction: ASC',
      '',
      '  - type: table',
      '    name: Recently edited',
      '    order:',
      '      - file.path',
      '      - zeus_summary',
      '      - formula.freshness_days',
      '    sort:',
      '      - property: formula.freshness_days',
      '        direction: ASC',
      '',
      '  - type: table',
      '    name: Zettelkasten — Permanent notes',
      '    filters:',
      '      and:',
      '        - file.ext == "md"',
      '        - formula.is_permanent == true',
      '    order:',
      '      - zeus_zettel_id',
      '      - file.path',
      '      - zeus_summary',
      '      - zeus_concepts',
      '      - formula.neighbor_count',
      '    sort:',
      '      - property: zeus_zettel_id',
      '        direction: ASC',
      '',
      '  - type: cards',
      '    name: Zettelkasten — Literature notes',
      '    filters:',
      '      and:',
      '        - file.ext == "md"',
      '        - formula.is_literature == true',
      '    order:',
      '      - file.path',
      '      - zeus_summary',
      '      - zeus_cornell_cue',
      '      - formula.freshness_days',
      '',
      '  - type: table',
      '    name: Zettelkasten — Fleeting notes (to process)',
      '    filters:',
      '      and:',
      '        - file.ext == "md"',
      '        - formula.is_fleeting == true',
      '    order:',
      '      - file.path',
      '      - zeus_summary',
      '      - formula.freshness_days',
      '    sort:',
      '      - property: formula.freshness_days',
      '        direction: ASC',
      '',
      '  - type: table',
      '    name: Cornell — Notas com cues',
      '    filters:',
      '      and:',
      '        - file.ext == "md"',
      '        - formula.has_cornell == true',
      '    order:',
      '      - file.path',
      '      - zeus_cornell_summary',
      '      - zeus_cornell_cue',
      '      - formula.cue_count',
      '    sort:',
      '      - property: formula.cue_count',
      '        direction: DESC',
      '',
    ].join('\n');
  }
}

module.exports = BasesGenerator;
