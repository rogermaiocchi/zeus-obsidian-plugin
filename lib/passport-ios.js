/*
 * passport-ios.js — JS-puro passport extractor para iOS Capacitor (sem daemon).
 *
 * v1.11.0 — Feature E (closes iOS gap): quando httpClient não está disponível
 * (iOS sem daemon Mac alcançável), extrai um passport "best-effort" a partir
 * do conteúdo + metadataCache do Obsidian, com qualidade ~60-70% do extrator
 * FoundationModels original. O passport mantém o MESMO schema canônico de
 * passports.jsonl — só o campo `model_versions.passport` é distinto
 * (`zeus-ios-1.11.0` vs `zeus-fm-X.Y`) para auditoria cross-device.
 *
 * Concept extraction (6 fontes, união dedupada, cap 12):
 *   1. fm.tags (array OU csv string)
 *   2. fm.aliases (array OU string)
 *   3. inline #tags via regex /#[\wÀ-ſ\-]+/g (cap 30)
 *   4. headings H1-H3 via metadataCache.getFileCache().headings
 *   5. wikilinks via metadataCache.resolvedLinks (target basenames)
 *   6. capitalized proper nouns (regex de 2-8 caracteres iniciais maiúsculos)
 *
 * Summary:
 *   - fm.zeus_summary se já existir (override declarativo)
 *   - senão: primeiras 2 sentenças do body strip-frontmatter (max 250 chars)
 *   - fallback: H1 + primeiro parágrafo
 *
 * Domain:
 *   - fm.zeus_domain (array OU string)
 *   - fallback: folder root (Templates, Clientes, Estudo, Escritorio, …)
 *
 * Difficulty:
 *   - >10KB → 4
 *   - >5KB → 3
 *   - >2KB → 2
 *   - else → 1
 *
 * Performance:
 *   - O(n) sobre o conteúdo da nota; regex única para cada fonte.
 *   - Cap conservador em concepts (12) garante payload comparable a FM extract.
 *
 * Schema de retorno:
 *   {
 *     path, extracted_at, char_count,
 *     concepts: string[],
 *     domain: string[],
 *     difficulty: 1..5,
 *     one_line_summary: string,
 *     model_versions: { passport: 'zeus-ios-1.11.0' },
 *     source: 'ios-local',
 *   }
 *
 * Referência: codex aprovação 2026-05-20 (Feature E para v1.11.0).
 */

'use strict';

const { extractCornellFields } = require('./cornell');
const { extractLuhmannFields } = require('./luhmann');

const MODEL_VERSION = 'zeus-ios-1.16.0';
const MAX_CONCEPTS = 12;
const MAX_INLINE_TAGS = 30;
const MAX_PROPER_NOUNS = 15;
const MIN_CONCEPT_LEN = 2;
const SUMMARY_MAX_CHARS = 250;

// Regex pré-compilados — extração é hot path.
const INLINE_TAG_RE = /#[\wÀ-ſ\-]+/g;
// Proper noun: 2+ caracteres com inicial maiúscula latina (PT/EN/ES); evita
// começar com dígito; aceita hífen (ex.: "São-Paulo"). Cap em 24 chars para
// evitar capturar parágrafos inteiros em vault mal-formatado.
const PROPER_NOUN_RE = /\b[A-ZÀ-Ý][\wÀ-ÿ\-]{1,23}\b/g;
// v1.11.1 codex MED #4: stopwords ALL-CAPS curtas + títulos PT-BR + siglas
// genéricas. Evita conceitos ruins tipo "DR. Silva" indexar "DR" como concept.
const PROPER_NOUN_STOPWORDS = new Set([
  // títulos
  'dr', 'dra', 'sr', 'sra', 'srta', 'exmo', 'exma', 'ilmo', 'ilma',
  // siglas all-caps comuns (não-discriminantes)
  'abc', 'cep', 'cnpj', 'cpf', 'dr', 'edt', 'gmt', 'iso', 'ltda', 'me', 'mei',
  'ong', 'pdf', 'rg', 'rh', 'sa', 'sl', 'sp', 'rj', 'usa', 'utc', 'url', 'uti',
  // demonstrativos/artigos capitalizados (início de frase)
  'a', 'as', 'da', 'das', 'de', 'do', 'dos', 'e', 'em', 'no', 'na', 'nos', 'nas',
  'o', 'os', 'um', 'uma', 'uns', 'umas', 'para', 'pelo', 'pela',
]);
const FRONTMATTER_RE = /^---\n[\s\S]*?\n---\n/;
const SENTENCE_SPLIT_RE = /(?<=[.!?])\s+(?=[A-ZÀ-Ý])/;

/**
 * Strip frontmatter YAML do corpo do markdown.
 * @param {string} content
 * @returns {string} body sem frontmatter (pode ser igual ao input se não houver)
 */
function stripFrontmatter(content) {
  if (!content || typeof content !== 'string') return '';
  return content.replace(FRONTMATTER_RE, '').trimStart();
}

