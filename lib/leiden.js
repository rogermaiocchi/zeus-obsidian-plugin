/*
 * leiden.js — community detection enxuto em JS puro sobre o grafo multiplex.
 *
 * NÃO é o Leiden canônico do Traag et al. 2019. Aqui implementamos um
 * Louvain-com-conectividade — local move + connectivity split + agregação
 * recursiva, que captura a contribuição central do paper (quebrar
 * sub-comunidades desconectadas) sem o refinement phase completo. Em vault
 * típico (<10k nós, multiplex 8 edge types) o ganho de qualidade do
 * refinement não compensa a complexidade adicional.
 *
 * Arquitetura:
 *   1. Constrói grafo undirected ponderado a partir das edges multiplex.
 *      Pesos somados quando A↔B aparece em múltiplos edge types (acumula
 *      evidência multiplex em um único grafo singleplex para Louvain).
 *   2. Local move phase — pra cada nó na ordem (seedada), calcula
 *      modularidade-ganho movendo para a comunidade do vizinho de maior
 *      ΔQ. Repete até convergência (no-pass-mudou).
 *   3. Connectivity split — varre cada comunidade resultante. Se um BFS
 *      a partir de qualquer nó interno não cobre todos os membros, a
 *      comunidade quebra em sub-componentes conexos. Esta é a contribuição
 *      Leiden sobre Louvain (badly-connected communities corrigidas).
 *   4. Aggregation — coleciona super-grafo onde cada comunidade vira um
 *      super-nó. Self-loop preserva grau intra-comunidade (crítico — sem
 *      ele a modularidade do nível agregado fica errada).
 *   5. Recursão — re-roda 2+3+4 sobre o super-grafo enquanto Q melhorar.
 *   6. Best-partition tracking — retorna a partição com maior Q vista em
 *      qualquer nível (não a última; níveis tardios podem regredir).
 *
 * Determinístico: RNG via xorshift32 com seed configurável.
 *
 * Persistência: data/communities.jsonl (1 linha por nó):
 *   {"path":"a.md","communityId":12,"modularity":0.421,"level":2}
 *
 * API:
 *   const l = new LeidenCommunities(plugin);
 *   const r = await l.detectCommunities({ resolution: 1.0, seed: 42 });
 *   r.communities  // Map<path, communityId>
 *   r.modularity   // Q final (number ∈ [-0.5, 1.0])
 *   r.levels       // [{level, communities, Q}, ...]
 *   r.stats        // { nodes, edges, communityCount, topSizes: [a,b,c] }
 *   await l.persist(r);
 *
 * Não-objetivos:
 *   - Refinement phase do Leiden canônico (Traag 2019 §3) — deferido.
 *   - Multiplex modularity (somar Q por layer) — usamos singleplex weighted.
 *   - Resolution-limit guarantee — escopo enxuto declarado.
 */

'use strict';

const universal = require('./universal-fs');

const DATA_DIR_NAME = 'data';
const COMMUNITIES_FILE = 'communities.jsonl';

const MAX_LEVELS = 10;          // safety cap — recursão nunca passa disso
const MAX_LOCAL_PASSES = 20;    // local move convergence cap
const MIN_GAIN = 1e-10;         // floating slop para "Q melhorou"

// xorshift32 — PRNG determinístico, 1 line of state. Suficiente para
// shuffle de ordem de nós no local move.
function _makeRng(seed) {
  let state = (seed >>> 0) || 1;
  return function rng() {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;  state >>>= 0;
    return (state >>> 0) / 0x100000000;
  };
}

function _shuffleInPlace(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
  }
  return arr;
}

// ---------------------------------------------------------------------------
// Graph representation
//
// adjacency: Array<Map<neighborIdx, weight>>  // undirected; self-loop possível
// degrees: Array<number>                       // sum of weights incident to i (self-loop conta 2× pra preservar 2m)
// totalWeight: number                          // 2m em notação canônica de modularidade
// idToNode: Array<nodeLabel>                   // string (path) ou super-community-id
// nodeToId: Map<nodeLabel, idx>
// ---------------------------------------------------------------------------

