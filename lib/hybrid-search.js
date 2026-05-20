/*
 * hybrid-search.js — fusão RRF (Reciprocal Rank Fusion, Cormack et al. SIGIR 2009)
 * de 7 retrievers ortogonais (v1.13 update — codex LOW #12 fix):
 *
 *   semantic — cosine NLContextualEmbedding (this.plugin.searcher.search / neighbors)
 *   path     — prefix/substring no filename (estilo Obsidian Cmd+O)
 *   graph    — frontmatter `zeus_graph_related` / `zeus_related` (wikilinks injetados
 *              por ZeusNativeGraphIntegration a partir de afm graph-extract + cosine)
 *   passport — passport.findByQuery (concept overlap + cosine sobre passports.jsonl
 *              via daemon Apple-native)
 *   spotlight — CSSearchQuery via daemon (macOS) — sinal "Spotlight nativo" do OS.
 *   bm25     — Okapi BM25 puro JS (v1.8) sobre body+title das notas com embedding.
 *              Acha o que *contém* o termo exato — sigla, nome próprio, id processual.
 *              Complementa a perna semântica (que acha o que *parece* parecido).
 *
 * RRF formula: score(d) = Σᵢ 1/(k + rank_i(d)), k=60 (default Cormack).
 * Vantagem vs weighted-sum: invariante a escala de cada retriever, robusto a
 * outliers, sem necessidade de calibrar pesos.
 *
 * v1.8 — adições:
 *   - 5º retriever (bm25) integrado, opcional via opts.disableBm25.
 *   - sourceMask interno (bitmask): bit 0=semantic, 1=path, 2=graph, 3=passport,
 *     4=spotlight, 5=bm25. Consumer continua recebendo `sources: string[]`.
 *   - diversify(items, lambda, topN): MMR sobre `sources` jaccard, proxy barato
 *     pra diversidade (real seria sobre embeddings cosine, mas custo > benefício
 *     em hot path de busca).
 *
 * Uso típico:
 *   const hits = await plugin.hybrid.sisterNotes(currentFilePath, 12);
 *   // hits: [{path, score, sources:['semantic','graph']}, ...]
 *
 *   const queryHits = await plugin.hybrid.query('contratos administrativos', 30,
 *     { diversify: true, diversityLambda: 0.5 });
 */

'use strict';

const RRF_K = 60;

// Bitmask para sources internas (5 retrievers). Permite operações de set
// O(1) em vez de Set<string> e tornam jaccard cheap em diversify().
const SOURCE_BITS = {
  semantic: 1 << 0,
  path: 1 << 1,
  graph: 1 << 2,
  passport: 1 << 3,
  spotlight: 1 << 4,
  bm25: 1 << 5,
  // v1.11 Feature I — lexical-ios é BM25 persistido (TF-IDF + stems pt-BR).
  // Mantém bit próprio (distinto de bm25 in-memory) para auditoria do sourceMask
  // sem confundir os dois retrievers durante MMR diversify.
  lexicalIos: 1 << 6,
};
const SOURCE_NAMES = Object.keys(SOURCE_BITS);

function _maskToNames(mask) {
  const out = [];
  for (const name of SOURCE_NAMES) {
    if ((mask & SOURCE_BITS[name]) !== 0) out.push(name);
  }
  return out;
}

// Hamming-popcount over 32-bit mask — usado em jaccard.
function _popcount(n) {
  n = n - ((n >> 1) & 0x55555555);
  n = (n & 0x33333333) + ((n >> 2) & 0x33333333);
  n = (n + (n >> 4)) & 0x0f0f0f0f;
  return (n * 0x01010101) >>> 24;
}

let _bm25;
try {
  _bm25 = require('./bm25');
} catch (e) {
  console.warn('[zeus.hybrid] bm25 lib não carregou — 5º retriever desativado:', e.message);
  _bm25 = null;
}

class HybridSearch {
  constructor(plugin) {
    this.plugin = plugin;
  }

