/*
 * device-capabilities.js — v1.15.0 manifesto canônico de modelos Apple
 * disponíveis por plataforma e versão mínima de OS.
 *
 * Regra de encapsulamento: qualquer dependência não-nativa deve ser
 * internalizada com prefixo zeus-. Modelos Apple são nativos do OS —
 * não requerem encapsulamento adicional.
 *
 * Referência: v1.15.0 device autonomy (auditoria 2026-05-21).
 * ADRs relacionados: ADR-010 (MobileCLIP), ADR-011 (iOS Spotlight),
 * APPLE_NATIVE_ROADMAP.md (v1.3→v1.5).
 */

'use strict';

/**
 * Mapa canônico de modelos Apple por plataforma e versão mínima de OS.
 * Usado por platform-detect.js para determinar capabilities disponíveis.
 */
const APPLE_MODEL_MATRIX = {
  mac: {
    minOS: '14.0',
    description: 'ZeusDaemonMac (arm64 codesigned) — full Apple ecosystem',
    models: {
      foundationModels: {
        minOS: '14.0',
        framework: 'FoundationModels',
        endpoints: ['/v1/summarize', '/v1/enrich', '/v1/agent', '/v1/classify',
          '/v1/prompt', '/v1/refine', '/v1/afm/refine', '/v1/hyde', '/v1/graph/extract'],
        quality: 'high',
        requiresAppleIntelligence: true,
      },
      nlContextualEmbedding: {
        minOS: '10.15',
        framework: 'NaturalLanguage',
        endpoint: '/v1/embed',
        dim: 512,
        languages: ['pt-BR', 'en', 'es', 'fr', 'de', 'it', 'ja', 'zh', 'ko'],
      },
      nlTagger: {
        minOS: '10.15',
        framework: 'NaturalLanguage',
        endpoints: ['/v1/nl/tag', '/v1/nl/sentiment', '/v1/nl/language-detect'],
      },
      vision: {
        minOS: '10.15',
        framework: 'Vision',
        endpoints: ['/v1/ocr', '/v1/vision/classify', '/v1/vision/landmarks',
          '/v1/vision/saliency', '/v1/vision/barcode', '/v1/vision/document',
          '/v1/vision/feature-print', '/v1/vision/aesthetics'],
      },
      speech: {
        minOS: '10.15',
        framework: 'Speech',
        engines: ['SpeechAnalyzer (macOS 26+)', 'SFSpeechRecognizer (macOS 10.15+)'],
        endpoints: ['/v1/asp/transcribe', '/v1/asp/vad'],
      },
      translation: {
        minOS: '14.0',
        framework: 'Translation',
        endpoint: '/v1/translate',
        note: 'TranslationSession (macOS 14+)',
      },
      coreSpotlight: {
        minOS: '10.13',
        framework: 'CoreSpotlight',
        endpoints: ['/v1/spotlight/index', '/v1/spotlight/query', '/v1/spotlight/purge',
          '/v1/spotlight/search'],
      },
      mobileCLIP: {
        minOS: '14.0',
        framework: 'CoreML',
        endpoints: ['/v1/mobileclip/embed-image', '/v1/mobileclip/embed-text',
          '/v1/mobileclip/status'],
        status: 'stub-v1.9',
        runtimeStatus: 'v2.0-labs',
      },
    },
  },

  ios: {
    minOS: '17.0',
    description: 'AegisDaemon (embedded em app host iOS) — Apple on-device intelligence',
    models: {
      foundationModels: {
        minOS: '26.0',
        framework: 'FoundationModels',
        endpoints: ['/v1/summarize', '/v1/enrich', '/v1/agent', '/v1/classify',
          '/v1/prompt', '/v1/refine', '/v1/afm/refine', '/v1/hyde', '/v1/graph/extract'],
        quality: 'high',
        requiresAppleIntelligence: true,
        note: 'iPhone 16+/iPad Pro M4+ com Apple Intelligence ativo',
      },
      gemma4: {
        minOS: '26.0',
        framework: 'mlx-swift',
        variants: { iphone: 'E2B', ipad: 'E4B' },
        quality: 'high',
        requiresAppleIntelligence: false,
        status: 'v1.0.0-planned',
        note: 'iPhone 15 (A16) / iPad Air gen 4 (A14) — sem Apple Intelligence',
      },
      nlContextualEmbedding: {
        minOS: '17.0',
        framework: 'NaturalLanguage',
        endpoint: '/v1/embed',
        dim: 512,
      },
      nlTagger: {
        minOS: '13.0',
        framework: 'NaturalLanguage',
        endpoints: ['/v1/nl/tag', '/v1/nl/sentiment', '/v1/nl/language-detect'],
        note: 'v1.15.0: implementado (antes unsupported)',
      },
      vision: {
        minOS: '13.0',
        framework: 'Vision',
        endpoints: ['/v1/ocr', '/v1/vision/classify', '/v1/vision/landmarks',
          '/v1/vision/saliency', '/v1/vision/barcode', '/v1/vision/document'],
        note: 'v1.15.0: saliency/barcode/document implementados (antes unsupported)',
      },
      speech: {
        minOS: '10.0',
        framework: 'Speech',
        engines: ['SpeechAnalyzer (iOS 26+)', 'SFSpeechRecognizer (iOS 10+)'],
        endpoints: ['/v1/asp/transcribe', '/v1/asp/vad'],
      },
      translation: {
        minOS: '17.4',
        framework: 'Translation',
        endpoint: '/v1/translate',
        note: 'v1.15.0: implementado (antes unsupported)',
      },
      coreSpotlight: {
        minOS: '9.0',
        framework: 'CoreSpotlight',
        endpoints: ['/v1/spotlight/index', '/v1/spotlight/query', '/v1/spotlight/purge'],
        note: 'ADR-011 v1.13.0 — CSSearchableIndex nativo iOS',
      },
    },
  },

  // Fallback JS puro (sem daemon — iOS < 17 ou sem app host)
  jsRuntime: {
    description: 'JS puro sem daemon — iOS legado ou sem app host',
    models: {
      lexicalSearch: {
        impl: 'lib/lexical-ios.js',
        algorithm: 'BM25 persistido com stems pt-BR',
        latency: '10-20ms',
      },
      passportExtract: {
        impl: 'lib/passport-ios.js',
        quality: '~60-70% vs FoundationModels',
        modelVersion: 'zeus-ios-1.15.0',
      },
      zeusEmbedRuntime: {
        impl: 'lib/zeus-embed-runtime.js',
        model: 'zeus-multilingual-e5-small',
        dim: 384,
        status: 'opt-in (zeus-embed-install necessário)',
        encapsulamento: 'internalizado (sem CDN externo)',
      },
    },
  },
};