function _newGraph() {
  return {
    adjacency: [],
    degrees: [],
    selfLoop: [],   // self-loop weight per node (preserva intra-community em agregação)
    totalWeight: 0,
    idToNode: [],
    nodeToId: new Map(),
  };
}

function _ensureNode(g, label) {
  let id = g.nodeToId.get(label);
  if (id !== undefined) return id;
  id = g.idToNode.length;
  g.idToNode.push(label);
  g.nodeToId.set(label, id);
  g.adjacency.push(new Map());
  g.degrees.push(0);
  g.selfLoop.push(0);
  return id;
}

function _addUndirected(g, srcLabel, dstLabel, weight) {
  if (weight <= 0) return;
  const s = _ensureNode(g, srcLabel);
  const d = _ensureNode(g, dstLabel);
  if (s === d) {
    // Self-loop — adiciona w no adjacency e 2w no degree (convenção canônica).
    g.adjacency[s].set(s, (g.adjacency[s].get(s) || 0) + weight);
    g.degrees[s] += 2 * weight;
    g.selfLoop[s] += weight;
    g.totalWeight += 2 * weight;
    return;
  }
  g.adjacency[s].set(d, (g.adjacency[s].get(d) || 0) + weight);
  g.adjacency[d].set(s, (g.adjacency[d].get(s) || 0) + weight);
  g.degrees[s] += weight;
  g.degrees[d] += weight;
  g.totalWeight += 2 * weight;
}

// ---------------------------------------------------------------------------
// Modularity — Q = (1/2m) Σ [A_ij - γ * k_i*k_j/2m] δ(c_i, c_j)
// ---------------------------------------------------------------------------
function _modularity(g, community, resolution) {
  const m2 = g.totalWeight;
  if (m2 <= 0) return 0;
  // Soma por comunidade: in-weight (Σ A_ij dentro) e tot-weight (Σ k_i)
  const inW = new Map();
  const totW = new Map();
  for (let i = 0; i < g.idToNode.length; i++) {
    const c = community[i];
    totW.set(c, (totW.get(c) || 0) + g.degrees[i]);
    // intra-edges: itera vizinhos j com c_j == c
    const adj = g.adjacency[i];
    for (const [j, w] of adj.entries()) {
      if (community[j] !== c) continue;
      // i==j é self-loop; conta uma vez (w), não 2w, porque o loop soma w para i→i só.
      // i!=j conta ambas direções (i→j e j→i adicionam w cada), o que dobra a aresta — correto.
      inW.set(c, (inW.get(c) || 0) + w);
    }
  }
  let Q = 0;
  for (const c of totW.keys()) {
    const sIn = inW.get(c) || 0;
    const sTot = totW.get(c) || 0;
    Q += sIn / m2 - resolution * (sTot / m2) * (sTot / m2);
  }
  return Q;
}

