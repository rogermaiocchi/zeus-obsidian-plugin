// ZeusSearchEngine.swift — Módulo isolado de busca híbrida BM25 in-memory.
//
// Criado v1.17 (2026-05-31) — Caminho 4 + 2 (julgamento Opus 4.8 do
// debate 2026-05-31 4 vozes Caminhos 1+2 Spotlight).
//
// Arquitetura:
//   - FileManager direct read dos vaults iCloud (Caminho 4 — Agy caught:
//     daemon user-space tem acesso direto sem precisar TCC FDA).
//   - BM25 in-memory ~120 LoC (Agy: NLTokenizer Swift + tf-idf custom).
//   - Cache em memória apenas (sem SQLite — Agy: desnecessário para 200 docs).
//   - Privacy: nenhum campo de conteúdo de nota em logs de nível >= info
//     (privacy-auditor pré-condição b).
//   - Cache path: in-memory only, sem disco (privacy-auditor pré-condição a).
//
// Endpoint público (em ZeusMacHTTPHandler):
//   POST /v1/smart_search
//     body: {"query": "...", "k": 60, "limit": 20, "sources": ["embed","bm25"]}
//     returns: {hits: [{path, title, bm25_score, embed_score, rrf_score}],
//               total_indexed, fusion: "rrf"}

import Foundation
import NaturalLanguage

/// Documento indexado pelo BM25 engine.
struct BM25Document {
    let path: String          // Path absoluto do arquivo .md
    let title: String         // Nome do arquivo sem extensão
    let tokens: [String]      // Tokens normalizados do conteúdo
    let termFreq: [String: Int]  // Term frequency local

    /// Tamanho do documento em tokens.
    var length: Int { tokens.count }
}

/// BM25 in-memory engine — Okapi BM25 standard formula.
///
/// Parâmetros canônicos (Robertson/Walker 1994):
///   - k1 = 1.5 (saturação term frequency)
///   - b  = 0.75 (normalização length)
///
/// Performance esperada (Agy): ~5ms para 200 docs em RAM.
final class BM25Engine {

    private var docs: [BM25Document] = []
    private var invertedIndex: [String: [Int]] = [:]  // token -> doc indices
    private var docFreq: [String: Int] = [:]          // token -> num docs com token
    private var avgDocLength: Double = 0
    private let k1: Double = 1.5
    private let b: Double = 0.75

    // MARK: - Public API

    /// Total de documentos indexados.
    var count: Int { docs.count }

    /// Indexar um documento (path + content). Recalcula avgDocLength.
    /// Idempotente: se path já indexado, substitui (LRU).
    func indexDocument(path: String, content: String) {
        let title = (path as NSString).lastPathComponent
            .replacingOccurrences(of: ".md", with: "")
        let tokens = Self.tokenize(content)
        var termFreq: [String: Int] = [:]
        for tok in tokens {
            termFreq[tok, default: 0] += 1
        }

        // Remove versão anterior se existir (LRU update)
        if let existingIdx = docs.firstIndex(where: { $0.path == path }) {
            removeFromIndex(docIdx: existingIdx)
            docs[existingIdx] = BM25Document(
                path: path, title: title,
                tokens: tokens, termFreq: termFreq
            )
            addToIndex(docIdx: existingIdx, doc: docs[existingIdx])
        } else {
            let newIdx = docs.count
            docs.append(BM25Document(
                path: path, title: title,
                tokens: tokens, termFreq: termFreq
            ))
            addToIndex(docIdx: newIdx, doc: docs[newIdx])
        }

        recalcAvgDocLength()
    }

    /// Query BM25 sobre o índice. Retorna top-K com scores ordenados.
    func search(_ query: String, limit: Int = 20) -> [(path: String, title: String, score: Double)] {
        let qTokens = Self.tokenize(query)
        guard !qTokens.isEmpty, !docs.isEmpty else { return [] }

        let n = Double(docs.count)
        var scores = [Double](repeating: 0, count: docs.count)

        for qTok in qTokens {
            guard let postings = invertedIndex[qTok] else { continue }
            let df = Double(docFreq[qTok] ?? postings.count)
            // IDF padrão Robertson: ln((N - df + 0.5) / (df + 0.5) + 1)
            let idf = log((n - df + 0.5) / (df + 0.5) + 1.0)
            for docIdx in postings {
                let doc = docs[docIdx]
                let tf = Double(doc.termFreq[qTok] ?? 0)
                let docLen = Double(doc.length)
                let normLen = avgDocLength > 0 ? docLen / avgDocLength : 1.0
                let numerator = tf * (k1 + 1)
                let denominator = tf + k1 * (1 - b + b * normLen)
                scores[docIdx] += idf * (numerator / denominator)
            }
        }

        var ranked: [(Int, Double)] = []
        for (i, s) in scores.enumerated() where s > 0 {
            ranked.append((i, s))
        }
        ranked.sort { $0.1 > $1.1 }

        let topK = ranked.prefix(limit)
        return topK.map { (idx, score) in
            (docs[idx].path, docs[idx].title, score)
        }
    }