/**
 * Coage um valor de frontmatter (que pode ser array, string CSV, ou string única)
 * para um array de strings limpas.
 * @param {*} v
 * @returns {string[]}
 */
function coerceArray(v) {
  if (Array.isArray(v)) return v.map(x => String(x).trim()).filter(Boolean);
  if (typeof v === 'string') {
    // CSV ou string única — split por vírgula tolera ambos.
    return v.split(',').map(s => s.trim()).filter(Boolean);
  }
  return [];
}

/**
 * Domain por folder root quando frontmatter zeus_domain ausente.
 * Heurística: usa o primeiro segmento do path da nota.
 * Para vaults conhecidos (Memoria/Estudo/Clientes/Escritorio), retorna o nome
 * canônico. Para outros, retorna o folder root limpo.
 *
 * @param {string} filePath
 * @returns {string[]}
 */
function detectDomainByFolder(filePath) {
  if (!filePath || typeof filePath !== 'string') return ['unknown'];
  const segments = filePath.split('/').filter(Boolean);
  if (segments.length < 2) return ['root'];
  const folder = segments[0];
  // Normaliza folders comuns para nome canônico (lowercase + sem números prefix).
  const normalized = folder
    .replace(/^\d+[_\s-]*/, '')   // remove prefix tipo "00_", "10 ", "20-"
    .replace(/\s+/g, '-')
    .toLowerCase();
  return [normalized || folder];
}

/**
 * Difficulty heurística baseada em char_count.
 * Apple FM extract usa modelo mais sofisticado (vocabulário, complexidade
 * sintática); fallback aqui é tamanho — vault grande tende a ter notas técnicas
 * mais densas.
 *
 * @param {number} charCount
 * @returns {number} 1..4
 */
function estimateDifficulty(charCount) {
  if (charCount > 10240) return 4;
  if (charCount > 5120) return 3;
  if (charCount > 2048) return 2;
  return 1;
}

/**
 * Extrai summary one-line do corpo.
 * Prioridade:
 *   1. fm.zeus_summary (override declarativo)
 *   2. Primeiras 2 sentenças do body (max 250 chars)
 *   3. Fallback: H1 + primeiro parágrafo
 *
 * @param {string} body — markdown sem frontmatter
 * @param {object} fm — frontmatter parseado pelo metadataCache
 * @param {object[]} headings — headings do metadataCache
 * @returns {string}
 */
