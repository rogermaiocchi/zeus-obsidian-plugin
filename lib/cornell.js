'use strict';

/*
 * cornell.js — Método Cornell automatizado para notas Obsidian.
 *
 * O método Cornell divide cada nota em três zonas:
 *   1. CUE (coluna esquerda): perguntas-chave / palavras-gatilho para recuperação
 *   2. NOTAS (área principal): conteúdo da nota (já existente)
 *   3. RESUMO (rodapé): síntese em uma frase (one_line_summary)
 *
 * Esta implementação extrai automaticamente as zonas 1 e 3 a partir
 * da estrutura da nota, sem modificar o conteúdo original.
 *
 * Fontes para cornell_cue (prioridade decrescente):
 *   1. Frontmatter zeus_cornell_cue (declaração explícita — maior prioridade)
 *   2. Headings H2/H3 convertidos para perguntas (detecta se já são perguntas)
 *   3. Conceitos extraídos como cues de recuperação
 *
 * Fontes para cornell_summary (prioridade decrescente):
 *   1. Frontmatter zeus_cornell_summary (declaração explícita)
 *   2. one_line_summary já extraído (Feynman compression)
 *   3. Primeira sentença do corpo
 *
 * v1.16.0 — Zeus Obsidian Plugin (Cornell + Luhmann completion).
 */

// Regex pré-compilados
const H2_H3_RE = /^#{2,3}\s+(.+)$/gm;
const QUESTION_RE = /[?？]$/;

// Palavras interrogativas PT-BR que indicam que o heading já é uma pergunta
const QUESTION_STARTS = new Set([
  'o que', 'como', 'por que', 'por quê', 'quem', 'quando', 'onde',
  'qual', 'quais', 'quanto', 'quantos', 'quantas', 'para que',
  'what', 'how', 'why', 'who', 'when', 'where', 'which',
]);

// Verbos de estado / copulativos no início do heading (indicam que já definem algo)
const DEF_STARTS = /^(é|são|significa|define|representa|descreve|explica|trata)/i;

/**
 * Converte um heading em uma pergunta de recuperação Cornell.
 * Se já for uma pergunta, retorna como está.
 * Se for um substantivo/conceito, converte: "Anáfora" → "O que é anáfora?"
 *
 * @param {string} heading
 * @returns {string}
 */
function headingToCue(heading) {
  const h = heading.trim();
  if (!h) return '';

  // Já é uma pergunta
  if (QUESTION_RE.test(h)) return h;

  const lower = h.toLowerCase();
  for (const qw of QUESTION_STARTS) {
    if (lower.startsWith(qw)) return h.endsWith('?') ? h : h + '?';
  }

  // Heading longo (> 6 palavras) — provavelmente já é um conceito complexo
  const words = h.split(/\s+/);
  if (words.length > 6) return h + '?';

  // Heading curto — converte para pergunta
  return `O que é ${lower.replace(/[?！!]/g, '')}?`;
}

/**
 * Extrai campos Cornell de uma nota.
 *
 * @param {string} body — conteúdo sem frontmatter
 * @param {object} fm — frontmatter parseado
 * @param {string[]} headings — headings da nota (texto limpo)
 * @param {string} one_line_summary — já extraído pelo passport extractor
 * @param {string[]} concepts — conceitos já extraídos
 * @returns {{ cornell_cue: string[], cornell_summary: string }}
 */
function extractCornellFields(body, fm, headings, one_line_summary, concepts) {
  // ---- CORNELL_CUE ----
  let cornell_cue = [];

  // 1. Frontmatter override
  if (fm && (fm.zeus_cornell_cue || fm.cornell_cue)) {
    const raw = fm.zeus_cornell_cue || fm.cornell_cue;
    cornell_cue = Array.isArray(raw)
      ? raw.map(String).filter(Boolean)
      : String(raw).split(/[;,\n]+/).map(s => s.trim()).filter(Boolean);
  }

  // 2. Derivar de headings H2/H3 (se frontmatter não proveu)
  if (cornell_cue.length === 0) {
    const h23 = [];
    let m;
    const re = new RegExp(H2_H3_RE.source, 'gm');
    while ((m = re.exec(body)) !== null) {
      const h = m[1].trim().replace(/\*\*/g, '').replace(/__/g, '');
      if (h.length >= 3 && h.length <= 80) h23.push(h);
    }
    cornell_cue = h23.slice(0, 8).map(headingToCue).filter(Boolean);
  }

  // 3. Fallback: top 3 conceitos como cues
  if (cornell_cue.length === 0 && Array.isArray(concepts) && concepts.length > 0) {
    cornell_cue = concepts.slice(0, 3).map(c => `O que é ${c.toLowerCase()}?`);
  }

  // ---- CORNELL_SUMMARY ----
  let cornell_summary = '';

  // 1. Frontmatter override
  if (fm && (fm.zeus_cornell_summary || fm.cornell_summary)) {
    cornell_summary = String(fm.zeus_cornell_summary || fm.cornell_summary).trim();
  }

  // 2. Usar one_line_summary (Feynman compression)
  if (!cornell_summary && one_line_summary) {
    cornell_summary = one_line_summary;
  }

  // 3. Primeira sentença do corpo
  if (!cornell_summary && body) {
    const firstSentence = body.replace(/^#{1,6}\s+.+\n?/m, '').trim().split(/[.!?]\s/)[0];
    if (firstSentence && firstSentence.length > 20) {
      cornell_summary = firstSentence.slice(0, 200).trim() + (firstSentence.length > 200 ? '…' : '');
    }
  }

  return { cornell_cue, cornell_summary };
}

/**
 * Detecta se uma nota foi escrita intencionalmente no formato Cornell
 * (seções explícitas: Anotações / Perguntas-Chave / Resumo).
 *
 * @param {string} body
 * @returns {boolean}
 */
function isCornellFormatted(body) {
  const lower = body.toLowerCase();
  const hasCueSection = /#{2,3}\s*(perguntas[- ]chave|cue|questões|keywords)/i.test(body);
  const hasSummarySection = /#{2,3}\s*(resumo|summary|síntese)/i.test(body);
  return hasCueSection || hasSummarySection;
}

module.exports = { extractCornellFields, headingToCue, isCornellFormatted };
