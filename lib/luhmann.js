'use strict';

/*
 * luhmann.js — Zettelkasten de Luhmann automatizado para notas Obsidian.
 *
 * Niklas Luhmann classificava suas notas em três tipos:
 *   1. FLEETING (volante): rascunhos, capturas rápidas — temporários
 *   2. LITERATURE (literatura): notas de leitura de fontes externas
 *   3. PERMANENT (permanente): ideias próprias elaboradas, nós autônomos
 *
 * Esta implementação detecta automaticamente o tipo de nota e atribui
 * um ID Zettel, sem modificar o conteúdo original.
 *
 * Detecção de note_type (heurísticas):
 *   FLEETING:   corpo < 300 chars, sem wikilinks, em pasta Inbox/Fleeting/Capture
 *   LITERATURE: frontmatter com source/author/url/doi/isbn OU > 30% blockquotes
 *   PERMANENT:  wikilinks ≥ 2, conceitos ≥ 3, corpo > 600 chars, não em Inbox
 *   (null se inconclusivo)
 *
 * Zettel ID:
 *   Formato: YYYYMMDDHHMM (12 dígitos, baseado em extracted_at ou data do arquivo)
 *   Exemplo: "202605211430" — 21 de maio de 2026, 14h30
 *   Prioridade: frontmatter zeus_zettel_id > zeus_id > gerado de extracted_at
 *
 * Sugestão de notas atômicas:
 *   H2/H3 com > 200 chars de conteúdo abaixo deles indicam que aquele
 *   conceito poderia virar uma nota própria no Zettelkasten.
 *
 * v1.16.0 — Zeus Obsidian Plugin (Cornell + Luhmann completion).
 */

// Pastas de captura rápida (fleeting)
const FLEETING_FOLDERS = new Set([
  'inbox', 'capture', 'fleeting', 'scratch', 'rascunho', 'captura',
  'quick', 'daily', 'diário', 'diario', 'log', 'notas-rápidas',
]);

// Frontmatter keys que indicam nota de literatura
const LITERATURE_KEYS = new Set([
  'source', 'author', 'authors', 'url', 'doi', 'isbn', 'journal',
  'book', 'livro', 'fonte', 'autor', 'artigo', 'paper', 'reference',
  'referência', 'referencia',
]);

// Regex
const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;
const BLOCKQUOTE_LINE_RE = /^>\s/gm;
const HEADING_RE = /^(#{1,3})\s+(.+)$/gm;

/**
 * Detecta o tipo Zettelkasten de uma nota.
 *
 * @param {string} body — conteúdo sem frontmatter
 * @param {object} fm — frontmatter parseado
 * @param {string} filePath — caminho relativo da nota
 * @param {number} charCount — tamanho do conteúdo em chars
 * @param {string[]} concepts — conceitos já extraídos
 * @returns {'fleeting'|'literature'|'permanent'|null}
 */
function detectNoteType(body, fm, filePath, charCount, concepts) {
  // Frontmatter override
  if (fm) {
    const explicit = fm.zeus_note_type || fm.note_type || fm.zettel_type;
    if (explicit) {
      const v = String(explicit).toLowerCase().trim();
      if (v === 'fleeting' || v === 'literature' || v === 'permanent') return v;
    }
  }

  // Detecta folder
  const folderParts = filePath.replace(/\\/g, '/').split('/');
  const topFolder = (folderParts[0] || '').toLowerCase();
  const secondFolder = (folderParts[1] || '').toLowerCase();
  const isFleetingFolder = FLEETING_FOLDERS.has(topFolder) || FLEETING_FOLDERS.has(secondFolder);

  // Conta wikilinks
  const wikilinkMatches = (body.match(WIKILINK_RE) || []).length;

  // Conta blockquotes
  const totalLines = (body.match(/\n/g) || []).length + 1;
  const bqLines = (body.match(BLOCKQUOTE_LINE_RE) || []).length;
  const bqRatio = totalLines > 0 ? bqLines / totalLines : 0;

  // Verifica frontmatter de literatura
  const hasLiteratureKey = fm && Object.keys(fm).some(k => LITERATURE_KEYS.has(k.toLowerCase()));

  // FLEETING: curto, sem wikilinks, em pasta de captura
  if (charCount < 300 && wikilinkMatches === 0 && (isFleetingFolder || charCount < 150)) {
    return 'fleeting';
  }

  // LITERATURE: frontmatter de fonte OU muitos blockquotes
  if (hasLiteratureKey || bqRatio > 0.3) {
    return 'literature';
  }

  // PERMANENT: bem conectado, rico em conceitos, substancial
  if (wikilinkMatches >= 2 && (concepts || []).length >= 3 && charCount > 600) {
    return 'permanent';
  }

  // Inconclusivo
  return null;
}

/**
 * Gera um ID Zettel no formato YYYYMMDDHHMM.
 *
 * @param {string} fm — frontmatter parseado
 * @param {string} extractedAt — ISO timestamp do extracted_at
 * @returns {string}
 */
function generateZettelId(fm, extractedAt) {
  // 1. Frontmatter override
  if (fm) {
    const explicit = fm.zeus_zettel_id || fm.zettel_id || fm.zeus_id;
    if (explicit) return String(explicit).trim();
  }

  // 2. Derivar de extracted_at ou data atual
  try {
    const d = extractedAt ? new Date(extractedAt) : new Date();
    const pad = n => String(n).padStart(2, '0');
    return (
      d.getFullYear() +
      pad(d.getMonth() + 1) +
      pad(d.getDate()) +
      pad(d.getHours()) +
      pad(d.getMinutes())
    );
  } catch {
    return String(Date.now()).slice(0, 12);
  }
}

/**
 * Sugere headings que poderiam virar notas atômicas independentes.
 * Critério: heading H2/H3 seguido de > 200 chars de conteúdo.
 *
 * @param {string} body
 * @returns {string[]} lista de textos de heading candidatos
 */
function suggestAtomicSplits(body) {
  const candidates = [];
  const sections = body.split(/^#{2,3}\s+/m).slice(1); // descarta antes do primeiro H2
  const headings = [];
  let m;
  const re = new RegExp(HEADING_RE.source, 'gm');
  while ((m = re.exec(body)) !== null) {
    if (m[1].length >= 2) headings.push(m[2].trim());
  }

  for (let i = 0; i < sections.length; i++) {
    const sectionBody = sections[i].split(/\n#{2,3}\s/)[0]; // até o próximo heading
    if (sectionBody.replace(/\s/g, '').length > 200 && headings[i]) {
      candidates.push(headings[i]);
    }
  }
  return candidates.slice(0, 5); // máximo 5 sugestões
}

/**
 * Extrai campos Luhmann completos de uma nota.
 *
 * @param {string} body
 * @param {object} fm
 * @param {string} filePath
 * @param {number} charCount
 * @param {string[]} concepts
 * @param {string} extractedAt
 * @returns {{ note_type: string|null, zettel_id: string, atomic_splits: string[] }}
 */
function extractLuhmannFields(body, fm, filePath, charCount, concepts, extractedAt) {
  return {
    note_type: detectNoteType(body, fm, filePath, charCount, concepts),
    zettel_id: generateZettelId(fm, extractedAt),
    atomic_splits: suggestAtomicSplits(body),
  };
}

module.exports = { extractLuhmannFields, detectNoteType, generateZettelId, suggestAtomicSplits };
