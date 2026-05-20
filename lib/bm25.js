/*
 * bm25.js — Okapi BM25 puro JS (sem dependências).
 *
 * Porte do `~/Code/maiocchi-ia/skills/tripla-fusao/scripts/bm25.py` para Node.
 * Implementação léxica que complementa a perna semântica (NLContextualEmbedding):
 * o vetor acha o que *parece* parecido (paráfrase, sinônimo); o BM25 acha o que
 * *contém* o termo exato (sigla, nome próprio, id processual). Cada perna cobre
 * o ponto cego da outra.
 *
 * API:
 *   - tokenize(text) → list<string>           (lower, [0-9a-zà-ÿ_-]{2,})
 *   - bm25Scores(corpus, queryTokens, k1, b)  → list<number>
 *   - rankNotes(notes, query)                  → list<{path, score, tokens}>
 *
 * Uso típico (no consumer hybrid-search.js):
 *   const { rankNotes } = require('./bm25');
 *   const ranked = rankNotes(
 *     [{path: 'a.md', text: 'corpus tokens'}, ...],
 *     'query terms here'
 *   );
 *   // ranked: [{path: 'a.md', score: 1.23, tokens: ['corpus','tokens']}, ...]
 *
 * Tests inline: `node lib/bm25.js "query"` roda um demo com corpus sintético.
 *
 * Parâmetros canônicos (Robertson & Zaragoza 2009):
 *   k1 = 1.5  — controla saturação de TF (10ª ocorrência soma bem menos que 2ª)
 *   b  = 0.75 — controla normalização por tamanho de documento (longo não
 *               ganha vantagem só por ter mais palavras)
 *   IDF clássico Okapi com +1 (nunca negativa):
 *     idf(t) = log(1 + (N - df + 0.5) / (df + 0.5))
 *
 * Performance:
 *   - O(N · |query|) por search.
 *   - Para vault grande (>10k notas), o consumer DEVE limitar corpus às notas
 *     com embedding carregado (Map<path, {vec}>) antes de chamar rankNotes.
 *   - tokenize() faz regex global em string lowercased — ~3M tokens/s em laptop M1.
 */

'use strict';

// Token: 2+ caracteres entre letras (incl. acentos latinos comuns), dígitos, _ e -.
// Mesma classe usada pelo bm25.py de referência — preserva interop léxica entre
// stacks (ex: query "habeas corpus" tokeniza igual no JS e no Py).
//
// Nota: classe latina-1 [à-ÿ] cobre acentos PT/EN/ES/FR/IT. Hebraico, árabe,
// chinês não são tokenizados (consideramos vault PT-BR/EN como caso comum).
const _TOKEN = /[0-9a-zà-ÿ_-]{2,}/g;

const K1_DEFAULT = 1.5;
const B_DEFAULT = 0.75;

/**
 * Quebra `text` em tokens léxicos: lowercase, 2+ letras/dígitos/_/-.
 * Espelha tokenização do bm25.py canônico; tokens de uma letra são ruído.
 *
 * @param {string} text
 * @returns {string[]}
 */
function tokenize(text) {
  if (!text || typeof text !== 'string') return [];
  return text.toLowerCase().match(_TOKEN) || [];
}

/**
 * Okapi BM25 clássico — score de relevância por documento.
 *
 *   IDF(termo) · (tf · (k1 + 1)) / (tf + k1 · (1 - b + b · |doc| / avgdl))
 *
 * Documento sem nenhum termo da query recebe score 0.0. Corpus vazio devolve
 * lista vazia.
 *
 * @param {string[][]} corpus — lista de docs JÁ tokenizados
 * @param {string[]} queryTokens — tokens da consulta
 * @param {number} [k1=1.5]
 * @param {number} [b=0.75]
 * @returns {number[]}
 */
