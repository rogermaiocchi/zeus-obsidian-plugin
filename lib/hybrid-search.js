/*
 * hybrid-search.js — fusão RRF (Reciprocal Rank Fusion, Cormack et al. SIGIR 2009)
 * de 4 retrievers ortogonais:
 *
 *   semantic — cosine NLContextualEmbedding (this.plugin.searcher.search / neighbors)
 *   path     — prefix/substring no filename (estilo Obsidian Cmd+O)
 *   graph    — frontmatter `zeus_graph_related` / `zeus_related` (wikilinks injetados
 *              por ZeusNativeGraphIntegration a partir de afm graph-extract + cosine)
 *   passport — passport.findByQuery (concept overlap + cosine sobre passports.jsonl
 *              via daemon Apple-native)
 *
 * RRF formula: score(d) = Σᵢ 1/(k + rank_i(d)), k=60 (default Cormack).
 * Vantagem vs weighted-sum: invariante a escala de cada retriever, robusto a
 * outliers, sem necessidade de calibrar pesos.
 *
 * Uso típico:
 *   const hits = await plugin.hybrid.sisterNotes(currentFilePath, 12);
 *   // hits: [{path, score, sources:['semantic','graph']}, ...]
 *
 *   const queryHits = await plugin.hybrid.query('contratos administrativos', 30);
 */

'use strict';

const RRF_K = 60;

class HybridSearch {
  constructor(plugin) {
    this.plugin = plugin;
  }

  // ---------------------------------------------------------------------------
  // RRF fuse — recebe array de listas ranqueadas, cada item {path, source}
  // (score por item ignorado — só posição). Devolve lista única ordenada por
  // RRF score com `sources` agregadas.
  // ---------------------------------------------------------------------------
  fuse(lists) {
    const fused = new Map();
    for (const list of lists) {
      if (!Array.isArray(list)) continue;
      list.forEach((item, idx) => {
        if (!item || !item.path) return;
        const inc = 1 / (RRF_K + idx + 1);
        const cur = fused.get(item.path) || { path: item.path, score: 0, sources: new Set() };
        cur.score += inc;
        if (item.source) cur.sources.add(item.source);
        fused.set(item.path, cur);
      });
    }
    const out = [];
    for (const v of fused.values()) {
      out.push({ path: v.path, score: v.score, sources: Array.from(v.sources) });
    }
    out.sort((a, b) => b.score - a.score);
    return out;
  }

  // ---------------------------------------------------------------------------
  // sisterNotes — combina semantic + graph (frontmatter) + passport para uma
  // nota dada. Diferente de `searcher.neighbors` puro porque inclui o sinal
  // explícito do afm graph-extract (entidades nomeadas) e do passport (conceitos
  // Apple NLTagger + Feynman summary). Retorna top-N RRF.
  // ---------------------------------------------------------------------------
  async sisterNotes(filePath, topN = 12) {
    const lists = [];

    // 1) Semantic neighbors (cosine NLContextualEmbedding)
    try {
      const sem = this.plugin.searcher.neighbors(filePath, topN * 2);
      lists.push(sem.map(x => ({ path: x.path, source: 'semantic' })));
    } catch (e) { console.warn('[zeus.hybrid] semantic neighbors failed', e.message); }

    // 2) Graph neighbors a partir do frontmatter (escrito por nativeGraph.syncFile/
    //    syncFromGraphExtract). Resolve wikilinks via metadataCache para suportar
    //    pastas, aliases e link relativos (codex MED — substitui regex .md naïve).
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
            // Usa API canônica do Obsidian — respeita pastas, aliases, relative paths
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

    return this.fuse(lists).slice(0, topN);
  }

  // ---------------------------------------------------------------------------
  // query — busca livre estilo Cmd+P. Funde semantic + path (basename match) +
  // passport. Bom para "busca híbrida" que pega tanto "encontrei pelo nome"
  // quanto "encontrei pelo conceito".
  // ---------------------------------------------------------------------------
  async query(q, topN = 30) {
    if (!q || !q.trim()) return [];
    const lists = [];

    // 1) Semantic — searcher.search é async (embedQuery via daemon HTTP).
    //    Codex HIGH #1: faltava await → .map() em Promise falhava silencioso.
    try {
      const sem = await this.plugin.searcher.search(q, topN * 2);
      lists.push((sem || []).map(x => ({ path: x.path, source: 'semantic' })));
    } catch (e) { console.warn('[zeus.hybrid] semantic search failed', e.message); }

    // 2) Path/basename substring (case-insensitive, sem normalize porque
    //    o Obsidian Quick Switcher também não normaliza acento)
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

    // 4) v1.7 — Spotlight (CSSearchQuery via daemon, ou mdfind fallback).
    //    Filtra resultados para ficar dentro do vault e converte path absoluto
    //    em vault-relative. mode propaga via `_lastSpotlightMode`.
    //    codex MED C: conversão robusta — usa path.relative + realpath quando
    //    disponível, valida que resultado não escapa do vault (../) nem é
    //    absoluto (path fora do vault).
    try {
      if (this.plugin.httpClient && this.plugin.vaultRoot) {
        const r = await this.plugin.httpClient.spotlightQueryNative(
          q, this.plugin.vaultRoot, topN * 2,
        );
        this._lastSpotlightMode = r.mode;
        let nodePath = null; let nodeFs = null;
        try { nodePath = require('path'); } catch {}
        try { nodeFs = require('fs'); } catch {}
        // Resolve vaultRoot canônico (resolve symlinks); fallback pra valor cru.
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
            // iOS Capacitor sem fs/path — fallback simples startsWith
            const root = canonicalRoot.endsWith('/') ? canonicalRoot : canonicalRoot + '/';
            rel = raw.startsWith(root) ? raw.slice(root.length) : raw;
          }
          // Valida: dentro do vault, não absoluto, não escapou via ../
          if (!rel || rel.startsWith('..') || (nodePath && nodePath.isAbsolute && nodePath.isAbsolute(rel))) continue;
          if (!rel.endsWith('.md')) continue;
          list.push({ path: rel, source: 'spotlight' });
          if (list.length >= topN * 2) break;
        }
        if (list.length > 0) lists.push(list);
      }
    } catch (e) { console.warn('[zeus.hybrid] spotlight retrieval failed', e.message); }

    return this.fuse(lists).slice(0, topN);
  }
}

module.exports = HybridSearch;