// ---------------------------------------------------------------------------
// Local move — para cada nó, move pra comunidade vizinha de maior ΔQ.
//
// ΔQ ao mover i de C_old → C_new (formulação Louvain):
//   ΔQ = [k_i,in(new) / m] - γ * [k_i * (Σ_tot(new)) / (2m²)]
//        - [k_i,in(old\i) / m] + γ * [k_i * (Σ_tot(old) - k_i) / (2m²)]
//
// Implementação enxuta: removemos i do C_old (atualizando totW), avaliamos
// candidatas, escolhemos a melhor (inclui voltar a C_old), aplicamos.
// ---------------------------------------------------------------------------
function _localMove(g, community, resolution, rng) {
  const n = g.idToNode.length;
  if (n === 0) return { passes: 0, moves: 0 };
  const m2 = g.totalWeight;
  if (m2 <= 0) return { passes: 0, moves: 0 };

  // Σ_tot por comunidade (sum of degrees of nodes inside)
  const totW = new Map();
  for (let i = 0; i < n; i++) {
    const c = community[i];
    totW.set(c, (totW.get(c) || 0) + g.degrees[i]);
  }

  let totalMoves = 0;
  let passes = 0;
  for (let pass = 0; pass < MAX_LOCAL_PASSES; pass++) {
    passes++;
    let movesThisPass = 0;
    const order = Array.from({ length: n }, (_, i) => i);
    _shuffleInPlace(order, rng);
    for (const i of order) {
      const oldC = community[i];
      const ki = g.degrees[i];
      // k_i,in(C) para cada comunidade C alcançável via vizinhos
      const linksToComm = new Map();
      const adj = g.adjacency[i];
      // self-loop não conta como link para comunidade externa
      for (const [j, w] of adj.entries()) {
        if (j === i) continue;
        const cj = community[j];
        linksToComm.set(cj, (linksToComm.get(cj) || 0) + w);
      }
      // Remove i de oldC virtualmente: linksToComm[oldC] é k_i,in(oldC sem i)
      const kIin_old = linksToComm.get(oldC) || 0;
      const totOldMinusI = (totW.get(oldC) || 0) - ki;

      // Tenta cada comunidade candidata (vizinhança + voltar pra oldC)
      let bestC = oldC;
      let bestGain = 0; // ganho de mudar; >0 == move vale a pena
      for (const [c, kIin_new] of linksToComm.entries()) {
        if (c === oldC) continue;
        const totNew = totW.get(c) || 0;
        // ΔQ = (kIin_new - kIin_old)/m  - γ * ki * (totNew - totOldMinusI) / (2m²)
        //   onde m = m2/2 (m2 é 2m). Simplificado pra m2:
        const gain = (kIin_new - kIin_old) / (m2 / 2)
          - resolution * ki * (totNew - totOldMinusI) / ((m2 / 2) * m2);
        if (gain > bestGain + MIN_GAIN) {
          bestGain = gain;
          bestC = c;
        }
      }
      if (bestC !== oldC) {
        community[i] = bestC;
        totW.set(oldC, totOldMinusI);
        totW.set(bestC, (totW.get(bestC) || 0) + ki);
        movesThisPass++;
        totalMoves++;
      }
    }
    if (movesThisPass === 0) break;
  }
  return { passes, moves: totalMoves };
}

// ---------------------------------------------------------------------------
// Connectivity split — para cada comunidade, BFS interna. Se um BFS a partir
// de um nó não cobre todos os membros, sub-componentes desconexos viram
// comunidades separadas (novos IDs).
//
// Esta é a contribuição central do Leiden sobre Louvain: Louvain pode deixar
// comunidades internamente desconectadas após o local move (badly-connected).
// Aqui detectamos e separamos.
// ---------------------------------------------------------------------------
function _connectivitySplit(g, community) {
  const n = g.idToNode.length;
  // membros por comunidade
  const members = new Map();
  for (let i = 0; i < n; i++) {
    const c = community[i];
    if (!members.has(c)) members.set(c, []);
    members.get(c).push(i);
  }
  // próximo ID livre
  let nextId = 1;
  for (const c of members.keys()) if (c >= nextId) nextId = c + 1;

  let splits = 0;
  for (const [c, nodes] of members.entries()) {
    if (nodes.length <= 1) continue;
    const nodeSet = new Set(nodes);
    const visited = new Set();
    let firstComponent = true;
    for (const start of nodes) {
      if (visited.has(start)) continue;
      // BFS interna — só visita nós em nodeSet
      const comp = [];
      const queue = [start];
      visited.add(start);
      while (queue.length) {
        const u = queue.shift();
        comp.push(u);
        for (const v of g.adjacency[u].keys()) {
          if (!nodeSet.has(v) || visited.has(v)) continue;
          visited.add(v);
          queue.push(v);
        }
      }
      if (!firstComponent) {
        // Sub-componente extra — atribui novo ID
        const newId = nextId++;
        for (const v of comp) community[v] = newId;
        splits++;
      }
      firstComponent = false;
    }
  }
  return splits;
}

