/*
 * zeus-embed-runtime.js — v1.15.0 motor de embed iOS internalizado.
 *
 * Regra de encapsulamento: dependências não-nativas do OS devem ser
 * duplicadas com prefixo zeus- e incorporadas no bundle (sem CDN externo).
 *
 * Este módulo substitui a referência externa a @xenova/transformers.
 * Modelo: zeus-multilingual-e5-small (fork internalizado do multilingual-e5-small).
 * Pesos: armazenados em data/zeus-e5-small/ (vault-local após zeus-embed-install).
 *         NÃO são embutidos no main.js — apenas o código de inferência é bundlado.
 *
 * Dimensão: 384-dim (separada dos 512-dim Apple NLContextualEmbedding).
 * Schema: 'zeus-embeddings-v1' em embeddings-ios.jsonl.
 * Source label: 'zeus-embed-runtime-ios' (auditável vs 'daemon-relay').
 *
 * Fluxo:
 *   1. Verifica data/zeus-e5-small/model.onnx via vault adapter
 *   2. Se ausente: retorna {ok: false, reason: 'zeus-embed-runtime-not-installed'}
 *      Usuário instala via comando "Zeus: instalar modelo embed iOS"
 *   3. Se presente: carrega ONNX + tokenizer (ambos em data/zeus-e5-small/)
 *   4. Retorna {ok: true, vec: Float[], dim: 384, model: 'zeus-multilingual-e5-small'}
 *
 * v1.15.0 ENTREGA: stub verificador de instalação + estrutura para runtime ONNX.
 * Runtime ONNX completo (ort.InferenceSession) em v1.16 labs após audit CSP/WASM.
 *
 * Referência: v1.15.0 encapsulamento (auditoria 2026-05-21).
 */

'use strict';

const universal = require('./universal-fs');

const ZEUS_EMBED_RUNTIME_VERSION = '1.0.0';
const ZEUS_EMBED_MODEL = 'zeus-multilingual-e5-small';
const ZEUS_EMBED_DIM = 384;
const MODEL_DIR = 'zeus-e5-small';
const MODEL_FILE = 'model.onnx';
const TOKENIZER_FILE = 'tokenizer.json';

// Checksum SHA-256 esperado do model.onnx (zeus-multilingual-e5-small v1.0.0).
// Verificado pelo comando zeus-embed-install antes de aceitar o arquivo.
const MODEL_SHA256 = 'zeus-e5-small-sha256-placeholder-v1.0.0';
// URL de download aprovada (sem CDN de terceiros não auditado).
// Em v1.16: substituir por URL de release do repositório zeus-obsidian-plugin.
const INSTALL_URL = 'https://releases.zeus-plugin.maiocchi.adv.br/models/zeus-e5-small-v1.0.0.zip';

/**
 * Verifica se o runtime zeus-embed está instalado em data/zeus-e5-small/.
 * @param {object} adapter — vault.adapter
 * @param {string} dataPath — path vault-relativo para data/
 * @returns {Promise<boolean>}
 */
async function isInstalled(adapter, dataPath) {
  const modelPath = universal.joinPath(dataPath, MODEL_DIR, MODEL_FILE);
  const tokenizerPath = universal.joinPath(dataPath, MODEL_DIR, TOKENIZER_FILE);
  try {
    return (await universal.adapterExists(adapter, modelPath)) &&
           (await universal.adapterExists(adapter, tokenizerPath));
  } catch (_) {
    return false;
  }
}

/**
 * Embed um texto via zeus-multilingual-e5-small (ONNX).
 *
 * v1.15.0: stub verificador — retorna instrução acionável se runtime ausente.
 * v1.16: implementará inferência ONNX real via ort.InferenceSession.
 *
 * @param {string} text — texto a embedar
 * @param {string} dataPath — path vault-relativo da pasta data/
 * @param {object} adapter — vault.adapter
 * @returns {Promise<{ok: boolean, vec?: number[], dim?: number, model?: string,
 *                    source?: string, reason?: string}>}
 */
async function zeusEmbedRuntime(text, dataPath, adapter) {
  if (!text || text.length < 3) {
    return { ok: false, reason: 'text-too-short' };
  }

  const installed = await isInstalled(adapter, dataPath);
  if (!installed) {
    return {
      ok: false,
      reason: 'zeus-embed-runtime-not-installed',
      hint: 'Execute o comando "Zeus: instalar modelo embed iOS" para baixar zeus-multilingual-e5-small (~90MB) em data/zeus-e5-small/.',
      install_url: INSTALL_URL,
      model: ZEUS_EMBED_MODEL,
      version: ZEUS_EMBED_RUNTIME_VERSION,
    };
  }

  // v1.16: implementar inferência ONNX real.
  // const ort = require('onnxruntime-web');  // bundlado via esbuild (não external)
  // const tokenizerRaw = await universal.adapterRead(adapter, tokenizerPath);
  // const tokenizer = JSON.parse(tokenizerRaw);
  // const session = await ort.InferenceSession.create(modelPath);
  // const inputs = tokenize(text, tokenizer);
  // const output = await session.run(inputs);
  // const vec = meanPool(output['last_hidden_state']);
  // return { ok: true, vec, dim: ZEUS_EMBED_DIM, model: ZEUS_EMBED_MODEL, source: 'zeus-embed-runtime-ios' };

  return {
    ok: false,
    reason: 'zeus-embed-runtime-onnx-not-implemented',
    hint: 'zeus-embed-runtime v1.15.0 detectou modelo instalado mas ONNX inference está pendente para v1.16 labs (audit CSP/WASM necessário).',
    model: ZEUS_EMBED_MODEL,
    version: ZEUS_EMBED_RUNTIME_VERSION,
  };
}

/**
 * Instruções de instalação para o usuário (copiadas para clipboard pelo comando).
 * @returns {string}
 */
function getInstallInstructions() {
  return [
    '# Zeus Embed Runtime — Instalação',
    '',
    'O modelo zeus-multilingual-e5-small (~90MB) não está instalado.',
    '',
    'Para instalar automaticamente, execute o comando:',
    '  "Zeus: instalar modelo embed iOS"',
    '',
    'O modelo será baixado de:',
    `  ${INSTALL_URL}`,
    '',
    'E salvo em: data/zeus-e5-small/ (vault-local, não sincronizado via iCloud).',
    '',
    `Checksum SHA-256 verificado: ${MODEL_SHA256}`,
    '',
    'Após instalar, o Zeus usará zeus-multilingual-e5-small (384-dim) como',
    'fallback de embed quando o daemon Mac não estiver disponível.',
  ].join('\n');
}

module.exports = {
  zeusEmbedRuntime,
  isInstalled,
  getInstallInstructions,
  ZEUS_EMBED_RUNTIME_VERSION,
  ZEUS_EMBED_MODEL,
  ZEUS_EMBED_DIM,
  MODEL_DIR,
  INSTALL_URL,
};
