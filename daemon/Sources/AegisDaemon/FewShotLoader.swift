import Foundation

// FewShotLoader — Fase A da estratégia de fidelidade (v1.0.0).
//
// Carrega de Resources/FewShotExamples/<task>.json os pares (input, output_Apple-style)
// curados para cada uma das 7 funções generativas. O MLXGemmaTwinRunner prepende
// esses exemplos ao prompt do usuário, junto com o system prompt canônico.
//
// Vantagem desta fase: nenhuma dependência de LoRA fine-tune. Sai pra produção AGORA
// usando pesos stock do Gemma 4 (gemma-4-e2b-it / gemma-4-e4b-it). Os adapters
// fine-tunados da Fase B chegam depois, via novas tags de ODR, sem precisar
// rebuildar o app.

public struct FewShotExample: Codable, Sendable {
    public let input: FewShotInputValue
    public let output: FewShotOutputValue
    public let instructions: String?
    public let style: String?
}

/// Aceita strings simples ou objetos (caso agent_query / graph_extract).
public enum FewShotInputValue: Codable, Sendable {
    case text(String)
    case object([String: AnyCodable])

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let s = try? c.decode(String.self) { self = .text(s); return }
        if let o = try? c.decode([String: AnyCodable].self) { self = .object(o); return }
        throw DecodingError.typeMismatch(FewShotInputValue.self,
            .init(codingPath: decoder.codingPath, debugDescription: "input deve ser string ou objeto"))
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .text(let s):   try c.encode(s)
        case .object(let o): try c.encode(o)
        }
    }
    public var rendered: String {
        switch self {
        case .text(let s): return s
        case .object(let o):
            if let data = try? JSONSerialization.data(withJSONObject: o.mapValues { $0.value }, options: [.prettyPrinted, .sortedKeys]),
               let str = String(data: data, encoding: .utf8) {
                return str
            }
            return "\(o)"
        }
    }
}

public enum FewShotOutputValue: Codable, Sendable {
    case text(String)
    case object([String: AnyCodable])

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let s = try? c.decode(String.self) { self = .text(s); return }
        if let o = try? c.decode([String: AnyCodable].self) { self = .object(o); return }
        throw DecodingError.typeMismatch(FewShotOutputValue.self,
            .init(codingPath: decoder.codingPath, debugDescription: "output deve ser string ou objeto"))
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .text(let s):   try c.encode(s)
        case .object(let o): try c.encode(o)
        }
    }
    public var rendered: String {
        switch self {
        case .text(let s): return s
        case .object(let o):
            if let data = try? JSONSerialization.data(withJSONObject: o.mapValues { $0.value }, options: [.prettyPrinted, .sortedKeys]),
               let str = String(data: data, encoding: .utf8) {
                return str
            }
            return "\(o)"
        }
    }
}

/// Helper para JSON heterogêneo Codable em Swift.
public struct AnyCodable: Codable, @unchecked Sendable {
    public let value: Any

    public init(_ value: Any) { self.value = value }

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil()                       { self.value = NSNull(); return }
        if let v = try? c.decode(Bool.self)    { self.value = v; return }
        if let v = try? c.decode(Int.self)     { self.value = v; return }
        if let v = try? c.decode(Double.self)  { self.value = v; return }
        if let v = try? c.decode(String.self)  { self.value = v; return }
        if let v = try? c.decode([AnyCodable].self) { self.value = v.map { $0.value }; return }
        if let v = try? c.decode([String: AnyCodable].self) {
            self.value = v.mapValues { $0.value }; return
        }
        throw DecodingError.dataCorruptedError(in: c, debugDescription: "Valor não suportado em AnyCodable")
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch value {
        case is NSNull:           try c.encodeNil()
        case let v as Bool:       try c.encode(v)
        case let v as Int:        try c.encode(v)
        case let v as Double:     try c.encode(v)
        case let v as String:     try c.encode(v)
        case let v as [Any]:      try c.encode(v.map(AnyCodable.init))
        case let v as [String: Any]:
                                  try c.encode(v.mapValues(AnyCodable.init))
        default: try c.encode(String(describing: value))
        }
    }
}

public struct FewShotPack: Codable, Sendable {
    public let task: String
    public let captured_from: String?
    public let captured_at: String?
    public let examples: [FewShotExample]
}

public enum FewShotTask: String, CaseIterable, Sendable {
    case summarize, refine, enrich, prompt, hyde, agent_query, graph_extract
}

public enum FewShotLoader {

    /// Cache em memória — carrega lazy uma vez por task.
    private static var cache: [FewShotTask: FewShotPack] = [:]
    private static let lock = NSLock()

    public static func load(_ task: FewShotTask) -> FewShotPack? {
        lock.lock(); defer { lock.unlock() }
        if let cached = cache[task] { return cached }

        // 1) Tenta Bundle.module (SPM)
        let resourceName = task.rawValue
        var url: URL?
        #if SWIFT_PACKAGE
        url = Bundle.module.url(forResource: resourceName, withExtension: "json",
                                subdirectory: "FewShotExamples")
        #endif
        // 2) Fallback: Bundle.main (app shell)
        if url == nil {
            url = Bundle.main.url(forResource: resourceName, withExtension: "json",
                                  subdirectory: "FewShotExamples")
        }
        guard let fileURL = url,
              let data = try? Data(contentsOf: fileURL),
              let pack = try? JSONDecoder().decode(FewShotPack.self, from: data) else {
            NSLog("[FewShot] não foi possível carregar pack para task=\(resourceName)")
            return nil
        }
        cache[task] = pack
        return pack
    }

    /// Renderiza os exemplos no template Gemma para serem prepended ao turno do usuário.
    public static func renderTurns(_ task: FewShotTask) -> String {
        guard let pack = load(task) else { return "" }
        var out = ""
        for ex in pack.examples.prefix(5) {
            var userPayload = ex.input.rendered
            if let inst = ex.instructions {
                userPayload = "[instruções: \(inst)]\n\(userPayload)"
            }
            if let style = ex.style {
                userPayload = "[style: \(style)]\n\(userPayload)"
            }
            out += "<start_of_turn>user\n\(userPayload)<end_of_turn>\n"
            out += "<start_of_turn>model\n\(ex.output.rendered)<end_of_turn>\n"
        }
        return out
    }
}
