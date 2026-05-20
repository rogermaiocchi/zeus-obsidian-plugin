#!/usr/bin/env node
// zeus-smoke.mjs — smoke test end-to-end do daemon Apple-nativo.
//
// Pré-condição: daemon respondendo em 127.0.0.1:2223 (rode `npm run doctor`).
// Exercita os endpoints mais críticos: /v1/health, /v1/embed, /v1/refine, /v1/tools.
//
// Exit 0 = todos os asserts passaram. Caso contrário, exit 1 com diagnóstico.

const BASE = process.env.ZEUS_DAEMON_URL || 'http://127.0.0.1:2223';

async function req(method, path, body, timeoutMs = 60000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, text, json };
  } finally {
    clearTimeout(timer);
  }
}

const results = [];
function assert(name, cond, detail) { results.push({ name, ok: !!cond, detail: detail || '' }); }

async function main() {
  console.log(`zeus smoke — ${BASE}`);
  console.log('='.repeat(40));

  // 1. /v1/health
  try {
    const h = await req('GET', '/v1/health');
    assert('/v1/health 200', h.status === 200, `status ${h.status}`);
    assert('/v1/health fm_available=true', h.json && h.json.fm_available === true, `fm_available=${h.json?.fm_available}`);
    assert('/v1/health nl_available=true', h.json && h.json.nl_available === true, `nl_available=${h.json?.nl_available}`);
  } catch (e) { assert('/v1/health reachable', false, e.message); }

  // 2. /v1/embed → 512-dim NLContextualEmbedding
  try {
    const r = await req('POST', '/v1/embed', { text: 'O Zeus é um plugin Apple-nativo para Obsidian.' });
    const v = r.json && (r.json.vectors?.[0] || r.json.vector);
    assert('/v1/embed 200', r.status === 200, `status ${r.status}`);
    assert('/v1/embed dim==512', Array.isArray(v) && v.length === 512, `dim=${v?.length}`);
  } catch (e) { assert('/v1/embed', false, e.message); }

  // 3. /v1/tools — listagem MCP
  try {
    const r = await req('GET', '/v1/tools');
    const n = (r.json && r.json.tools && r.json.tools.length) || 0;
    assert('/v1/tools 200', r.status === 200, `status ${r.status}`);
    assert('/v1/tools count>0', n > 0, `${n} tools`);
  } catch (e) { assert('/v1/tools', false, e.message); }

  // 4. /v1/refine — Writing Tools nativo v1.4+. Opcional (cold path; FM precisa estar ativo).
  try {
    const r = await req('POST', '/v1/refine', { text: 'isso e um teste', instructions: 'corrige ortografia', language: 'pt' }, 90000);
    if (r.status === 503) {
      console.log('  (skip /v1/refine — daemon reportou FM indisponível)');
    } else {
      assert('/v1/refine 200', r.status === 200, `status ${r.status}`);
      const refined = r.json && (r.json.refined_text || r.json.text || r.json.output);
      assert('/v1/refine non-empty', typeof refined === 'string' && refined.length > 0, `refined=${refined?.slice(0, 40)}`);
    }
  } catch (e) { assert('/v1/refine', false, e.message); }

  // Summary
  console.log();
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name.padEnd(28)} ${r.detail}`);
  }
  const failed = results.filter(r => !r.ok).length;
  console.log();
  console.log(`resumo: ${results.length - failed}/${results.length} asserts passaram`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('[smoke] ✗', e.message); process.exit(1); });