  // ---------------------------------------------------------------------------
  // RRF fuse — recebe array de listas ranqueadas, cada item {path, source}
  // (score por item ignorado — só posição). Devolve lista única ordenada por
  // RRF score com `sources` agregadas. Internamente usa bitmask, expõe string[].
  // ---------------------------------------------------------------------------
  fuse(lists) {
    const fused = new Map();
    for (const list of lists) {
      if (!Array.isArray(list)) continue;
      list.forEach((item, idx) => {
        if (!item || !item.path) return;
        const inc = 1 / (RRF_K + idx + 1);
        const cur = fused.get(item.path) || { path: item.path, score: 0, sourceMask: 0 };
        cur.score += inc;
        if (item.source && SOURCE_BITS[item.source]) {
          cur.sourceMask |= SOURCE_BITS[item.source];
        }
        fused.set(item.path, cur);
      });
    }
    const out = [];
    for (const v of fused.values()) {
      out.push({
        path: v.path,
        score: v.score,
        sources: _maskToNames(v.sourceMask),
        // sourceMask exposto pra MMR/diversify; consumer não-MMR ignora.
        sourceMask: v.sourceMask,
      });
    }
    out.sort((a, b) => b.score - a.score);
    return out;
  }

  // ---------------------------------------------------------------------------
  // diversify(items, lambda, topN) — Maximal Marginal Relevance (Carbonell &
  // Goldstein 1998) sobre `sources` jaccard como proxy de diversidade.
  //
  //   MMR: argmax [ λ · score(d) - (1-λ) · max_{s ∈ selected} sim(d, s) ]
  //
  // sim aqui = jaccard(sourceMask) = |A ∩ B| / |A ∪ B|. Itens com fontes
  // idênticas (ex: dois resultados puramente semânticos) penalizam um ao outro;
  // mistura semantic+bm25+path se favorece sobre 3 semantic puros.
  //
  // lambda 0..1: 1 = só relevância (sem MMR), 0 = só diversidade (ignora score).
  // Default 0.5 = balanceado.
  // ---------------------------------------------------------------------------
  diversify(items, lambda = 0.5, topN = null) {
    if (!Array.isArray(items) || items.length === 0) return [];
    const clampLambda = Math.max(0, Math.min(1, lambda));
    const limit = topN ? Math.min(topN, items.length) : items.length;
    // Normaliza scores para [0,1] dentro do batch — MMR vs jaccard só faz
    // sentido se as escalas são comparáveis. Se todos os scores são iguais,
    // mantemos relevância flat e a diversidade vira o único critério.
    const maxScore = items.reduce((m, it) => Math.max(m, it.score || 0), 0);
    const normScore = (s) => (maxScore > 0 ? (s || 0) / maxScore : 0);

    const candidates = items.slice();
    const selected = [];
    while (selected.length < limit && candidates.length > 0) {
      let bestIdx = -1;
      let bestVal = -Infinity;
      for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i];
        let maxSim = 0;
        const cMask = c.sourceMask || 0;
        for (const s of selected) {
          const sMask = s.sourceMask || 0;
          const inter = _popcount(cMask & sMask);
          const union = _popcount(cMask | sMask);
          const sim = union > 0 ? inter / union : 0;
          if (sim > maxSim) maxSim = sim;
        }
        const val = clampLambda * normScore(c.score) - (1 - clampLambda) * maxSim;
        if (val > bestVal) {
          bestVal = val;
          bestIdx = i;
        }
      }
      if (bestIdx < 0) break;
      selected.push(candidates[bestIdx]);
      candidates.splice(bestIdx, 1);
    }
    return selected;
  }

  // ---------------------------------------------------------------------------
  // _bm25Retriever — roda BM25 sobre as notas com embedding carregado (lazy
  // corpus para limitar a memória; vault grande não precisa carregar TUDO).
  //
  // Estratégia:
  //   - corpus = todas as notas em this.plugin.searcher.embeddings (já carregadas).
  //   - text = title + body (lido via searcher.readDoc quando disponível;
  //            fallback título quando readDoc indisponível ou vazio — iOS).
  //   - cap em maxCorpus pra evitar leitura de >2k arquivos por query.
  // ---------------------------------------------------------------------------
  _bm25Retriever(query, topN, maxCorpus = 2000) {
    if (!_bm25 || !_bm25.rankNotes) return [];
    try {
      const searcher = this.plugin.searcher;
      if (!searcher || !searcher.embeddings) return [];
      const embs = searcher.embeddings;
      // codex MED #5: BM25 só sobre .md. searcher.embeddings inclui pdf/png/heic
      // (indexador multimodal); rankear binários por BM25 é ruído sintático sem
      // valor lexical real (título de PDF não responde a "habeas corpus").
      const notes = [];
      let count = 0;
      const canReadDoc = typeof searcher.readDoc === 'function';
      for (const [p, e] of embs.entries()) {
        if (count >= maxCorpus) break;
        if (!p || !p.endsWith('.md')) continue;
        let text = '';
        const title = e && e.title ? e.title : p.split('/').pop().replace(/\.md$/, '');
        if (canReadDoc) {
          try {
            // readDoc é sync no Mac e devolve '' no iOS — fallback automático.
            const body = searcher.readDoc(p);
            if (body) text = title + '\n' + body.slice(0, 30000);
            else text = title;
          } catch {
            text = title;
          }
        } else {
          text = title;
        }
        notes.push({ path: p, text });
        count++;
      }
      const ranked = _bm25.rankNotes(notes, query, topN);
      return ranked.map(r => ({ path: r.path, source: 'bm25' }));
    } catch (e) {
      console.warn('[zeus.hybrid] bm25 retriever failed:', e.message);
      return [];
    }
  }

  // ---------------------------------------------------------------------------
  // sisterNotes — combina semantic + graph (frontmatter) + passport + multiplex
  // (opcional) para uma nota dada. Diferente de `searcher.neighbors` puro porque
  // inclui o sinal explícito do afm graph-extract (entidades nomeadas) e do
  // passport (conceitos Apple NLTagger + Feynman summary). Retorna top-N RRF.
  //
  // v1.8: aceita opts.diversify (default false) — quando true aplica MMR sobre
  // jaccard de sources com lambda=0.5 (override via opts.diversityLambda).
  // ---------------------------------------------------------------------------
  async sisterNotes(filePath, topN = 12, opts = {}) {
    const lists = [];

    // 1) Semantic neighbors (cosine NLContextualEmbedding)
    try {
      const sem = this.plugin.searcher.neighbors(filePath, topN * 2);
      lists.push(sem.map(x => ({ path: x.path, source: 'semantic' })));
    } catch (e) { console.warn('[zeus.hybrid] semantic neighbors failed', e.message); }

    // 2) Graph neighbors a partir do frontmatter (escrito por nativeGraph.syncFile/
    //    syncFromGraphExtract). Resolve wikilinks via metadataCache para suportar
    //    pastas, aliases e link relativos.
    try {
      const file = this.plugin.app.vault.getAbstractFileByPath(filePath);
      const mdc = this.plugin.app.metadataCache;
      const cache = file ? mdc.getFileCache(file) : null;
      const fm = cache && cache.frontmatter ? cache.frontmatter : null;
      const collected = new Set();
      if (fm) {
        for (const key of ['zeus_graph_related', 'zeus_related']) {
          const arr = fm[key];
          if (!Array.isArray(arr)) continue;
          for (const raw of arr) {
            const link = String(raw)
              .replace(/^\[\[/, '')
              .replace(/\]\]$/, '')
              .split('|')[0]
              .split('#')[0]
              .trim();
            if (!link) continue;
            const dest = mdc.getFirstLinkpathDest
              ? mdc.getFirstLinkpathDest(link, filePath)
              : null;
            if (dest && dest.path && dest.path !== filePath) {
              collected.add(dest.path);
            }
          }
        }
      }
      if (collected.size > 0) {
        const validated = [...collected].filter(p => this.plugin.searcher.embeddings.has(p));
        lists.push(validated.map(p => ({ path: p, source: 'graph' })));
      }
    } catch (e) { console.warn('[zeus.hybrid] graph frontmatter parse failed', e.message); }

    // 3) Passport find via daemon — usa título/basename como query para concept-
    //    overlap. Não inclui o próprio arquivo.
    try {
      if (this.plugin.passport && typeof this.plugin.passport.findByQuery === 'function') {
        const basename = filePath.split('/').pop().replace(/\.md$/, '');
        const hits = await this.plugin.passport.findByQuery(basename, { topN: topN * 2 });
        const list = (hits || [])
          .map(h => (h && (h.path || h.file)) || null)
          .filter(p => p && p !== filePath)
          .map(p => ({ path: p, source: 'passport' }));
        lists.push(list);
      }
    } catch (e) { console.warn('[zeus.hybrid] passport find failed', e.message); }

    // 4) v1.8 — Multiplex (opcional): edges out da nota corrente, agrupadas por
    //    destino somando weight. codex MED #3: tenta carregar lazy do disco quando
    //    `mg.edges.size === 0` mas `data/multiplex.jsonl` existe. Sem isso, após
    //    restart do Obsidian o sinal multiplex fica inerte até auto-build ou
    //    comando manual.
    try {
      const mg = this.plugin.multiplex;
      if (mg && typeof mg.load === 'function' && (!mg.edges || mg.edges.size === 0)
          && !this.plugin._multiplexLoaded && !this.plugin._multiplexLoadAttempted) {
        this.plugin._multiplexLoadAttempted = true;
        try {
          const r = await mg.load();
          if (r && r.read > 0) this.plugin._multiplexLoaded = true;
        } catch (e) { /* sem multiplex.jsonl no disco — ignora */ }
      }
      if (mg && mg.edges && mg.edges.size > 0) {
        const byDst = mg.neighborsByDst(filePath);
        if (byDst.length > 0) {
          lists.push(byDst.slice(0, topN * 2).map(x => ({ path: x.dst, source: 'graph' })));
        }
      }
    } catch (e) { console.warn('[zeus.hybrid] multiplex neighbors failed', e.message); }

    let fused = this.fuse(lists).slice(0, topN * 2);
    if (opts.diversify) {
      fused = this.diversify(fused, opts.diversityLambda != null ? opts.diversityLambda : 0.5, topN);
    } else {
      fused = fused.slice(0, topN);
    }
    return fused;
  }

  // ---------------------------------------------------------------------------
  // query — busca livre estilo Cmd+P. Funde semantic + path + passport +
  // spotlight + bm25. v1.8 ganha 5º retriever (bm25) + opcional MMR diversify.
  // ---------------------------------------------------------------------------
  async query(q, topN = 30, opts = {}) {
    if (!q || !q.trim()) return [];
    const lists = [];

    // 1) Semantic — searcher.search é async (embedQuery via daemon HTTP).
    try {
      const sem = await this.plugin.searcher.search(q, topN * 2);
      lists.push((sem || []).map(x => ({ path: x.path, source: 'semantic' })));
    } catch (e) { console.warn('[zeus.hybrid] semantic search failed', e.message); }

    // 2) Path/basename substring (case-insensitive)
    try {
      const qn = q.toLowerCase().trim();
      const all = this.plugin.app.vault.getMarkdownFiles ? this.plugin.app.vault.getMarkdownFiles() : [];
      const matched = [];
      for (const f of all) {
        const base = (f.basename || '').toLowerCase();
        const full = (f.path || '').toLowerCase();
        if (base.includes(qn) || full.includes(qn)) {
          matched.push({ path: f.path, source: 'path' });
          if (matched.length >= topN * 2) break;
        }
      }
      lists.push(matched);
    } catch (e) { console.warn('[zeus.hybrid] path match failed', e.message); }

    // 3) Passport
    try {
      if (this.plugin.passport && typeof this.plugin.passport.findByQuery === 'function') {
        const hits = await this.plugin.passport.findByQuery(q, { topN: topN * 2 });
        const list = (hits || [])
          .map(h => (h && (h.path || h.file)) || null)
          .filter(Boolean)
          .map(p => ({ path: p, source: 'passport' }));
        lists.push(list);
      }
    } catch (e) { console.warn('[zeus.hybrid] passport find failed', e.message); }

    // 4) Spotlight (CSSearchQuery via daemon, ou mdfind fallback).
    try {
      if (this.plugin.httpClient && this.plugin.vaultRoot) {
        const r = await this.plugin.httpClient.spotlightQueryNative(
          q, this.plugin.vaultRoot, topN * 2,
        );
        this._lastSpotlightMode = r.mode;
        let nodePath = null; let nodeFs = null;
        try { nodePath = require('path'); } catch {}
        try { nodeFs = require('fs'); } catch {}
        let canonicalRoot = this.plugin.vaultRoot;
        try {
          if (nodeFs && nodeFs.realpathSync && nodeFs.realpathSync.native) {
            canonicalRoot = nodeFs.realpathSync.native(this.plugin.vaultRoot);
          }
        } catch {}
        const list = [];
        for (const raw of (r.results || [])) {
          if (typeof raw !== 'string' || !raw) continue;
          let rel;
          if (nodePath && nodePath.relative) {
            try {
              let canonAbs = raw;
              try {
                if (nodeFs && nodeFs.realpathSync && nodeFs.realpathSync.native) {
                  canonAbs = nodeFs.realpathSync.native(raw);
                }
              } catch {}
              rel = nodePath.relative(canonicalRoot, canonAbs);
            } catch { continue; }
          } else {
            const root = canonicalRoot.endsWith('/') ? canonicalRoot : canonicalRoot + '/';
            rel = raw.startsWith(root) ? raw.slice(root.length) : raw;
          }
          if (!rel || rel.startsWith('..') || (nodePath && nodePath.isAbsolute && nodePath.isAbsolute(rel))) continue;
          if (!rel.endsWith('.md')) continue;
          list.push({ path: rel, source: 'spotlight' });
          if (list.length >= topN * 2) break;
        }
        if (list.length > 0) lists.push(list);
      }
    } catch (e) { console.warn('[zeus.hybrid] spotlight retrieval failed', e.message); }

    // 5) v1.8 — BM25 puro JS sobre body+title das notas embedidas. Acha termo
    //    exato (sigla, processo, id) que a perna semântica perde.
    //    codex LOW #9: respeita setting hybridBm25Enabled (compat v1.7.1) +
    //    flag opts.disableBm25 (override per-call).
    const bm25SettingEnabled = this.plugin.settings
      ? this.plugin.settings.hybridBm25Enabled !== false
      : true;
    if (!opts.disableBm25 && bm25SettingEnabled) {
      try {
        const bm25Hits = this._bm25Retriever(q, topN * 2);
        if (bm25Hits.length > 0) lists.push(bm25Hits);
      } catch (e) { console.warn('[zeus.hybrid] bm25 retrieval failed', e.message); }
    }

    // 6) v1.11 Feature I — Lexical-ios (BM25 persistido com stems pt-BR).
    //    Complementa bm25 in-memory acima quando:
    //    - vault grande (>2k notas) — in-memory cap em maxCorpus=2000 perde notas
    //    - iOS sem daemon — semantic pode estar inacessível, lexicalIos cobre
    //    - paráfrase morfológica PT-BR — stem pega "estudante/estudo/estudar"
    try {
      if (this.plugin.lexicalIos && typeof this.plugin.lexicalIos.search === 'function') {
        const lexHits = await this.plugin.lexicalIos.search(q, topN * 2);
        if (lexHits && lexHits.length > 0) {
          lists.push(lexHits.map(h => ({ path: h.path, source: 'lexicalIos' })));
        }
      }
    } catch (e) { console.warn('[zeus.hybrid] lexical-ios retrieval failed', e.message); }

    let fused = this.fuse(lists);
    if (opts.diversify) {
      fused = this.diversify(fused, opts.diversityLambda != null ? opts.diversityLambda : 0.5, topN);
    } else {
      fused = fused.slice(0, topN);
    }
    return fused;
  }
}

module.exports = HybridSearch;
module.exports.SOURCE_BITS = SOURCE_BITS;