// ---------------------------------------------------------------------------
// Aggregate — constrói super-grafo onde cada comunidade vira super-nó.
// Self-loop preserva grau interno (sem isso modularidade do próximo nível
// fica errada — codex audit anterior destacou).
// ---------------------------------------------------------------------------
function _aggregate(g, community) {
  const superGraph = _newGraph();
  // Soma pesos entre cada par de comunidades (incluindo self-loop)
  const edgeMap = new Map(); // "cA|cB" → weight (cA <= cB para dedup, exceto self-loop)
  for (let i = 0; i < g.idToNode.length; i++) {
    const cI = community[i];
    for (const [j, w] of g.adjacency[i].entries()) {
      const cJ = community[j];
      if (i === j) {
        // self-loop original do nó — vira self-loop no super-nó cI
        const key = `${cI}|${cI}|self`;
        edgeMap.set(key, (edgeMap.get(key) || 0) + w);
      } else if (i < j) {
        // aresta i→j (i<j para não duplicar)
        if (cI === cJ) {
          // intra-comunidade: vira self-loop com peso w (não 2w, já que i<j conta uma vez)
          const key = `${cI}|${cI}|self`;
          edgeMap.set(key, (edgeMap.get(key) || 0) + w);
        } else {
          const [a, b] = cI < cJ ? [cI, cJ] : [cJ, cI];
          const key = `${a}|${b}|inter`;
          edgeMap.set(key, (edgeMap.get(key) || 0) + w);
        }
      }
    }
  }
  // Materializa
  for (const [key, w] of edgeMap.entries()) {
    const [a, b, kind] = key.split('|');
    if (kind === 'self') {
      _addUndirected(superGraph, String(a), String(a), w);
    } else {
      _addUndirected(superGraph, String(a), String(b), w);
    }
  }
  // Edge case: comunidades isoladas (sem arestas internas nem externas).
  // Não aparecem em edgeMap; ainda precisam virar nó no super-grafo.
  const seen = new Set();
  for (const c of community) seen.add(c);
  for (const c of seen) _ensureNode(superGraph, String(c));
  return superGraph;
}

// ---------------------------------------------------------------------------
// LeidenCommunities — classe pública
// ---------------------------------------------------------------------------
class LeidenCommunities {
  constructor(plugin) {
    this.plugin = plugin;
  }

  get _adapter() {
    return this.plugin.app.vault.adapter;
  }

  get dataPath() {
    return universal.joinPath(this.plugin.manifest.dir, DATA_DIR_NAME);
  }

  get jsonlPath() {
    return universal.joinPath(this.dataPath, COMMUNITIES_FILE);
  }

  /**
   * Constrói grafo singleplex weighted a partir de multiplex edges.
   * Edges undirected: A↔B somado dos dois sentidos. Filtra por edgeTypes
   * se passado.
   */
  _buildGraphFromMultiplex(edgeTypesFilter) {
    const g = _newGraph();
    const multiplex = this.plugin.multiplex;
    if (!multiplex || !multiplex.edges) return g;
    const filter = (edgeTypesFilter && edgeTypesFilter.length)
      ? new Set(edgeTypesFilter) : null;
    // Junta arestas A→B e B→A num único peso undirected (somando).
    // Dedup via pair-key canônico (min|max).
    const pairWeight = new Map(); // "a|b" → weight
    for (const edge of multiplex.edges.values()) {
      if (filter && !filter.has(edge.type)) continue;
      const src = edge.src, dst = edge.dst;
      if (!src || !dst || src === dst) continue;
      const [a, b] = src < dst ? [src, dst] : [dst, src];
      const key = `${a}|${b}`;
      pairWeight.set(key, (pairWeight.get(key) || 0) + (edge.weight || 0));
    }
    for (const [key, w] of pairWeight.entries()) {
      const [a, b] = key.split('|');
      // Dividimos por 2 — A→B + B→A somam 2× o peso real undirected.
      _addUndirected(g, a, b, w / 2);
    }
    return g;
  }

