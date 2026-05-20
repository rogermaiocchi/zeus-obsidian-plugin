/*
 * multiplex-graph.js — grafo multiplex de 8 edge types entre notas do vault.
 *
 * Cada tipo de aresta é uma evidência diferente de relação entre notas.
 * "Multiplex" porque o mesmo par (A,B) pode ter VÁRIAS arestas — uma por
 * canal — em vez de fundir tudo em um único score opaco. A explicação `why`
 * em cada aresta torna o grafo auditável (XAI-friendly).
 *
 * Edge types:
 *   1. wikilink         — A → B com [[B]] explícito em A. metadataCache.resolvedLinks.
 *   2. backlink         — inverso de wikilink (recíproca).
 *   3. entity_overlap   — passports.jsonl: concepts(A) ∩ concepts(B) ≥ minOverlap (default 2).
 *   4. date_overlap     — mesma data de modificação (file.mtime no mesmo dia).
 *   5. folder_path      — mesmo diretório (sem incluir raiz "").
 *   6. semantic_cosine  — cosine(emb(A), emb(B)) > minCosine (default 0.5).
 *   7. spotlight_token_bm25 — placeholder: BM25 sobre tokens spotlight do daemon.
 *                              Skipado quando daemon down ou Spotlight indisponível.
 *   8. co_citation      — A e B ambas linkadas pela mesma terceira nota C.
 *                          Limitado a top-1000 notas com mais backlinks para evitar O(N²).
 *
 * Persistência: data/multiplex.jsonl (1 edge per line, JSONL).
 *   {"src":"a.md","dst":"b.md","type":"wikilink","weight":1.0,"why":["[[b]] em a"]}
 *
 * API:
 *   const g = new MultiplexGraph(plugin);
 *   await g.buildFromVault((msg, pct) => console.log(msg, pct));
 *   await g.persist();        // grava data/multiplex.jsonl
 *   await g.load();            // lê data/multiplex.jsonl pro grafo em memória
 *   g.neighbors('a.md');       // edges out de a.md
 *   g.neighbors('a.md', ['semantic_cosine']);  // só semantic_cosine
 *   g.stats();                 // {total, byType: {wikilink: 142, ...}}
 *
 * Performance:
 *   - O(N) para wikilink/backlink (metadataCache já tem o mapa).
 *   - O(N²) para entity_overlap, semantic_cosine — bounded pelo tamanho do vault.
 *     Em vault grande (>5k notes), considere passar limit no buildFromVault.
 *   - co_citation O(N²) sobre wikilinks — caped via top-1000 notas-com-mais-backlinks.
 *
 * Não-objetivos v1.8:
 *   - Comunidades (Leiden) — deferido v1.9 (precisa schema multiplex congelado).
 *   - Edge weight aprendido por usuário — fixo por tipo (TODO v2.0 com ELO).
 */

'use strict';

const universal = require('./universal-fs');

const DATA_DIR_NAME = 'data';
const MULTIPLEX_FILE = 'multiplex.jsonl';

const EDGE_TYPES = [
  'wikilink',
  'backlink',
  'entity_overlap',
  'date_overlap',
  'folder_path',
  'semantic_cosine',
  'spotlight_token_bm25',
  'co_citation',
];

// Pesos default por tipo — calibrados intuitivamente. wikilink/backlink são
// sinais mais fortes (autor explicitou); semantic_cosine é forte mas opaco;
// date_overlap é fraco (proxy temporal apenas).
const DEFAULT_WEIGHTS = {
  wikilink: 1.0,
  backlink: 1.0,
  entity_overlap: 0.7,
  date_overlap: 0.2,
  folder_path: 0.3,
  semantic_cosine: 0.8,
  spotlight_token_bm25: 0.6,
  co_citation: 0.5,
};