    /// Limpa o índice (purge).
    func clear() {
        docs.removeAll()
        invertedIndex.removeAll()
        docFreq.removeAll()
        avgDocLength = 0
    }

    // MARK: - Internal

    private func addToIndex(docIdx: Int, doc: BM25Document) {
        for tok in Set(doc.tokens) {
            invertedIndex[tok, default: []].append(docIdx)
            docFreq[tok, default: 0] += 1
        }
    }

    private func removeFromIndex(docIdx: Int) {
        let doc = docs[docIdx]
        for tok in Set(doc.tokens) {
            invertedIndex[tok]?.removeAll(where: { $0 == docIdx })
            docFreq[tok] = max(0, (docFreq[tok] ?? 1) - 1)
        }
    }

    private func recalcAvgDocLength() {
        guard !docs.isEmpty else { avgDocLength = 0; return }
        let total = docs.reduce(0) { $0 + $1.length }
        avgDocLength = Double(total) / Double(docs.count)
    }

    /// Tokenização Apple NLTokenizer (word units) com lowercase + filtro <2 chars.
    /// Stopwords mínimas PT-BR (frequente em corpus jurídico).
    private static let stopwords: Set<String> = [
        "a", "o", "e", "de", "da", "do", "das", "dos", "na", "no", "nas", "nos",
        "em", "por", "para", "com", "sem", "que", "se", "as", "os", "um", "uma",
        "uns", "umas", "ao", "à", "às", "aos", "the", "of", "and", "to", "in"
    ]

    static func tokenize(_ text: String) -> [String] {
        let normalized = text.lowercased()
        let tokenizer = NLTokenizer(unit: .word)
        tokenizer.string = normalized
        var tokens: [String] = []
        tokenizer.enumerateTokens(in: normalized.startIndex..<normalized.endIndex) { range, _ in
            let tok = String(normalized[range])
            // Filtro: >=2 chars, alphanumeric, não-stopword
            if tok.count >= 2,
               tok.unicodeScalars.contains(where: { (CharacterSet.alphanumerics).contains($0) }),
               !stopwords.contains(tok) {
                tokens.append(tok)
            }
            return true
        }
        return tokens
    }
}

// MARK: - Vault Loader (Caminho 4 — FileManager direto sem TCC)

/// Carrega notas .md de paths iCloud via FileManager. Sem dependência de
/// Spotlight/mdfind. Agy caught: daemon user-space tem acesso direto a
/// `~/Library/Mobile Documents/` sem TCC FDA.
struct VaultLoader {

    /// Carrega todas as notas .md de um diretório recursivamente.
    /// - Parameters:
    ///   - root: Diretório raiz (ex: vault iCloud Obsidian path)
    ///   - excludeDirs: Pastas a pular (.obsidian, .claude, etc.)
    ///   - maxBytes: Limite por arquivo (proteção memory)
    /// - Returns: Array (path, content) de cada nota encontrada.
    static func loadMarkdownNotes(
        root: String,
        excludeDirs: Set<String> = [".obsidian", ".claude", ".trash", "node_modules", ".git", ".smart-env"],
        maxBytes: Int = 200_000
    ) -> [(path: String, content: String)] {
        var notes: [(String, String)] = []
        let fm = FileManager.default
        let rootURL = URL(fileURLWithPath: root)
        guard let enumerator = fm.enumerator(
            at: rootURL,
            includingPropertiesForKeys: [.isRegularFileKey, .fileSizeKey],
            options: [.skipsHiddenFiles, .skipsPackageDescendants]
        ) else { return [] }

        for case let fileURL as URL in enumerator {
            // Skip excluded dirs
            let comps = fileURL.pathComponents
            if comps.contains(where: { excludeDirs.contains($0) }) {
                continue
            }
            guard fileURL.pathExtension == "md" else { continue }
            // Size check
            if let size = try? fileURL.resourceValues(forKeys: [.fileSizeKey]).fileSize,
               size > maxBytes {
                continue
            }
            // Read (skip on error — privacy: no log of failed path)
            guard let data = try? Data(contentsOf: fileURL),
                  let content = String(data: data, encoding: .utf8) else {
                continue
            }
            notes.append((fileURL.path, content))
        }
        return notes
    }
}