  /**
   * detectCommunities — algoritmo completo.
   *
   * options:
   *   resolution: 1.0  (γ na modularidade; >1 favorece comunidades menores)
   *   seed: 42         (RNG)
   *   maxIterations: 10 (cap recursão)
   *   edgeTypes: null  (null = todos os tipos multiplex)
   *
   * @returns {Promise<{communities: Map<path, communityId>, modularity: number, levels: object[], stats: object}>}
   */
  async detectCommunities(options = {}) {
    const opts = {
      resolution: options.resolution != null ? options.resolution : 1.0,
      seed: options.seed != null ? options.seed : 42,
      maxIterations: options.maxIterations != null ? options.maxIterations : MAX_LEVELS,
      edgeTypes: options.edgeTypes || null,
    };
    const rng = _makeRng(opts.seed);

    // Nível 0: grafo a partir do multiplex
    let g = this._buildGraphFromMultiplex(opts.edgeTypes);
    const n0 = g.idToNode.length;
    const e0 = (() => { let c = 0; for (const a of g.adjacency) c += a.size; return c / 2; })();

    if (n0 === 0) {
      return {
        communities: new Map(),
        modularity: 0,
        levels: [],
        stats: { nodes: 0, edges: 0, communityCount: 0, topSizes: [] },
      };
    }

    // Tracking de melhor partição vista (na escala dos nós originais)
    // Inicialização: cada nó é sua própria comunidade
    let community = new Array(g.idToNode.length);
    for (let i = 0; i < community.length; i++) community[i] = i;
    let bestPartitionOriginal = community.slice(); // mapeado pra nós originais
    let bestQ = _modularity(g, community, opts.resolution);
    const originalLabels = g.idToNode.slice(); // path strings, índice = id no nível 0

    // node→community no nível 0 (acumula via composição em cada agregação)
    // No level k > 0, working community é sobre super-nós; precisamos
    // resolver pra nós originais. Mantemos `level0Community[i]` = comunidade
    // atual do nó original i.
    let level0Community = community.slice();

    const levelsLog = [];
    let currentG = g;
    let currentCommunity = community;

    for (let level = 0; level < opts.maxIterations; level++) {
      const { passes, moves } = _localMove(currentG, currentCommunity, opts.resolution, rng);
      const splits = _connectivitySplit(currentG, currentCommunity);
      const Q = _modularity(currentG, currentCommunity, opts.resolution);

      // Atualiza level0Community: para cada nó original i, sua comunidade
      // atual é `currentCommunity[mapeamento(i)]` no nível atual.
      // Em level=0, mapeamento(i) = i. Em level>0, level0Community já
      // refletia a comunidade do nível anterior, e currentCommunity
      // mapeia super-nó → nova comunidade. Compomos:
      if (level === 0) {
        level0Community = currentCommunity.slice();
      } else {
        // currentG.idToNode tem strings que são community-ids do nível anterior
        // (vide _aggregate que usa String(c) como label do super-nó).
        // Para cada nó original i, sua comunidade anterior era prevLevel0[i].
        // Encontramos o super-nó cujo label === String(prevLevel0[i]),
        // e pegamos currentCommunity[esseSuperNo].
        const labelToSuperId = new Map();
        for (let s = 0; s < currentG.idToNode.length; s++) {
          labelToSuperId.set(currentG.idToNode[s], s);
        }
        const newLevel0 = new Array(level0Community.length);
        for (let i = 0; i < level0Community.length; i++) {
          const prevC = level0Community[i];
          const superId = labelToSuperId.get(String(prevC));
          newLevel0[i] = superId !== undefined ? currentCommunity[superId] : prevC;
        }
        level0Community = newLevel0;
      }

      // Conta comunidades no nível atual
      const communitySet = new Set(currentCommunity);
      levelsLog.push({
        level,
        Q,
        passes,
        moves,
        splits,
        nodes: currentG.idToNode.length,
        communities: communitySet.size,
      });

      // Track best Q ever seen (sobre nós originais)
      if (Q > bestQ + MIN_GAIN) {
        bestQ = Q;
        bestPartitionOriginal = level0Community.slice();
      }

      // Critério de parada: se número de comunidades não diminuiu, agregação
      // não vai produzir nada novo. Ou se só sobrou 1 comunidade.
      if (communitySet.size === currentG.idToNode.length) break; // ninguém se moveu
      if (communitySet.size <= 1) break;

      // Agregação para o próximo nível
      const nextG = _aggregate(currentG, currentCommunity);
      const nextCommunity = new Array(nextG.idToNode.length);
      for (let i = 0; i < nextCommunity.length; i++) nextCommunity[i] = i;

      // Modularidade no super-grafo com cada nó em sua própria comunidade ===
      // modularidade do nível anterior; se local move não reduzir mais, paramos.
      currentG = nextG;
      currentCommunity = nextCommunity;
    }

    // Renumera comunidades em IDs contíguos 0..K-1 para estabilidade do output
    const remap = new Map();
    let nextId = 0;
    for (const c of bestPartitionOriginal) {
      if (!remap.has(c)) remap.set(c, nextId++);
    }
    const finalCommunities = new Map();
    for (let i = 0; i < bestPartitionOriginal.length; i++) {
      finalCommunities.set(originalLabels[i], remap.get(bestPartitionOriginal[i]));
    }

    // Stats: top sizes
    const sizeByComm = new Map();
    for (const c of finalCommunities.values()) {
      sizeByComm.set(c, (sizeByComm.get(c) || 0) + 1);
    }
    const sizesSorted = Array.from(sizeByComm.values()).sort((a, b) => b - a);

    return {
      communities: finalCommunities,
      modularity: bestQ,
      levels: levelsLog,
      stats: {
        nodes: n0,
        edges: e0,
        communityCount: sizeByComm.size,
        topSizes: sizesSorted.slice(0, 3),
      },
    };
  }