function _cosine(a, b) {
  if (!a || !b) return 0;
  let dot = 0, na = 0, nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function _dayBucket(mtime) {
  if (!mtime || typeof mtime !== 'number') return null;
  const d = new Date(mtime);
  // YYYY-MM-DD em UTC — granularidade dia, suficiente para "co-edição na mesma sessão"
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function _folderOf(filePath) {
  if (!filePath) return '';
  const idx = filePath.lastIndexOf('/');
  return idx < 0 ? '' : filePath.slice(0, idx);
}

function _edgeKey(src, dst, type) {
  return `${src}|${dst}|${type}`;
}

class MultiplexGraph {
  constructor(plugin) {
    this.plugin = plugin;
    // edges: Map<key="src|dst|type", edge>
    this.edges = new Map();
    this._builtAt = null;
  }

  get _adapter() {
    return this.plugin.app.vault.adapter;
  }

  get dataPath() {
    return universal.joinPath(this.plugin.manifest.dir, DATA_DIR_NAME);
  }

  get jsonlPath() {
    return universal.joinPath(this.dataPath, MULTIPLEX_FILE);
  }

  // ---------------------------------------------------------------------------
  // Edge primitives
  // ---------------------------------------------------------------------------
  addEdge(src, dst, type, why, weight) {
    if (!src || !dst || src === dst) return;
    if (!EDGE_TYPES.includes(type)) return;
    const w = weight != null ? weight : DEFAULT_WEIGHTS[type];
    const key = _edgeKey(src, dst, type);
    const existing = this.edges.get(key);
    if (existing) {
      // Dedup: agrega `why` se houver evidência adicional, mantém weight maior.
      if (why) {
        if (!Array.isArray(existing.why)) existing.why = [];
        for (const w2 of (Array.isArray(why) ? why : [why])) {
          if (!existing.why.includes(w2)) existing.why.push(w2);
        }
      }
      if (w > existing.weight) existing.weight = w;
      return;
    }
    this.edges.set(key, {
      src,
      dst,
      type,
      weight: w,
      why: Array.isArray(why) ? why.slice() : (why ? [why] : []),
    });
  }

  // ---------------------------------------------------------------------------
  // Build — coleta todas as 8 evidências do vault
  //
  // codex MED #4: mutex contra builds concorrentes. Auto-build setting + comando
  // manual podem disparar simultaneamente. Sem lock, this.edges fica corrompido
  // (clear() no meio + addEdge() concorrente). _buildPromise serializa.
  // ---------------------------------------------------------------------------
  async buildFromVault(onProgress = () => {}) {
    if (this._buildPromise) return this._buildPromise;
    this._buildPromise = (async () => {
      try { return await this._doBuildFromVault(onProgress); }
      finally { this._buildPromise = null; }
    })();
    return this._buildPromise;
  }

  async _doBuildFromVault(onProgress = () => {}) {
    const t0 = Date.now();
    this.edges.clear();
    // codex LOW #8: yield para não travar UI mesmo em vault grande. setImmediate
    // (Node) ou setTimeout 0 (todos os runtimes) entrega 1 frame de UI antes
    // do próximo bloco de O(N²) começar.
    const _yield = () => new Promise((r) => setTimeout(r, 0));
    const app = this.plugin.app;
    const mdc = app.metadataCache;
    const files = (app.vault.getMarkdownFiles ? app.vault.getMarkdownFiles() : []) || [];
    const allPaths = new Set(files.map(f => f.path));

    onProgress('build: edges wikilink + backlink (resolvedLinks)', 5);
    // 1+2) wikilink + backlink — metadataCache.resolvedLinks é {src: {dst: count}}
    // codex MED #1: filtra src também (metadata cache pode ter notas apagadas
    // ou pré-rename pendurando)
    const resolved = (mdc && mdc.resolvedLinks) || {};
    const backlinkCount = new Map(); // path → count (para co_citation cap)
    for (const src of Object.keys(resolved)) {
      if (!allPaths.has(src)) continue;
      const inner = resolved[src] || {};
      for (const dst of Object.keys(inner)) {
        if (!allPaths.has(dst)) continue;
        const count = inner[dst] || 1;
        this.addEdge(src, dst, 'wikilink', `${count}× [[${dst.replace(/\.md$/, '').split('/').pop()}]] em ${src.split('/').pop()}`);
        this.addEdge(dst, src, 'backlink', `${src.split('/').pop()} → ${dst.split('/').pop()}`);
        backlinkCount.set(dst, (backlinkCount.get(dst) || 0) + 1);
      }
    }

    await _yield();
    onProgress('build: folder_path + date_overlap', 25);
    // 4+5) folder_path + date_overlap — agrupa por bucket e cria edges intra-grupo.
    // Para evitar O(N²), agrupamos primeiro e só ligamos dentro do mesmo bucket.
    const byFolder = new Map(); // folder → string[] paths
    const byDay = new Map();    // dayBucket → string[] paths
    for (const f of files) {
      const fp = _folderOf(f.path);
      if (fp) {
        if (!byFolder.has(fp)) byFolder.set(fp, []);
        byFolder.get(fp).push(f.path);
      }
      const day = _dayBucket(f.stat && f.stat.mtime);
      if (day) {
        if (!byDay.has(day)) byDay.set(day, []);
        byDay.get(day).push(f.path);
      }
    }
    // Liga edges dentro de cada folder (bidirecional). Para folder com >50 notes,
    // não criamos clique completo (explosão N²); cortamos em 50.
    for (const [folder, paths] of byFolder.entries()) {
      const slice = paths.length > 50 ? paths.slice(0, 50) : paths;
      for (let i = 0; i < slice.length; i++) {
        for (let j = i + 1; j < slice.length; j++) {
          this.addEdge(slice[i], slice[j], 'folder_path', `pasta ${folder}`);
          this.addEdge(slice[j], slice[i], 'folder_path', `pasta ${folder}`);
        }
      }
    }
    for (const [day, paths] of byDay.entries()) {
      // Para day, só ligamos se ≤30 notas no mesmo dia (rajada de edição comum).
      if (paths.length > 30 || paths.length < 2) continue;
      for (let i = 0; i < paths.length; i++) {
        for (let j = i + 1; j < paths.length; j++) {
          this.addEdge(paths[i], paths[j], 'date_overlap', `editadas ${day}`);
          this.addEdge(paths[j], paths[i], 'date_overlap', `editadas ${day}`);
        }
      }
    }

    await _yield();
    onProgress('build: entity_overlap (passports concepts)', 45);
    // 3) entity_overlap — passports.jsonl: concepts(A) ∩ concepts(B) ≥ 2
    try {
      if (this.plugin.passport && typeof this.plugin.passport.loadAll === 'function') {
        const passportMap = await this.plugin.passport.loadAll();
        // codex MED #2: filtra paths ainda existentes no vault (passports.jsonl
        // pode conter entradas stale pós-delete/rename).
        const conceptIndex = new Map();
        for (const [path, p] of passportMap.entries()) {
          if (!allPaths.has(path)) continue;
          if (!Array.isArray(p.concepts)) continue;
          for (const c of p.concepts) {
            const cl = String(c).toLowerCase();
            if (!conceptIndex.has(cl)) conceptIndex.set(cl, new Set());
            conceptIndex.get(cl).add(path);
          }
        }
        // Pairwise overlap via index reverso: para cada par (A,B) compartilhando
        // ≥2 conceitos, criamos edge. Conta overlap unique.
        const pairOverlap = new Map(); // "a|b" → Set<concept>
        for (const [concept, paths] of conceptIndex.entries()) {
          if (paths.size < 2 || paths.size > 100) continue; // concept ubíquo? skip ("paper", "código" são ruído)
          const arr = Array.from(paths);
          for (let i = 0; i < arr.length; i++) {
            for (let j = i + 1; j < arr.length; j++) {
              const key = arr[i] < arr[j] ? `${arr[i]}|${arr[j]}` : `${arr[j]}|${arr[i]}`;
              if (!pairOverlap.has(key)) pairOverlap.set(key, new Set());
              pairOverlap.get(key).add(concept);
            }
          }
        }
        for (const [key, concepts] of pairOverlap.entries()) {
          if (concepts.size < 2) continue;
          const [a, b] = key.split('|');
          const sample = Array.from(concepts).slice(0, 3).join(', ');
          this.addEdge(a, b, 'entity_overlap', `${concepts.size} conceitos: ${sample}`);
          this.addEdge(b, a, 'entity_overlap', `${concepts.size} conceitos: ${sample}`);
        }
      }
    } catch (e) {
      console.warn('[zeus.multiplex] entity_overlap failed:', e.message);
    }

    await _yield();
    onProgress('build: semantic_cosine (embeddings)', 65);
    // 6) semantic_cosine — apenas notas com embedding carregado. O(N²) bound.
    try {
      const emb = (this.plugin.searcher && this.plugin.searcher.embeddings) || new Map();
      const entries = [];
      for (const [p, e] of emb.entries()) {
        // codex MED #2: ignora entradas legadas/multimodais — embeddings pode
        // ter pdf/png/heic, mas multiplex semantic_cosine só faz sentido sobre
        // markdown atual do vault.
        if (!allPaths.has(p)) continue;
        if (e && Array.isArray(e.vec) && e.vec.length > 0) entries.push([p, e.vec]);
      }
      // Cap pra evitar explosão em vault grande
      const MAX = 2000;
      const useEntries = entries.length > MAX ? entries.slice(0, MAX) : entries;
      const MIN_COS = 0.5;
      for (let i = 0; i < useEntries.length; i++) {
        const [pa, va] = useEntries[i];
        for (let j = i + 1; j < useEntries.length; j++) {
          const [pb, vb] = useEntries[j];
          const c = _cosine(va, vb);
          if (c < MIN_COS) continue;
          this.addEdge(pa, pb, 'semantic_cosine', `cosine ${c.toFixed(3)}`);
          this.addEdge(pb, pa, 'semantic_cosine', `cosine ${c.toFixed(3)}`);
        }
      }
    } catch (e) {
      console.warn('[zeus.multiplex] semantic_cosine failed:', e.message);
    }

    onProgress('build: spotlight_token_bm25 (best-effort)', 80);
    // 7) spotlight_token_bm25 — placeholder/best-effort. Pula se daemon down OU
    // Spotlight indisponível. Marca um sinal sem custos quando inviável.
    try {
      const hasSpotlight = this.plugin.httpClient && this.plugin.vaultRoot
        && (await this.plugin.httpClient.isAvailable());
      if (!hasSpotlight) {
        onProgress('spotlight_token_bm25: skip (daemon ou vaultRoot indisponíveis)', 82);
      }
      // Edge type fica disponível; população real virá em v1.9 quando o daemon
      // expor /v1/spotlight/tokens. Por ora não criamos edges deste tipo —
      // skip gracioso registra schema, não fail.
    } catch (e) {
      console.warn('[zeus.multiplex] spotlight_token_bm25 skip:', e.message);
    }

    await _yield();
    onProgress('build: co_citation (top-N backlinked)', 90);
    // 8) co_citation — A e B linkadas pela mesma C. Limitado às top-1000 notas
    // com mais backlinks (cap O(N²)).
    try {
      const topBacklinked = Array.from(backlinkCount.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 1000)
        .map(([p]) => p);
      const targetSet = new Set(topBacklinked);
      // Para cada nota fonte C, pega seus destinos D ∈ resolved[C], filtra para
      // os que estão em targetSet, e adiciona co_citation entre todos os pares.
      for (const src of Object.keys(resolved)) {
        const inner = resolved[src] || {};
        const targets = Object.keys(inner).filter(d => targetSet.has(d));
        if (targets.length < 2) continue;
        // Cap em 20 alvos por fonte — fonte com mil links polui co_citation.
        const slice = targets.length > 20 ? targets.slice(0, 20) : targets;
        const srcName = src.split('/').pop();
        for (let i = 0; i < slice.length; i++) {
          for (let j = i + 1; j < slice.length; j++) {
            this.addEdge(slice[i], slice[j], 'co_citation', `ambas citadas por ${srcName}`);
            this.addEdge(slice[j], slice[i], 'co_citation', `ambas citadas por ${srcName}`);
          }
        }
      }
    } catch (e) {
      console.warn('[zeus.multiplex] co_citation failed:', e.message);
    }

    this._builtAt = new Date().toISOString();
    const elapsedMs = Date.now() - t0;
    onProgress(`build: done ${this.edges.size} edges in ${elapsedMs}ms`, 100);
    return { total: this.edges.size, elapsedMs, builtAt: this._builtAt };
  }

  // ---------------------------------------------------------------------------
  // Persistence — JSONL: 1 edge per line
  //
  // codex MED #4: mutex em persist também (auto-build + persist manual
  // concorrentes poderiam pisar no mesmo .tmp). _persistPromise serializa.
  // ---------------------------------------------------------------------------
  async persist() {
    if (this._persistPromise) return this._persistPromise;
    this._persistPromise = (async () => {
      try { return await this._doPersist(); }
      finally { this._persistPromise = null; }
    })();
    return this._persistPromise;
  }

  async _doPersist() {
    await universal.adapterMkdir(this._adapter, this.dataPath);
    const lines = [];
    for (const edge of this.edges.values()) {
      lines.push(JSON.stringify(edge));
    }
    await universal.adapterWriteAtomic(this._adapter, this.jsonlPath, lines.join('\n'));
    return { wrote: lines.length, path: this.jsonlPath };
  }

  async load() {
    this.edges.clear();
    if (!(await universal.adapterExists(this._adapter, this.jsonlPath))) {
      return { loaded: 0, path: this.jsonlPath, exists: false };
    }
    const raw = await universal.adapterRead(this._adapter, this.jsonlPath);
    let n = 0;
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (!e || !e.src || !e.dst || !e.type) continue;
        this.edges.set(_edgeKey(e.src, e.dst, e.type), e);
        n++;
      } catch (err) {
        // linha corrompida — skip silencioso
      }
    }
    return { loaded: n, path: this.jsonlPath, exists: true };
  }

  // ---------------------------------------------------------------------------
  // Query
  // ---------------------------------------------------------------------------
  /**
   * neighbors(filePath, types) — devolve todas as edges out de filePath.
   * Se `types` for array, filtra; null/undefined = todos os tipos.
   */
  neighbors(filePath, types = null) {
    if (!filePath) return [];
    const out = [];
    const filter = Array.isArray(types) ? new Set(types) : null;
    for (const edge of this.edges.values()) {
      if (edge.src !== filePath) continue;
      if (filter && !filter.has(edge.type)) continue;
      out.push(edge);
    }
    return out;
  }

  /**
   * neighborsByDst — agrupa neighbors por destino, somando weight e mergeando why
   * por tipo. Útil para "qual a nota mais relacionada, somando todas as evidências?"
   *
   * @returns {Array<{dst, totalWeight, edges: edge[]}>}
   */
  neighborsByDst(filePath, types = null) {
    const edges = this.neighbors(filePath, types);
    const byDst = new Map();
    for (const e of edges) {
      if (!byDst.has(e.dst)) byDst.set(e.dst, { dst: e.dst, totalWeight: 0, edges: [] });
      const slot = byDst.get(e.dst);
      slot.totalWeight += e.weight;
      slot.edges.push(e);
    }
    const arr = Array.from(byDst.values());
    arr.sort((a, b) => b.totalWeight - a.totalWeight);
    return arr;
  }

  stats() {
    const byType = {};
    for (const t of EDGE_TYPES) byType[t] = 0;
    for (const e of this.edges.values()) {
      byType[e.type] = (byType[e.type] || 0) + 1;
    }
    return {
      total: this.edges.size,
      byType,
      builtAt: this._builtAt,
    };
  }
}

module.exports = MultiplexGraph;
module.exports.EDGE_TYPES = EDGE_TYPES;
module.exports.DEFAULT_WEIGHTS = DEFAULT_WEIGHTS;