/**
 * Retorna as capabilities disponíveis para um device/OS específico.
 * @param {string} deviceClass - 'mac'|'iphone'|'ipad'|'unknown'
 * @param {string} osVersion - semver string ex: "26.0"
 * @param {boolean} [fmAvailable] - resultado de /v1/health probe
 * @returns {object} capabilities filtradas por versão mínima
 */
function getCapabilitiesForDevice(deviceClass, osVersion, fmAvailable) {
  const { versionGte } = require('./platform-detect');
  const platform = deviceClass === 'mac' ? 'mac' : 'ios';
  const matrix = APPLE_MODEL_MATRIX[platform] || APPLE_MODEL_MATRIX.jsRuntime;

  const available = {};
  for (const [name, model] of Object.entries(matrix.models || {})) {
    if (model.minOS && !versionGte(osVersion, model.minOS)) continue;
    if (model.requiresAppleIntelligence && fmAvailable === false) continue;
    available[name] = model;
  }
  return {
    platform,
    deviceClass,
    osVersion,
    available,
    daemonRequired: platform === 'mac' || Object.keys(available).some(k =>
      k !== 'lexicalSearch' && k !== 'passportExtract' && k !== 'zeusEmbedRuntime'),
  };
}

module.exports = {
  APPLE_MODEL_MATRIX,
  getCapabilitiesForDevice,
};