  /**
   * Persiste resultado em data/communities.jsonl (1 linha por nó).
   */
  async persist(result) {
    if (!result || !result.communities) throw new Error('persist: result.communities ausente');
    await universal.adapterMkdir(this._adapter, this.dataPath);
    const lines = [];
    const Q = result.modularity;
    const lastLevel = result.levels.length ? result.levels[result.levels.length - 1].level : 0;
    for (const [path, communityId] of result.communities.entries()) {
      lines.push(JSON.stringify({
        path,
        communityId,
        modularity: Number(Q.toFixed(6)),
        level: lastLevel,
      }));
    }
    await universal.adapterWriteAtomic(this._adapter, this.jsonlPath, lines.join('\n'));
    return { wrote: lines.length, path: this.jsonlPath };
  }

  /**
   * Carrega data/communities.jsonl → Map<path, {communityId, modularity, level}>
   */
  async load() {
    if (!(await universal.adapterExists(this._adapter, this.jsonlPath))) {
      return { loaded: 0, communities: new Map(), modularity: null, path: this.jsonlPath, exists: false };
    }
    const raw = await universal.adapterRead(this._adapter, this.jsonlPath);
    const communities = new Map();
    let Q = null;
    let n = 0;
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (!entry || !entry.path) continue;
        communities.set(entry.path, {
          communityId: entry.communityId,
          modularity: entry.modularity,
          level: entry.level,
        });
        if (Q == null && typeof entry.modularity === 'number') Q = entry.modularity;
        n++;
      } catch (_) {
        // skip linha corrompida
      }
    }
    return { loaded: n, communities, modularity: Q, path: this.jsonlPath, exists: true };
  }

  /**
   * Stats prontas a partir de um load() (ou de um result em memória).
   */
  statsFromMap(communitiesMap) {
    const sizeByComm = new Map();
    for (const v of communitiesMap.values()) {
      const cid = (v && typeof v === 'object') ? v.communityId : v;
      sizeByComm.set(cid, (sizeByComm.get(cid) || 0) + 1);
    }
    const sorted = Array.from(sizeByComm.entries()).sort((a, b) => b[1] - a[1]);
    return {
      total: communitiesMap.size,
      communityCount: sizeByComm.size,
      topSizes: sorted.slice(0, 3).map(([cid, size]) => ({ communityId: cid, size })),
      sizeBreakdown: sorted.slice(0, 20).map(([cid, size]) => `c${cid}:${size}`).join(' · '),
    };
  }
}

module.exports = LeidenCommunities;
module.exports._internal = {
  _makeRng,
  _modularity,
  _newGraph,
  _addUndirected,
  _localMove,
  _connectivitySplit,
  _aggregate,
};