function bm25Scores(corpus, queryTokens, k1 = K1_DEFAULT, b = B_DEFAULT) {
  const N = corpus.length;
  if (N === 0) return [];
  if (!Array.isArray(queryTokens) || queryTokens.length === 0) {
    return new Array(N).fill(0);
  }

  // Comprimentos + avgdl
  const docLens = new Array(N);
  let totalLen = 0;
  for (let i = 0; i < N; i++) {
    const dl = corpus[i].length;
    docLens[i] = dl;
    totalLen += dl;
  }
  const avgdl = totalLen / N;

  // df: em quantos documentos cada termo aparece (set por doc)
  const df = new Map();
  for (let i = 0; i < N; i++) {
    const seen = new Set(corpus[i]);
    for (const term of seen) {
      df.set(term, (df.get(term) || 0) + 1);
    }
  }

  // idf Okapi clássico com +1 (nunca negativa, mesmo p/ termo em quase todos docs).
  const idf = new Map();
  for (const [term, freq] of df.entries()) {
    idf.set(term, Math.log(1 + (N - freq + 0.5) / (freq + 0.5)));
  }

  // querySet: dedup tokens da query (BM25 não pondera repetição da query)
  const querySet = new Set(queryTokens);
  const scores = new Array(N).fill(0);

  for (let i = 0; i < N; i++) {
    const doc = corpus[i];
    const docLen = docLens[i];
    if (doc.length === 0) continue;
    // tf do documento (Counter)
    const tf = new Map();
    for (const term of doc) {
      tf.set(term, (tf.get(term) || 0) + 1);
    }
    let score = 0;
    for (const term of querySet) {
      const freq = tf.get(term) || 0;
      if (freq === 0) continue;
      const denom = avgdl > 0
        ? (freq + k1 * (1 - b + (b * docLen) / avgdl))
        : freq;
      score += (idf.get(term) || 0) * (freq * (k1 + 1)) / denom;
    }
    scores[i] = score;
  }
  return scores;
}

/**
 * rankNotes — BM25 sobre lista de notas `{path, text}`. Devolve top-N ranking
 * por score decrescente, descartando score 0 (nenhum termo da query casou).
 *
 * @param {Array<{path: string, text: string}>} notes
 * @param {string} query
 * @param {number} [topN=30]
 * @param {object} [opts] — {k1, b}
 * @returns {Array<{path: string, score: number, tokens: string[]}>}
 */
function rankNotes(notes, query, topN = 30, opts = {}) {
  if (!Array.isArray(notes) || notes.length === 0) return [];
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];

  const k1 = opts.k1 != null ? opts.k1 : K1_DEFAULT;
  const b = opts.b != null ? opts.b : B_DEFAULT;

  // Tokeniza corpus uma vez — caller é responsável por passar notes com .text válido.
  const corpus = new Array(notes.length);
  const docTokens = new Array(notes.length);
  for (let i = 0; i < notes.length; i++) {
    const tokens = tokenize(notes[i].text || '');
    corpus[i] = tokens;
    docTokens[i] = tokens;
  }

  const scores = bm25Scores(corpus, queryTokens, k1, b);
  const ranked = [];
  for (let i = 0; i < notes.length; i++) {
    if (scores[i] <= 0) continue;
    ranked.push({ path: notes[i].path, score: scores[i], tokens: docTokens[i] });
  }
  ranked.sort((a, b2) => b2.score - a.score);
  return ranked.slice(0, topN);
}

module.exports = {
  tokenize,
  bm25Scores,
  rankNotes,
  K1_DEFAULT,
  B_DEFAULT,
};

// CLI demo — `node lib/bm25.js "query terms"`
// Smoke test do tokenize + bm25Scores com corpus sintético. Útil pra debug
// rápido sem ter que rodar o plugin inteiro.
if (require.main === module) {
  const query = process.argv.slice(2).join(' ') || 'habeas corpus';
  console.log(`[bm25 demo] query=${JSON.stringify(query)}`);
  const notes = [
    { path: 'doc-a.md', text: 'O habeas corpus é remédio constitucional contra prisão ilegal. Garantia fundamental do art. 5º.' },
    { path: 'doc-b.md', text: 'Mandado de segurança protege direito líquido e certo. Distinto do habeas corpus.' },
    { path: 'doc-c.md', text: 'Contratos administrativos seguem regime de direito público — Lei 14.133/2021.' },
    { path: 'doc-d.md', text: 'habeas habeas habeas — repetição satura via k1=1.5.' },
  ];
  const ranked = rankNotes(notes, query, 10);
  console.log(JSON.stringify(ranked.map(r => ({ path: r.path, score: +r.score.toFixed(4) })), null, 2));
  console.log(`[bm25 demo] tokenize("Habeas Corpus, Lei 14.133"):`, tokenize('Habeas Corpus, Lei 14.133'));
}