function extractSummary(body, fm, headings) {
  if (fm && typeof fm.zeus_summary === 'string' && fm.zeus_summary.trim()) {
    return fm.zeus_summary.trim().slice(0, SUMMARY_MAX_CHARS);
  }
  const trimmed = (body || '').trim();
  if (trimmed.length > 0) {
    // Remove markdown noise comum antes de fatiar (headings, listas, code-fence
    // markers). Heurística: pega só linhas que parecem prosa.
    const lines = trimmed.split('\n');
    const proseLines = [];
    let inCodeBlock = false;
    for (const ln of lines) {
      const t = ln.trim();
      if (t.startsWith('```')) { inCodeBlock = !inCodeBlock; continue; }
      if (inCodeBlock) continue;
      if (!t) continue;
      if (t.startsWith('#')) continue;     // heading
      if (t.startsWith('- ') || t.startsWith('* ')) continue; // bullet
      if (/^\d+\.\s/.test(t)) continue;    // numbered list
      if (t.startsWith('>')) continue;     // callout
      if (t.startsWith('|')) continue;     // table
      proseLines.push(t);
      if (proseLines.join(' ').length > SUMMARY_MAX_CHARS * 1.5) break;
    }
    if (proseLines.length > 0) {
      const joined = proseLines.join(' ');
      const sentences = joined.split(SENTENCE_SPLIT_RE).slice(0, 2);
      const summary = sentences.join(' ').trim();
      if (summary) return summary.slice(0, SUMMARY_MAX_CHARS);
    }
  }
  // Fallback: H1 + primeiro parágrafo (body sem heading)
  const h1 = (headings || []).find(h => h.level === 1);
  if (h1) {
    const prefix = h1.heading ? h1.heading.trim() + ' — ' : '';
    const rest = (body || '').replace(/^#+\s.*$/m, '').trim().split('\n').find(l => l.trim());
    return (prefix + (rest || '').trim()).slice(0, SUMMARY_MAX_CHARS);
  }
  return '';
}

/**
 * Extração principal — pura função, async para compat com pipeline e para
 * permitir uso de adapter.read no caller (que já é async).
 *
 * @param {string} filePath — caminho vault-relativo da nota
 * @param {string} fileContent — conteúdo bruto da nota (já lido pelo caller)
 * @param {object} metadataCache — this.plugin.app.metadataCache (já carregado)
 * @returns {Promise<object>} passport
 */
async function extractPassportLocal(filePath, fileContent, metadataCache) {
  const content = typeof fileContent === 'string' ? fileContent : '';
  const body = stripFrontmatter(content);
  const charCount = content.length;

  // metadataCache.getFileCache requer TFile; aceita também resolved cache via
  // getCache(path) em algumas versões. Defensivo: aceita null.
  let fileCache = null;
  if (metadataCache && typeof metadataCache.getCache === 'function') {
    try { fileCache = metadataCache.getCache(filePath); } catch { /* ignore */ }
  }
  const fm = (fileCache && fileCache.frontmatter) || {};
  const headings = (fileCache && fileCache.headings) || [];

  // ---- Concept extraction (6 fontes) ----
  const conceptsBag = []; // mantém ordem de inserção; dedup posterior

  // 1) fm.tags
  for (const t of coerceArray(fm.tags)) {
    conceptsBag.push(String(t).replace(/^#/, ''));
  }
  // 2) fm.aliases
  for (const a of coerceArray(fm.aliases)) {
    conceptsBag.push(String(a));
  }
  // 3) inline #tags (cap 30)
  const inlineMatches = body.match(INLINE_TAG_RE) || [];
  for (let i = 0; i < Math.min(inlineMatches.length, MAX_INLINE_TAGS); i++) {
    conceptsBag.push(inlineMatches[i].replace(/^#/, ''));
  }
  // 4) headings H1-H3 (sem prefixo do #)
  for (const h of headings) {
    if (h && typeof h.level === 'number' && h.level >= 1 && h.level <= 3 && h.heading) {
      conceptsBag.push(String(h.heading).trim());
    }
  }
  // 5) wikilinks via resolvedLinks (target basenames sem .md)
  if (metadataCache && metadataCache.resolvedLinks
      && typeof metadataCache.resolvedLinks === 'object') {
    const outLinks = metadataCache.resolvedLinks[filePath];
    if (outLinks && typeof outLinks === 'object') {
      for (const targetPath of Object.keys(outLinks)) {
        const basename = targetPath.split('/').pop().replace(/\.md$/, '');
        if (basename) conceptsBag.push(basename);
      }
    }
  }
  // 6) proper nouns capitalizados (cap 15)
  // v1.11.1 codex MED #4: filtra stopwords (Dr/Dra/Sr/...), rejeita ALL-CAPS
  // curtas (≤4 chars sem dígitos = sigla provável), prefere termos com letras
  // minúsculas embutidas (real proper noun, não SCREAMING TEXT).
  const properMatches = body.match(PROPER_NOUN_RE) || [];
  let properCount = 0;
  const properSeen = new Set();
  for (const pn of properMatches) {
    if (properCount >= MAX_PROPER_NOUNS) break;
    if (pn.length < MIN_CONCEPT_LEN || pn.length > 24) continue;
    const lower = pn.toLowerCase();
    if (PROPER_NOUN_STOPWORDS.has(lower)) continue;          // títulos/siglas
    if (properSeen.has(lower)) continue;
    // v1.15.0 fix: rejeita qualquer token ALL-CAPS sem dígitos (sigla/acrônimo).
    // Bug anterior: só rejeitava ≤4 chars — "BRASIL", "FEDERAL" passavam.
    if (pn === pn.toUpperCase() && !/\d/.test(pn)) continue;
    properSeen.add(lower);
    conceptsBag.push(pn);
    properCount++;
  }

  // ---- Dedup case-insensitive + filter + cap ----
  const seen = new Set();
  const concepts = [];
  for (const raw of conceptsBag) {
    const s = String(raw).trim();
    if (s.length < MIN_CONCEPT_LEN) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    concepts.push(s);
    if (concepts.length >= MAX_CONCEPTS) break;
  }

  // ---- Domain ----
  let domain = coerceArray(fm.zeus_domain);
  if (domain.length === 0) domain = detectDomainByFolder(filePath);

  // ---- Summary ----
  const summary = extractSummary(body, fm, headings);

  // ---- Difficulty ----
  const difficulty = estimateDifficulty(charCount);

  const extractedAt = new Date().toISOString();

  // Cornell fields (cue column + summary row)
  const cornell = extractCornellFields(body, fm, headings, summary, concepts);

  // Luhmann fields (note type + zettel ID + atomic split suggestions)
  const luhmann = extractLuhmannFields(body, fm, filePath, charCount, concepts, extractedAt);

  return {
    path: filePath,
    extracted_at: extractedAt,
    char_count: charCount,
    concepts,
    domain,
    difficulty,
    one_line_summary: summary,
    cornell_cue: cornell.cornell_cue,
    cornell_summary: cornell.cornell_summary,
    note_type: luhmann.note_type,
    zettel_id: luhmann.zettel_id,
    atomic_splits: luhmann.atomic_splits,
    model_versions: { passport: MODEL_VERSION },
    source: 'ios-local',
  };
}

module.exports = {
  extractPassportLocal,
  // Exports privados para testes
  _stripFrontmatter: stripFrontmatter,
  _coerceArray: coerceArray,
  _detectDomainByFolder: detectDomainByFolder,
  _estimateDifficulty: estimateDifficulty,
  _extractSummary: extractSummary,
  MODEL_VERSION,
};
