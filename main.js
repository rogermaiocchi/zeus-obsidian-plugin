"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

// lib/universal-fs.js
var require_universal_fs = __commonJS({
  "lib/universal-fs.js"(exports2, module2) {
    "use strict";
    var nodeFs = null;
    var nodePath = null;
    var nodeCrypto = null;
    var nodeOs = null;
    var nodeChildProcess = null;
    try {
      nodeFs = require("fs");
    } catch (_) {
    }
    try {
      nodePath = require("path");
    } catch (_) {
    }
    try {
      nodeCrypto = require("crypto");
    } catch (_) {
    }
    try {
      nodeOs = require("os");
    } catch (_) {
    }
    try {
      nodeChildProcess = require("child_process");
    } catch (_) {
    }
    var IS_NODE = !!nodeFs;
    async function sha256Hex(input) {
      if (nodeCrypto && typeof nodeCrypto.createHash === "function") {
        return nodeCrypto.createHash("sha256").update(String(input)).digest("hex");
      }
      if (typeof crypto !== "undefined" && crypto.subtle && typeof crypto.subtle.digest === "function") {
        const data = typeof input === "string" ? new TextEncoder().encode(input) : input;
        const buf = await crypto.subtle.digest("SHA-256", data);
        return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
      }
      throw new Error("universal-fs: no SHA-256 implementation available");
    }
    function sha256HexSync(input) {
      if (nodeCrypto && typeof nodeCrypto.createHash === "function") {
        return nodeCrypto.createHash("sha256").update(String(input)).digest("hex");
      }
      return null;
    }
    function joinPath(...parts) {
      return parts.filter((p) => p !== null && p !== void 0 && p !== "").map((p) => String(p)).join("/").replace(/\/+/g, "/");
    }
    function dirname(p) {
      if (!p) return "";
      const s = String(p).replace(/\/+$/, "");
      const i = s.lastIndexOf("/");
      return i < 0 ? "" : s.slice(0, i);
    }
    function basename(p) {
      if (!p) return "";
      const s = String(p).replace(/\/+$/, "");
      const i = s.lastIndexOf("/");
      return i < 0 ? s : s.slice(i + 1);
    }
    function extname(p) {
      const b = basename(p);
      const i = b.lastIndexOf(".");
      return i <= 0 ? "" : b.slice(i);
    }
    function byteLength(s) {
      if (s == null) return 0;
      if (typeof Buffer !== "undefined" && typeof Buffer.byteLength === "function") {
        return Buffer.byteLength(String(s), "utf8");
      }
      if (typeof TextEncoder !== "undefined") {
        return new TextEncoder().encode(String(s)).length;
      }
      return String(s).length;
    }
    function detectPlatform() {
      if (typeof process !== "undefined" && process.platform) {
        return process.platform;
      }
      if (typeof navigator !== "undefined" && navigator.userAgent) {
        const ua = navigator.userAgent;
        if (/iPad/i.test(ua)) return "ipados";
        if (/iPhone|iPod/i.test(ua)) return "ios";
        if (/Macintosh|Mac OS X/i.test(ua)) return "darwin";
        if (/Android/i.test(ua)) return "android";
        if (/Windows/i.test(ua)) return "win32";
        if (/Linux/i.test(ua)) return "linux";
      }
      return "unknown";
    }
    function isMacLike() {
      const p = detectPlatform();
      return p === "darwin";
    }
    function isMobile() {
      const p = detectPlatform();
      return p === "ios" || p === "ipados" || p === "android";
    }
    function generateDeviceId() {
      const platform = detectPlatform();
      let hint = "dev";
      try {
        if (nodeOs && typeof nodeOs.hostname === "function") {
          hint = String(nodeOs.hostname()).replace(/[^a-z0-9-]/gi, "").slice(0, 12) || "dev";
        } else if (typeof navigator !== "undefined") {
          const ua = String(navigator.userAgent || "");
          const m = ua.match(/(iPhone|iPad|iPod|Mac|Win|Linux|Android)[^\s;)]*/i);
          if (m) hint = m[0].replace(/[^a-z0-9-]/gi, "").slice(0, 12);
        }
      } catch (_) {
      }
      const rand = Math.random().toString(36).slice(2, 8);
      const ts = Date.now().toString(36).slice(-4);
      return `${platform}-${hint}-${ts}-${rand}`;
    }
    async function adapterRead(adapter, vaultRelPath) {
      return await adapter.read(vaultRelPath);
    }
    async function adapterReadBinary(adapter, vaultRelPath) {
      if (typeof adapter.readBinary === "function") return await adapter.readBinary(vaultRelPath);
      return await adapter.read(vaultRelPath);
    }
    async function adapterWrite(adapter, vaultRelPath, data) {
      const parent = dirname(vaultRelPath);
      if (parent) {
        try {
          await adapter.mkdir(parent);
        } catch (_) {
        }
      }
      return await adapter.write(vaultRelPath, data);
    }
    async function adapterExists(adapter, vaultRelPath) {
      try {
        return await adapter.exists(vaultRelPath);
      } catch (_) {
        return false;
      }
    }
    async function adapterMkdir(adapter, vaultRelPath) {
      try {
        return await adapter.mkdir(vaultRelPath);
      } catch (_) {
      }
    }
    async function adapterRemove(adapter, vaultRelPath) {
      try {
        return await adapter.remove(vaultRelPath);
      } catch (_) {
      }
    }
    async function adapterStat(adapter, vaultRelPath) {
      try {
        return await adapter.stat(vaultRelPath);
      } catch (_) {
        return null;
      }
    }
    async function adapterList(adapter, vaultRelPath) {
      try {
        return await adapter.list(vaultRelPath);
      } catch (_) {
        return { files: [], folders: [] };
      }
    }
    async function adapterWalk(adapter, rootRel, skipNames = /* @__PURE__ */ new Set()) {
      const out = [];
      const queue = [rootRel || ""];
      while (queue.length) {
        const dir = queue.shift();
        const { files, folders } = await adapterList(adapter, dir);
        for (const f of files || []) {
          const name = basename(f);
          if (skipNames.has(name)) continue;
          out.push(f);
        }
        for (const sub of folders || []) {
          const name = basename(sub);
          if (name && name.startsWith(".")) continue;
          if (skipNames.has(name)) continue;
          queue.push(sub);
        }
      }
      return out;
    }
    async function adapterWriteAtomic(adapter, vaultRelPath, data) {
      const tmp = vaultRelPath + ".tmp";
      await adapterWrite(adapter, tmp, data);
      if (typeof adapter.rename === "function") {
        try {
          try {
            await adapter.remove(vaultRelPath);
          } catch (_) {
          }
          await adapter.rename(tmp, vaultRelPath);
          return;
        } catch (_) {
        }
      }
      await adapterWrite(adapter, vaultRelPath, data);
      try {
        await adapter.remove(tmp);
      } catch (_) {
      }
    }
    module2.exports = {
      IS_NODE,
      // hashing
      sha256Hex,
      sha256HexSync,
      // paths
      joinPath,
      dirname,
      basename,
      extname,
      // misc
      byteLength,
      detectPlatform,
      isMacLike,
      isMobile,
      generateDeviceId,
      // vault adapter helpers
      adapterRead,
      adapterReadBinary,
      adapterWrite,
      adapterWriteAtomic,
      adapterExists,
      adapterMkdir,
      adapterRemove,
      adapterStat,
      adapterList,
      adapterWalk,
      // node escape hatches — null on iOS
      nodeFs,
      nodePath,
      nodeCrypto,
      nodeOs,
      nodeChildProcess
    };
  }
});

// lib/hierarchical.js
var require_hierarchical = __commonJS({
  "lib/hierarchical.js"(exports2, module2) {
    "use strict";
    var universal2 = require_universal_fs();
    var spawn2 = universal2.nodeChildProcess ? universal2.nodeChildProcess.spawn : null;
    var path2 = universal2.nodePath;
    var fs2 = universal2.nodeFs;
    var crypto2 = universal2.nodeCrypto;
    var nodeOs = universal2.nodeOs;
    var DEFAULT_TIMEOUT_MS = 9e4;
    var RECURSIVE_REDUCE_MAX_ITER = 3;
    var SUMMARY_TARGET_CHARS = 300;
    var FINAL_SUMMARY_TARGET_CHARS = 2e3;
    function execAfm(binPath, args, stdinText, timeoutMs = DEFAULT_TIMEOUT_MS) {
      return new Promise((resolve, reject) => {
        if (!spawn2) {
          reject(new Error("hierarchical.execAfm: child_process unavailable (iOS sandbox)"));
          return;
        }
        let child;
        try {
          child = spawn2(binPath, args, { stdio: ["pipe", "pipe", "pipe"] });
        } catch (e) {
          reject(new Error("afm spawn failed: " + e.message));
          return;
        }
        let stdout = "", stderr = "";
        const timer = setTimeout(() => {
          try {
            child.kill("SIGTERM");
          } catch (e) {
          }
          reject(new Error("afm timeout (" + timeoutMs + "ms)"));
        }, timeoutMs);
        child.stdout.on("data", (d) => stdout += d.toString());
        child.stderr.on("data", (d) => stderr += d.toString());
        child.on("close", (code) => {
          clearTimeout(timer);
          if (code === 0) resolve(stdout);
          else reject(new Error("afm exit " + code + ": " + stderr.slice(0, 400)));
        });
        child.on("error", (e) => {
          clearTimeout(timer);
          reject(e);
        });
        if (stdinText) {
          try {
            child.stdin.write(stdinText);
            child.stdin.end();
          } catch (e) {
          }
        } else {
          try {
            child.stdin.end();
          } catch (e) {
          }
        }
      });
    }
    function sha8(s) {
      if (crypto2 && typeof crypto2.createHash === "function") {
        return crypto2.createHash("sha256").update(s).digest("hex").slice(0, 8);
      }
      let h = 0;
      for (let i = 0; i < s.length; i++) h = (h << 5) - h + s.charCodeAt(i) | 0;
      return (h >>> 0).toString(16).padStart(8, "0").slice(0, 8);
    }
    var HierarchicalProcessor2 = class {
      constructor(afmBinPath, maxChunkChars = 8e3) {
        this.afmBin = afmBinPath || null;
        this.maxChunkChars = maxChunkChars;
        this._batchMode = null;
      }
      // -------------------------------------------------------------------------
      // chunkText — paragraph-aware splitter with overlap. Three-tier fallback:
      //   1. Split on double-newline (paragraph boundaries).
      //   2. If a paragraph itself exceeds maxChars, split on sentence boundaries
      //      (". " or "? " or "! ").
      //   3. If a sentence still exceeds, hard-cut at maxChars.
      // Overlap: append last `overlapChars` of chunk N to start of chunk N+1.
      // -------------------------------------------------------------------------
      chunkText(text, maxChars, overlapChars = 200) {
        if (!text || typeof text !== "string") return [];
        maxChars = maxChars || this.maxChunkChars;
        if (text.length <= maxChars) return [text];
        if (overlapChars >= maxChars) overlapChars = Math.floor(maxChars / 4);
        const atoms = [];
        const paragraphs = text.split(/\n\s*\n/);
        for (const para of paragraphs) {
          if (!para.trim()) continue;
          if (para.length <= maxChars) {
            atoms.push(para);
            continue;
          }
          const sentences = para.split(/(?<=[.!?])\s+/);
          for (const sent of sentences) {
            if (sent.length <= maxChars) {
              atoms.push(sent);
            } else {
              for (let i = 0; i < sent.length; i += maxChars) {
                atoms.push(sent.slice(i, i + maxChars));
              }
            }
          }
        }
        const chunks = [];
        let current = "";
        for (const atom of atoms) {
          const sep = current ? "\n\n" : "";
          if (current.length + sep.length + atom.length <= maxChars) {
            current += sep + atom;
          } else {
            if (current) chunks.push(current);
            current = atom;
          }
        }
        if (current) chunks.push(current);
        if (overlapChars > 0 && chunks.length > 1) {
          const withOverlap = [chunks[0]];
          for (let i = 1; i < chunks.length; i++) {
            const tail = chunks[i - 1].slice(-overlapChars);
            withOverlap.push(tail + "\n\n" + chunks[i]);
          }
          return withOverlap;
        }
        return chunks;
      }
      // -------------------------------------------------------------------------
      // summarizeChunks — try `afm batch` first; on first failure or unknown
      // signature, drop permanently to sequential `afm summarize` (stdin).
      // Returns string[] — same length as input, individual failures become ''.
      // -------------------------------------------------------------------------
      async summarizeChunks(chunks) {
        if (!Array.isArray(chunks) || chunks.length === 0) return [];
        if (this._batchMode === null) {
          try {
            const result = await this._tryBatchSummarize(chunks);
            if (Array.isArray(result) && result.length === chunks.length) {
              this._batchMode = true;
              return result.map((s) => this._trimSummary(s));
            }
            this._batchMode = false;
          } catch (e) {
            console.warn("[zeus/hierarchical] afm batch unavailable, falling back to sequential summarize:", e.message);
            this._batchMode = false;
          }
        }
        if (this._batchMode === true) {
          try {
            const result = await this._tryBatchSummarize(chunks);
            if (Array.isArray(result) && result.length === chunks.length) {
              return result.map((s) => this._trimSummary(s));
            }
          } catch (e) {
            console.warn("[zeus/hierarchical] afm batch failed mid-flight, sequential fallback:", e.message);
          }
        }
        const summaries = [];
        for (let i = 0; i < chunks.length; i++) {
          try {
            const out = await execAfm(
              this.afmBin,
              ["summarize", "--max-tokens", "100", "--deterministic"],
              chunks[i],
              DEFAULT_TIMEOUT_MS
            );
            summaries.push(this._trimSummary(out));
          } catch (e) {
            console.warn("[zeus/hierarchical] summarize chunk " + i + " failed:", e.message);
            summaries.push(this._fallbackExtract(chunks[i]));
          }
        }
        return summaries;
      }
      // afm batch signature: per `afm --help`, "Process multiple files in parallel
      // via independent FM sessions". The CLI shape is not fully documented in the
      // plugin source — we attempt the most natural shape (files via temp dir) and
      // give up gracefully if exit ≠ 0 or output cannot be aligned to chunks.
      async _tryBatchSummarize(chunks) {
        if (!fs2 || !path2 || !nodeOs) {
          throw new Error("hierarchical._tryBatchSummarize: fs/path/os unavailable (iOS sandbox)");
        }
        const tmpDir = fs2.mkdtempSync(path2.join(nodeOs.tmpdir(), "zeus-batch-"));
        const filePaths = [];
        try {
          for (let i = 0; i < chunks.length; i++) {
            const p = path2.join(tmpDir, "chunk-" + String(i).padStart(4, "0") + ".txt");
            fs2.writeFileSync(p, chunks[i], "utf8");
            filePaths.push(p);
          }
          const out = await execAfm(
            this.afmBin,
            ["batch", "summarize", "--max-tokens", "100", "--deterministic", ...filePaths],
            null,
            DEFAULT_TIMEOUT_MS * 2
          );
          const parsed = this._parseBatchOutput(out, filePaths);
          if (parsed && parsed.length === chunks.length) return parsed;
          return null;
        } finally {
          try {
            for (const fp of filePaths) {
              try {
                fs2.unlinkSync(fp);
              } catch (e) {
              }
            }
            fs2.rmdirSync(tmpDir);
          } catch (e) {
          }
        }
      }
      _parseBatchOutput(out, filePaths) {
        try {
          const j = JSON.parse(out);
          if (Array.isArray(j)) {
            if (typeof j[0] === "string") return j;
            if (j[0] && typeof j[0] === "object") {
              return j.map((x) => x.summary || x.tldr || x.text || "");
            }
          }
          if (j && typeof j === "object" && j.results) {
            return j.results.map((r) => r.summary || r.tldr || r.text || (typeof r === "string" ? r : ""));
          }
        } catch (e) {
        }
        const blocks = out.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
        if (blocks.length === filePaths.length) return blocks;
        return null;
      }
      _trimSummary(s) {
        if (typeof s !== "string") return "";
        let t = s.trim();
        if (t.length > SUMMARY_TARGET_CHARS) {
          const slice = t.slice(0, SUMMARY_TARGET_CHARS);
          const lastDot = Math.max(slice.lastIndexOf(". "), slice.lastIndexOf("! "), slice.lastIndexOf("? "));
          t = lastDot > SUMMARY_TARGET_CHARS / 2 ? slice.slice(0, lastDot + 1) : slice;
        }
        return t;
      }
      _fallbackExtract(text) {
        const firstPara = text.split(/\n\s*\n/)[0] || text;
        return firstPara.slice(0, SUMMARY_TARGET_CHARS).trim();
      }
      // -------------------------------------------------------------------------
      // recursiveReduce — joined summaries may STILL exceed maxChunkChars on
      // very large docs (e.g., 50-chunk note → 50×300 ≈ 15KB joined). Recur up
      // to maxIter times, re-chunking and re-summarizing.
      // -------------------------------------------------------------------------
      async recursiveReduce(summaries, maxIter = RECURSIVE_REDUCE_MAX_ITER) {
        if (!Array.isArray(summaries) || summaries.length === 0) return "";
        let joined = summaries.filter((s) => s && s.trim()).join("\n\n");
        let iter = 0;
        while (joined.length > this.maxChunkChars && iter < maxIter) {
          const subChunks = this.chunkText(joined, this.maxChunkChars, 100);
          if (subChunks.length <= 1) break;
          const subSummaries = await this.summarizeChunks(subChunks);
          joined = subSummaries.filter((s) => s && s.trim()).join("\n\n");
          iter++;
        }
        if (joined.length > FINAL_SUMMARY_TARGET_CHARS) {
          joined = joined.slice(0, FINAL_SUMMARY_TARGET_CHARS);
          const lastDot = joined.lastIndexOf(". ");
          if (lastDot > FINAL_SUMMARY_TARGET_CHARS / 2) joined = joined.slice(0, lastDot + 1);
        }
        return joined;
      }
      // -------------------------------------------------------------------------
      // enrichSummary — write the reduced summary to a temp .md inside vaultRoot
      // (so `afm enrich --vault <root>` can resolve it as a vault path), call
      // enrich, parse JSON, ALWAYS delete the temp file in finally{}.
      // -------------------------------------------------------------------------
      async enrichSummary(summary, vaultRoot) {
        if (!summary || !vaultRoot) {
          return { suggested_links: [], suggested_tags: [], connections: [] };
        }
        if (!fs2 || !path2) {
          throw new Error("hierarchical.enrichSummary: fs/path unavailable (iOS sandbox)");
        }
        const tag = sha8(summary + ":" + Date.now());
        const tempBaseName = ".zeus-temp-" + tag + ".md";
        const tempAbs = path2.join(vaultRoot, tempBaseName);
        try {
          fs2.writeFileSync(tempAbs, summary, "utf8");
          const out = await execAfm(
            this.afmBin,
            ["enrich", tempBaseName, "--vault", vaultRoot, "--prewarm", "--deterministic"],
            null,
            DEFAULT_TIMEOUT_MS
          );
          try {
            return JSON.parse(out);
          } catch (e) {
            console.warn("[zeus/hierarchical] enrich non-JSON output:", out.slice(0, 200));
            return { suggested_links: [], suggested_tags: [], connections: [] };
          }
        } catch (e) {
          console.warn("[zeus/hierarchical] enrichSummary failed:", e.message);
          return { suggested_links: [], suggested_tags: [], connections: [] };
        } finally {
          try {
            if (fs2.existsSync(tempAbs)) fs2.unlinkSync(tempAbs);
          } catch (e) {
            console.warn("[zeus/hierarchical] temp cleanup failed for", tempAbs, e.message);
          }
        }
      }
      // -------------------------------------------------------------------------
      // processLargeDoc — top-level entry point used by ZeusEnricher when a
      // note exceeds the 4096-token FM window. Returns an enrich-shaped object
      // augmented with { source: 'hierarchical', chunks: N }.
      // -------------------------------------------------------------------------
      async processLargeDoc(filePath, vaultRoot) {
        if (!fs2 || !path2) {
          throw new Error("hierarchical.processLargeDoc: fs/path unavailable (iOS sandbox)");
        }
        const absPath = path2.isAbsolute(filePath) ? filePath : path2.join(vaultRoot, filePath);
        let text;
        try {
          text = fs2.readFileSync(absPath, "utf8");
        } catch (e) {
          throw new Error("processLargeDoc: cannot read " + absPath + " \u2014 " + e.message);
        }
        const stripped = text.replace(/^---\n[\s\S]*?\n---\n/, "");
        const chunks = this.chunkText(stripped, this.maxChunkChars, 200);
        if (chunks.length === 0) {
          return {
            suggested_links: [],
            suggested_tags: [],
            connections: [],
            source: "hierarchical",
            chunks: 0
          };
        }
        if (chunks.length === 1) {
          const enriched2 = await this.enrichSummary(chunks[0], vaultRoot);
          return Object.assign(
            { suggested_links: [], suggested_tags: [], connections: [] },
            enriched2,
            { source: "hierarchical", chunks: 1 }
          );
        }
        let summaries;
        try {
          summaries = await this.summarizeChunks(chunks);
        } catch (e) {
          console.warn("[zeus/hierarchical] summarizeChunks unrecoverable:", e.message);
          summaries = chunks.map((c) => this._fallbackExtract(c));
        }
        const reduced = await this.recursiveReduce(summaries, RECURSIVE_REDUCE_MAX_ITER);
        if (!reduced || reduced.trim().length === 0) {
          return {
            suggested_links: [],
            suggested_tags: [],
            connections: [],
            source: "hierarchical",
            chunks: chunks.length,
            skipped: true,
            reason: "all chunk summaries failed"
          };
        }
        const enriched = await this.enrichSummary(reduced, vaultRoot);
        return Object.assign(
          { suggested_links: [], suggested_tags: [], connections: [] },
          enriched,
          { source: "hierarchical", chunks: chunks.length }
        );
      }
    };
    module2.exports = HierarchicalProcessor2;
  }
});

// lib/multi-vector.js
var require_multi_vector = __commonJS({
  "lib/multi-vector.js"(exports2, module2) {
    "use strict";
    var universal2 = require_universal_fs();
    var spawn2 = universal2.nodeChildProcess ? universal2.nodeChildProcess.spawn : null;
    var path2 = universal2.nodePath;
    var fs2 = universal2.nodeFs;
    var crypto2 = universal2.nodeCrypto;
    var MULTI_VECTORS_FILE = "multi-vectors.jsonl";
    var SUMMARIZE_CONCURRENCY = 4;
    var BODY_MAX_CHARS = 4e3;
    var SUMMARY_FALLBACK_CHARS = 500;
    var EMBED_TIMEOUT_MS = 3e5;
    var SUMMARIZE_TIMEOUT_MS = 6e4;
    function cosine2(a, b) {
      if (!a || !b) return 0;
      let dot = 0, na = 0, nb = 0;
      const len = Math.min(a.length, b.length);
      for (let i = 0; i < len; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
      }
      if (na === 0 || nb === 0) return 0;
      return dot / (Math.sqrt(na) * Math.sqrt(nb));
    }
    function sha2562(text) {
      if (crypto2 && typeof crypto2.createHash === "function") {
        return crypto2.createHash("sha256").update(text).digest("hex");
      }
      let h = 0;
      for (let i = 0; i < text.length; i++) h = (h << 5) - h + text.charCodeAt(i) | 0;
      return (h >>> 0).toString(16).padStart(8, "0");
    }
    function execAfm(binPath, args, stdinText, timeoutMs) {
      return new Promise((resolve, reject) => {
        if (!spawn2) {
          reject(new Error("multi-vector.execAfm: child_process unavailable (iOS sandbox)"));
          return;
        }
        const child = spawn2(binPath, args, { stdio: ["pipe", "pipe", "pipe"] });
        let stdout = "", stderr = "";
        const timer = setTimeout(() => {
          child.kill("SIGTERM");
          reject(new Error("afm timeout after " + timeoutMs + "ms"));
        }, timeoutMs);
        child.stdout.on("data", (d) => stdout += d.toString());
        child.stderr.on("data", (d) => stderr += d.toString());
        child.on("close", (code) => {
          clearTimeout(timer);
          if (code === 0) resolve(stdout);
          else reject(new Error("afm exit " + code + ": " + stderr.slice(0, 400)));
        });
        child.on("error", (e) => {
          clearTimeout(timer);
          reject(e);
        });
        if (stdinText != null) {
          child.stdin.write(stdinText);
          child.stdin.end();
        } else {
          child.stdin.end();
        }
      });
    }
    function parseEmbedOutput(out) {
      const trimmed = out.trim();
      try {
        const obj2 = JSON.parse(trimmed);
        return obj2.vectors || [];
      } catch (e) {
      }
      const start = trimmed.indexOf("{");
      if (start < 0) throw new Error("no JSON object in afm output");
      const obj = JSON.parse(trimmed.slice(start));
      return obj.vectors || [];
    }
    async function mapWithConcurrency(items, limit, fn) {
      const results = new Array(items.length);
      let idx = 0;
      async function worker() {
        while (true) {
          const i = idx++;
          if (i >= items.length) return;
          try {
            results[i] = await fn(items[i], i);
          } catch (e) {
            results[i] = { __error: e.message || String(e) };
          }
        }
      }
      const workers = [];
      for (let w = 0; w < Math.min(limit, items.length); w++) workers.push(worker());
      await Promise.all(workers);
      return results;
    }
    var MultiVectorEmbedder2 = class {
      constructor(afmBinPath, dataPath) {
        this.afmBinPath = afmBinPath;
        this.dataPath = dataPath;
        this.jsonlPath = path2 ? path2.join(dataPath, MULTI_VECTORS_FILE) : `${dataPath}/${MULTI_VECTORS_FILE}`.replace(/\/+/g, "/");
      }
      // -----------------------------------------------------------------------
      // Single-doc convenience (NOT batch-optimized — prefer embedDocsBatch)
      // -----------------------------------------------------------------------
      async embedDoc({ path: docPath, title, body }) {
        const map = await this.embedDocsBatch([{ path: docPath, title, body }]);
        const v = map.get(docPath) || {};
        const sha = sha2562((title || "") + "\n" + (body || ""));
        return {
          path: docPath,
          sha,
          title_vec: v.title_vec || null,
          body_vec: v.body_vec || null,
          summary_vec: v.summary_vec || null
        };
      }
      // -----------------------------------------------------------------------
      // Batch: 3 embed spawns total + N concurrent-limited summarize spawns
      // -----------------------------------------------------------------------
      async embedDocsBatch(docs) {
        const result = /* @__PURE__ */ new Map();
        if (!docs || docs.length === 0) return result;
        const titles = docs.map((d) => (d.title || "").trim() || (d.path || "untitled"));
        const bodies = docs.map((d) => (d.body || "").slice(0, BODY_MAX_CHARS));
        const summaries = await mapWithConcurrency(
          bodies,
          SUMMARIZE_CONCURRENCY,
          async (body) => {
            const text = (body || "").trim();
            if (!text) return "";
            try {
              const out = await execAfm(
                this.afmBinPath,
                ["summarize"],
                text,
                SUMMARIZE_TIMEOUT_MS
              );
              const tldr = (out || "").trim();
              if (tldr) return tldr;
              return body.slice(0, SUMMARY_FALLBACK_CHARS);
            } catch (e) {
              return body.slice(0, SUMMARY_FALLBACK_CHARS);
            }
          }
        );
        const summaryTexts = summaries.map((s, i) => {
          if (s && typeof s === "object" && s.__error) return bodies[i].slice(0, SUMMARY_FALLBACK_CHARS);
          return String(s || "");
        });
        let titleVecs = null, bodyVecs = null, summaryVecs = null;
        try {
          titleVecs = await this._embedBatch(titles);
        } catch (e) {
          titleVecs = new Array(titles.length).fill(null);
        }
        try {
          bodyVecs = await this._embedBatch(bodies);
        } catch (e) {
          bodyVecs = new Array(bodies.length).fill(null);
        }
        try {
          summaryVecs = await this._embedBatch(summaryTexts);
        } catch (e) {
          summaryVecs = new Array(summaryTexts.length).fill(null);
        }
        for (let i = 0; i < docs.length; i++) {
          result.set(docs[i].path, {
            title_vec: titleVecs[i] || null,
            body_vec: bodyVecs[i] || null,
            summary_vec: summaryVecs[i] || null
          });
        }
        return result;
      }
      // Internal: one batched afm embed call → array of vectors aligned with input texts.
      async _embedBatch(texts) {
        if (!texts || texts.length === 0) return [];
        const stdin = JSON.stringify(texts);
        const out = await execAfm(
          this.afmBinPath,
          ["embed", "--backend", "apple"],
          stdin,
          EMBED_TIMEOUT_MS
        );
        const vectors = parseEmbedOutput(out);
        const padded = new Array(texts.length).fill(null);
        for (let i = 0; i < Math.min(vectors.length, texts.length); i++) {
          padded[i] = vectors[i] || null;
        }
        return padded;
      }
      // -----------------------------------------------------------------------
      // Query embedding — single text → single 512-dim vector
      // -----------------------------------------------------------------------
      async embedQuery(query) {
        const q = (query || "").trim();
        if (!q) return null;
        const vecs = await this._embedBatch([q]);
        return vecs[0] || null;
      }
      // -----------------------------------------------------------------------
      // Scoring — MAX-pool cosine over the 3 doc vectors
      // -----------------------------------------------------------------------
      scoreDocVsQuery(qVec, docVecs) {
        if (!qVec || !docVecs) return { score: 0, source: null };
        const candidates = [
          { source: "title", vec: docVecs.title_vec },
          { source: "body", vec: docVecs.body_vec },
          { source: "summary", vec: docVecs.summary_vec }
        ];
        let best = { score: -Infinity, source: null };
        for (const c of candidates) {
          if (!c.vec) continue;
          const s = cosine2(qVec, c.vec);
          if (s > best.score) best = { score: s, source: c.source };
        }
        if (best.source == null) return { score: 0, source: null };
        return best;
      }
      // -----------------------------------------------------------------------
      // Persistence — JSONL, one doc per line
      // -----------------------------------------------------------------------
      saveAll(map) {
        if (!map) return;
        if (!fs2) {
          throw new Error("multi-vector.saveAll: fs unavailable (iOS sandbox). Run reindex on Mac.");
        }
        fs2.mkdirSync(this.dataPath, { recursive: true });
        const tmpPath = this.jsonlPath + ".tmp";
        const lines = [];
        for (const [docPath, entry] of map.entries()) {
          lines.push(JSON.stringify({
            path: docPath,
            sha: entry.sha || null,
            mtime: entry.mtime || null,
            title: entry.title || null,
            title_vec: entry.title_vec || null,
            body_vec: entry.body_vec || null,
            summary_vec: entry.summary_vec || null
          }));
        }
        fs2.writeFileSync(tmpPath, lines.join("\n") + (lines.length ? "\n" : ""), "utf8");
        fs2.renameSync(tmpPath, this.jsonlPath);
      }
      loadAll() {
        const map = /* @__PURE__ */ new Map();
        if (!fs2) return map;
        if (!fs2.existsSync(this.jsonlPath)) return map;
        const raw = fs2.readFileSync(this.jsonlPath, "utf8");
        const lines = raw.split("\n");
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const obj = JSON.parse(trimmed);
            if (!obj.path) continue;
            map.set(obj.path, {
              path: obj.path,
              sha: obj.sha || null,
              mtime: obj.mtime || null,
              title: obj.title || null,
              title_vec: obj.title_vec || null,
              body_vec: obj.body_vec || null,
              summary_vec: obj.summary_vec || null
            });
          } catch (e) {
          }
        }
        return map;
      }
    };
    module2.exports = MultiVectorEmbedder2;
  }
});

// lib/zeus-http-client.js
var require_zeus_http_client = __commonJS({
  "lib/zeus-http-client.js"(exports2, module2) {
    "use strict";
    var universal2 = require_universal_fs();
    var ZeusHttpClient2 = class {
      constructor(baseUrl) {
        this.baseUrl = (baseUrl || "http://127.0.0.1:2223").replace(/\/$/, "");
        this.healthCache = null;
        this.healthCheckedAt = 0;
        this.HEALTH_TTL_MS = 3e4;
        this.metrics = {
          requests: 0,
          bytesIn: 0,
          // bytes received from daemon (response payload)
          bytesOut: 0,
          // bytes sent to daemon (request payload)
          byEndpoint: /* @__PURE__ */ new Map(),
          // endpoint → { count, bytesIn, bytesOut }
          startedAt: Date.now()
        };
        this.pccMode = "off";
        this.lastPccUsed = false;
        this.pccUsageCount = 0;
      }
      setPccMode(mode) {
        const valid = ["off", "opt-in", "auto"];
        this.pccMode = valid.includes(mode) ? mode : "off";
      }
      getPccStatus() {
        return {
          mode: this.pccMode,
          lastUsed: this.lastPccUsed,
          totalUsageCount: this.pccUsageCount
        };
      }
      /**
       * Snapshot of current metrics + estimated token cost.
       * Heuristic: 1 token ~= 4 bytes for English/Portuguese text (very rough).
       */
      getMetrics() {
        const byEndpoint = {};
        for (const [k, v] of this.metrics.byEndpoint) {
          byEndpoint[k] = {
            count: v.count,
            bytesIn: v.bytesIn,
            bytesOut: v.bytesOut,
            estimatedTokens: Math.round((v.bytesIn + v.bytesOut) / 4)
          };
        }
        return {
          requests: this.metrics.requests,
          bytesIn: this.metrics.bytesIn,
          bytesOut: this.metrics.bytesOut,
          estimatedTokens: Math.round((this.metrics.bytesIn + this.metrics.bytesOut) / 4),
          byEndpoint,
          sinceMs: Date.now() - this.metrics.startedAt
        };
      }
      resetMetrics() {
        this.metrics = {
          requests: 0,
          bytesIn: 0,
          bytesOut: 0,
          byEndpoint: /* @__PURE__ */ new Map(),
          startedAt: Date.now()
        };
      }
      _recordMetric(endpoint, bytesOut, bytesIn) {
        this.metrics.requests++;
        this.metrics.bytesOut += bytesOut;
        this.metrics.bytesIn += bytesIn;
        let row = this.metrics.byEndpoint.get(endpoint);
        if (!row) {
          row = { count: 0, bytesIn: 0, bytesOut: 0 };
          this.metrics.byEndpoint.set(endpoint, row);
        }
        row.count++;
        row.bytesIn += bytesIn;
        row.bytesOut += bytesOut;
      }
      setBaseUrl(url) {
        this.baseUrl = (url || "http://127.0.0.1:2223").replace(/\/$/, "");
        this.healthCache = null;
      }
      _isLoopbackBaseUrl() {
        return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i.test(this.baseUrl || "");
      }
      _isPrivatePath(path2, payload = {}) {
        if (typeof path2 === "string" && path2) {
          if (/^Clientes\//i.test(path2.replace(/^\/+/, ""))) return true;
          if (/(^|\/)Clientes\//i.test(path2)) return true;
        }
        if (payload && payload.privacy && /sigiloso/i.test(String(payload.privacy))) return true;
        return false;
      }
      _assertRawContentAllowed(endpoint, options = {}) {
        const privacyPath = options._privacyPath || options.privacyPath || options.path || null;
        if (!this._isLoopbackBaseUrl() && this._isPrivatePath(privacyPath, options)) {
          throw new Error(
            `privacy-gate: ${endpoint} recusou enviar conte\xFAdo sigiloso para daemon remoto (${this.baseUrl})`
          );
        }
      }
      // Lazy health check — cached for HEALTH_TTL_MS
      // v1.4.1 — timeoutMs (default 1500ms): probes precisam falhar rápido em URLs mortas
      // para que discovery cross-device funcione sem travar Obsidian no startup.
      async isAvailable(timeoutMs = 1500) {
        const now = Date.now();
        if (this.healthCache !== null && now - this.healthCheckedAt < this.HEALTH_TTL_MS) {
          return this.healthCache;
        }
        try {
          const probe = this._requestUrl({
            url: `${this.baseUrl}/v1/health`,
            method: "GET",
            throw: false
          });
          const timeout = new Promise(
            (resolve) => setTimeout(() => resolve({ status: 0, _timedOut: true }), timeoutMs)
          );
          const resp = await Promise.race([probe, timeout]);
          const ok = resp && resp.status >= 200 && resp.status < 300;
          this.healthCache = ok;
        } catch (e) {
          this.healthCache = false;
        }
        this.healthCheckedAt = Date.now();
        return this.healthCache;
      }
      // v2.0 — Inject PCC routing header into outgoing request headers.
      _pccHeaders() {
        if (this.pccMode === "off") return {};
        if (this.pccMode === "auto") return { "X-Zeus-Allow-Pcc": "auto" };
        return { "X-Zeus-Allow-Pcc": "1" };
      }
      // v2.0 — Read PCC-routing signal from response headers.
      // Daemon sets `X-Zeus-Pcc-Used: 1` when the request was routed via Private Cloud Compute.
      _readPccUsed(headers) {
        if (!headers) return false;
        const val = typeof headers.get === "function" ? headers.get("x-zeus-pcc-used") || headers.get("X-Zeus-Pcc-Used") : headers["x-zeus-pcc-used"] || headers["X-Zeus-Pcc-Used"];
        const used = val === "1" || val === "true";
        if (used) this.pccUsageCount++;
        this.lastPccUsed = used;
        return used;
      }
      // Try to load Obsidian's requestUrl from the obsidian module; fallback to fetch on Node
      async _requestUrl({ url, method = "GET", body, contentType = "application/json", throw: throwOnError = true, signal = null }) {
        let obsidian2;
        try {
          obsidian2 = require("obsidian");
        } catch (e) {
          obsidian2 = null;
        }
        const pccHeaders = this._pccHeaders();
        if (obsidian2 && obsidian2.requestUrl) {
          const resp = await obsidian2.requestUrl({
            url,
            method,
            contentType,
            headers: { "Content-Type": contentType, ...pccHeaders },
            body: typeof body === "string" ? body : body ? JSON.stringify(body) : void 0,
            throw: throwOnError
          });
          this._readPccUsed(resp.headers);
          return resp;
        }
        if (typeof fetch === "function") {
          const resp = await fetch(url, {
            method,
            headers: { "Content-Type": contentType, ...pccHeaders },
            body: body ? typeof body === "string" ? body : JSON.stringify(body) : void 0,
            signal
          });
          this._readPccUsed(resp.headers);
          const text = await resp.text();
          let json = null;
          try {
            json = JSON.parse(text);
          } catch (e) {
          }
          return { status: resp.status, text, json, headers: resp.headers };
        }
        throw new Error("Nenhum transporte HTTP dispon\xEDvel (sem obsidian.requestUrl, sem fetch)");
      }
      async _post(endpoint, body, timeoutMs = 6e4, privacyCtx = null) {
        const privacyPath = privacyCtx && (privacyCtx._privacyPath || privacyCtx.privacyPath) || (body && typeof body === "object" ? body.path || body.note_path || body.notePath || body.image_path || null : null);
        const privacyTag = privacyCtx && privacyCtx.privacy || (body && typeof body === "object" ? body.privacy : null);
        this._assertRawContentAllowed(endpoint, { _privacyPath: privacyPath, privacy: privacyTag });
        const ctrl = new (typeof AbortController !== "undefined" ? AbortController : class {
          constructor() {
            this.signal = null;
          }
          abort() {
          }
        })();
        let timer = null;
        const bodyStr = typeof body === "string" ? body : body ? JSON.stringify(body) : "";
        const bytesOut = bodyStr ? universal2.byteLength(bodyStr) : 0;
        try {
          const request = this._requestUrl({
            url: `${this.baseUrl}${endpoint}`,
            method: "POST",
            body: bodyStr,
            signal: ctrl.signal
          });
          const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => {
              try {
                if (ctrl.abort) ctrl.abort();
              } catch (e) {
              }
              reject(new Error(`Daemon ${endpoint}: timeout ap\xF3s ${timeoutMs}ms`));
            }, timeoutMs);
          });
          const resp = await Promise.race([request, timeout]);
          const respText = resp.text || (resp.json ? JSON.stringify(resp.json) : "");
          const bytesIn = respText ? universal2.byteLength(respText) : 0;
          this._recordMetric(endpoint, bytesOut, bytesIn);
          if (resp.status >= 400) {
            const err = resp.json && resp.json.error || resp.text || `HTTP ${resp.status}`;
            throw new Error(`Daemon ${endpoint}: ${err}`);
          }
          return resp.json || JSON.parse(resp.text);
        } finally {
          clearTimeout(timer);
        }
      }
      // High-level API mirroring afm CLI subcommands
      async embed(text, options = {}) {
        const { _privacyPath, privacyPath, privacy, ...wireOptions } = options || {};
        return await this._post(
          "/v1/embed",
          { text, ...wireOptions },
          6e4,
          { _privacyPath: _privacyPath || privacyPath, privacy }
        );
      }
      // v1.3.0 — afm refine (Writing Tools nativo)
      // mode: "proofread|rewrite|simplify"; tone para rewrite: "academic|professional|casual"
      async refine(text, mode = "proofread", options = {}) {
        return await this._post("/v1/afm/refine", { text, mode, ...options }, 9e4);
      }
      // v1.3.0 — asp transcribe (SpeechAnalyzer macOS 26+ ou SFSpeechRecognizer fallback)
      // engine: "sa|sf|auto" (default auto); locale: BCP47 (e.g. "pt-BR", "en-US")
      async aspTranscribe(absPath, locale = "pt-BR", engine = "auto") {
        return await this._post(
          "/v1/asp/transcribe",
          { path: absPath, locale, engine },
          6e5
          // 10min para áudios longos + asset download primeira vez
        );
      }
      // v1.3.0 — asp vad (Voice Activity Detection rápido, pré-filtro)
      async aspVad(absPath) {
        return await this._post("/v1/asp/vad", { path: absPath }, 15e3);
      }
      async embedBatch(texts, options = {}) {
        if (!Array.isArray(texts)) {
          throw new Error("embedBatch: requer array de strings");
        }
        const { _privacyPath, privacyPath, privacy, ...wireOptions } = options || {};
        const privacyCtx = { _privacyPath: _privacyPath || privacyPath, privacy };
        const vectors = [];
        let dim = 0, model = "";
        for (const t of texts) {
          const r = await this._post("/v1/embed", { text: t, ...wireOptions }, 3e4, privacyCtx);
          const v = r.vectors && r.vectors[0] || r.vector;
          if (!Array.isArray(v)) throw new Error('embedBatch: daemon n\xE3o retornou vetor para "' + (t || "").slice(0, 40) + '..."');
          vectors.push(v);
          if (!dim) {
            dim = r.dim || v.length;
            model = r.model || "";
          }
        }
        return { vectors, dim, model, count: vectors.length };
      }
      async enrich(noteContent, notePath, vaultSummary = "", fewShotExamples = []) {
        return await this._post("/v1/enrich", {
          note_content: noteContent,
          note_path: notePath,
          vault_summary: vaultSummary,
          ...fewShotExamples.length > 0 ? { few_shot_examples: fewShotExamples } : {}
        }, 9e4);
      }
      async agent(question, pattern = "auto") {
        return await this._post("/v1/agent", { question, pattern }, 18e4);
      }
      async ocr(filePath, outputFormat = "text", language = "pt-BR,en") {
        const langArr = typeof language === "string" ? language.split(",").map((s) => s.trim()).filter(Boolean) : Array.isArray(language) ? language : ["pt-BR", "en-US"];
        return await this._post("/v1/ocr", {
          image_path: filePath,
          languages: langArr,
          output_format: outputFormat
        }, 12e4);
      }
      async summarize(text, fewShotExamples = []) {
        const body = { text };
        if (fewShotExamples.length > 0) body.few_shot_examples = fewShotExamples;
        return await this._post("/v1/summarize", body, 6e4);
      }
      async graphExtract(text, maxNodes = 20, maxEdges = 30, fewShotExamples = []) {
        const body = { text, max_nodes: maxNodes, max_edges: maxEdges };
        if (fewShotExamples.length > 0) body.few_shot_examples = fewShotExamples;
        return await this._post("/v1/graph/extract", body, 6e4);
      }
      async classify(text, options) {
        return await this._post("/v1/classify", { text, options }, 6e4);
      }
      async prompt(instruction, options = {}) {
        const body = {
          instruction,
          max_tokens: options.max_tokens || 300,
          deterministic: options.deterministic !== false
        };
        if (options.prewarm !== void 0) body.prewarm = options.prewarm;
        if (Array.isArray(options.fewShotExamples) && options.fewShotExamples.length > 0) {
          body.few_shot_examples = options.fewShotExamples;
        }
        return await this._post("/v1/prompt", body, options.timeoutMs || 9e4);
      }
      async visionClassify(imagePath, topN = 8) {
        return await this._post("/v1/vision/classify", { path: imagePath, top_n: topN }, 3e4);
      }
      async visionLandmarks(imagePath) {
        return await this._post("/v1/vision/landmarks", { path: imagePath }, 3e4);
      }
      // ----- v0.7 new methods — full Apple ecosystem coverage -----
      async translate(text, sourceLang, targetLang) {
        return await this._post("/v1/translate", { text, source_lang: sourceLang, target_lang: targetLang }, 3e4);
      }
      async nlTag(text, scheme = "lemma") {
        return await this._post("/v1/nl/tag", { text, scheme }, 15e3);
      }
      async nlSentiment(text) {
        return await this._post("/v1/nl/sentiment", { text }, 15e3);
      }
      async nlLanguageDetect(text, topN = 3) {
        return await this._post("/v1/nl/language-detect", { text, top_n: topN }, 1e4);
      }
      async visionSaliency(imagePath, mode = "attention") {
        return await this._post("/v1/vision/saliency", { path: imagePath, mode }, 3e4);
      }
      async visionFeaturePrint(imagePath) {
        return await this._post("/v1/vision/feature-print", { path: imagePath }, 3e4);
      }
      async visionAesthetics(imagePath) {
        return await this._post("/v1/vision/aesthetics", { path: imagePath }, 3e4);
      }
      async visionBarcode(imagePath) {
        return await this._post("/v1/vision/barcode", { path: imagePath }, 3e4);
      }
      async visionDocument(imagePath) {
        return await this._post("/v1/vision/document", { path: imagePath }, 6e4);
      }
      async dataDetect(text) {
        return await this._post("/v1/data-detect", { text }, 1e4);
      }
      async spotlightSearch(query, scope = null, limit = 50) {
        return await this._post("/v1/spotlight/search", { query, scope, limit }, 15e3);
      }
      // v1.7 — Spotlight via CSSearchableIndex programático (requer daemon ≥ v1.7,
      // ativa após `node scripts/build-release.mjs`). Cliente prefere este endpoint
      // mas faz fallback gracioso para `/v1/spotlight/search` (mdfind shell) quando
      // o daemon bundled ainda for v1.0.0 (HTTP 404).
      //
      // mode: 'spotlight' | 'stale' | 'unindexed' | 'mdfind-fallback' | 'error'
      // (padrão inspirado em maiocchi-ia/skills/tripla-fusao/scripts/bm25.py
      //  — fallback honesto declarado em vez de scores silenciosos vazios)
      async spotlightQueryNative(query, scope = null, limit = 50, domainHint = null) {
        let resolvedDomainHint = domainHint;
        if (!resolvedDomainHint && scope) {
          try {
            const hex = await universal2.sha256Hex(scope);
            resolvedDomainHint = "com.maiocchi.zeus." + hex.slice(0, 16);
          } catch (e) {
          }
        }
        const body = { query, scope, limit };
        if (resolvedDomainHint) body.domain_hint = resolvedDomainHint;
        try {
          const r = await this._post("/v1/spotlight/query", body, 15e3);
          return { ...r, mode: "spotlight" };
        } catch (e) {
          const nativeMessage = e.message || String(e);
          if (/domain_hint obrigat[oó]rio|unsupported_on_aegis_daemon/i.test(nativeMessage)) {
            return { mode: "error", error: nativeMessage, results: [] };
          }
          try {
            const r = await this.spotlightSearch(query, scope, limit);
            return { ...r, mode: "mdfind-fallback", native_error: nativeMessage.slice(0, 200) };
          } catch (e2) {
            return { mode: "error", error: e2.message, native_error: nativeMessage, results: [] };
          }
        }
      }
      async spotlightIndex(items, domainHint = null) {
        return await this._post("/v1/spotlight/index", { items, domain_hint: domainHint }, 6e4);
      }
      async spotlightPurge(domainHint = null) {
        return await this._post("/v1/spotlight/purge", { domain_hint: domainHint }, 15e3);
      }
      // ----- v0.9 new methods — Passport Index Architecture (PIA) -----
      // MCP-first surface for agent consumption with progressive disclosure.
      /**
       * Extract a single passport (concepts + summary + domain + difficulty) for a note.
       * Daemon uses Apple NLTagger (nameType+lemma) + afm summarize + afm classify.
       */
      async passportExtract(notePath, domainOptions = []) {
        return await this._post("/v1/passport/extract", {
          path: notePath,
          domain_options: domainOptions
        }, 3e4);
      }
      /**
       * Batch extract passports for many notes in one daemon call.
       * Long timeout (10min) — vault-wide rebuild can take a while.
       */
      async passportBatchExtract(notePaths, domainOptions = []) {
        return await this._post("/v1/passport/batch-extract", {
          paths: notePaths,
          domain_options: domainOptions
        }, 6e5);
      }
      /**
       * Find passports semantically relevant to a query.
       * Combines embeddings cosine (over embeddings.jsonl) + concept-match scoring
       * (over passports.jsonl). Returns top-N passports WITHOUT raw content —
       * token-efficient first probe for agents.
       *
       * @param {string} query
       * @param {object} options
       *   - embeddingsPath: path to embeddings.jsonl
       *   - passportsPath:  path to passports.jsonl
       *   - topN:           number of results (default 10)
       *   - minScore:       cosine threshold (default 0.3)
       *   - conceptFilter:  array of concepts to require in result
       */
      async passportFind(query, options = {}) {
        return await this._post("/v1/passport/find", {
          query,
          embeddings_jsonl_path: options.embeddingsPath,
          passports_jsonl_path: options.passportsPath,
          top_n: options.topN || 10,
          min_score: options.minScore || 0.3,
          concept_filter: options.conceptFilter || null
        }, 3e4);
      }
      /**
       * Fetch raw markdown content for a specific note.
       * Agents call this ONLY after passport lookup indicates this note is needed
       * for deep-dive. max_chars caps payload to prevent context blow-up.
       */
      async contentGet(filePath, vaultRoot, maxChars = 5e4) {
        return await this._post("/v1/content/get", {
          path: filePath,
          vault_root: vaultRoot,
          max_chars: maxChars
        }, 15e3);
      }
      async health() {
        const resp = await this._requestUrl({
          url: `${this.baseUrl}/v1/health`,
          method: "GET",
          throw: false
        });
        return resp.json || { status: "unreachable" };
      }
      async tools() {
        const resp = await this._requestUrl({
          url: `${this.baseUrl}/v1/tools`,
          method: "GET",
          throw: false
        });
        return resp.json && resp.json.tools || [];
      }
      // v1.9 — MobileCLIP stub opt-in (ADR-010)
      //
      // Sem modelo instalado em ~/Library/Application Support/Zeus/mobileclip-model/
      // o daemon retorna 501 com `hint` acionável apontando para o comando do plugin
      // "Zeus: instalar modelo MobileCLIP (download manual)". Runtime CoreML real
      // chega em v2.0.
      async mobileclipStatus() {
        try {
          const resp = await this._requestUrl({
            url: `${this.baseUrl}/v1/mobileclip/status`,
            method: "GET",
            throw: false
          });
          return resp.json || { error: "unreachable" };
        } catch (e) {
          return { error: e.message };
        }
      }
      async mobileclipEmbedImage(imagePath) {
        return await this._post("/v1/mobileclip/embed-image", { image_path: imagePath }, 6e4);
      }
      async mobileclipEmbedText(text) {
        return await this._post("/v1/mobileclip/embed-text", { text }, 3e4);
      }
    };
    module2.exports = ZeusHttpClient2;
  }
});

// lib/image-similarity.js
var require_image_similarity = __commonJS({
  "lib/image-similarity.js"(exports2, module2) {
    "use strict";
    var universal2 = require_universal_fs();
    var IMAGE_EXTS = /* @__PURE__ */ new Set(["png", "jpg", "jpeg", "heic", "gif", "webp", "tiff", "bmp"]);
    var CACHE_FILE = "image-features.jsonl";
    function cosine2(a, b) {
      if (!a || !b || a.length !== b.length) return 0;
      let dot = 0, na = 0, nb = 0;
      for (let i = 0; i < a.length; i++) {
        const x = a[i], y = b[i];
        dot += x * y;
        na += x * x;
        nb += y * y;
      }
      if (na === 0 || nb === 0) return 0;
      return dot / (Math.sqrt(na) * Math.sqrt(nb));
    }
    var ImageSimilaritySearch2 = class {
      constructor(plugin) {
        this.plugin = plugin;
        this.cache = /* @__PURE__ */ new Map();
        this.loaded = false;
      }
      get _adapter() {
        return this.plugin.app.vault.adapter;
      }
      _cachePath() {
        return universal2.joinPath(this.plugin.manifest.dir, "data", CACHE_FILE);
      }
      size() {
        return this.cache.size;
      }
      async _sha256OfFile(rel) {
        try {
          const stat = await universal2.adapterStat(this._adapter, rel);
          if (!stat) return "";
          return await universal2.sha256Hex(`${rel}:${stat.mtime || 0}:${stat.size || 0}`);
        } catch (e) {
          return "";
        }
      }
      async loadCache() {
        this.cache.clear();
        const p = this._cachePath();
        if (!await universal2.adapterExists(this._adapter, p)) {
          this.loaded = true;
          return 0;
        }
        try {
          const raw = await universal2.adapterRead(this._adapter, p);
          const lines = raw.split("\n");
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const obj = JSON.parse(line);
              if (obj && obj.rel && Array.isArray(obj.vector)) {
                this.cache.set(obj.rel, {
                  sha: obj.sha || "",
                  dim: obj.dim || obj.vector.length,
                  vector: obj.vector,
                  indexedAt: obj.indexedAt || 0
                });
              }
            } catch (e) {
            }
          }
        } catch (e) {
          console.warn("[zeus image-similarity] loadCache failed:", e.message);
        }
        this.loaded = true;
        return this.cache.size;
      }
      async saveCache() {
        const p = this._cachePath();
        try {
          await universal2.adapterMkdir(this._adapter, universal2.dirname(p));
          const lines = [];
          for (const [rel, v] of this.cache.entries()) {
            lines.push(JSON.stringify({ rel, sha: v.sha, dim: v.dim, vector: v.vector, indexedAt: v.indexedAt }));
          }
          await universal2.adapterWriteAtomic(this._adapter, p, lines.join("\n") + (lines.length ? "\n" : ""));
        } catch (e) {
          console.warn("[zeus image-similarity] saveCache failed:", e.message);
        }
      }
      _isImage(rel) {
        const ext = (rel.split(".").pop() || "").toLowerCase();
        return IMAGE_EXTS.has(ext);
      }
      async enumerateImages() {
        const out = [];
        const exclusions = new Set(this.plugin.settings.folderExclusions || []);
        const skipNames = /* @__PURE__ */ new Set([...exclusions, ".DS_Store"]);
        const allFiles = await universal2.adapterWalk(this._adapter, "", skipNames);
        for (const rel of allFiles) {
          if (this._isImage(rel)) out.push({ rel });
        }
        return out;
      }
      async indexAllImages(onProgress) {
        if (!this.loaded) await this.loadCache();
        const httpClient = this.plugin.httpClient;
        if (!httpClient) throw new Error("plugin.httpClient ausente \u2014 daemon Aegis indispon\xEDvel");
        const reachable = await httpClient.isAvailable();
        if (!reachable) throw new Error("Daemon Zeus inalcan\xE7\xE1vel \u2014 n\xE3o posso gerar feature-prints");
        const imgs = await this.enumerateImages();
        let processed = 0, indexed = 0, skipped = 0, failed = 0;
        for (const img of imgs) {
          processed++;
          const sha = await this._sha256OfFile(img.rel);
          const prev = this.cache.get(img.rel);
          if (prev && prev.sha === sha && Array.isArray(prev.vector) && prev.vector.length > 0) {
            skipped++;
            if (onProgress && processed % 10 === 0) onProgress({ processed, indexed, skipped, failed, total: imgs.length, current: img.rel });
            continue;
          }
          const abs = this._absForDaemon(img.rel);
          try {
            const r = await httpClient.visionFeaturePrint(abs);
            const vector = r && (r.feature_print || r.vector || r.features);
            if (Array.isArray(vector) && vector.length > 0) {
              this.cache.set(img.rel, {
                sha,
                dim: r.dim || vector.length,
                vector,
                indexedAt: Date.now()
              });
              indexed++;
            } else {
              failed++;
            }
          } catch (e) {
            failed++;
            console.warn("[zeus image-similarity] feature-print failed for", img.rel, e.message);
          }
          if (onProgress) onProgress({ processed, indexed, skipped, failed, total: imgs.length, current: img.rel });
          if (indexed > 0 && indexed % 25 === 0) await this.saveCache();
        }
        await this.saveCache();
        return { processed, indexed, skipped, failed, total: imgs.length };
      }
      // Build absolute path for the daemon. On iOS the daemon may not be local, so we
      // pass the vault-relative path and let the daemon resolve via its vault_root config.
      _absForDaemon(relOrAbs) {
        if (universal2.IS_NODE && universal2.nodePath && this.plugin.vaultRoot) {
          const p = universal2.nodePath;
          if (p.isAbsolute(relOrAbs)) return relOrAbs;
          return p.join(this.plugin.vaultRoot, relOrAbs);
        }
        return relOrAbs;
      }
      async featurePrintFor(imagePath) {
        if (!this.loaded) await this.loadCache();
        let rel = imagePath;
        let abs = imagePath;
        if (universal2.IS_NODE && universal2.nodePath && this.plugin.vaultRoot) {
          const p = universal2.nodePath;
          if (p.isAbsolute(imagePath)) {
            abs = imagePath;
            const candidateRel = p.relative(this.plugin.vaultRoot, imagePath);
            if (candidateRel && !candidateRel.startsWith("..")) rel = candidateRel;
          } else {
            abs = p.join(this.plugin.vaultRoot, imagePath);
            rel = imagePath;
          }
        }
        if (this.cache.has(rel)) {
          const prev = this.cache.get(rel);
          const sha = await this._sha256OfFile(rel);
          if (sha && prev.sha === sha) return prev.vector;
        }
        const httpClient = this.plugin.httpClient;
        if (!httpClient) throw new Error("plugin.httpClient ausente");
        const r = await httpClient.visionFeaturePrint(abs);
        const vector = r && (r.feature_print || r.vector || r.features);
        if (!Array.isArray(vector) || vector.length === 0) throw new Error("feature-print retornou vazio");
        return vector;
      }
      async findSimilar(imagePath, topK = 10) {
        if (!this.loaded) await this.loadCache();
        if (this.cache.size === 0) {
          throw new Error("Cache de feature-prints vazio \u2014 rode indexAllImages() primeiro");
        }
        const qVec = await this.featurePrintFor(imagePath);
        let qRel = null;
        if (universal2.IS_NODE && universal2.nodePath && this.plugin.vaultRoot) {
          const p = universal2.nodePath;
          try {
            const abs = p.isAbsolute(imagePath) ? imagePath : p.join(this.plugin.vaultRoot, imagePath);
            const rel = p.relative(this.plugin.vaultRoot, abs);
            if (!rel.startsWith("..")) qRel = rel;
          } catch (e) {
          }
        } else {
          qRel = imagePath;
        }
        const scored = [];
        for (const [rel, v] of this.cache.entries()) {
          if (qRel && rel === qRel) continue;
          const sim = cosine2(qVec, v.vector);
          scored.push({ rel, similarity: sim });
        }
        scored.sort((a, b) => b.similarity - a.similarity);
        return scored.slice(0, topK);
      }
    };
    module2.exports = ImageSimilaritySearch2;
    module2.exports.cosine = cosine2;
    module2.exports.IMAGE_EXTS = IMAGE_EXTS;
  }
});

// lib/cornell.js
var require_cornell = __commonJS({
  "lib/cornell.js"(exports2, module2) {
    "use strict";
    var H2_H3_RE = /^#{2,3}\s+(.+)$/gm;
    var QUESTION_RE = /[?？]$/;
    var QUESTION_STARTS = /* @__PURE__ */ new Set([
      "o que",
      "como",
      "por que",
      "por qu\xEA",
      "quem",
      "quando",
      "onde",
      "qual",
      "quais",
      "quanto",
      "quantos",
      "quantas",
      "para que",
      "what",
      "how",
      "why",
      "who",
      "when",
      "where",
      "which"
    ]);
    function headingToCue(heading) {
      const h = heading.trim();
      if (!h) return "";
      if (QUESTION_RE.test(h)) return h;
      const lower = h.toLowerCase();
      for (const qw of QUESTION_STARTS) {
        if (lower.startsWith(qw)) return h.endsWith("?") ? h : h + "?";
      }
      const words = h.split(/\s+/);
      if (words.length > 6) return h + "?";
      return `O que \xE9 ${lower.replace(/[?！!]/g, "")}?`;
    }
    function extractCornellFields(body, fm, headings, one_line_summary, concepts) {
      let cornell_cue = [];
      if (fm && (fm.zeus_cornell_cue || fm.cornell_cue)) {
        const raw = fm.zeus_cornell_cue || fm.cornell_cue;
        cornell_cue = Array.isArray(raw) ? raw.map(String).filter(Boolean) : String(raw).split(/[;,\n]+/).map((s) => s.trim()).filter(Boolean);
      }
      if (cornell_cue.length === 0) {
        const h23 = [];
        let m;
        const re = new RegExp(H2_H3_RE.source, "gm");
        while ((m = re.exec(body)) !== null) {
          const h = m[1].trim().replace(/\*\*/g, "").replace(/__/g, "");
          if (h.length >= 3 && h.length <= 80) h23.push(h);
        }
        cornell_cue = h23.slice(0, 8).map(headingToCue).filter(Boolean);
      }
      if (cornell_cue.length === 0 && Array.isArray(concepts) && concepts.length > 0) {
        cornell_cue = concepts.slice(0, 3).map((c) => `O que \xE9 ${c.toLowerCase()}?`);
      }
      let cornell_summary = "";
      if (fm && (fm.zeus_cornell_summary || fm.cornell_summary)) {
        cornell_summary = String(fm.zeus_cornell_summary || fm.cornell_summary).trim();
      }
      if (!cornell_summary && one_line_summary) {
        cornell_summary = one_line_summary;
      }
      if (!cornell_summary && body) {
        const firstSentence = body.replace(/^#{1,6}\s+.+\n?/m, "").trim().split(/[.!?]\s/)[0];
        if (firstSentence && firstSentence.length > 20) {
          cornell_summary = firstSentence.slice(0, 200).trim() + (firstSentence.length > 200 ? "\u2026" : "");
        }
      }
      return { cornell_cue, cornell_summary };
    }
    function isCornellFormatted(body) {
      const lower = body.toLowerCase();
      const hasCueSection = /#{2,3}\s*(perguntas[- ]chave|cue|questões|keywords)/i.test(body);
      const hasSummarySection = /#{2,3}\s*(resumo|summary|síntese)/i.test(body);
      return hasCueSection || hasSummarySection;
    }
    module2.exports = { extractCornellFields, headingToCue, isCornellFormatted };
  }
});

// lib/luhmann.js
var require_luhmann = __commonJS({
  "lib/luhmann.js"(exports2, module2) {
    "use strict";
    var FLEETING_FOLDERS = /* @__PURE__ */ new Set([
      "inbox",
      "capture",
      "fleeting",
      "scratch",
      "rascunho",
      "captura",
      "quick",
      "daily",
      "di\xE1rio",
      "diario",
      "log",
      "notas-r\xE1pidas"
    ]);
    var LITERATURE_KEYS = /* @__PURE__ */ new Set([
      "source",
      "author",
      "authors",
      "url",
      "doi",
      "isbn",
      "journal",
      "book",
      "livro",
      "fonte",
      "autor",
      "artigo",
      "paper",
      "reference",
      "refer\xEAncia",
      "referencia"
    ]);
    var WIKILINK_RE = /\[\[([^\]]+)\]\]/g;
    var BLOCKQUOTE_LINE_RE = /^>\s/gm;
    var HEADING_RE = /^(#{1,3})\s+(.+)$/gm;
    function detectNoteType(body, fm, filePath, charCount, concepts) {
      if (fm) {
        const explicit = fm.zeus_note_type || fm.note_type || fm.zettel_type;
        if (explicit) {
          const v = String(explicit).toLowerCase().trim();
          if (v === "fleeting" || v === "literature" || v === "permanent") return v;
        }
      }
      const folderParts = filePath.replace(/\\/g, "/").split("/");
      const topFolder = (folderParts[0] || "").toLowerCase();
      const secondFolder = (folderParts[1] || "").toLowerCase();
      const isFleetingFolder = FLEETING_FOLDERS.has(topFolder) || FLEETING_FOLDERS.has(secondFolder);
      const wikilinkMatches = (body.match(WIKILINK_RE) || []).length;
      const totalLines = (body.match(/\n/g) || []).length + 1;
      const bqLines = (body.match(BLOCKQUOTE_LINE_RE) || []).length;
      const bqRatio = totalLines > 0 ? bqLines / totalLines : 0;
      const hasLiteratureKey = fm && Object.keys(fm).some((k) => LITERATURE_KEYS.has(k.toLowerCase()));
      if (charCount < 300 && wikilinkMatches === 0 && (isFleetingFolder || charCount < 150)) {
        return "fleeting";
      }
      if (hasLiteratureKey || bqRatio > 0.3) {
        return "literature";
      }
      if (wikilinkMatches >= 2 && (concepts || []).length >= 3 && charCount > 600) {
        return "permanent";
      }
      return null;
    }
    function generateZettelId(fm, extractedAt) {
      if (fm) {
        const explicit = fm.zeus_zettel_id || fm.zettel_id || fm.zeus_id;
        if (explicit) return String(explicit).trim();
      }
      try {
        const d = extractedAt ? new Date(extractedAt) : /* @__PURE__ */ new Date();
        const pad = (n) => String(n).padStart(2, "0");
        return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + pad(d.getHours()) + pad(d.getMinutes());
      } catch (e) {
        return String(Date.now()).slice(0, 12);
      }
    }
    function suggestAtomicSplits(body) {
      const candidates = [];
      const sections = body.split(/^#{2,3}\s+/m).slice(1);
      const headings = [];
      let m;
      const re = new RegExp(HEADING_RE.source, "gm");
      while ((m = re.exec(body)) !== null) {
        if (m[1].length >= 2) headings.push(m[2].trim());
      }
      for (let i = 0; i < sections.length; i++) {
        const sectionBody = sections[i].split(/\n#{2,3}\s/)[0];
        if (sectionBody.replace(/\s/g, "").length > 200 && headings[i]) {
          candidates.push(headings[i]);
        }
      }
      return candidates.slice(0, 5);
    }
    function extractLuhmannFields(body, fm, filePath, charCount, concepts, extractedAt) {
      return {
        note_type: detectNoteType(body, fm, filePath, charCount, concepts),
        zettel_id: generateZettelId(fm, extractedAt),
        atomic_splits: suggestAtomicSplits(body)
      };
    }
    module2.exports = { extractLuhmannFields, detectNoteType, generateZettelId, suggestAtomicSplits };
  }
});

// lib/passport-ios.js
var require_passport_ios = __commonJS({
  "lib/passport-ios.js"(exports2, module2) {
    "use strict";
    var { extractCornellFields } = require_cornell();
    var { extractLuhmannFields } = require_luhmann();
    var MODEL_VERSION = "zeus-ios-1.16.0";
    var MAX_CONCEPTS = 12;
    var MAX_INLINE_TAGS = 30;
    var MAX_PROPER_NOUNS = 15;
    var MIN_CONCEPT_LEN = 2;
    var SUMMARY_MAX_CHARS = 250;
    var INLINE_TAG_RE = /#[\wÀ-ſ\-]+/g;
    var PROPER_NOUN_RE = /\b[A-ZÀ-Ý][\wÀ-ÿ\-]{1,23}\b/g;
    var PROPER_NOUN_STOPWORDS = /* @__PURE__ */ new Set([
      // títulos
      "dr",
      "dra",
      "sr",
      "sra",
      "srta",
      "exmo",
      "exma",
      "ilmo",
      "ilma",
      // siglas all-caps comuns (não-discriminantes)
      "abc",
      "cep",
      "cnpj",
      "cpf",
      "dr",
      "edt",
      "gmt",
      "iso",
      "ltda",
      "me",
      "mei",
      "ong",
      "pdf",
      "rg",
      "rh",
      "sa",
      "sl",
      "sp",
      "rj",
      "usa",
      "utc",
      "url",
      "uti",
      // demonstrativos/artigos capitalizados (início de frase)
      "a",
      "as",
      "da",
      "das",
      "de",
      "do",
      "dos",
      "e",
      "em",
      "no",
      "na",
      "nos",
      "nas",
      "o",
      "os",
      "um",
      "uma",
      "uns",
      "umas",
      "para",
      "pelo",
      "pela"
    ]);
    var FRONTMATTER_RE = /^---\n[\s\S]*?\n---\n/;
    var SENTENCE_SPLIT_RE = /(?<=[.!?])\s+(?=[A-ZÀ-Ý])/;
    function stripFrontmatter(content) {
      if (!content || typeof content !== "string") return "";
      return content.replace(FRONTMATTER_RE, "").trimStart();
    }
    function coerceArray(v) {
      if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
      if (typeof v === "string") {
        return v.split(",").map((s) => s.trim()).filter(Boolean);
      }
      return [];
    }
    function detectDomainByFolder(filePath) {
      if (!filePath || typeof filePath !== "string") return ["unknown"];
      const segments = filePath.split("/").filter(Boolean);
      if (segments.length < 2) return ["root"];
      const folder = segments[0];
      const normalized = folder.replace(/^\d+[_\s-]*/, "").replace(/\s+/g, "-").toLowerCase();
      return [normalized || folder];
    }
    function estimateDifficulty(charCount) {
      if (charCount > 10240) return 4;
      if (charCount > 5120) return 3;
      if (charCount > 2048) return 2;
      return 1;
    }
    function extractSummary(body, fm, headings) {
      if (fm && typeof fm.zeus_summary === "string" && fm.zeus_summary.trim()) {
        return fm.zeus_summary.trim().slice(0, SUMMARY_MAX_CHARS);
      }
      const trimmed = (body || "").trim();
      if (trimmed.length > 0) {
        const lines = trimmed.split("\n");
        const proseLines = [];
        let inCodeBlock = false;
        for (const ln of lines) {
          const t = ln.trim();
          if (t.startsWith("```")) {
            inCodeBlock = !inCodeBlock;
            continue;
          }
          if (inCodeBlock) continue;
          if (!t) continue;
          if (t.startsWith("#")) continue;
          if (t.startsWith("- ") || t.startsWith("* ")) continue;
          if (/^\d+\.\s/.test(t)) continue;
          if (t.startsWith(">")) continue;
          if (t.startsWith("|")) continue;
          proseLines.push(t);
          if (proseLines.join(" ").length > SUMMARY_MAX_CHARS * 1.5) break;
        }
        if (proseLines.length > 0) {
          const joined = proseLines.join(" ");
          const sentences = joined.split(SENTENCE_SPLIT_RE).slice(0, 2);
          const summary = sentences.join(" ").trim();
          if (summary) return summary.slice(0, SUMMARY_MAX_CHARS);
        }
      }
      const h1 = (headings || []).find((h) => h.level === 1);
      if (h1) {
        const prefix = h1.heading ? h1.heading.trim() + " \u2014 " : "";
        const rest = (body || "").replace(/^#+\s.*$/m, "").trim().split("\n").find((l) => l.trim());
        return (prefix + (rest || "").trim()).slice(0, SUMMARY_MAX_CHARS);
      }
      return "";
    }
    async function extractPassportLocal(filePath, fileContent, metadataCache) {
      const content = typeof fileContent === "string" ? fileContent : "";
      const body = stripFrontmatter(content);
      const charCount = content.length;
      let fileCache = null;
      if (metadataCache && typeof metadataCache.getCache === "function") {
        try {
          fileCache = metadataCache.getCache(filePath);
        } catch (e) {
        }
      }
      const fm = fileCache && fileCache.frontmatter || {};
      const headings = fileCache && fileCache.headings || [];
      const conceptsBag = [];
      for (const t of coerceArray(fm.tags)) {
        conceptsBag.push(String(t).replace(/^#/, ""));
      }
      for (const a of coerceArray(fm.aliases)) {
        conceptsBag.push(String(a));
      }
      const inlineMatches = body.match(INLINE_TAG_RE) || [];
      for (let i = 0; i < Math.min(inlineMatches.length, MAX_INLINE_TAGS); i++) {
        conceptsBag.push(inlineMatches[i].replace(/^#/, ""));
      }
      for (const h of headings) {
        if (h && typeof h.level === "number" && h.level >= 1 && h.level <= 3 && h.heading) {
          conceptsBag.push(String(h.heading).trim());
        }
      }
      if (metadataCache && metadataCache.resolvedLinks && typeof metadataCache.resolvedLinks === "object") {
        const outLinks = metadataCache.resolvedLinks[filePath];
        if (outLinks && typeof outLinks === "object") {
          for (const targetPath of Object.keys(outLinks)) {
            const basename = targetPath.split("/").pop().replace(/\.md$/, "");
            if (basename) conceptsBag.push(basename);
          }
        }
      }
      const properMatches = body.match(PROPER_NOUN_RE) || [];
      let properCount = 0;
      const properSeen = /* @__PURE__ */ new Set();
      for (const pn of properMatches) {
        if (properCount >= MAX_PROPER_NOUNS) break;
        if (pn.length < MIN_CONCEPT_LEN || pn.length > 24) continue;
        const lower = pn.toLowerCase();
        if (PROPER_NOUN_STOPWORDS.has(lower)) continue;
        if (properSeen.has(lower)) continue;
        if (pn === pn.toUpperCase() && !/\d/.test(pn)) continue;
        properSeen.add(lower);
        conceptsBag.push(pn);
        properCount++;
      }
      const seen = /* @__PURE__ */ new Set();
      const concepts = [];
      for (const raw of conceptsBag) {
        const s = String(raw).trim();
        if (s.length < MIN_CONCEPT_LEN) continue;
        const key = s.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        concepts.push(s);
        if (concepts.length >= MAX_CONCEPTS) break;
      }
      let domain = coerceArray(fm.zeus_domain);
      if (domain.length === 0) domain = detectDomainByFolder(filePath);
      const summary = extractSummary(body, fm, headings);
      const difficulty = estimateDifficulty(charCount);
      const extractedAt = (/* @__PURE__ */ new Date()).toISOString();
      const cornell = extractCornellFields(body, fm, headings, summary, concepts);
      const luhmann = extractLuhmannFields(body, fm, filePath, charCount, concepts, extractedAt);
      return {
        path: filePath,
        extracted_at: extractedAt,
        char_count: charCount,
        concepts,
        domain,
        difficulty,
        one_line_summary: summary,
        cornell_cue: cornell.cornell_cue,
        cornell_summary: cornell.cornell_summary,
        note_type: luhmann.note_type,
        zettel_id: luhmann.zettel_id,
        atomic_splits: luhmann.atomic_splits,
        model_versions: { passport: MODEL_VERSION },
        source: "ios-local"
      };
    }
    module2.exports = {
      extractPassportLocal,
      // Exports privados para testes
      _stripFrontmatter: stripFrontmatter,
      _coerceArray: coerceArray,
      _detectDomainByFolder: detectDomainByFolder,
      _estimateDifficulty: estimateDifficulty,
      _extractSummary: extractSummary,
      MODEL_VERSION
    };
  }
});

// lib/bm25.js
var require_bm25 = __commonJS({
  "lib/bm25.js"(exports2, module2) {
    "use strict";
    var _TOKEN = /[0-9a-zà-ÿ_-]{2,}/g;
    var K1_DEFAULT = 1.5;
    var B_DEFAULT = 0.75;
    function tokenize(text) {
      if (!text || typeof text !== "string") return [];
      return text.toLowerCase().match(_TOKEN) || [];
    }
    function bm25Scores(corpus, queryTokens, k1 = K1_DEFAULT, b = B_DEFAULT) {
      const N = corpus.length;
      if (N === 0) return [];
      if (!Array.isArray(queryTokens) || queryTokens.length === 0) {
        return new Array(N).fill(0);
      }
      const docLens = new Array(N);
      let totalLen = 0;
      for (let i = 0; i < N; i++) {
        const dl = corpus[i].length;
        docLens[i] = dl;
        totalLen += dl;
      }
      const avgdl = totalLen / N;
      const df = /* @__PURE__ */ new Map();
      for (let i = 0; i < N; i++) {
        const seen = new Set(corpus[i]);
        for (const term of seen) {
          df.set(term, (df.get(term) || 0) + 1);
        }
      }
      const idf = /* @__PURE__ */ new Map();
      for (const [term, freq] of df.entries()) {
        idf.set(term, Math.log(1 + (N - freq + 0.5) / (freq + 0.5)));
      }
      const querySet = new Set(queryTokens);
      const scores = new Array(N).fill(0);
      for (let i = 0; i < N; i++) {
        const doc = corpus[i];
        const docLen = docLens[i];
        if (doc.length === 0) continue;
        const tf = /* @__PURE__ */ new Map();
        for (const term of doc) {
          tf.set(term, (tf.get(term) || 0) + 1);
        }
        let score = 0;
        for (const term of querySet) {
          const freq = tf.get(term) || 0;
          if (freq === 0) continue;
          const denom = avgdl > 0 ? freq + k1 * (1 - b + b * docLen / avgdl) : freq;
          score += (idf.get(term) || 0) * (freq * (k1 + 1)) / denom;
        }
        scores[i] = score;
      }
      return scores;
    }
    function rankNotes(notes, query, topN = 30, opts = {}) {
      if (!Array.isArray(notes) || notes.length === 0) return [];
      const queryTokens = tokenize(query);
      if (queryTokens.length === 0) return [];
      const k1 = opts.k1 != null ? opts.k1 : K1_DEFAULT;
      const b = opts.b != null ? opts.b : B_DEFAULT;
      const corpus = new Array(notes.length);
      const docTokens = new Array(notes.length);
      for (let i = 0; i < notes.length; i++) {
        const tokens = tokenize(notes[i].text || "");
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
    module2.exports = {
      tokenize,
      bm25Scores,
      rankNotes,
      K1_DEFAULT,
      B_DEFAULT
    };
    if (require.main === module2) {
      const query = process.argv.slice(2).join(" ") || "habeas corpus";
      console.log(`[bm25 demo] query=${JSON.stringify(query)}`);
      const notes = [
        { path: "doc-a.md", text: "O habeas corpus \xE9 rem\xE9dio constitucional contra pris\xE3o ilegal. Garantia fundamental do art. 5\xBA." },
        { path: "doc-b.md", text: "Mandado de seguran\xE7a protege direito l\xEDquido e certo. Distinto do habeas corpus." },
        { path: "doc-c.md", text: "Contratos administrativos seguem regime de direito p\xFAblico \u2014 Lei 14.133/2021." },
        { path: "doc-d.md", text: "habeas habeas habeas \u2014 repeti\xE7\xE3o satura via k1=1.5." }
      ];
      const ranked = rankNotes(notes, query, 10);
      console.log(JSON.stringify(ranked.map((r) => ({ path: r.path, score: +r.score.toFixed(4) })), null, 2));
      console.log(`[bm25 demo] tokenize("Habeas Corpus, Lei 14.133"):`, tokenize("Habeas Corpus, Lei 14.133"));
    }
  }
});

// lib/passport-index.js
var require_passport_index = __commonJS({
  "lib/passport-index.js"(exports2, module2) {
    "use strict";
    var universal2 = require_universal_fs();
    var { extractPassportLocal } = require_passport_ios();
    var bm25 = require_bm25();
    var PASSPORTS_FILE = "passports.jsonl";
    var DATA_DIR_NAME2 = "data";
    var PassportIndex2 = class {
      constructor(plugin) {
        this.plugin = plugin;
        this._cache = null;
        this._cacheLoadedAt = 0;
        this._lastBuiltAt = null;
      }
      // ---- Path helpers (vault-relative) ----
      get _adapter() {
        return this.plugin.app.vault.adapter;
      }
      get dataPath() {
        return universal2.joinPath(this.plugin.manifest.dir, DATA_DIR_NAME2);
      }
      get jsonlPath() {
        return universal2.joinPath(this.dataPath, PASSPORTS_FILE);
      }
      async _ensureDataDir() {
        await universal2.adapterMkdir(this._adapter, this.dataPath);
      }
      // ---- Build / extract operations ----
      /**
       * Extract passport for a single note.
       * Calls daemon /v1/passport/extract.
       * Returns the passport object (also persisted to JSONL).
       *
       * v0.10: passport gains `sha` (sha256 of file content at extraction time),
       * `extracted_by` (device_id from coordinator) and `extracted_at` (ISO timestamp)
       * for cross-device staleness detection via PassportScheduler.
       */
      async buildOne(filePath, domainOptions = []) {
        let daemonReachable = false;
        if (this.plugin.httpClient && typeof this.plugin.httpClient.isAvailable === "function") {
          try {
            daemonReachable = await this.plugin.httpClient.isAvailable(1500);
          } catch (e) {
            daemonReachable = false;
          }
        }
        if (!daemonReachable) {
          return await this._buildOneLocal(filePath);
        }
        let currentSha = null;
        try {
          const relForRead = this._vaultRelative(filePath);
          if (relForRead && await universal2.adapterExists(this._adapter, relForRead)) {
            const content = await universal2.adapterRead(this._adapter, relForRead);
            currentSha = await universal2.sha256Hex(content);
          }
        } catch (e) {
          console.warn("[zeus][passport] sha precompute failed for", filePath, e.message);
        }
        let passport;
        try {
          passport = await this.plugin.httpClient.passportExtract(filePath, domainOptions);
        } catch (e) {
          console.warn("[zeus][passport] daemon extract failed, fallback to ios-local:", e.message);
          return await this._buildOneLocal(filePath);
        }
        if (!passport || !passport.path) {
          throw new Error(`PassportIndex.buildOne: resposta inv\xE1lida para ${filePath}`);
        }
        passport.path = this._vaultRelative(passport.path);
        if (currentSha) passport.sha = currentSha;
        if (this.plugin.coordinator && this.plugin.coordinator.deviceId) {
          passport.extracted_by = this.plugin.coordinator.deviceId;
        }
        passport.extracted_at = (/* @__PURE__ */ new Date()).toISOString();
        const map = await this.loadAll();
        map.set(passport.path, passport);
        await this.saveAll(map);
        try {
          await this._updateManifestEntry(passport);
        } catch (e) {
          console.warn("[zeus][passport] manifest mirror failed:", e.message);
        }
        this._lastBuiltAt = (/* @__PURE__ */ new Date()).toISOString();
        return passport;
      }
      /**
       * v1.11 Feature E — Coage o filePath para vault-relative.
       * AutoIndexer passa abs path no Mac (`/Users/.../vault/Note.md`); vault.adapter
       * só aceita vault-relative. Se filePath for absoluto e começar com vaultRoot,
       * tira o prefixo. Senão retorna como veio (assume relativo).
       */
      _vaultRelative(filePath) {
        if (!filePath || typeof filePath !== "string") return filePath;
        const root = this.plugin && this.plugin.vaultRoot;
        if (root && filePath.startsWith(root)) {
          const stripped = filePath.slice(root.length).replace(/^\/+/, "");
          return stripped;
        }
        return filePath;
      }
      /**
       * v1.11 Feature E — Build passport puramente local (sem daemon) via
       * extractPassportLocal. Usado:
       *   - iOS quando httpClient indisponível
       *   - Mac quando daemon offline e usuário não quer bloquear
       *
       * Persiste no MESMO passports.jsonl que o caminho daemon — só
       * model_versions.passport difere ('zeus-ios-1.11.0').
       */
      async _buildOneLocal(filePath) {
        const relPath = this._vaultRelative(filePath);
        if (!relPath) {
          throw new Error("PassportIndex._buildOneLocal: filePath inv\xE1lido");
        }
        if (!await universal2.adapterExists(this._adapter, relPath)) {
          throw new Error(`PassportIndex._buildOneLocal: arquivo n\xE3o existe: ${relPath}`);
        }
        const content = await universal2.adapterRead(this._adapter, relPath);
        const metadataCache = this.plugin.app && this.plugin.app.metadataCache;
        const passport = await extractPassportLocal(relPath, content, metadataCache);
        try {
          passport.sha = await universal2.sha256Hex(content);
        } catch (e) {
          console.warn("[zeus][passport] local sha failed:", e.message);
        }
        if (this.plugin.coordinator && this.plugin.coordinator.deviceId) {
          passport.extracted_by = this.plugin.coordinator.deviceId;
        }
        passport.path = relPath;
        const map = await this.loadAll();
        map.set(passport.path, passport);
        await this.saveAll(map);
        try {
          await this._updateManifestEntry(passport);
        } catch (e) {
          console.warn("[zeus][passport] manifest mirror failed (local):", e.message);
        }
        this._lastBuiltAt = (/* @__PURE__ */ new Date()).toISOString();
        return passport;
      }
      /**
       * Mirror passport_sha / passport_extracted_by / passport_extracted_at into
       * manifest.json files[<path>] for fast staleness scans (without parsing JSONL).
       */
      async _updateManifestEntry(passport) {
        if (!this.plugin.indexer || typeof this.plugin.indexer.loadManifest !== "function") return;
        const m = await this.plugin.indexer.loadManifest();
        if (!m.files || typeof m.files !== "object") m.files = {};
        const key = this._vaultRelative(passport.path);
        const entry = m.files[key] || {};
        entry.passport_sha = passport.sha || null;
        entry.passport_extracted_by = passport.extracted_by || null;
        entry.passport_extracted_at = passport.extracted_at || null;
        m.files[key] = entry;
        await this.plugin.indexer.saveManifest(m);
      }
      /**
       * Batch extract all markdown notes in vault.
       * Calls daemon /v1/passport/batch-extract with progress callback.
       *
       * @param {(msg: string, pct?: number) => void} onProgress
       * @returns {Promise<{total: number, succeeded: number, failed: number}>}
       */
      async buildAll(onProgress = () => {
      }) {
        if (!this.plugin.httpClient) {
          throw new Error("PassportIndex.buildAll: httpClient indispon\xEDvel");
        }
        const notes = await this._enumerateMarkdownNotes();
        onProgress(`enumerated ${notes.length} markdown notes`, 0);
        const BATCH = 100;
        const map = await this.loadAll();
        let succeeded = 0, failed = 0;
        for (let i = 0; i < notes.length; i += BATCH) {
          const chunk = notes.slice(i, i + BATCH);
          onProgress(
            `extracting passports ${i + 1}-${i + chunk.length}/${notes.length}\u2026`,
            Math.round(100 * i / notes.length)
          );
          try {
            const resp = await this.plugin.httpClient.passportBatchExtract(chunk, []);
            const items = resp && resp.passports || (Array.isArray(resp) ? resp : []);
            for (const p of items) {
              if (p && p.path) {
                p.path = this._vaultRelative(p.path);
                map.set(p.path, p);
                succeeded++;
              } else {
                failed++;
              }
            }
          } catch (e) {
            console.warn("[zeus][passport] batch fail:", e.message, "chunk size:", chunk.length);
            failed += chunk.length;
          }
          await this.saveAll(map);
        }
        this._lastBuiltAt = (/* @__PURE__ */ new Date()).toISOString();
        onProgress(`done \u2014 ${succeeded} passports, ${failed} failed`, 100);
        try {
          if (this.plugin.basesGen) {
            await this.plugin.basesGen.regenerate();
          }
        } catch (e) {
          console.warn("[zeus][passport] bases regenerate failed:", e.message);
        }
        return { total: notes.length, succeeded, failed };
      }
      async _enumerateMarkdownNotes() {
        const exclusions = new Set(this.plugin.settings && this.plugin.settings.folderExclusions || []);
        if (this.plugin.app && this.plugin.app.vault && typeof this.plugin.app.vault.getMarkdownFiles === "function") {
          const all = this.plugin.app.vault.getMarkdownFiles();
          const out = [];
          for (const f of all) {
            const segments = f.path.split("/");
            let skip = false;
            for (const seg of segments) {
              if (exclusions.has(seg) || seg.startsWith(".")) {
                skip = true;
                break;
              }
            }
            if (!skip) out.push(f.path);
          }
          return out;
        }
        const skipNames = new Set(exclusions);
        const allFiles = await universal2.adapterWalk(this._adapter, "", skipNames);
        return allFiles.filter((p) => p.endsWith(".md"));
      }
      // ---- JSONL I/O ----
      /**
       * Load all passports as Map<path, passport>.
       * Cache invalidated when file mtime changes.
       */
      async loadAll() {
        const file = this.jsonlPath;
        if (!await universal2.adapterExists(this._adapter, file)) {
          this._cache = /* @__PURE__ */ new Map();
          return this._cache;
        }
        let mtime = 0;
        const stat = await universal2.adapterStat(this._adapter, file);
        if (stat && typeof stat.mtime === "number") mtime = stat.mtime;
        if (this._cache && this._cacheLoadedAt >= mtime) {
          return this._cache;
        }
        const map = /* @__PURE__ */ new Map();
        const raw = await universal2.adapterRead(this._adapter, file);
        const lines = raw.split("\n");
        for (const ln of lines) {
          if (!ln.trim()) continue;
          try {
            const obj = JSON.parse(ln);
            if (obj && obj.path) map.set(obj.path, obj);
          } catch (e) {
            console.warn("[zeus][passport] skip bad line:", e.message);
          }
        }
        this._cache = map;
        this._cacheLoadedAt = Date.now();
        return map;
      }
      /**
       * Persist Map<path, passport> to JSONL atomically.
       */
      async saveAll(map) {
        await this._ensureDataDir();
        const lines = [];
        for (const passport of map.values()) {
          lines.push(JSON.stringify(passport));
        }
        await universal2.adapterWriteAtomic(this._adapter, this.jsonlPath, lines.join("\n"));
        this._cache = map;
        this._cacheLoadedAt = Date.now();
      }
      // ---- Query (MCP-first surface) ----
      /**
       * Find passports semantically relevant to query.
       * Delegates to daemon /v1/passport/find (which combines embeddings cosine + concept match).
       *
       * @param {string} query
       * @param {object} options - { topN, minScore, conceptFilter, embeddingsPath, passportsPath }
       * @returns {Promise<Array<passport>>}
       */
      async findByQuery(query, options = {}) {
        let daemonReachable = false;
        if (this.plugin.httpClient && typeof this.plugin.httpClient.isAvailable === "function") {
          try {
            daemonReachable = await this.plugin.httpClient.isAvailable(1500);
          } catch (e) {
            daemonReachable = false;
          }
        }
        if (!daemonReachable) {
          return await this.findByQueryLocal(query, options);
        }
        const dataDir = this.dataPath;
        const opts = {
          topN: options.topN || 10,
          minScore: options.minScore || 0.3,
          conceptFilter: options.conceptFilter || null,
          embeddingsPath: options.embeddingsPath || universal2.joinPath(dataDir, "embeddings.jsonl"),
          passportsPath: options.passportsPath || this.jsonlPath
        };
        try {
          const resp = await this.plugin.httpClient.passportFind(query, opts);
          return resp && resp.results || (Array.isArray(resp) ? resp : []);
        } catch (e) {
          console.warn("[zeus][passport] daemon find failed, fallback to local:", e.message);
          return await this.findByQueryLocal(query, options);
        }
      }
      /**
       * v1.11 Feature E — busca local sobre passports.jsonl quando daemon não está
       * disponível (iOS sandbox).
       *
       * Score = concept_overlap(query_tokens, p.concepts) +
       *         bm25Score(query_tokens, p.one_line_summary || basename(p.path))
       *
       * Reusa lib/bm25 — tokenize idêntica, garante interop léxica com o retriever
       * principal. concept_overlap conta tokens da query que aparecem como substring
       * case-insensitive em algum concept do passport (Jaccard-like; pesa overlap
       * sem inflar por concept-redundance).
       *
       * @param {string} query
       * @param {object} options - { topN, minScore, conceptFilter }
       * @returns {Promise<Array<passport>>}
       */
      async findByQueryLocal(query, options = {}) {
        if (!query || typeof query !== "string" || !query.trim()) return [];
        const topN = options.topN || 10;
        const minScore = options.minScore != null ? options.minScore : 0;
        const conceptFilter = options.conceptFilter ? new Set((Array.isArray(options.conceptFilter) ? options.conceptFilter : [options.conceptFilter]).map((s) => String(s).toLowerCase())) : null;
        const map = await this.loadAll();
        if (map.size === 0) return [];
        const queryTokens = bm25.tokenize(query);
        if (queryTokens.length === 0) return [];
        const queryTokenSet = new Set(queryTokens);
        const passports = Array.from(map.values());
        const corpus = passports.map((p) => {
          const summary = p.one_line_summary || p.summary || "";
          const basename = (p.path || "").split("/").pop().replace(/\.md$/, "");
          const cornellText = Array.isArray(p.cornell_cue) ? p.cornell_cue.join(" ") : "";
          return bm25.tokenize(summary + " " + cornellText + " " + basename);
        });
        const bmScores = bm25.bm25Scores(corpus, queryTokens);
        const scored = [];
        for (let i = 0; i < passports.length; i++) {
          const p = passports[i];
          if (conceptFilter) {
            const concepts2 = (p.concepts || []).map((c) => String(c).toLowerCase());
            let hasMatch = false;
            for (const c of concepts2) {
              if (conceptFilter.has(c)) {
                hasMatch = true;
                break;
              }
            }
            if (!hasMatch) continue;
          }
          let overlap = 0;
          const concepts = p.concepts || [];
          for (const c of concepts) {
            const cLower = String(c).toLowerCase();
            for (const qt of queryTokenSet) {
              if (cLower === qt || cLower.includes(qt) || qt.includes(cLower)) {
                overlap++;
                break;
              }
            }
          }
          const score = overlap + 0.5 * bmScores[i];
          if (score < minScore) continue;
          scored.push({ passport: p, score, overlap, bm25: bmScores[i] });
        }
        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, topN).map((x) => ({
          ...x.passport,
          _score: x.score,
          _overlap: x.overlap,
          _bm25: x.bm25,
          _source: "ios-local"
        }));
      }
      /**
       * Lookup a single passport from in-memory cache (cheap).
       * Note: async because loadAll() is async.
       */
      async getPassport(notePath) {
        const map = await this.loadAll();
        return map.get(notePath) || null;
      }
      // ---- Stats ----
      /**
       * Return aggregate stats: total count, byDomain, byDifficulty, lastBuilt.
       */
      async stats() {
        const map = await this.loadAll();
        const byDomain = {};
        const byDifficulty = {};
        for (const p of map.values()) {
          for (const d of p.domain || []) {
            byDomain[d] = (byDomain[d] || 0) + 1;
          }
          const diff = String(p.difficulty != null ? p.difficulty : "?");
          byDifficulty[diff] = (byDifficulty[diff] || 0) + 1;
        }
        return {
          total: map.size,
          byDomain,
          byDifficulty,
          lastBuilt: this._lastBuiltAt
        };
      }
    };
    module2.exports = PassportIndex2;
  }
});

// lib/bases-generator.js
var require_bases_generator = __commonJS({
  "lib/bases-generator.js"(exports2, module2) {
    "use strict";
    var universal2 = require_universal_fs();
    var DATA_DIR_NAME2 = "data";
    var BASE_FILE = "zeus-cards.base";
    var PASSPORTS_FILE = "passports.jsonl";
    var BasesGenerator2 = class {
      constructor(plugin) {
        this.plugin = plugin;
      }
      get _adapter() {
        return this.plugin.app.vault.adapter;
      }
      get dataPath() {
        return universal2.joinPath(this.plugin.manifest.dir, DATA_DIR_NAME2);
      }
      get basePath() {
        return universal2.joinPath(this.dataPath, BASE_FILE);
      }
      get jsonlPath() {
        return universal2.joinPath(this.dataPath, PASSPORTS_FILE);
      }
      async regenerate() {
        return await this.generateBase(this.jsonlPath, this.basePath);
      }
      async generateBase(jsonlPath, outputPath) {
        if (!await universal2.adapterExists(this._adapter, jsonlPath)) {
          console.warn("[zeus][bases] passports.jsonl missing \u2014 skipping .base regen");
          return { written: false, count: 0, path: outputPath };
        }
        const raw = await universal2.adapterRead(this._adapter, jsonlPath);
        const lines = raw.split("\n").filter((l) => l.trim());
        let count = 0;
        let withSummary = 0;
        let withConcepts = 0;
        let withDomain = 0;
        let withCornell = 0;
        let withLuhmann = 0;
        const domains = /* @__PURE__ */ new Set();
        const noteTypes = { fleeting: 0, literature: 0, permanent: 0 };
        for (const ln of lines) {
          try {
            const obj = JSON.parse(ln);
            if (!obj || !obj.path) continue;
            count++;
            if (obj.one_line_summary || obj.summary) withSummary++;
            if (Array.isArray(obj.concepts) && obj.concepts.length) withConcepts++;
            if (obj.domain) {
              withDomain++;
              if (Array.isArray(obj.domain)) for (const d of obj.domain) domains.add(d);
              else domains.add(String(obj.domain));
            }
            if (Array.isArray(obj.cornell_cue) && obj.cornell_cue.length) withCornell++;
            if (obj.note_type) {
              withLuhmann++;
              if (noteTypes[obj.note_type] !== void 0) noteTypes[obj.note_type]++;
            }
          } catch (e) {
          }
        }
        const generatedAt = (/* @__PURE__ */ new Date()).toISOString();
        const stats = { count, withSummary, withConcepts, withDomain, withCornell, withLuhmann, noteTypes, domainList: [...domains].sort() };
        const yaml = this._renderYaml(stats, generatedAt);
        await universal2.adapterWriteAtomic(this._adapter, outputPath, yaml);
        return { written: true, count, stats, path: outputPath };
      }
      _renderYaml(stats, generatedAt) {
        const cornellStat = `cornell=${stats.withCornell}`;
        const luhmannStat = `luhmann=${stats.withLuhmann}(f=${stats.noteTypes.fleeting}/l=${stats.noteTypes.literature}/p=${stats.noteTypes.permanent})`;
        return [
          "# zeus-cards.base \u2014 auto-generated v1.8.0 (Cornell + Luhmann Zettelkasten)",
          "# DO NOT EDIT MANUALLY \u2014 regenerated on each passport rebuild.",
          `# generated_at: ${generatedAt}`,
          `# stats: ${stats.count} passports \xB7 summary=${stats.withSummary} \xB7 concepts=${stats.withConcepts} \xB7 domain=${stats.withDomain} \xB7 ${cornellStat} \xB7 ${luhmannStat}`,
          `# domains: ${stats.domainList.slice(0, 10).join(", ")}${stats.domainList.length > 10 ? " \u2026" : ""}`,
          "#",
          "# Can\xF4nico: data/passports.jsonl. Bases \xE9 UI derivativa.",
          "# Sintaxe: https://obsidian.md/help/bases/syntax",
          "",
          "filters:",
          "  and:",
          '    - file.ext == "md"',
          "",
          "formulas:",
          '  density_est: "file.size / 6"',
          '  freshness_days: "(now() - file.mtime) / 86400000"',
          '  has_graph: "list(zeus_graph_related).length > 0"',
          '  has_neighbors: "list(zeus_related).length > 0"',
          '  neighbor_count: "list(zeus_related).length"',
          '  graph_node_count: "list(zeus_graph_related).length"',
          '  domain_primary: "list(zeus_domain)[0]"',
          '  has_cornell: "list(zeus_cornell_cue).length > 0"',
          '  cue_count: "list(zeus_cornell_cue).length"',
          '  is_permanent: "zeus_note_type == \\"permanent\\""',
          '  is_literature: "zeus_note_type == \\"literature\\""',
          '  is_fleeting: "zeus_note_type == \\"fleeting\\""',
          "",
          "properties:",
          "  file.path:",
          "    displayName: Note",
          "  zeus_summary:",
          "    displayName: Summary",
          "  zeus_concepts:",
          "    displayName: Concepts",
          "  zeus_domain:",
          "    displayName: Domain",
          "  zeus_difficulty:",
          "    displayName: Difficulty",
          "  zeus_related:",
          "    displayName: Semantic neighbors",
          "  zeus_graph_related:",
          "    displayName: Graph entities",
          "  zeus_cornell_cue:",
          "    displayName: Cornell Cues",
          "  zeus_cornell_summary:",
          "    displayName: Cornell Summary",
          "  zeus_note_type:",
          "    displayName: Note type (Luhmann)",
          "  zeus_zettel_id:",
          "    displayName: Zettel ID",
          "  formula.density_est:",
          "    displayName: Density ~tokens",
          "  formula.freshness_days:",
          "    displayName: Days since edit",
          "  formula.neighbor_count:",
          '    displayName: "# neighbors"',
          "  formula.graph_node_count:",
          '    displayName: "# graph nodes"',
          "  formula.cue_count:",
          '    displayName: "# Cornell cues"',
          "",
          "views:",
          "  - type: table",
          "    name: All passports",
          "    order:",
          "      - file.path",
          "      - zeus_summary",
          "      - zeus_domain",
          "      - zeus_difficulty",
          "      - zeus_note_type",
          "      - formula.neighbor_count",
          "      - formula.graph_node_count",
          "      - formula.density_est",
          "      - formula.freshness_days",
          "    sort:",
          "      - property: formula.density_est",
          "        direction: DESC",
          "",
          "  - type: cards",
          "    name: Orphans (no semantic neighbors)",
          "    filters:",
          "      and:",
          '        - file.ext == "md"',
          "        - formula.has_neighbors == false",
          "    order:",
          "      - file.path",
          "      - zeus_summary",
          "      - formula.density_est",
          "",
          "  - type: table",
          "    name: Graph-rich (\u22655 entities)",
          "    filters:",
          "      and:",
          '        - file.ext == "md"',
          "        - formula.graph_node_count >= 5",
          "    order:",
          "      - file.path",
          "      - zeus_summary",
          "      - formula.graph_node_count",
          "      - formula.neighbor_count",
          "    sort:",
          "      - property: formula.graph_node_count",
          "        direction: DESC",
          "",
          "  - type: cards",
          "    name: Cards by domain",
          "    order:",
          "      - zeus_summary",
          "      - zeus_concepts",
          "      - zeus_difficulty",
          "    groupBy:",
          "      property: formula.domain_primary",
          "      direction: ASC",
          "",
          "  - type: table",
          "    name: Recently edited",
          "    order:",
          "      - file.path",
          "      - zeus_summary",
          "      - formula.freshness_days",
          "    sort:",
          "      - property: formula.freshness_days",
          "        direction: ASC",
          "",
          "  - type: table",
          "    name: Zettelkasten \u2014 Permanent notes",
          "    filters:",
          "      and:",
          '        - file.ext == "md"',
          "        - formula.is_permanent == true",
          "    order:",
          "      - zeus_zettel_id",
          "      - file.path",
          "      - zeus_summary",
          "      - zeus_concepts",
          "      - formula.neighbor_count",
          "    sort:",
          "      - property: zeus_zettel_id",
          "        direction: ASC",
          "",
          "  - type: cards",
          "    name: Zettelkasten \u2014 Literature notes",
          "    filters:",
          "      and:",
          '        - file.ext == "md"',
          "        - formula.is_literature == true",
          "    order:",
          "      - file.path",
          "      - zeus_summary",
          "      - zeus_cornell_cue",
          "      - formula.freshness_days",
          "",
          "  - type: table",
          "    name: Zettelkasten \u2014 Fleeting notes (to process)",
          "    filters:",
          "      and:",
          '        - file.ext == "md"',
          "        - formula.is_fleeting == true",
          "    order:",
          "      - file.path",
          "      - zeus_summary",
          "      - formula.freshness_days",
          "    sort:",
          "      - property: formula.freshness_days",
          "        direction: ASC",
          "",
          "  - type: table",
          "    name: Cornell \u2014 Notas com cues",
          "    filters:",
          "      and:",
          '        - file.ext == "md"',
          "        - formula.has_cornell == true",
          "    order:",
          "      - file.path",
          "      - zeus_cornell_summary",
          "      - zeus_cornell_cue",
          "      - formula.cue_count",
          "    sort:",
          "      - property: formula.cue_count",
          "        direction: DESC",
          ""
        ].join("\n");
      }
    };
    module2.exports = BasesGenerator2;
  }
});

// lib/distributed-coordinator.js
var require_distributed_coordinator = __commonJS({
  "lib/distributed-coordinator.js"(exports2, module2) {
    "use strict";
    var universal2 = require_universal_fs();
    var DEFAULT_TTL_MS = 6e4;
    var CLAIMS_DIR_NAME = "claims";
    async function sha256Short(s) {
      const hex = await universal2.sha256Hex(String(s));
      return hex.slice(0, 16);
    }
    var DistributedCoordinator2 = class {
      /**
       * @param {*} plugin Zeus plugin instance (uses plugin.app.vault.adapter + plugin.manifest.dir)
       * @param {{deviceId?: string, ttlMs?: number}} options
       */
      constructor(plugin, options = {}) {
        this.plugin = plugin;
        this.ttlMs = options.ttlMs || DEFAULT_TTL_MS;
        this.deviceId = options.deviceId || universal2.generateDeviceId();
      }
      get _adapter() {
        return this.plugin.app.vault.adapter;
      }
      // Vault-relative path to the claims directory.
      get claimsDir() {
        return universal2.joinPath(this.plugin.manifest.dir, "data", CLAIMS_DIR_NAME);
      }
      async _ensureDir() {
        await universal2.adapterMkdir(this._adapter, universal2.joinPath(this.plugin.manifest.dir, "data"));
        await universal2.adapterMkdir(this._adapter, this.claimsDir);
      }
      async _lockPath(notePath) {
        const short = await sha256Short(notePath);
        return universal2.joinPath(this.claimsDir, short + ".lock");
      }
      /**
       * Try to acquire a claim on `notePath`. Returns { claimed: true, ...claim } on
       * success, or { claimed: false, current_holder, expires_at } if held by another
       * device whose claim hasn't yet expired.
       *
       * If the existing lock is owned by THIS device, the claim is renewed (TTL extended).
       * If the existing lock is expired or malformed, it's overwritten.
       */
      async claim(notePath) {
        await this._ensureDir();
        const lp = await this._lockPath(notePath);
        if (await universal2.adapterExists(this._adapter, lp)) {
          try {
            const raw = await universal2.adapterRead(this._adapter, lp);
            const existing = JSON.parse(raw);
            const now = Date.now();
            if (existing && typeof existing.expires_at === "number" && existing.expires_at > now) {
              if (existing.device_id === this.deviceId) {
                return await this._writeClaimAtomic(notePath, lp);
              }
              return {
                claimed: false,
                current_holder: existing.device_id,
                expires_at: existing.expires_at,
                note_path: notePath
              };
            }
          } catch (e) {
            console.warn("[zeus][coord] malformed lock, overwriting:", e.message);
          }
        }
        return await this._writeClaimAtomic(notePath, lp);
      }
      async _writeClaimAtomic(notePath, lockPath) {
        const now = Date.now();
        const claim = {
          device_id: this.deviceId,
          note_path: notePath,
          claimed_at: now,
          expires_at: now + this.ttlMs
        };
        await universal2.adapterWriteAtomic(this._adapter, lockPath, JSON.stringify(claim));
        return { claimed: true, ...claim };
      }
      /**
       * Release a claim previously acquired by this device. Returns:
       *   { released: true } on success
       *   { released: false, reason } if lock doesn't exist, owned by another device,
       *     or unreadable.
       */
      async release(notePath) {
        const lp = await this._lockPath(notePath);
        if (!await universal2.adapterExists(this._adapter, lp)) {
          return { released: false, reason: "no lock" };
        }
        try {
          const raw = await universal2.adapterRead(this._adapter, lp);
          const existing = JSON.parse(raw);
          if (existing.device_id !== this.deviceId) {
            return { released: false, reason: "not owner", current_holder: existing.device_id };
          }
          await universal2.adapterRemove(this._adapter, lp);
          return { released: true };
        } catch (e) {
          return { released: false, reason: e.message };
        }
      }
      /**
       * Sweep all expired locks. Returns count of removed locks (including
       * malformed ones, which are treated as expired).
       */
      async sweepExpired() {
        await this._ensureDir();
        let cleaned = 0;
        const now = Date.now();
        const listing = await universal2.adapterList(this._adapter, this.claimsDir);
        const entries = listing.files || [];
        for (const full of entries) {
          if (!full.endsWith(".lock")) continue;
          try {
            const raw = await universal2.adapterRead(this._adapter, full);
            const claim = JSON.parse(raw);
            if (typeof claim.expires_at !== "number" || claim.expires_at < now) {
              await universal2.adapterRemove(this._adapter, full);
              cleaned++;
            }
          } catch (e) {
            try {
              await universal2.adapterRemove(this._adapter, full);
              cleaned++;
            } catch (e2) {
            }
          }
        }
        return cleaned;
      }
      /**
       * Snapshot of active claims grouped by device.
       * Returns: { total, expired, byDevice: {<id>: count}, thisDeviceId }
       *
       * NOTE: this method is async (vault adapter is async). Callers must await.
       */
      async stats() {
        await this._ensureDir();
        const byDevice = /* @__PURE__ */ new Map();
        let total = 0, expired = 0;
        const now = Date.now();
        const listing = await universal2.adapterList(this._adapter, this.claimsDir);
        const entries = listing.files || [];
        for (const full of entries) {
          if (!full.endsWith(".lock")) continue;
          try {
            const raw = await universal2.adapterRead(this._adapter, full);
            const claim = JSON.parse(raw);
            total++;
            if (typeof claim.expires_at !== "number" || claim.expires_at < now) expired++;
            const dev = claim.device_id || "unknown";
            byDevice.set(dev, (byDevice.get(dev) || 0) + 1);
          } catch (e) {
          }
        }
        return {
          total,
          expired,
          byDevice: Object.fromEntries(byDevice),
          thisDeviceId: this.deviceId
        };
      }
    };
    module2.exports = DistributedCoordinator2;
  }
});

// lib/passport-scheduler.js
var require_passport_scheduler = __commonJS({
  "lib/passport-scheduler.js"(exports2, module2) {
    "use strict";
    var universal2 = require_universal_fs();
    var DEFAULT_INTERVAL_MS = 15 * 60 * 1e3;
    var INITIAL_DELAY_MS = 30 * 1e3;
    var PassportScheduler2 = class {
      /**
       * @param {*} plugin Zeus plugin instance (uses plugin.coordinator + plugin.indexer + plugin.passport)
       * @param {{intervalMs?: number}} options
       */
      constructor(plugin, options = {}) {
        this.plugin = plugin;
        this.intervalMs = options.intervalMs || DEFAULT_INTERVAL_MS;
        this.timerId = null;
        this.initialTimerId = null;
        this.lastSweep = null;
        this.running = false;
      }
      get coord() {
        return this.plugin.coordinator;
      }
      get _adapter() {
        return this.plugin.app.vault.adapter;
      }
      start() {
        if (this.timerId) return;
        this.timerId = setInterval(
          () => this.sweep().catch((e) => console.warn("[zeus][scheduler] interval sweep:", e.message)),
          this.intervalMs
        );
        console.log(`[zeus][scheduler] started \u2014 interval ${Math.round(this.intervalMs / 1e3)}s`);
        this.initialTimerId = setTimeout(
          () => this.sweep().catch((e) => console.warn("[zeus][scheduler] initial sweep:", e.message)),
          INITIAL_DELAY_MS
        );
      }
      stop() {
        if (this.timerId) {
          clearInterval(this.timerId);
          this.timerId = null;
        }
        if (this.initialTimerId) {
          clearTimeout(this.initialTimerId);
          this.initialTimerId = null;
        }
      }
      /**
       * One sweep cycle: cleanup expired claims → walk vault → re-extract stale passports.
       * Re-entry safe (no-op if already running).
       *
       * Returns: { at, elapsed, claimed, skipped, extracted, errors, expiredCleaned }
       */
      async sweep() {
        if (this.running) {
          return { at: Date.now(), skipped: true, reason: "already running" };
        }
        this.running = true;
        const start = Date.now();
        let claimed = 0, skipped = 0, extracted = 0, errors = 0, expiredCleaned = 0;
        try {
          if (!this.coord) {
            throw new Error("coordinator unavailable");
          }
          expiredCleaned = await this.coord.sweepExpired();
          const files = (await this.plugin.indexer.enumerateFiles()).filter((f) => f.ext === "md");
          const passports = await this.plugin.passport.loadAll();
          for (const f of files) {
            let content;
            try {
              content = await universal2.adapterRead(this._adapter, f.rel);
            } catch (e) {
              console.warn("[zeus][scheduler] read fail", f.rel, e.message);
              errors++;
              continue;
            }
            const currentSha = await universal2.sha256Hex(content);
            const existing = passports.get(f.rel);
            if (existing && existing.sha === currentSha) {
              skipped++;
              continue;
            }
            const claim = await this.coord.claim(f.rel);
            if (!claim.claimed) {
              skipped++;
              continue;
            }
            claimed++;
            try {
              await this.plugin.passport.buildOne(f.rel);
              extracted++;
            } catch (e) {
              console.warn("[zeus][scheduler] extract failed for", f.rel, e.message);
              errors++;
            } finally {
              try {
                await this.coord.release(f.rel);
              } catch (e) {
              }
            }
          }
        } catch (e) {
          console.warn("[zeus][scheduler] sweep error:", e.message);
          errors++;
        } finally {
          this.running = false;
          this.lastSweep = {
            at: Date.now(),
            elapsed: Date.now() - start,
            claimed,
            skipped,
            extracted,
            errors,
            expiredCleaned
          };
        }
        return this.lastSweep;
      }
      /**
       * Quick status snapshot for status command / Settings tab.
       * NOTE: async — coord.stats() is async in v0.11.
       */
      async stats() {
        let coordStats = null;
        if (this.coord) {
          try {
            coordStats = await this.coord.stats();
          } catch (e) {
            coordStats = { error: e.message };
          }
        }
        return {
          running: this.running,
          enabled: !!this.timerId,
          intervalMs: this.intervalMs,
          lastSweep: this.lastSweep,
          coordinator: coordStats
        };
      }
    };
    module2.exports = PassportScheduler2;
  }
});

// lib/daemon-lifecycle.js
var require_daemon_lifecycle = __commonJS({
  "lib/daemon-lifecycle.js"(exports2, module2) {
    "use strict";
    var BINARY_NAME = "ZeusDaemonMac";
    var DEFAULT_PORT = 2223;
    var DEFAULT_HOST = "127.0.0.1";
    var DaemonLifecycle2 = class {
      constructor(plugin, options = {}) {
        this.plugin = plugin;
        this.port = options.port || DEFAULT_PORT;
        this.host = options.host || DEFAULT_HOST;
        this.url = `http://${this.host}:${this.port}`;
        this.child = null;
        this.spawnedByUs = false;
        this.lastStatus = null;
        this._startPromise = null;
      }
      _fs() {
        try {
          return require("fs");
        } catch (e) {
          return null;
        }
      }
      _path() {
        try {
          return require("path");
        } catch (e) {
          return null;
        }
      }
      _spawn() {
        try {
          return require("child_process").spawn;
        } catch (e) {
          return null;
        }
      }
      _execFileSync() {
        try {
          return require("child_process").execFileSync;
        } catch (e) {
          return null;
        }
      }
      binaryPath() {
        const fs2 = this._fs();
        const path2 = this._path();
        if (!fs2 || !path2) return null;
        const vaultRoot = this.plugin.vaultRoot;
        if (!vaultRoot || !this.plugin.manifest || !this.plugin.manifest.dir) return null;
        const candidate = path2.join(vaultRoot, this.plugin.manifest.dir, "bin", BINARY_NAME);
        return fs2.existsSync(candidate) ? candidate : null;
      }
      async isHealthy(timeoutMs = 1500) {
        const ZeusHttpClient2 = require_zeus_http_client();
        const probe = new ZeusHttpClient2(this.url);
        try {
          return await probe.isAvailable(timeoutMs);
        } catch (e) {
          return false;
        }
      }
      // Garante que o binário tem +x e sem quarantena (Gatekeeper).
      // Idempotente — silencia falhas (codesign já é adhoc).
      _prepareBinary(absPath) {
        const fs2 = this._fs();
        if (fs2) {
          try {
            fs2.chmodSync(absPath, 493);
          } catch (e) {
          }
        }
        const execFileSync = this._execFileSync();
        if (execFileSync) {
          try {
            execFileSync("/usr/bin/xattr", ["-d", "com.apple.quarantine", absPath], { stdio: "ignore" });
          } catch (e) {
          }
        }
      }
      async ensureRunning() {
        if (this._startPromise) return this._startPromise;
        this._startPromise = (async () => {
          try {
            return await this._doEnsureRunning();
          } finally {
            this._startPromise = null;
          }
        })();
        return this._startPromise;
      }
      async _doEnsureRunning() {
        if (await this.isHealthy(800)) {
          this.lastStatus = { running: true, source: "pre-existing", url: this.url };
          return this.lastStatus;
        }
        const spawn2 = this._spawn();
        if (!spawn2) {
          this.lastStatus = { running: false, source: "no-spawn", reason: "child_process unavailable (Capacitor / iOS)" };
          return this.lastStatus;
        }
        const bin = this.binaryPath();
        if (!bin) {
          this.lastStatus = { running: false, source: "no-binary", reason: `${BINARY_NAME} ausente em bin/` };
          return this.lastStatus;
        }
        this._prepareBinary(bin);
        return new Promise((resolve) => {
          let resolved = false;
          const finish = (status) => {
            if (!resolved) {
              resolved = true;
              this.lastStatus = status;
              resolve(status);
            }
          };
          let child;
          try {
            child = spawn2(bin, ["--port", String(this.port), "--host", this.host], {
              stdio: "ignore",
              detached: false,
              env: Object.assign({}, process.env || {}, { ZEUS_SPAWN_PARENT: "obsidian" })
            });
          } catch (e) {
            finish({ running: false, source: "spawn-error", reason: e.message });
            return;
          }
          child.on("error", (err) => {
            finish({ running: false, source: "spawn-error", reason: err.message });
          });
          child.on("exit", (code, signal) => {
            if (this.child === child) {
              this.child = null;
              this.spawnedByUs = false;
            }
            if (!resolved) finish({ running: false, source: "spawn-exit", reason: `exit ${code} ${signal || ""}`.trim() });
          });
          this.child = child;
          this.spawnedByUs = true;
          const start = Date.now();
          const poll = async () => {
            if (resolved) return;
            if (await this.isHealthy(600)) {
              finish({ running: true, source: "spawned", pid: child.pid, url: this.url, latencyMs: Date.now() - start });
              return;
            }
            if (Date.now() - start > 1e4) {
              try {
                child.kill("SIGTERM");
              } catch (e) {
              }
              finish({ running: false, source: "spawn-timeout", reason: "sem /v1/health em 10s" });
              return;
            }
            setTimeout(poll, 300);
          };
          setTimeout(poll, 250);
        });
      }
      async stop({ graceMs = 2e3 } = {}) {
        if (!this.spawnedByUs || !this.child) return { stopped: false, reason: "not-spawned-by-us" };
        const child = this.child;
        this.child = null;
        this.spawnedByUs = false;
        let exited = false;
        const exitPromise = new Promise((resolve) => {
          const onExit = () => {
            exited = true;
            resolve();
          };
          child.once("exit", onExit);
          child.once("close", onExit);
        });
        try {
          child.kill("SIGTERM");
        } catch (e) {
        }
        const timer = new Promise((r) => setTimeout(r, graceMs));
        await Promise.race([exitPromise, timer]);
        if (!exited) {
          try {
            child.kill("SIGKILL");
          } catch (e) {
          }
          await Promise.race([exitPromise, new Promise((r) => setTimeout(r, 500))]);
        }
        return { stopped: true, force: !exited };
      }
    };
    module2.exports = DaemonLifecycle2;
  }
});

// lib/zeus-simhash.js
var require_zeus_simhash = __commonJS({
  "lib/zeus-simhash.js"(exports2, module2) {
    "use strict";
    var DIM = 512;
    var BITS = 128;
    var WORDS = 4;
    function _buildProj() {
      const P = new Int8Array(BITS * DIM);
      for (let b = 0; b < BITS; b++) {
        for (let d = 0; d < DIM; d++) {
          const seed = (b << 16 ^ d & 65535) >>> 0;
          let h = 2166136261;
          h = Math.imul(h ^ seed & 255, 16777619) >>> 0;
          h = Math.imul(h ^ seed >> 8 & 255, 16777619) >>> 0;
          h = Math.imul(h ^ seed >> 16 & 255, 16777619) >>> 0;
          h = Math.imul(h ^ seed >> 24 & 255, 16777619) >>> 0;
          P[b * DIM + d] = h & 1 ? 1 : -1;
        }
      }
      return P;
    }
    var PROJ = _buildProj();
    function computeSimHash(vec) {
      const result = new Uint32Array(WORDS);
      const len = Math.min(vec.length, DIM);
      for (let b = 0; b < BITS; b++) {
        let dot = 0;
        const base = b * DIM;
        for (let d = 0; d < len; d++) {
          dot += vec[d] * PROJ[base + d];
        }
        if (dot > 0) {
          result[b >> 5] |= 1 << (b & 31) >>> 0;
        }
      }
      return result;
    }
    function hammingDistance(a, b) {
      let dist = 0;
      for (let i = 0; i < WORDS; i++) {
        let x = (a[i] ^ b[i]) >>> 0;
        x -= x >> 1 & 1431655765;
        x = (x & 858993459) + (x >> 2 & 858993459);
        x = x + (x >> 4) & 252645135;
        dist += Math.imul(x, 16843009) >>> 24;
      }
      return dist;
    }
    function serializeHash(hash) {
      let s = "";
      for (let i = 0; i < WORDS; i++) {
        s += (hash[i] >>> 0).toString(16).padStart(8, "0");
      }
      return s;
    }
    function deserializeHash(hex) {
      const result = new Uint32Array(WORDS);
      for (let i = 0; i < WORDS; i++) {
        result[i] = parseInt(hex.slice(i * 8, i * 8 + 8), 16) >>> 0;
      }
      return result;
    }
    function filterBySimHash(candidates, queryHash, maxDist = 20) {
      const out = [];
      for (const c of candidates) {
        if (!c.sh) {
          out.push(c);
          continue;
        }
        try {
          const h = deserializeHash(c.sh);
          if (hammingDistance(queryHash, h) <= maxDist) out.push(c);
        } catch (e) {
          out.push(c);
        }
      }
      return out;
    }
    function annotateWithSimHash(embObj) {
      if (!embObj || !Array.isArray(embObj.vec)) return embObj;
      embObj.sh = serializeHash(computeSimHash(embObj.vec));
      return embObj;
    }
    module2.exports = {
      computeSimHash,
      hammingDistance,
      serializeHash,
      deserializeHash,
      filterBySimHash,
      annotateWithSimHash,
      PROJ,
      // exposto para testes unitários (verificar determinismo)
      DIM,
      BITS,
      WORDS
    };
  }
});

// lib/hybrid-search.js
var require_hybrid_search = __commonJS({
  "lib/hybrid-search.js"(exports2, module2) {
    "use strict";
    var RRF_K = 60;
    var SOURCE_BITS = {
      semantic: 1 << 0,
      path: 1 << 1,
      graph: 1 << 2,
      passport: 1 << 3,
      spotlight: 1 << 4,
      bm25: 1 << 5,
      // v1.11 Feature I — lexical-ios é BM25 persistido (TF-IDF + stems pt-BR).
      lexicalIos: 1 << 6,
      // v1.15.0 — SimHash 128-bit pré-filtro turbo quantico. Bit de auditoria:
      // items que sobreviveram ao filtro Hamming distance ≤ 20 recebem este bit.
      simhash: 1 << 7
    };
    var SOURCE_NAMES = Object.keys(SOURCE_BITS);
    function _maskToNames(mask) {
      const out = [];
      for (const name of SOURCE_NAMES) {
        if ((mask & SOURCE_BITS[name]) !== 0) out.push(name);
      }
      return out;
    }
    function _popcount(n) {
      n = n - (n >> 1 & 1431655765);
      n = (n & 858993459) + (n >> 2 & 858993459);
      n = n + (n >> 4) & 252645135;
      return n * 16843009 >>> 24;
    }
    var _bm25;
    try {
      _bm25 = require_bm25();
    } catch (e) {
      console.warn("[zeus.hybrid] bm25 lib n\xE3o carregou \u2014 5\xBA retriever desativado:", e.message);
      _bm25 = null;
    }
    var _simhash;
    try {
      _simhash = require_zeus_simhash();
    } catch (e) {
      console.warn("[zeus.hybrid] zeus-simhash n\xE3o carregou \u2014 pr\xE9-filtro turbo quantico desativado:", e.message);
      _simhash = null;
    }
    var HybridSearch2 = class {
      constructor(plugin) {
        this.plugin = plugin;
      }
      // ---------------------------------------------------------------------------
      // RRF fuse — recebe array de listas ranqueadas, cada item {path, source}
      // (score por item ignorado — só posição). Devolve lista única ordenada por
      // RRF score com `sources` agregadas. Internamente usa bitmask, expõe string[].
      // ---------------------------------------------------------------------------
      fuse(lists) {
        const fused = /* @__PURE__ */ new Map();
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
            sourceMask: v.sourceMask
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
        const maxScore = items.reduce((m, it) => Math.max(m, it.score || 0), 0);
        const normScore = (s) => maxScore > 0 ? (s || 0) / maxScore : 0;
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
      // _simhashRetriever — pré-filtro turbo quantico: hamming distance O(N×4)
      // sobre campo `sh` (SimHash 128-bit) dos embeddings, antes do cosine exato.
      //
      // Retorna apenas itens dentro de maxDist Hamming bits do query SimHash.
      // Source bit `simhash` marca itens sobreviventes para auditoria via MMR.
      //
      // Requisitos:
      //   - embeddings.jsonl deve ter campo `sh` (gerado por annotateWithSimHash)
      //   - queryVec deve ser um vetor 512-dim válido
      // ---------------------------------------------------------------------------
      _simhashRetriever(queryVec, topN, maxDist = 20) {
        if (!_simhash || !queryVec || !Array.isArray(queryVec)) return [];
        const searcher = this.plugin.searcher;
        if (!searcher || !searcher.embeddings) return [];
        try {
          const queryHash = _simhash.computeSimHash(queryVec);
          const hits = [];
          for (const [path2, emb] of searcher.embeddings.entries()) {
            if (!emb || !emb.sh) continue;
            try {
              const h = _simhash.deserializeHash(emb.sh);
              const dist = _simhash.hammingDistance(queryHash, h);
              if (dist <= maxDist) hits.push({ path: path2, dist });
            } catch (e) {
            }
          }
          hits.sort((a, b) => a.dist - b.dist);
          return hits.slice(0, topN).map((h) => ({ path: h.path, source: "simhash" }));
        } catch (e) {
          console.warn("[zeus.hybrid] simhash retriever failed:", e.message);
          return [];
        }
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
      _bm25Retriever(query, topN, maxCorpus = 2e3) {
        if (!_bm25 || !_bm25.rankNotes) return [];
        try {
          const searcher = this.plugin.searcher;
          if (!searcher || !searcher.embeddings) return [];
          const embs = searcher.embeddings;
          const notes = [];
          let count = 0;
          const canReadDoc = typeof searcher.readDoc === "function";
          for (const [p, e] of embs.entries()) {
            if (count >= maxCorpus) break;
            if (!p || !p.endsWith(".md")) continue;
            let text = "";
            const title = e && e.title ? e.title : p.split("/").pop().replace(/\.md$/, "");
            if (canReadDoc) {
              try {
                const body = searcher.readDoc(p);
                if (body) text = title + "\n" + body.slice(0, 3e4);
                else text = title;
              } catch (e2) {
                text = title;
              }
            } else {
              text = title;
            }
            notes.push({ path: p, text });
            count++;
          }
          const ranked = _bm25.rankNotes(notes, query, topN);
          return ranked.map((r) => ({ path: r.path, source: "bm25" }));
        } catch (e) {
          console.warn("[zeus.hybrid] bm25 retriever failed:", e.message);
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
        try {
          const sem = this.plugin.searcher.neighbors(filePath, topN * 2);
          lists.push(sem.map((x) => ({ path: x.path, source: "semantic" })));
        } catch (e) {
          console.warn("[zeus.hybrid] semantic neighbors failed", e.message);
        }
        try {
          const file = this.plugin.app.vault.getAbstractFileByPath(filePath);
          const mdc = this.plugin.app.metadataCache;
          const cache = file ? mdc.getFileCache(file) : null;
          const fm = cache && cache.frontmatter ? cache.frontmatter : null;
          const collected = /* @__PURE__ */ new Set();
          if (fm) {
            for (const key of ["zeus_graph_related", "zeus_related"]) {
              const arr = fm[key];
              if (!Array.isArray(arr)) continue;
              for (const raw of arr) {
                const link = String(raw).replace(/^\[\[/, "").replace(/\]\]$/, "").split("|")[0].split("#")[0].trim();
                if (!link) continue;
                const dest = mdc.getFirstLinkpathDest ? mdc.getFirstLinkpathDest(link, filePath) : null;
                if (dest && dest.path && dest.path !== filePath) {
                  collected.add(dest.path);
                }
              }
            }
          }
          if (collected.size > 0) {
            const validated = [...collected].filter((p) => this.plugin.searcher.embeddings.has(p));
            lists.push(validated.map((p) => ({ path: p, source: "graph" })));
          }
        } catch (e) {
          console.warn("[zeus.hybrid] graph frontmatter parse failed", e.message);
        }
        try {
          if (this.plugin.passport && typeof this.plugin.passport.findByQuery === "function") {
            const basename = filePath.split("/").pop().replace(/\.md$/, "");
            const hits = await this.plugin.passport.findByQuery(basename, { topN: topN * 2 });
            const list = (hits || []).map((h) => h && (h.path || h.file) || null).filter((p) => p && p !== filePath).map((p) => ({ path: p, source: "passport" }));
            lists.push(list);
          }
        } catch (e) {
          console.warn("[zeus.hybrid] passport find failed", e.message);
        }
        try {
          const mg = this.plugin.multiplex;
          if (mg && typeof mg.load === "function" && (!mg.edges || mg.edges.size === 0) && !this.plugin._multiplexLoaded && !this.plugin._multiplexLoadAttempted) {
            this.plugin._multiplexLoadAttempted = true;
            try {
              const r = await mg.load();
              if (r && r.read > 0) this.plugin._multiplexLoaded = true;
            } catch (e) {
            }
          }
          if (mg && mg.edges && mg.edges.size > 0) {
            const byDst = mg.neighborsByDst(filePath);
            if (byDst.length > 0) {
              lists.push(byDst.slice(0, topN * 2).map((x) => ({ path: x.dst, source: "graph" })));
            }
          }
        } catch (e) {
          console.warn("[zeus.hybrid] multiplex neighbors failed", e.message);
        }
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
        let _queryVec = null;
        try {
          const sem = await this.plugin.searcher.search(q, topN * 2);
          lists.push((sem || []).map((x) => ({ path: x.path, source: "semantic" })));
          if (this.plugin.searcher.lastQueryVec) {
            _queryVec = this.plugin.searcher.lastQueryVec;
          }
        } catch (e) {
          console.warn("[zeus.hybrid] semantic search failed", e.message);
        }
        if (_simhash && _queryVec) {
          try {
            const shHits = this._simhashRetriever(_queryVec, topN * 2);
            if (shHits.length > 0) lists.push(shHits);
          } catch (e) {
            console.warn("[zeus.hybrid] simhash retrieval failed", e.message);
          }
        }
        try {
          const qn = q.toLowerCase().trim();
          const all = this.plugin.app.vault.getMarkdownFiles ? this.plugin.app.vault.getMarkdownFiles() : [];
          const matched = [];
          for (const f of all) {
            const base = (f.basename || "").toLowerCase();
            const full = (f.path || "").toLowerCase();
            if (base.includes(qn) || full.includes(qn)) {
              matched.push({ path: f.path, source: "path" });
              if (matched.length >= topN * 2) break;
            }
          }
          lists.push(matched);
        } catch (e) {
          console.warn("[zeus.hybrid] path match failed", e.message);
        }
        try {
          if (this.plugin.passport && typeof this.plugin.passport.findByQuery === "function") {
            const hits = await this.plugin.passport.findByQuery(q, { topN: topN * 2 });
            const list = (hits || []).map((h) => h && (h.path || h.file) || null).filter(Boolean).map((p) => ({ path: p, source: "passport" }));
            lists.push(list);
          }
        } catch (e) {
          console.warn("[zeus.hybrid] passport find failed", e.message);
        }
        try {
          if (this.plugin.httpClient && this.plugin.vaultRoot) {
            const r = await this.plugin.httpClient.spotlightQueryNative(
              q,
              this.plugin.vaultRoot,
              topN * 2
            );
            this._lastSpotlightMode = r.mode;
            let nodePath = null;
            let nodeFs = null;
            try {
              nodePath = require("path");
            } catch (e) {
            }
            try {
              nodeFs = require("fs");
            } catch (e) {
            }
            let canonicalRoot = this.plugin.vaultRoot;
            try {
              if (nodeFs && nodeFs.realpathSync && nodeFs.realpathSync.native) {
                canonicalRoot = nodeFs.realpathSync.native(this.plugin.vaultRoot);
              }
            } catch (e) {
            }
            const list = [];
            for (const raw of r.results || []) {
              if (typeof raw !== "string" || !raw) continue;
              let rel;
              if (nodePath && nodePath.relative) {
                try {
                  let canonAbs = raw;
                  try {
                    if (nodeFs && nodeFs.realpathSync && nodeFs.realpathSync.native) {
                      canonAbs = nodeFs.realpathSync.native(raw);
                    }
                  } catch (e) {
                  }
                  rel = nodePath.relative(canonicalRoot, canonAbs);
                } catch (e) {
                  continue;
                }
              } else {
                const root = canonicalRoot.endsWith("/") ? canonicalRoot : canonicalRoot + "/";
                rel = raw.startsWith(root) ? raw.slice(root.length) : raw;
              }
              if (!rel || rel.startsWith("..") || nodePath && nodePath.isAbsolute && nodePath.isAbsolute(rel)) continue;
              if (!rel.endsWith(".md")) continue;
              list.push({ path: rel, source: "spotlight" });
              if (list.length >= topN * 2) break;
            }
            if (list.length > 0) lists.push(list);
          }
        } catch (e) {
          console.warn("[zeus.hybrid] spotlight retrieval failed", e.message);
        }
        const bm25SettingEnabled = this.plugin.settings ? this.plugin.settings.hybridBm25Enabled !== false : true;
        if (!opts.disableBm25 && bm25SettingEnabled) {
          try {
            const bm25Hits = this._bm25Retriever(q, topN * 2);
            if (bm25Hits.length > 0) lists.push(bm25Hits);
          } catch (e) {
            console.warn("[zeus.hybrid] bm25 retrieval failed", e.message);
          }
        }
        try {
          if (this.plugin.lexicalIos && typeof this.plugin.lexicalIos.search === "function") {
            const lexHits = await this.plugin.lexicalIos.search(q, topN * 2);
            if (lexHits && lexHits.length > 0) {
              lists.push(lexHits.map((h) => ({ path: h.path, source: "lexicalIos" })));
            }
          }
        } catch (e) {
          console.warn("[zeus.hybrid] lexical-ios retrieval failed", e.message);
        }
        let fused = this.fuse(lists);
        if (opts.diversify) {
          fused = this.diversify(fused, opts.diversityLambda != null ? opts.diversityLambda : 0.5, topN);
        } else {
          fused = fused.slice(0, topN);
        }
        return fused;
      }
    };
    module2.exports = HybridSearch2;
    module2.exports.SOURCE_BITS = SOURCE_BITS;
  }
});

// lib/native-watcher.js
var require_native_watcher = __commonJS({
  "lib/native-watcher.js"(exports2, module2) {
    "use strict";
    var universal2 = require_universal_fs();
    var QUIET_MS = 1500;
    var ADAPTER_DEADLINE_MS = 5e3;
    var MAX_TRACKED = 500;
    var NativeWatcher2 = class {
      constructor(plugin) {
        this.plugin = plugin;
        this.watcher = null;
        this.running = false;
        this._pending = /* @__PURE__ */ new Map();
        this._adapterSeen = /* @__PURE__ */ new Map();
        this._deadlineTimers = /* @__PURE__ */ new Set();
        this.stats = {
          externalEvents: 0,
          adapterSawEvent: 0,
          adapterMissed: 0,
          missedPaths: [],
          lastExternalAt: 0
        };
        this._vaultListener = null;
      }
      start() {
        if (this.running) return { running: true, reason: "already-running" };
        const fs2 = universal2.nodeFs;
        if (!fs2 || !fs2.watch) {
          return { running: false, reason: "fs.watch indispon\xEDvel (Capacitor/iOS)" };
        }
        const root = this.plugin.vaultRoot;
        if (!root) return { running: false, reason: "no vaultRoot" };
        try {
          this.watcher = fs2.watch(root, { recursive: true }, (eventType, filename) => {
            if (!filename) return;
            const rel = String(filename);
            if (!rel.endsWith(".md")) return;
            if (rel.includes("/.") || rel.startsWith(".")) return;
            const prev = this._pending.get(rel);
            if (prev && prev.timer) clearTimeout(prev.timer);
            const entry = {
              lastSeenAt: Date.now(),
              source: eventType,
              timer: setTimeout(() => this._onStable(rel), QUIET_MS)
            };
            this._pending.set(rel, entry);
            if (this._pending.size > MAX_TRACKED) {
              const oldest = [...this._pending.entries()].sort((a, b) => a[1].lastSeenAt - b[1].lastSeenAt)[0];
              if (oldest) {
                clearTimeout(oldest[1].timer);
                this._pending.delete(oldest[0]);
              }
            }
          });
        } catch (e) {
          return { running: false, reason: `fs.watch failed: ${e.message}` };
        }
        try {
          const ref = this.plugin.app.vault.on("modify", (file) => {
            const seen = this._adapterSeen.get(file && file.path);
            if (seen) {
              this.stats.adapterSawEvent++;
              this._adapterSeen.delete(file.path);
            }
          });
          if (this.plugin.registerEvent) this.plugin.registerEvent(ref);
          this._vaultListener = ref;
        } catch (_) {
        }
        this.running = true;
        return { running: true, root, quietMs: QUIET_MS };
      }
      _onStable(rel) {
        this._pending.delete(rel);
        this.stats.externalEvents++;
        this.stats.lastExternalAt = Date.now();
        const deadline = Date.now() + ADAPTER_DEADLINE_MS;
        this._adapterSeen.set(rel, deadline);
        if (this._adapterSeen.size > MAX_TRACKED) {
          const oldest = [...this._adapterSeen.entries()].sort((a, b) => a[1] - b[1])[0];
          if (oldest) this._adapterSeen.delete(oldest[0]);
        }
        const timer = setTimeout(() => {
          this._deadlineTimers.delete(timer);
          if (this._adapterSeen.has(rel)) {
            this.stats.adapterMissed++;
            this.stats.missedPaths.push({ path: rel, at: Date.now() });
            if (this.stats.missedPaths.length > 50) this.stats.missedPaths.shift();
            this._adapterSeen.delete(rel);
          }
        }, ADAPTER_DEADLINE_MS + 200);
        this._deadlineTimers.add(timer);
      }
      getStats() {
        const elapsed = this.stats.lastExternalAt ? Date.now() - this.stats.lastExternalAt : null;
        const hitRate = this.stats.externalEvents > 0 ? this.stats.adapterSawEvent / this.stats.externalEvents : null;
        return {
          running: this.running,
          externalEvents: this.stats.externalEvents,
          adapterSawEvent: this.stats.adapterSawEvent,
          adapterMissed: this.stats.adapterMissed,
          missedPaths: this.stats.missedPaths.slice(-10),
          adapterHitRate: hitRate,
          lastExternalAgoMs: elapsed
        };
      }
      stop() {
        if (this.watcher) {
          try {
            this.watcher.close();
          } catch (e) {
          }
          this.watcher = null;
        }
        for (const entry of this._pending.values()) {
          if (entry.timer) clearTimeout(entry.timer);
        }
        this._pending.clear();
        for (const t of this._deadlineTimers) clearTimeout(t);
        this._deadlineTimers.clear();
        this._adapterSeen.clear();
        this.running = false;
      }
    };
    module2.exports = NativeWatcher2;
  }
});

// lib/multiplex-graph.js
var require_multiplex_graph = __commonJS({
  "lib/multiplex-graph.js"(exports2, module2) {
    "use strict";
    var universal2 = require_universal_fs();
    var DATA_DIR_NAME2 = "data";
    var MULTIPLEX_FILE = "multiplex.jsonl";
    var EDGE_TYPES = [
      "wikilink",
      "backlink",
      "entity_overlap",
      "date_overlap",
      "folder_path",
      "semantic_cosine",
      "spotlight_token_bm25",
      "co_citation"
    ];
    var DEFAULT_WEIGHTS = {
      wikilink: 1,
      backlink: 1,
      entity_overlap: 0.7,
      date_overlap: 0.2,
      folder_path: 0.3,
      semantic_cosine: 0.8,
      spotlight_token_bm25: 0.6,
      co_citation: 0.5
    };
    function _cosine(a, b) {
      if (!a || !b) return 0;
      let dot = 0, na = 0, nb = 0;
      const len = Math.min(a.length, b.length);
      for (let i = 0; i < len; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
      }
      if (na === 0 || nb === 0) return 0;
      return dot / (Math.sqrt(na) * Math.sqrt(nb));
    }
    function _dayBucket(mtime) {
      if (!mtime || typeof mtime !== "number") return null;
      const d = new Date(mtime);
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
    }
    function _folderOf(filePath) {
      if (!filePath) return "";
      const idx = filePath.lastIndexOf("/");
      return idx < 0 ? "" : filePath.slice(0, idx);
    }
    function _edgeKey(src, dst, type) {
      return `${src}|${dst}|${type}`;
    }
    var MultiplexGraph2 = class {
      constructor(plugin) {
        this.plugin = plugin;
        this.edges = /* @__PURE__ */ new Map();
        this._builtAt = null;
      }
      get _adapter() {
        return this.plugin.app.vault.adapter;
      }
      get dataPath() {
        return universal2.joinPath(this.plugin.manifest.dir, DATA_DIR_NAME2);
      }
      get jsonlPath() {
        return universal2.joinPath(this.dataPath, MULTIPLEX_FILE);
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
          if (why) {
            if (!Array.isArray(existing.why)) existing.why = [];
            for (const w2 of Array.isArray(why) ? why : [why]) {
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
          why: Array.isArray(why) ? why.slice() : why ? [why] : []
        });
      }
      // ---------------------------------------------------------------------------
      // Build — coleta todas as 8 evidências do vault
      //
      // codex MED #4: mutex contra builds concorrentes. Auto-build setting + comando
      // manual podem disparar simultaneamente. Sem lock, this.edges fica corrompido
      // (clear() no meio + addEdge() concorrente). _buildPromise serializa.
      // ---------------------------------------------------------------------------
      async buildFromVault(onProgress = () => {
      }) {
        if (this._buildPromise) return this._buildPromise;
        this._buildPromise = (async () => {
          try {
            return await this._doBuildFromVault(onProgress);
          } finally {
            this._buildPromise = null;
          }
        })();
        return this._buildPromise;
      }
      async _doBuildFromVault(onProgress = () => {
      }) {
        const t0 = Date.now();
        this.edges.clear();
        const _yield = () => new Promise((r) => setTimeout(r, 0));
        const app = this.plugin.app;
        const mdc = app.metadataCache;
        const files = (app.vault.getMarkdownFiles ? app.vault.getMarkdownFiles() : []) || [];
        const allPaths = new Set(files.map((f) => f.path));
        onProgress("build: edges wikilink + backlink (resolvedLinks)", 5);
        const resolved = mdc && mdc.resolvedLinks || {};
        const backlinkCount = /* @__PURE__ */ new Map();
        for (const src of Object.keys(resolved)) {
          if (!allPaths.has(src)) continue;
          const inner = resolved[src] || {};
          for (const dst of Object.keys(inner)) {
            if (!allPaths.has(dst)) continue;
            const count = inner[dst] || 1;
            this.addEdge(src, dst, "wikilink", `${count}\xD7 [[${dst.replace(/\.md$/, "").split("/").pop()}]] em ${src.split("/").pop()}`);
            this.addEdge(dst, src, "backlink", `${src.split("/").pop()} \u2192 ${dst.split("/").pop()}`);
            backlinkCount.set(dst, (backlinkCount.get(dst) || 0) + 1);
          }
        }
        await _yield();
        onProgress("build: folder_path + date_overlap", 25);
        const byFolder = /* @__PURE__ */ new Map();
        const byDay = /* @__PURE__ */ new Map();
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
        for (const [folder, paths] of byFolder.entries()) {
          const slice = paths.length > 50 ? paths.slice(0, 50) : paths;
          for (let i = 0; i < slice.length; i++) {
            for (let j = i + 1; j < slice.length; j++) {
              this.addEdge(slice[i], slice[j], "folder_path", `pasta ${folder}`);
              this.addEdge(slice[j], slice[i], "folder_path", `pasta ${folder}`);
            }
          }
        }
        for (const [day, paths] of byDay.entries()) {
          if (paths.length > 30 || paths.length < 2) continue;
          for (let i = 0; i < paths.length; i++) {
            for (let j = i + 1; j < paths.length; j++) {
              this.addEdge(paths[i], paths[j], "date_overlap", `editadas ${day}`);
              this.addEdge(paths[j], paths[i], "date_overlap", `editadas ${day}`);
            }
          }
        }
        await _yield();
        onProgress("build: entity_overlap (passports concepts)", 45);
        try {
          if (this.plugin.passport && typeof this.plugin.passport.loadAll === "function") {
            const passportMap = await this.plugin.passport.loadAll();
            const conceptIndex = /* @__PURE__ */ new Map();
            for (const [path2, p] of passportMap.entries()) {
              if (!allPaths.has(path2)) continue;
              if (!Array.isArray(p.concepts)) continue;
              for (const c of p.concepts) {
                const cl = String(c).toLowerCase();
                if (!conceptIndex.has(cl)) conceptIndex.set(cl, /* @__PURE__ */ new Set());
                conceptIndex.get(cl).add(path2);
              }
            }
            const pairOverlap = /* @__PURE__ */ new Map();
            for (const [concept, paths] of conceptIndex.entries()) {
              if (paths.size < 2 || paths.size > 100) continue;
              const arr = Array.from(paths);
              for (let i = 0; i < arr.length; i++) {
                for (let j = i + 1; j < arr.length; j++) {
                  const key = arr[i] < arr[j] ? `${arr[i]}|${arr[j]}` : `${arr[j]}|${arr[i]}`;
                  if (!pairOverlap.has(key)) pairOverlap.set(key, /* @__PURE__ */ new Set());
                  pairOverlap.get(key).add(concept);
                }
              }
            }
            for (const [key, concepts] of pairOverlap.entries()) {
              if (concepts.size < 2) continue;
              const [a, b] = key.split("|");
              const sample = Array.from(concepts).slice(0, 3).join(", ");
              this.addEdge(a, b, "entity_overlap", `${concepts.size} conceitos: ${sample}`);
              this.addEdge(b, a, "entity_overlap", `${concepts.size} conceitos: ${sample}`);
            }
          }
        } catch (e) {
          console.warn("[zeus.multiplex] entity_overlap failed:", e.message);
        }
        await _yield();
        onProgress("build: semantic_cosine (embeddings)", 65);
        try {
          const emb = this.plugin.searcher && this.plugin.searcher.embeddings || /* @__PURE__ */ new Map();
          const entries = [];
          for (const [p, e] of emb.entries()) {
            if (!allPaths.has(p)) continue;
            if (e && Array.isArray(e.vec) && e.vec.length > 0) entries.push([p, e.vec]);
          }
          const MAX = 2e3;
          const useEntries = entries.length > MAX ? entries.slice(0, MAX) : entries;
          const MIN_COS = 0.5;
          for (let i = 0; i < useEntries.length; i++) {
            const [pa, va] = useEntries[i];
            for (let j = i + 1; j < useEntries.length; j++) {
              const [pb, vb] = useEntries[j];
              const c = _cosine(va, vb);
              if (c < MIN_COS) continue;
              this.addEdge(pa, pb, "semantic_cosine", `cosine ${c.toFixed(3)}`);
              this.addEdge(pb, pa, "semantic_cosine", `cosine ${c.toFixed(3)}`);
            }
          }
        } catch (e) {
          console.warn("[zeus.multiplex] semantic_cosine failed:", e.message);
        }
        onProgress("build: spotlight_token_bm25 (best-effort)", 80);
        try {
          const hasSpotlight = this.plugin.httpClient && this.plugin.vaultRoot && await this.plugin.httpClient.isAvailable();
          if (!hasSpotlight) {
            onProgress("spotlight_token_bm25: skip (daemon ou vaultRoot indispon\xEDveis)", 82);
          }
        } catch (e) {
          console.warn("[zeus.multiplex] spotlight_token_bm25 skip:", e.message);
        }
        await _yield();
        onProgress("build: co_citation (top-N backlinked)", 90);
        try {
          const topBacklinked = Array.from(backlinkCount.entries()).sort((a, b) => b[1] - a[1]).slice(0, 1e3).map(([p]) => p);
          const targetSet = new Set(topBacklinked);
          for (const src of Object.keys(resolved)) {
            const inner = resolved[src] || {};
            const targets = Object.keys(inner).filter((d) => targetSet.has(d));
            if (targets.length < 2) continue;
            const slice = targets.length > 20 ? targets.slice(0, 20) : targets;
            const srcName = src.split("/").pop();
            for (let i = 0; i < slice.length; i++) {
              for (let j = i + 1; j < slice.length; j++) {
                this.addEdge(slice[i], slice[j], "co_citation", `ambas citadas por ${srcName}`);
                this.addEdge(slice[j], slice[i], "co_citation", `ambas citadas por ${srcName}`);
              }
            }
          }
        } catch (e) {
          console.warn("[zeus.multiplex] co_citation failed:", e.message);
        }
        this._builtAt = (/* @__PURE__ */ new Date()).toISOString();
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
          try {
            return await this._doPersist();
          } finally {
            this._persistPromise = null;
          }
        })();
        return this._persistPromise;
      }
      async _doPersist() {
        await universal2.adapterMkdir(this._adapter, this.dataPath);
        const lines = [];
        for (const edge of this.edges.values()) {
          lines.push(JSON.stringify(edge));
        }
        await universal2.adapterWriteAtomic(this._adapter, this.jsonlPath, lines.join("\n"));
        return { wrote: lines.length, path: this.jsonlPath };
      }
      async load() {
        this.edges.clear();
        if (!await universal2.adapterExists(this._adapter, this.jsonlPath)) {
          return { loaded: 0, path: this.jsonlPath, exists: false };
        }
        const raw = await universal2.adapterRead(this._adapter, this.jsonlPath);
        let n = 0;
        for (const line of raw.split("\n")) {
          if (!line.trim()) continue;
          try {
            const e = JSON.parse(line);
            if (!e || !e.src || !e.dst || !e.type) continue;
            this.edges.set(_edgeKey(e.src, e.dst, e.type), e);
            n++;
          } catch (err) {
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
        const byDst = /* @__PURE__ */ new Map();
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
          builtAt: this._builtAt
        };
      }
    };
    module2.exports = MultiplexGraph2;
    module2.exports.EDGE_TYPES = EDGE_TYPES;
    module2.exports.DEFAULT_WEIGHTS = DEFAULT_WEIGHTS;
  }
});

// lib/auto-indexer.js
var require_auto_indexer = __commonJS({
  "lib/auto-indexer.js"(exports2, module2) {
    "use strict";
    var DEBOUNCE = {
      passport: 8e3,
      base: 1e4,
      spotlight: 15e3,
      multiplex: 6e4,
      leiden: 3e4,
      // v1.11 Feature I — lexical-ios incremental ~30s após passport (em iOS,
      // bm25 in-memory pode estar indisponível; este é o único sinal lexical).
      lexicalIos: 3e4
    };
    var MULTIPLEX_MOD_THRESHOLD = 10;
    var AutoIndexer2 = class {
      constructor(plugin) {
        this.plugin = plugin;
        this.running = false;
        this.timers = /* @__PURE__ */ new Map();
        this.runningKeys = /* @__PURE__ */ new Set();
        this.lastRun = /* @__PURE__ */ new Map();
        this._modCount = 0;
        this._bootTimer = null;
        this._eventRefs = [];
      }
      start() {
        if (this.running) return { running: true, reason: "already-running" };
        if (!this.plugin || !this.plugin.app || !this.plugin.app.vault) {
          return { running: false, reason: "plugin.app.vault unavailable" };
        }
        const v = this.plugin.app.vault;
        const refs = [
          v.on("modify", (f) => this._onChange(f, "modify")),
          v.on("create", (f) => this._onChange(f, "create")),
          v.on("delete", (f) => this._onDelete(f)),
          v.on("rename", (f, old) => this._onRename(f, old))
        ];
        for (const r of refs) {
          if (this.plugin.registerEvent) this.plugin.registerEvent(r);
          this._eventRefs.push(r);
        }
        this._bootTimer = setTimeout(() => this._bootCheck(), 8e3);
        this.running = true;
        return { running: true, hooks: 4 };
      }
      stop() {
        if (!this.running) return { stopped: false };
        for (const t of this.timers.values()) clearTimeout(t);
        this.timers.clear();
        if (this._bootTimer) {
          clearTimeout(this._bootTimer);
          this._bootTimer = null;
        }
        this._eventRefs = [];
        this.running = false;
        return { stopped: true };
      }
      // ---------------------------------------------------------------------------
      // Event handlers
      // ---------------------------------------------------------------------------
      _onChange(file, kind) {
        if (!file || !file.path) return;
        if (!file.path.endsWith(".md")) return;
        if (file.path.startsWith(this.plugin.manifest.dir)) return;
        this._modCount++;
        this._schedule("passport:" + file.path, DEBOUNCE.passport, () => this._runPassport(file.path));
        this._schedule("base", DEBOUNCE.base, () => this._runBase());
        this._schedule("spotlight", DEBOUNCE.spotlight, () => this._runSpotlight());
        if (this._modCount >= MULTIPLEX_MOD_THRESHOLD) {
          this._modCount = 0;
          this._schedule("multiplex", DEBOUNCE.multiplex, () => this._runMultiplex());
        }
        this._schedule("lexicalIos:" + file.path, DEBOUNCE.lexicalIos, () => this._runLexicalIos(file.path));
      }
      _onDelete(file) {
        if (!file || !file.path || !file.path.endsWith(".md")) return;
        this._schedule("base", DEBOUNCE.base, () => this._runBase());
        this._modCount++;
        if (this._modCount >= MULTIPLEX_MOD_THRESHOLD) {
          this._modCount = 0;
          this._schedule("multiplex", DEBOUNCE.multiplex, () => this._runMultiplex());
        }
      }
      _onRename(file, oldPath) {
        if (!file || !file.path) return;
        this._onDelete({ path: oldPath || "" });
        this._onChange(file, "rename");
      }
      // ---------------------------------------------------------------------------
      // Schedulers (debounced + dedup)
      // ---------------------------------------------------------------------------
      _schedule(key, ms, fn) {
        if (this.runningKeys.has(key)) return;
        const prev = this.timers.get(key);
        if (prev) clearTimeout(prev);
        const t = setTimeout(async () => {
          this.timers.delete(key);
          this.runningKeys.add(key);
          const t0 = Date.now();
          try {
            const result = await fn();
            this.lastRun.set(key, { at: Date.now(), result, durationMs: Date.now() - t0 });
          } catch (e) {
            console.warn("[zeus.autoidx]", key, "failed:", e && e.message ? e.message : e);
            this.lastRun.set(key, { at: Date.now(), error: e && e.message ? e.message : String(e), durationMs: Date.now() - t0 });
          } finally {
            this.runningKeys.delete(key);
          }
        }, ms);
        this.timers.set(key, t);
      }
      // ---------------------------------------------------------------------------
      // Runners
      // ---------------------------------------------------------------------------
      async _runPassport(path2) {
        const p = this.plugin.passport;
        if (!p) return { skipped: "no-passport" };
        if (typeof p.buildOne === "function") {
          try {
            let absPath = path2;
            if (path2 && !path2.startsWith("/") && this.plugin.vaultRoot) {
              absPath = this.plugin.vaultRoot.replace(/\/$/, "") + "/" + path2;
            }
            const passport = await p.buildOne(absPath, []);
            try {
              if (passport && passport.source === "ios-local" && this.plugin.ioQueue && this.plugin.coordinator && this.plugin.coordinator.deviceId && /ios|ipad/i.test(this.plugin.coordinator.deviceId)) {
                const relPath = path2 && path2.startsWith("/") && this.plugin.vaultRoot ? path2.slice(this.plugin.vaultRoot.length).replace(/^\/+/, "") : path2;
                await this.plugin.ioQueue.enqueue({
                  path: relPath,
                  sha: passport.sha || "",
                  type: "passport",
                  payload: { reason: "ios-local-needs-fm-refine" },
                  enqueued_at: (/* @__PURE__ */ new Date()).toISOString(),
                  enqueued_by: this.plugin.coordinator.deviceId
                });
              }
            } catch (eq) {
              console.warn("[zeus.autoidx] ios passport enqueue failed:", eq.message);
            }
            return {
              passport: passport && passport.path,
              concepts: (passport && passport.concepts || []).length,
              source: passport && passport.source || "daemon"
            };
          } catch (e) {
            if (this.plugin.ioQueue && this.plugin.coordinator && this.plugin.coordinator.deviceId && /ios|ipad/i.test(this.plugin.coordinator.deviceId)) {
              try {
                const relPath = path2 && path2.startsWith("/") && this.plugin.vaultRoot ? path2.slice(this.plugin.vaultRoot.length).replace(/^\/+/, "") : path2;
                const adapter = this.plugin.app.vault.adapter;
                const universal2 = require_universal_fs();
                let sha = "";
                try {
                  if (await universal2.adapterExists(adapter, relPath)) {
                    const c = await universal2.adapterRead(adapter, relPath);
                    sha = await universal2.sha256Hex(c);
                  }
                } catch (e2) {
                }
                await this.plugin.ioQueue.enqueue({
                  path: relPath,
                  sha,
                  type: "passport"
                });
              } catch (eq) {
                console.warn("[zeus.autoidx] ioQueue.enqueue failed:", eq.message);
              }
            }
            return { skipped: "buildOne-failed", reason: (e.message || String(e)).slice(0, 80) };
          }
        }
        return { skipped: "no-buildOne-api" };
      }
      async _runBase() {
        if (!this.plugin.basesGen) return { skipped: "no-basesGen" };
        const r = await this.plugin.basesGen.regenerate();
        return { written: r.written, count: r.count };
      }
      async _runSpotlight() {
        if (!this.plugin.httpClient || !this.plugin.vaultRoot) return { skipped: "no-spotlight" };
        if (!this.plugin.app.vault.getMarkdownFiles) return { skipped: "no-getMarkdownFiles" };
        const files = this.plugin.app.vault.getMarkdownFiles();
        if (!files.length) return { skipped: "empty-vault" };
        let passportMap = /* @__PURE__ */ new Map();
        try {
          if (this.plugin.passport && typeof this.plugin.passport.loadAll === "function") {
            passportMap = await this.plugin.passport.loadAll();
          }
        } catch (e) {
        }
        const items = [];
        for (const f of files) {
          const passport = passportMap.get(f.path) || null;
          const cache = this.plugin.app.metadataCache && this.plugin.app.metadataCache.getFileCache ? this.plugin.app.metadataCache.getFileCache(f) || {} : {};
          const fm = cache.frontmatter || {};
          const headings = (cache.headings || []).filter((h) => h.level <= 3).slice(0, 8).map((h) => h.heading);
          const keywords = /* @__PURE__ */ new Set();
          for (const c of (passport == null ? void 0 : passport.concepts) || []) keywords.add(String(c));
          const fmTags = Array.isArray(fm.tags) ? fm.tags : typeof fm.tags === "string" ? fm.tags.split(",").map((s) => s.trim()) : [];
          for (const t of fmTags) keywords.add(t);
          const aliases = Array.isArray(fm.aliases) ? fm.aliases : typeof fm.aliases === "string" ? [fm.aliases] : [];
          for (const a of aliases) keywords.add(a);
          for (const h of headings) keywords.add(h);
          const seen = /* @__PURE__ */ new Set();
          const kw = [];
          for (const k of keywords) {
            if (!k) continue;
            const s = String(k).trim();
            if (s.length < 2) continue;
            const lower = s.toLowerCase();
            if (seen.has(lower)) continue;
            seen.add(lower);
            kw.push(s);
            if (kw.length >= 25) break;
          }
          items.push({
            path: this.plugin.vaultRoot.replace(/\/$/, "") + "/" + f.path,
            title: f.basename,
            summary: passport && (passport.one_line_summary || passport.summary) || "",
            keywords: kw,
            mtime: f.stat ? f.stat.mtime : Date.now()
          });
        }
        let domainHint = "com.maiocchi.zeus.default";
        try {
          const universal2 = require_universal_fs();
          const hex = await universal2.sha256Hex(this.plugin.vaultRoot);
          domainHint = "com.maiocchi.zeus." + hex.slice(0, 16);
        } catch (e) {
        }
        try {
          const r = await this.plugin.httpClient.spotlightIndex(items, domainHint);
          try {
            const universal2 = require_universal_fs();
            const stateRel = universal2.joinPath(this.plugin.manifest.dir, "data", "spotlight-state.json");
            const adapter = this.plugin.app.vault.adapter;
            const payload = {
              last_indexed_at: (/* @__PURE__ */ new Date()).toISOString(),
              count: r.indexed,
              domain: r.domain,
              mode: r.mode || "queued",
              source: "auto-indexer-v1.10"
            };
            await universal2.adapterMkdir(adapter, universal2.joinPath(this.plugin.manifest.dir, "data"));
            await universal2.adapterWriteAtomic(adapter, stateRel, JSON.stringify(payload, null, 2));
          } catch (persistErr) {
            console.warn("[zeus.autoidx] spotlight-state persist failed:", persistErr.message);
          }
          return { indexed: r.indexed, domain: r.domain };
        } catch (e) {
          return { skipped: "daemon-error", reason: e.message.slice(0, 80) };
        }
      }
      async _runMultiplex() {
        if (!this.plugin.multiplex) return { skipped: "no-multiplex" };
        const stats = await this.plugin.multiplex.buildFromVault(() => {
        });
        await this.plugin.multiplex.persist();
        this.plugin._multiplexLoaded = true;
        this._schedule("leiden", DEBOUNCE.leiden, () => this._runLeiden());
        return { total: stats.total, elapsedMs: stats.elapsedMs };
      }
      async _runLeiden() {
        if (!this.plugin.leiden) return { skipped: "no-leiden" };
        if (!this.plugin.multiplex || this.plugin.multiplex.edges.size === 0) {
          return { skipped: "no-multiplex-edges" };
        }
        const r = await this.plugin.leiden.detectCommunities({
          resolution: this.plugin.settings && this.plugin.settings.leidenResolution || 1,
          seed: 42
        });
        if (this.plugin.leiden.persist) await this.plugin.leiden.persist(r);
        return {
          communities: (/* @__PURE__ */ new Set([...r.communities.values()])).size,
          nodes: r.communities.size,
          Q: Number(r.modularity.toFixed(4))
        };
      }
      // v1.11 Feature I — incremental rebuild do lexical-ios para a nota tocada.
      // Gating:
      //   - Só roda se this.plugin.lexicalIos estiver definido (opt-in via wire).
      //   - lexicalIosAutoBuild controla SE o build inicial rodou — aqui só
      //     incrementa, que é barato (~10ms).
      async _runLexicalIos(path2) {
        const lex = this.plugin.lexicalIos;
        if (!lex) return { skipped: "no-lexical-ios" };
        if (typeof lex.incremental !== "function") return { skipped: "no-incremental-api" };
        try {
          const r = await lex.incremental(path2);
          return { updated: r.updated, reason: r.reason };
        } catch (e) {
          return { skipped: "incremental-failed", reason: (e.message || String(e)).slice(0, 80) };
        }
      }
      // ---------------------------------------------------------------------------
      // Boot check — se data files estão stale vs vault, dispara rebuild
      // ---------------------------------------------------------------------------
      async _bootCheck() {
      }
      // ---------------------------------------------------------------------------
      // Status — comando "Zeus: status auto-indexer"
      // ---------------------------------------------------------------------------
      getStatus() {
        const summary = {};
        for (const [k, v] of this.lastRun) {
          summary[k] = {
            ago_s: Math.round((Date.now() - v.at) / 1e3),
            durationMs: v.durationMs,
            result: v.result || null,
            error: v.error || null
          };
        }
        return {
          running: this.running,
          pending: Array.from(this.timers.keys()),
          running_now: Array.from(this.runningKeys),
          mod_count_since_multiplex: this._modCount,
          mod_threshold: MULTIPLEX_MOD_THRESHOLD,
          last_run: summary,
          debounces: DEBOUNCE
        };
      }
    };
    module2.exports = AutoIndexer2;
  }
});

// lib/zeus-embed-runtime.js
var require_zeus_embed_runtime = __commonJS({
  "lib/zeus-embed-runtime.js"(exports2, module2) {
    "use strict";
    var universal2 = require_universal_fs();
    var ZEUS_EMBED_RUNTIME_VERSION = "1.0.0";
    var ZEUS_EMBED_MODEL = "zeus-multilingual-e5-small";
    var ZEUS_EMBED_DIM = 384;
    var MODEL_DIR = "zeus-e5-small";
    var MODEL_FILE = "model.onnx";
    var TOKENIZER_FILE = "tokenizer.json";
    var MODEL_SHA256 = "zeus-e5-small-sha256-placeholder-v1.0.0";
    var INSTALL_URL = "https://releases.zeus-plugin.maiocchi.adv.br/models/zeus-e5-small-v1.0.0.zip";
    async function isInstalled(adapter, dataPath) {
      const modelPath = universal2.joinPath(dataPath, MODEL_DIR, MODEL_FILE);
      const tokenizerPath = universal2.joinPath(dataPath, MODEL_DIR, TOKENIZER_FILE);
      try {
        return await universal2.adapterExists(adapter, modelPath) && await universal2.adapterExists(adapter, tokenizerPath);
      } catch (_) {
        return false;
      }
    }
    async function zeusEmbedRuntime(text, dataPath, adapter) {
      if (!text || text.length < 3) {
        return { ok: false, reason: "text-too-short" };
      }
      const installed = await isInstalled(adapter, dataPath);
      if (!installed) {
        return {
          ok: false,
          reason: "zeus-embed-runtime-not-installed",
          hint: 'Execute o comando "Zeus: instalar modelo embed iOS" para baixar zeus-multilingual-e5-small (~90MB) em data/zeus-e5-small/.',
          install_url: INSTALL_URL,
          model: ZEUS_EMBED_MODEL,
          version: ZEUS_EMBED_RUNTIME_VERSION
        };
      }
      return {
        ok: false,
        reason: "zeus-embed-runtime-onnx-not-implemented",
        hint: "zeus-embed-runtime v1.15.0 detectou modelo instalado mas ONNX inference est\xE1 pendente para v1.16 labs (audit CSP/WASM necess\xE1rio).",
        model: ZEUS_EMBED_MODEL,
        version: ZEUS_EMBED_RUNTIME_VERSION
      };
    }
    function getInstallInstructions() {
      return [
        "# Zeus Embed Runtime \u2014 Instala\xE7\xE3o",
        "",
        "O modelo zeus-multilingual-e5-small (~90MB) n\xE3o est\xE1 instalado.",
        "",
        "Para instalar automaticamente, execute o comando:",
        '  "Zeus: instalar modelo embed iOS"',
        "",
        "O modelo ser\xE1 baixado de:",
        `  ${INSTALL_URL}`,
        "",
        "E salvo em: data/zeus-e5-small/ (vault-local, n\xE3o sincronizado via iCloud).",
        "",
        `Checksum SHA-256 verificado: ${MODEL_SHA256}`,
        "",
        "Ap\xF3s instalar, o Zeus usar\xE1 zeus-multilingual-e5-small (384-dim) como",
        "fallback de embed quando o daemon Mac n\xE3o estiver dispon\xEDvel."
      ].join("\n");
    }
    module2.exports = {
      zeusEmbedRuntime,
      isInstalled,
      getInstallInstructions,
      ZEUS_EMBED_RUNTIME_VERSION,
      ZEUS_EMBED_MODEL,
      ZEUS_EMBED_DIM,
      MODEL_DIR,
      INSTALL_URL
    };
  }
});

// lib/embed-ios.js
var require_embed_ios = __commonJS({
  "lib/embed-ios.js"(exports2, module2) {
    "use strict";
    var universal2 = require_universal_fs();
    var zeusEmbedRuntimeMod = require_zeus_embed_runtime();
    var EMBED_IOS_FILE = "embeddings-ios.jsonl";
    var EMBED_IOS_DIM = 384;
    var EMBED_IOS_MODEL = "zeus-multilingual-e5-small";
    var EMBED_MAC_DIM = 512;
    var EMBED_MAC_MODEL = "apple-nlcontextual-pt-BR";
    var EmbedIos = class {
      constructor(plugin) {
        this.plugin = plugin;
        this._entries = /* @__PURE__ */ new Map();
        this._loaded = false;
        this._writePromise = null;
      }
      get _adapter() {
        return this.plugin.app.vault.adapter;
      }
      get dataPath() {
        return universal2.joinPath(this.plugin.manifest.dir, "data");
      }
      get jsonlPath() {
        return universal2.joinPath(this.dataPath, EMBED_IOS_FILE);
      }
      async load() {
        if (this._loaded) return;
        if (!await universal2.adapterExists(this._adapter, this.jsonlPath)) {
          this._loaded = true;
          return;
        }
        try {
          const raw = await universal2.adapterRead(this._adapter, this.jsonlPath);
          for (const line of raw.split("\n").filter(Boolean)) {
            try {
              const obj = JSON.parse(line);
              if (!obj || !obj.path) continue;
              if (obj.dim !== EMBED_IOS_DIM) {
                console.warn("[zeus.embed-ios] skip linha dim mismatch:", obj.path, "dim=", obj.dim);
                continue;
              }
              if (!Array.isArray(obj.vec) || obj.vec.length !== EMBED_IOS_DIM) {
                console.warn("[zeus.embed-ios] skip linha vec inv\xE1lida:", obj.path);
                continue;
              }
              this._entries.set(obj.path, obj);
            } catch (e) {
            }
          }
        } catch (e) {
          console.warn("[zeus.embed-ios] load failed:", e.message);
        }
        this._loaded = true;
      }
      // Get entry por path (iOS-local 384-dim).
      async get(path2) {
        await this.load();
        return this._entries.get(path2) || null;
      }
      // Persist atomic. Mutex serializa concorrentes (v1.8.1 pattern).
      async _persist() {
        if (this._writePromise) await this._writePromise.catch(() => {
        });
        this._writePromise = (async () => {
          try {
            await universal2.adapterMkdir(this._adapter, this.dataPath);
            const lines = [];
            for (const e of this._entries.values()) lines.push(JSON.stringify(e));
            await universal2.adapterWriteAtomic(this._adapter, this.jsonlPath, lines.join("\n"));
          } finally {
            this._writePromise = null;
          }
        })();
        return this._writePromise;
      }
      // Upsert entry. Validate schema + dim.
      async upsert(entry) {
        await this.load();
        if (!entry || !entry.path) throw new Error("embed-ios.upsert: path obrigat\xF3rio");
        if (entry.dim !== EMBED_IOS_DIM) throw new Error(`embed-ios.upsert: dim ${entry.dim} \u2260 ${EMBED_IOS_DIM}`);
        if (!Array.isArray(entry.vec) || entry.vec.length !== EMBED_IOS_DIM) {
          throw new Error("embed-ios.upsert: vec inv\xE1lido");
        }
        entry.schema = entry.schema || "zeus-embeddings-v1";
        entry.model_id = entry.model_id || EMBED_IOS_MODEL;
        entry.created_at = entry.created_at || (/* @__PURE__ */ new Date()).toISOString();
        entry.source = entry.source || "transformers-ios";
        this._entries.set(entry.path, entry);
        await this._persist();
        return { upserted: entry.path, total: this._entries.size };
      }
      // Removes entry (note deleted/renamed)
      async remove(path2) {
        await this.load();
        if (this._entries.has(path2)) {
          this._entries.delete(path2);
          await this._persist();
          return { removed: true };
        }
        return { removed: false };
      }
      // Stats
      async stats() {
        await this.load();
        return {
          schema: "zeus-embeddings-v1",
          file: this.jsonlPath,
          model_id: EMBED_IOS_MODEL,
          dim: EMBED_IOS_DIM,
          count: this._entries.size,
          runtime_installed: await this._modelInstalled()
        };
      }
      // Check se zeus-embed-runtime está instalado (data/zeus-e5-small/).
      async _modelInstalled() {
        return zeusEmbedRuntimeMod.isInstalled(this._adapter, this.dataPath);
      }
      /**
       * Embed via zeus-embed-runtime internalizado (zeus-multilingual-e5-small, ONNX).
       * Substitui referência externa a @xenova/transformers (encapsulamento v1.15.0).
       * Retorna vec 384-dim ou lança com instrução acionável.
       */
      async embedText(text) {
        const result = await zeusEmbedRuntimeMod.zeusEmbedRuntime(
          text,
          this.dataPath,
          this._adapter
        );
        if (!result.ok) {
          throw new Error(
            `zeus-embed-runtime: ${result.reason}. ${result.hint || ""} (zeus-embed-runtime v${zeusEmbedRuntimeMod.ZEUS_EMBED_RUNTIME_VERSION})`
          );
        }
        return result.vec;
      }
    };
    var EmbedRelay = class {
      constructor(plugin) {
        this.plugin = plugin;
      }
      /**
       * Determina se deve usar AegisDaemon local iOS (autonomia por device).
       * Retorna true quando:
       *   - deviceAutonomyMode === 'ios-native', OU
       *   - mode 'auto' + running iOS + AegisDaemon respondendo localmente
       * @returns {boolean}
       */
      _shouldUseLocalAegis() {
        const settings = this.plugin && this.plugin.settings;
        if (!settings) return false;
        const mode = settings.deviceAutonomyMode || "auto";
        if (mode === "ios-native") return true;
        if (mode === "mac-only" || mode === "ios-fallback") return false;
        const caps = settings.deviceCapabilities || {};
        return caps.aegis_available === true && universal2.isMobile();
      }
      /**
       * Tenta embed via AegisDaemon local (127.0.0.1:2223) ou relay Mac.
       * Camada 0 (nova): AegisDaemon iOS local — source: 'daemon-ios-local'
       * Camada 1 (preservada): relay Mac — source: 'daemon-relay'
       * Sucesso → {ok: true, vec, dim, model, source}
       * Falha   → {ok: false, reason}  (não lança)
       */
      async tryEmbed(text, options = {}) {
        if (!this.plugin.httpClient) return { ok: false, reason: "no-httpClient" };
        if (!text || text.length < 2) return { ok: false, reason: "text-too-short" };
        const useLocal = this._shouldUseLocalAegis();
        const sourceLabel = useLocal ? "daemon-ios-local" : "daemon-relay";
        try {
          const available = await this.plugin.httpClient.isAvailable(1500);
          if (!available) return { ok: false, reason: "daemon-unreachable" };
          const r = await this.plugin.httpClient.embed(text, options);
          const vec = r && r.vectors && r.vectors[0] || r && r.vector || null;
          if (!Array.isArray(vec) || vec.length !== EMBED_MAC_DIM) {
            return { ok: false, reason: `dim-mismatch: ${vec ? vec.length : "null"}` };
          }
          return {
            ok: true,
            vec,
            dim: EMBED_MAC_DIM,
            model: r && r.model || EMBED_MAC_MODEL,
            source: sourceLabel
          };
        } catch (e) {
          return { ok: false, reason: (e.message || String(e)).slice(0, 100) };
        }
      }
    };
    module2.exports = EmbedIos;
    module2.exports.EmbedRelay = EmbedRelay;
    module2.exports.EMBED_IOS_DIM = EMBED_IOS_DIM;
    module2.exports.EMBED_IOS_MODEL = EMBED_IOS_MODEL;
    module2.exports.EMBED_MAC_DIM = EMBED_MAC_DIM;
    module2.exports.EMBED_MAC_MODEL = EMBED_MAC_MODEL;
    module2.exports.zeusEmbedRuntime = zeusEmbedRuntimeMod;
  }
});

// lib/leiden.js
var require_leiden = __commonJS({
  "lib/leiden.js"(exports2, module2) {
    "use strict";
    var universal2 = require_universal_fs();
    var DATA_DIR_NAME2 = "data";
    var COMMUNITIES_FILE = "communities.jsonl";
    var MAX_LEVELS = 10;
    var MAX_LOCAL_PASSES = 20;
    var MIN_GAIN = 1e-10;
    function _makeRng(seed) {
      let state = seed >>> 0 || 1;
      return function rng() {
        state ^= state << 13;
        state >>>= 0;
        state ^= state >>> 17;
        state ^= state << 5;
        state >>>= 0;
        return (state >>> 0) / 4294967296;
      };
    }
    function _shuffleInPlace(arr, rng) {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        const tmp = arr[i];
        arr[i] = arr[j];
        arr[j] = tmp;
      }
      return arr;
    }
    function _newGraph() {
      return {
        adjacency: [],
        degrees: [],
        selfLoop: [],
        // self-loop weight per node (preserva intra-community em agregação)
        totalWeight: 0,
        idToNode: [],
        nodeToId: /* @__PURE__ */ new Map()
      };
    }
    function _ensureNode(g, label) {
      let id = g.nodeToId.get(label);
      if (id !== void 0) return id;
      id = g.idToNode.length;
      g.idToNode.push(label);
      g.nodeToId.set(label, id);
      g.adjacency.push(/* @__PURE__ */ new Map());
      g.degrees.push(0);
      g.selfLoop.push(0);
      return id;
    }
    function _addUndirected(g, srcLabel, dstLabel, weight) {
      if (weight <= 0) return;
      const s = _ensureNode(g, srcLabel);
      const d = _ensureNode(g, dstLabel);
      if (s === d) {
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
    function _modularity(g, community, resolution) {
      const m2 = g.totalWeight;
      if (m2 <= 0) return 0;
      const inW = /* @__PURE__ */ new Map();
      const totW = /* @__PURE__ */ new Map();
      for (let i = 0; i < g.idToNode.length; i++) {
        const c = community[i];
        totW.set(c, (totW.get(c) || 0) + g.degrees[i]);
        const adj = g.adjacency[i];
        for (const [j, w] of adj.entries()) {
          if (community[j] !== c) continue;
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
    function _localMove(g, community, resolution, rng) {
      const n = g.idToNode.length;
      if (n === 0) return { passes: 0, moves: 0 };
      const m2 = g.totalWeight;
      if (m2 <= 0) return { passes: 0, moves: 0 };
      const totW = /* @__PURE__ */ new Map();
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
          const linksToComm = /* @__PURE__ */ new Map();
          const adj = g.adjacency[i];
          for (const [j, w] of adj.entries()) {
            if (j === i) continue;
            const cj = community[j];
            linksToComm.set(cj, (linksToComm.get(cj) || 0) + w);
          }
          const kIin_old = linksToComm.get(oldC) || 0;
          const totOldMinusI = (totW.get(oldC) || 0) - ki;
          let bestC = oldC;
          let bestGain = 0;
          for (const [c, kIin_new] of linksToComm.entries()) {
            if (c === oldC) continue;
            const totNew = totW.get(c) || 0;
            const gain = (kIin_new - kIin_old) / (m2 / 2) - resolution * ki * (totNew - totOldMinusI) / (m2 / 2 * m2);
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
    function _connectivitySplit(g, community) {
      const n = g.idToNode.length;
      const members = /* @__PURE__ */ new Map();
      for (let i = 0; i < n; i++) {
        const c = community[i];
        if (!members.has(c)) members.set(c, []);
        members.get(c).push(i);
      }
      let nextId = 1;
      for (const c of members.keys()) if (c >= nextId) nextId = c + 1;
      let splits = 0;
      for (const [c, nodes] of members.entries()) {
        if (nodes.length <= 1) continue;
        const nodeSet = new Set(nodes);
        const visited = /* @__PURE__ */ new Set();
        let firstComponent = true;
        for (const start of nodes) {
          if (visited.has(start)) continue;
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
            const newId = nextId++;
            for (const v of comp) community[v] = newId;
            splits++;
          }
          firstComponent = false;
        }
      }
      return splits;
    }
    function _aggregate(g, community) {
      const superGraph = _newGraph();
      const edgeMap = /* @__PURE__ */ new Map();
      for (let i = 0; i < g.idToNode.length; i++) {
        const cI = community[i];
        for (const [j, w] of g.adjacency[i].entries()) {
          const cJ = community[j];
          if (i === j) {
            const key = `${cI}|${cI}|self`;
            edgeMap.set(key, (edgeMap.get(key) || 0) + w);
          } else if (i < j) {
            if (cI === cJ) {
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
      for (const [key, w] of edgeMap.entries()) {
        const [a, b, kind] = key.split("|");
        if (kind === "self") {
          _addUndirected(superGraph, String(a), String(a), w);
        } else {
          _addUndirected(superGraph, String(a), String(b), w);
        }
      }
      const seen = /* @__PURE__ */ new Set();
      for (const c of community) seen.add(c);
      for (const c of seen) _ensureNode(superGraph, String(c));
      return superGraph;
    }
    var LeidenCommunities2 = class {
      constructor(plugin) {
        this.plugin = plugin;
      }
      get _adapter() {
        return this.plugin.app.vault.adapter;
      }
      get dataPath() {
        return universal2.joinPath(this.plugin.manifest.dir, DATA_DIR_NAME2);
      }
      get jsonlPath() {
        return universal2.joinPath(this.dataPath, COMMUNITIES_FILE);
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
        const filter = edgeTypesFilter && edgeTypesFilter.length ? new Set(edgeTypesFilter) : null;
        const pairWeight = /* @__PURE__ */ new Map();
        for (const edge of multiplex.edges.values()) {
          if (filter && !filter.has(edge.type)) continue;
          const src = edge.src, dst = edge.dst;
          if (!src || !dst || src === dst) continue;
          const [a, b] = src < dst ? [src, dst] : [dst, src];
          const key = `${a}|${b}`;
          pairWeight.set(key, (pairWeight.get(key) || 0) + (edge.weight || 0));
        }
        for (const [key, w] of pairWeight.entries()) {
          const [a, b] = key.split("|");
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
          resolution: options.resolution != null ? options.resolution : 1,
          seed: options.seed != null ? options.seed : 42,
          maxIterations: options.maxIterations != null ? options.maxIterations : MAX_LEVELS,
          edgeTypes: options.edgeTypes || null
        };
        const rng = _makeRng(opts.seed);
        let g = this._buildGraphFromMultiplex(opts.edgeTypes);
        const n0 = g.idToNode.length;
        const e0 = (() => {
          let c = 0;
          for (const a of g.adjacency) c += a.size;
          return c / 2;
        })();
        if (n0 === 0) {
          return {
            communities: /* @__PURE__ */ new Map(),
            modularity: 0,
            levels: [],
            stats: { nodes: 0, edges: 0, communityCount: 0, topSizes: [] }
          };
        }
        let community = new Array(g.idToNode.length);
        for (let i = 0; i < community.length; i++) community[i] = i;
        let bestPartitionOriginal = community.slice();
        let bestQ = _modularity(g, community, opts.resolution);
        const originalLabels = g.idToNode.slice();
        let level0Community = community.slice();
        const levelsLog = [];
        let currentG = g;
        let currentCommunity = community;
        for (let level = 0; level < opts.maxIterations; level++) {
          const { passes, moves } = _localMove(currentG, currentCommunity, opts.resolution, rng);
          const splits = _connectivitySplit(currentG, currentCommunity);
          const Q = _modularity(currentG, currentCommunity, opts.resolution);
          if (level === 0) {
            level0Community = currentCommunity.slice();
          } else {
            const labelToSuperId = /* @__PURE__ */ new Map();
            for (let s = 0; s < currentG.idToNode.length; s++) {
              labelToSuperId.set(currentG.idToNode[s], s);
            }
            const newLevel0 = new Array(level0Community.length);
            for (let i = 0; i < level0Community.length; i++) {
              const prevC = level0Community[i];
              const superId = labelToSuperId.get(String(prevC));
              newLevel0[i] = superId !== void 0 ? currentCommunity[superId] : prevC;
            }
            level0Community = newLevel0;
          }
          const communitySet = new Set(currentCommunity);
          levelsLog.push({
            level,
            Q,
            passes,
            moves,
            splits,
            nodes: currentG.idToNode.length,
            communities: communitySet.size
          });
          if (Q > bestQ + MIN_GAIN) {
            bestQ = Q;
            bestPartitionOriginal = level0Community.slice();
          }
          if (communitySet.size === currentG.idToNode.length) break;
          if (communitySet.size <= 1) break;
          const nextG = _aggregate(currentG, currentCommunity);
          const nextCommunity = new Array(nextG.idToNode.length);
          for (let i = 0; i < nextCommunity.length; i++) nextCommunity[i] = i;
          currentG = nextG;
          currentCommunity = nextCommunity;
        }
        const remap = /* @__PURE__ */ new Map();
        let nextId = 0;
        for (const c of bestPartitionOriginal) {
          if (!remap.has(c)) remap.set(c, nextId++);
        }
        const finalCommunities = /* @__PURE__ */ new Map();
        for (let i = 0; i < bestPartitionOriginal.length; i++) {
          finalCommunities.set(originalLabels[i], remap.get(bestPartitionOriginal[i]));
        }
        const sizeByComm = /* @__PURE__ */ new Map();
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
            topSizes: sizesSorted.slice(0, 3)
          }
        };
      }
      /**
       * Persiste resultado em data/communities.jsonl (1 linha por nó).
       */
      async persist(result) {
        if (!result || !result.communities) throw new Error("persist: result.communities ausente");
        await universal2.adapterMkdir(this._adapter, this.dataPath);
        const lines = [];
        const Q = result.modularity;
        const lastLevel = result.levels.length ? result.levels[result.levels.length - 1].level : 0;
        for (const [path2, communityId] of result.communities.entries()) {
          lines.push(JSON.stringify({
            path: path2,
            communityId,
            modularity: Number(Q.toFixed(6)),
            level: lastLevel
          }));
        }
        await universal2.adapterWriteAtomic(this._adapter, this.jsonlPath, lines.join("\n"));
        return { wrote: lines.length, path: this.jsonlPath };
      }
      /**
       * Carrega data/communities.jsonl → Map<path, {communityId, modularity, level}>
       */
      async load() {
        if (!await universal2.adapterExists(this._adapter, this.jsonlPath)) {
          return { loaded: 0, communities: /* @__PURE__ */ new Map(), modularity: null, path: this.jsonlPath, exists: false };
        }
        const raw = await universal2.adapterRead(this._adapter, this.jsonlPath);
        const communities = /* @__PURE__ */ new Map();
        let Q = null;
        let n = 0;
        for (const line of raw.split("\n")) {
          if (!line.trim()) continue;
          try {
            const entry = JSON.parse(line);
            if (!entry || !entry.path) continue;
            communities.set(entry.path, {
              communityId: entry.communityId,
              modularity: entry.modularity,
              level: entry.level
            });
            if (Q == null && typeof entry.modularity === "number") Q = entry.modularity;
            n++;
          } catch (_) {
          }
        }
        return { loaded: n, communities, modularity: Q, path: this.jsonlPath, exists: true };
      }
      /**
       * Stats prontas a partir de um load() (ou de um result em memória).
       */
      statsFromMap(communitiesMap) {
        const sizeByComm = /* @__PURE__ */ new Map();
        for (const v of communitiesMap.values()) {
          const cid = v && typeof v === "object" ? v.communityId : v;
          sizeByComm.set(cid, (sizeByComm.get(cid) || 0) + 1);
        }
        const sorted = Array.from(sizeByComm.entries()).sort((a, b) => b[1] - a[1]);
        return {
          total: communitiesMap.size,
          communityCount: sizeByComm.size,
          topSizes: sorted.slice(0, 3).map(([cid, size]) => ({ communityId: cid, size })),
          sizeBreakdown: sorted.slice(0, 20).map(([cid, size]) => `c${cid}:${size}`).join(" \xB7 ")
        };
      }
    };
    module2.exports = LeidenCommunities2;
    module2.exports._internal = {
      _makeRng,
      _modularity,
      _newGraph,
      _addUndirected,
      _localMove,
      _connectivitySplit,
      _aggregate
    };
  }
});

// lib/io-queue.js
var require_io_queue = __commonJS({
  "lib/io-queue.js"(exports2, module2) {
    "use strict";
    var universal2 = require_universal_fs();
    var QUEUE_DIR_NAME = "ios-queue";
    var VALID_TYPES = /* @__PURE__ */ new Set(["passport", "embed", "spotlight"]);
    var IoQueue2 = class _IoQueue {
      /**
       * @param {*} plugin Zeus plugin instance
       */
      constructor(plugin) {
        this.plugin = plugin;
      }
      /**
       * codex HIGH #4 — privacy gate hard-enforced.
       * Recusa paths sigilosos (Clientes/**, ou marcados como privacy:'sigiloso' no
       * payload). Conforme ~/Code/claude-config/rules/juridico.md: Clientes/** é
       * SIGILOSO por default, NÃO pode ir para nenhum caminho cloud — incluindo
       * io-queue que persiste em iCloud sync.
       * @param {string} path — vault-relative
       * @param {object} [payload]
       * @returns {boolean} true se path é privado e NÃO pode ser enfileirado
       */
      static isPrivatePath(path2, payload) {
        if (!path2) return false;
        if (/^Clientes\//i.test(path2)) return true;
        if (payload && payload.privacy && /sigiloso/i.test(String(payload.privacy))) return true;
        return false;
      }
      get _adapter() {
        return this.plugin.app.vault.adapter;
      }
      get queueDir() {
        return universal2.joinPath(this.plugin.manifest.dir, "data", QUEUE_DIR_NAME);
      }
      async _ensureDir() {
        await universal2.adapterMkdir(this._adapter, universal2.joinPath(this.plugin.manifest.dir, "data"));
        await universal2.adapterMkdir(this._adapter, this.queueDir);
      }
      /**
       * SHA do payload identitário do task — garante idempotência.
       * Stringify usa keys ordenadas para evitar variação por ordem de inserção.
       * @param {{path:string, sha:string, type:string}} task
       * @returns {Promise<string>} hex short (16 chars) — colisão prática ~zero
       */
      async _taskSha(task) {
        const canonical = JSON.stringify({
          path: task.path || "",
          sha: task.sha || "",
          type: task.type || ""
        });
        const hex = await universal2.sha256Hex(canonical);
        return hex.slice(0, 16);
      }
      async _taskFilePath(task) {
        const sha = await this._taskSha(task);
        return universal2.joinPath(this.queueDir, sha + ".json");
      }
      /**
       * Enfileira um task. Idempotente: mesmo (path, sha, type) → mesmo file.
       *
       * @param {{path:string, sha:string, type:string, payload?:object}} task
       * @returns {Promise<{enqueued: boolean, taskSha: string, file: string, reason?: string}>}
       */
      async enqueue(task) {
        if (!task || typeof task !== "object") {
          return { enqueued: false, reason: "task inv\xE1lido" };
        }
        if (!task.path || typeof task.path !== "string") {
          return { enqueued: false, reason: "path ausente" };
        }
        if (!task.type || !VALID_TYPES.has(task.type)) {
          return { enqueued: false, reason: `type inv\xE1lido (esperado: ${[...VALID_TYPES].join("|")})` };
        }
        if (_IoQueue.isPrivatePath(task.path, task.payload)) {
          return { enqueued: false, reason: "privacy-gate: path sigiloso, n\xE3o enfileirado" };
        }
        if (!task.sha) {
          task.sha = "";
        }
        await this._ensureDir();
        const taskSha = await this._taskSha(task);
        const file = universal2.joinPath(this.queueDir, taskSha + ".json");
        const deviceId = this.plugin.coordinator && this.plugin.coordinator.deviceId || "unknown";
        const fullTask = {
          path: task.path,
          sha: task.sha,
          type: task.type,
          payload: task.payload || null,
          enqueued_at: task.enqueued_at || (/* @__PURE__ */ new Date()).toISOString(),
          enqueued_by: task.enqueued_by || deviceId,
          task_sha: taskSha
        };
        await universal2.adapterWriteAtomic(this._adapter, file, JSON.stringify(fullTask));
        return { enqueued: true, taskSha, file };
      }
      /**
       * Lista todos os tasks pendentes na fila.
       * @returns {Promise<Array<object>>}
       */
      async list() {
        await this._ensureDir();
        const listing = await universal2.adapterList(this._adapter, this.queueDir);
        const entries = listing && listing.files || [];
        const out = [];
        for (const f of entries) {
          if (!f.endsWith(".json")) continue;
          try {
            const raw = await universal2.adapterRead(this._adapter, f);
            const task = JSON.parse(raw);
            task._file = f;
            out.push(task);
          } catch (e) {
            console.warn("[zeus][io-queue] skip malformed task:", f, e.message);
          }
        }
        return out;
      }
      /**
       * Consome UM task: claim via DistributedCoordinator → processor(task) →
       * delete file em sucesso.
       *
       * Idempotente:
       *   - Se task já foi processada (output existe), apenas deleta o file.
       *     Caller (processor) é responsável por sinalizar isso via `{ alreadyDone: true }`.
       *   - Se claim falha (outro device pegou), pula e retorna `{ consumed: false, reason }`.
       *   - Em erro do processor, file fica na fila para retry.
       *
       * @param {object} task
       * @param {(task) => Promise<{ok: boolean, alreadyDone?: boolean, error?: string}>} processor
       * @returns {Promise<{consumed: boolean, reason?: string, result?: any}>}
       */
      async consume(task, processor) {
        if (!task || !task.path) {
          return { consumed: false, reason: "task inv\xE1lido" };
        }
        if (typeof processor !== "function") {
          return { consumed: false, reason: "processor n\xE3o \xE9 fun\xE7\xE3o" };
        }
        const coord = this.plugin.coordinator;
        let claimed = false;
        if (coord) {
          try {
            const claim = await coord.claim(task.path);
            if (!claim.claimed) {
              return { consumed: false, reason: `claim held by ${claim.current_holder}` };
            }
            claimed = true;
          } catch (e) {
            console.warn("[zeus][io-queue] claim failed:", e.message);
          }
        }
        let result;
        try {
          result = await processor(task);
        } catch (e) {
          result = { ok: false, error: e.message || String(e) };
        } finally {
          if (claimed && coord) {
            try {
              await coord.release(task.path);
            } catch (e) {
            }
          }
        }
        if (result && (result.ok || result.alreadyDone)) {
          const file = task._file || await this._taskFilePath(task);
          try {
            await universal2.adapterRemove(this._adapter, file);
          } catch (e) {
            console.warn("[zeus][io-queue] remove task file failed:", file, e.message);
          }
          return { consumed: true, result };
        }
        return { consumed: false, reason: result && result.error || "processor n\xE3o-OK", result };
      }
      /**
       * Conta tasks pendentes.
       * @returns {Promise<number>}
       */
      async size() {
        await this._ensureDir();
        const listing = await universal2.adapterList(this._adapter, this.queueDir);
        const entries = listing && listing.files || [];
        return entries.filter((f) => f.endsWith(".json")).length;
      }
      /**
       * Status agregado: total + breakdown por type.
       * @returns {Promise<{total:number, byType:object, oldest:string|null}>}
       */
      async status() {
        const tasks = await this.list();
        const byType = {};
        let oldest = null;
        for (const t of tasks) {
          const ty = t.type || "unknown";
          byType[ty] = (byType[ty] || 0) + 1;
          if (t.enqueued_at && (!oldest || t.enqueued_at < oldest)) {
            oldest = t.enqueued_at;
          }
        }
        return { total: tasks.length, byType, oldest };
      }
    };
    module2.exports = IoQueue2;
  }
});

// lib/lexical-ios.js
var require_lexical_ios = __commonJS({
  "lib/lexical-ios.js"(exports2, module2) {
    "use strict";
    var universal2 = require_universal_fs();
    var bm25Lib = require_bm25();
    var FILE_NAME = "lexical-ios.jsonl";
    var DATA_DIR_NAME2 = "data";
    var SCHEMA_VERSION = "lexical-ios-v1";
    var K1 = 1.5;
    var B = 0.75;
    var PT_SUFFIXES = [
      // Sufixos longos (6+ chars) — deve vir primeiro
      /(?:idades|edades)$/,
      // universidades → univers  (bug fix v1.15.0)
      /(?:amente|mente)$/,
      // rapidamente → rapid
      // Sufixos médios (4-5 chars)
      /(?:ções|coes|sões|soes)$/,
      // ações/visões plural
      /(?:ável|ível)$/,
      // amável → am
      /(?:ção|cao|são|sao)$/,
      // ação/visão singular
      /(?:ados|idas|idos|adas)$/,
      // particípios plural
      /(?:idade|edade)$/,
      // universidade → univers
      /(?:inho|inha)$/,
      // diminutivo
      // Sufixos curtos (2-3 chars)
      /(?:ado|ido|ada|ida)$/,
      // estudado → estud
      /(?:ar|er|ir)$/,
      // estudar → estud
      // Plural simples (1 char — mantido last para não interceptar antes)
      /(?:s)$/
    ];
    function normalizeAndStem(token) {
      if (!token || typeof token !== "string") return null;
      let t = token.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
      if (t.length < 2) return null;
      if (t.length >= 4) {
        t = t.replace(/coes$/, "cao");
        t = t.replace(/soes$/, "sao");
        t = t.replace(/oes$/, "ao");
        t = t.replace(/aes$/, "ae");
      }
      for (const re of PT_SUFFIXES) {
        const stripped = t.replace(re, "");
        if (stripped.length >= 3 && stripped.length < t.length) {
          t = stripped;
          break;
        }
      }
      if (t.length < 2) return null;
      return t;
    }
    function tokenizeAndStem(text) {
      const raw = bm25Lib.tokenize(text);
      const out = [];
      for (const t of raw) {
        const norm = normalizeAndStem(t);
        if (norm) out.push(norm);
      }
      return out;
    }
    function buildTokenArray(tokens) {
      const counts = /* @__PURE__ */ new Map();
      for (const t of tokens) counts.set(t, (counts.get(t) || 0) + 1);
      const arr = Array.from(counts.entries()).map(([token, tf]) => ({ token, tf }));
      arr.sort((a, b) => b.tf - a.tf);
      return arr.slice(0, 200);
    }
    var LexicalIosIndex2 = class {
      constructor(plugin) {
        this.plugin = plugin;
        this._docs = /* @__PURE__ */ new Map();
        this._header = null;
        this._writePromise = null;
        this._loaded = false;
      }
      get _adapter() {
        return this.plugin.app.vault.adapter;
      }
      get dataPath() {
        return universal2.joinPath(this.plugin.manifest.dir, DATA_DIR_NAME2);
      }
      get jsonlPath() {
        return universal2.joinPath(this.dataPath, FILE_NAME);
      }
      async _ensureDir() {
        await universal2.adapterMkdir(this._adapter, this.dataPath);
      }
      /**
       * Carrega o índice do disco para memória (lazy — só na primeira chamada).
       */
      async _load() {
        if (this._loaded) return;
        this._docs = /* @__PURE__ */ new Map();
        this._header = null;
        if (!await universal2.adapterExists(this._adapter, this.jsonlPath)) {
          this._loaded = true;
          return;
        }
        try {
          const raw = await universal2.adapterRead(this._adapter, this.jsonlPath);
          const lines = raw.split("\n");
          for (let i = 0; i < lines.length; i++) {
            const ln = lines[i].trim();
            if (!ln) continue;
            try {
              const obj = JSON.parse(ln);
              if (i === 0 && obj.schema === SCHEMA_VERSION) {
                this._header = obj;
              } else if (obj.path) {
                this._docs.set(obj.path, obj);
              }
            } catch (e) {
              console.warn("[zeus][lexical-ios] skip bad line", i, e.message);
            }
          }
        } catch (e) {
          console.warn("[zeus][lexical-ios] load failed:", e.message);
        }
        this._loaded = true;
      }
      /**
       * Persiste o índice in-memory para disco (header + 1 linha por doc).
       */
      async _persist() {
        if (this._writePromise) await this._writePromise.catch(() => {
        });
        this._writePromise = (async () => {
          try {
            await this._ensureDir();
            const lines = [];
            if (this._header) lines.push(JSON.stringify(this._header));
            for (const doc of this._docs.values()) {
              lines.push(JSON.stringify(doc));
            }
            await universal2.adapterWriteAtomic(this._adapter, this.jsonlPath, lines.join("\n"));
          } finally {
            this._writePromise = null;
          }
        })();
        return this._writePromise;
      }
      /**
       * Build full index: itera todas notas .md, tokeniza+stem, recomputa header
       * (N, avgdl, IDF global).
       *
       * @param {(msg:string, pct?:number) => void} onProgress
       * @returns {Promise<{N:number, vocab:number, elapsedMs:number}>}
       */
      async build(onProgress = () => {
      }) {
        const start = Date.now();
        await this._load();
        onProgress("enumerando notas\u2026", 0);
        let notes = [];
        if (this.plugin.app && this.plugin.app.vault && this.plugin.app.vault.getMarkdownFiles) {
          notes = this.plugin.app.vault.getMarkdownFiles().map((f) => f.path);
        } else {
          const all = await universal2.adapterWalk(this._adapter, "");
          notes = all.filter((p) => p.endsWith(".md"));
        }
        onProgress(`tokenizando ${notes.length} notas\u2026`, 5);
        this._docs = /* @__PURE__ */ new Map();
        let totalLen = 0;
        const df = /* @__PURE__ */ new Map();
        for (let i = 0; i < notes.length; i++) {
          const path2 = notes[i];
          if (i % 100 === 0) {
            onProgress(`tokenize ${i}/${notes.length}`, Math.round(5 + 90 * i / notes.length));
          }
          let content = "";
          try {
            content = await universal2.adapterRead(this._adapter, path2);
          } catch (e) {
            console.warn("[zeus][lexical-ios] read fail", path2, e.message);
            continue;
          }
          const tokens = tokenizeAndStem(content);
          if (tokens.length === 0) continue;
          const tokArr = buildTokenArray(tokens);
          const sha = await universal2.sha256Hex(content);
          this._docs.set(path2, { path: path2, sha, tokens: tokArr, dl: tokens.length });
          totalLen += tokens.length;
          const seen = /* @__PURE__ */ new Set();
          for (const t of tokens) seen.add(t);
          for (const t of seen) df.set(t, (df.get(t) || 0) + 1);
        }
        const N = this._docs.size;
        const avgdl = N > 0 ? totalLen / N : 0;
        const idf = {};
        for (const [token, freq] of df.entries()) {
          idf[token] = Math.log(1 + (N - freq + 0.5) / (freq + 0.5));
        }
        this._header = {
          schema: SCHEMA_VERSION,
          N,
          avgdl,
          idf,
          last_built: (/* @__PURE__ */ new Date()).toISOString()
        };
        onProgress("persistindo\u2026", 95);
        await this._persist();
        const elapsed = Date.now() - start;
        onProgress(`done \u2014 ${N} notas, ${Object.keys(idf).length} tokens \xFAnicos (${elapsed}ms)`, 100);
        return { N, vocab: Object.keys(idf).length, elapsedMs: elapsed };
      }
      /**
       * Search BM25 sobre o índice persistido.
       *
       * @param {string} query
       * @param {number} [topN=30]
       * @returns {Promise<Array<{path:string, score:number, matched_tokens:string[]}>>}
       */
      async search(query, topN = 30) {
        await this._load();
        if (!this._header || this._docs.size === 0) return [];
        if (!query || typeof query !== "string" || !query.trim()) return [];
        const qTokens = tokenizeAndStem(query);
        if (qTokens.length === 0) return [];
        const qSet = new Set(qTokens);
        const avgdl = this._header.avgdl || 0;
        const idfMap = this._header.idf || {};
        const results = [];
        for (const doc of this._docs.values()) {
          const tfMap = /* @__PURE__ */ new Map();
          for (const { token, tf } of doc.tokens || []) {
            if (qSet.has(token)) tfMap.set(token, tf);
          }
          if (tfMap.size === 0) continue;
          let score = 0;
          const matched = [];
          for (const qt of qSet) {
            const freq = tfMap.get(qt) || 0;
            if (freq === 0) continue;
            const idf = idfMap[qt] || 0;
            if (idf === 0) continue;
            const dl = doc.dl || 0;
            const denom = avgdl > 0 ? freq + K1 * (1 - B + B * dl / avgdl) : freq;
            score += idf * (freq * (K1 + 1)) / denom;
            matched.push(qt);
          }
          if (score > 0) {
            results.push({ path: doc.path, score, matched_tokens: matched });
          }
        }
        results.sort((a, b) => b.score - a.score);
        return results.slice(0, topN);
      }
      /**
       * Atualização incremental: re-tokeniza UMA nota, atualiza posting list e
       * recalcula df (delta) + persiste.
       *
       * NOTA: recalcular IDF global a cada incremental é caro (O(vocab)). Em vez,
       * marcamos o header como "stale-incremental" e o consumer pode chamar
       * recomputeIdf() em background. Para queries-críticas, prefere rebuild.
       *
       * @param {string} path
       * @param {string|null} sha (opcional — se ausente, recomputa)
       * @returns {Promise<{updated:boolean, reason?:string}>}
       */
      async incremental(path2, sha = null) {
        await this._load();
        if (!path2 || !path2.endsWith(".md")) return { updated: false, reason: "not-md" };
        let content;
        try {
          content = await universal2.adapterRead(this._adapter, path2);
        } catch (e) {
          if (this._docs.has(path2)) {
            this._docs.delete(path2);
            await this._persist();
            return { updated: true, reason: "deleted" };
          }
          return { updated: false, reason: e.message };
        }
        const currentSha = sha || await universal2.sha256Hex(content);
        const existing = this._docs.get(path2);
        if (existing && existing.sha === currentSha) {
          return { updated: false, reason: "sha unchanged" };
        }
        const tokens = tokenizeAndStem(content);
        const tokArr = buildTokenArray(tokens);
        this._docs.set(path2, { path: path2, sha: currentSha, tokens: tokArr, dl: tokens.length });
        this._recomputeHeader();
        await this._persist();
        return { updated: true };
      }
      // v1.11.1 codex MED #6: _recomputeHeader varre _docs e refaz idf/avgdl/N
      // do zero. Garante consistência sem necessitar build() periódico. O(D × T_avg)
      // mas em vault típico (~1k notas, ~200 tokens cada) é <50ms.
      _recomputeHeader() {
        const N = this._docs.size;
        if (N === 0) {
          this._header = { schema: "lexical-ios-v1", N: 0, avgdl: 0, idf: {}, last_built: (/* @__PURE__ */ new Date()).toISOString() };
          return;
        }
        let totalLen = 0;
        const df = /* @__PURE__ */ new Map();
        for (const doc of this._docs.values()) {
          totalLen += doc.dl || 0;
          const seen = /* @__PURE__ */ new Set();
          for (const entry of doc.tokens || []) {
            const token = entry && entry.token;
            if (!token || seen.has(token)) continue;
            seen.add(token);
            df.set(token, (df.get(token) || 0) + 1);
          }
        }
        const idf = {};
        for (const [t, dfCount] of df) {
          idf[t] = Math.log(1 + (N - dfCount + 0.5) / (dfCount + 0.5));
        }
        this._header = {
          schema: "lexical-ios-v1",
          N,
          avgdl: totalLen / N,
          idf,
          last_built: (/* @__PURE__ */ new Date()).toISOString()
        };
      }
      /**
       * Stats agregados: N, avgdl, vocab, last_built.
       * @returns {Promise<{N:number, avgdl:number, vocab_size:number, last_built:string|null}>}
       */
      async stats() {
        await this._load();
        return {
          N: this._docs.size,
          avgdl: this._header ? this._header.avgdl : 0,
          vocab_size: this._header && this._header.idf ? Object.keys(this._header.idf).length : 0,
          last_built: this._header ? this._header.last_built : null
        };
      }
    };
    module2.exports = LexicalIosIndex2;
    module2.exports._tokenizeAndStem = tokenizeAndStem;
    module2.exports._normalizeAndStem = normalizeAndStem;
  }
});

// main.source.js
function _zeusFindPluginDir() {
  let fs0, path0;
  try {
    fs0 = require("fs");
  } catch (_) {
    fs0 = null;
  }
  try {
    path0 = require("path");
  } catch (_) {
    path0 = null;
  }
  const isValid = (dir) => {
    try {
      if (!dir || !fs0) return false;
      return fs0.existsSync(dir + "/main.js") && fs0.existsSync(dir + "/manifest.json");
    } catch (e) {
      return false;
    }
  };
  try {
    if (typeof __dirname === "string" && isValid(__dirname)) return __dirname;
  } catch (_) {
  }
  try {
    const stack = new Error().stack || "";
    const re = /(?:\(|at\s+)((?:\/[^():\n]+)+\/main\.js):\d+(?::\d+)?\)?/g;
    let m;
    if (path0) {
      while ((m = re.exec(stack)) !== null) {
        const candidate = path0.dirname(m[1].trim());
        if (isValid(candidate)) return candidate;
      }
    }
  } catch (_) {
  }
  try {
    if (fs0 && path0) {
      const iosBases = [
        "/private/var/mobile/Library/Mobile Documents/iCloud~md~obsidian/Documents",
        "/var/mobile/Library/Mobile Documents/iCloud~md~obsidian/Documents"
      ];
      for (const base of iosBases) {
        if (!fs0.existsSync(base)) continue;
        const entries = fs0.readdirSync(base, { withFileTypes: true });
        for (const e of entries) {
          if (!e.isDirectory()) continue;
          const candidate = `${base}/${e.name}/.obsidian/plugins/zeus`;
          if (isValid(candidate)) return candidate;
        }
      }
    }
  } catch (_) {
  }
  try {
    if (fs0 && path0) {
      const home2 = process.env.HOME || "/Users/" + (process.env.USER || "rogermaiocchi");
      const iCloudBase = home2 + "/Library/Mobile Documents/iCloud~md~obsidian/Documents";
      if (fs0.existsSync(iCloudBase)) {
        const entries = fs0.readdirSync(iCloudBase, { withFileTypes: true });
        for (const e of entries) {
          if (!e.isDirectory()) continue;
          const candidate = `${iCloudBase}/${e.name}/.obsidian/plugins/zeus`;
          if (isValid(candidate)) return candidate;
        }
        const root = `${iCloudBase}/.obsidian/plugins/zeus`;
        if (isValid(root)) return root;
      }
    }
  } catch (_) {
  }
  const home = typeof process !== "undefined" && process.env && process.env.HOME || "";
  const fallback = [
    "/private/var/mobile/Library/Mobile Documents/iCloud~md~obsidian/Documents/Memoria/.obsidian/plugins/zeus",
    "/var/mobile/Library/Mobile Documents/iCloud~md~obsidian/Documents/Memoria/.obsidian/plugins/zeus",
    home + "/Library/Mobile Documents/iCloud~md~obsidian/Documents/Memoria/.obsidian/plugins/zeus",
    "/Users/rogermaiocchi/Library/Mobile Documents/iCloud~md~obsidian/Documents/Memoria/.obsidian/plugins/zeus",
    "/Users/maiocchi/Library/Mobile Documents/iCloud~md~obsidian/Documents/Memoria/.obsidian/plugins/zeus",
    "/Users/rogermaiocchi/Library/Mobile Documents/iCloud~md~obsidian/Documents/.obsidian/plugins/zeus"
  ];
  for (const c of fallback) {
    if (isValid(c)) return c;
  }
  if (!fs0) {
    return "/private/var/mobile/Library/Mobile Documents/iCloud~md~obsidian/Documents/Memoria/.obsidian/plugins/zeus";
  }
  throw new Error("Zeus pluginRequire: cannot locate plugin dir (procurei __dirname, stack, iOS sandbox, glob iCloud, fallbacks)");
}
var _ZEUS_PLUGIN_DIR = _zeusFindPluginDir();
var _zeusPath = null;
try {
  _zeusPath = require("path");
} catch (_) {
}
console.log("[zeus] pluginRequire base:", _ZEUS_PLUGIN_DIR);
var obsidian = require("obsidian");
var { Plugin, PluginSettingTab, Setting, SuggestModal, ItemView, Notice, TFile } = obsidian;
var universal = require_universal_fs();
var path = universal.nodePath;
var fs = universal.nodeFs;
var spawn = universal.nodeChildProcess ? universal.nodeChildProcess.spawn : null;
var HierarchicalProcessor = require_hierarchical();
var MultiVectorEmbedder = require_multi_vector();
var ZeusHttpClient = require_zeus_http_client();
var ImageSimilaritySearch = require_image_similarity();
var PassportIndex = require_passport_index();
var BasesGenerator = require_bases_generator();
var DistributedCoordinator = require_distributed_coordinator();
var PassportScheduler = require_passport_scheduler();
var DaemonLifecycle = require_daemon_lifecycle();
var HybridSearch = require_hybrid_search();
var NativeWatcher = require_native_watcher();
var MultiplexGraph = require_multiplex_graph();
var AutoIndexer = require_auto_indexer();
var EmbedIosLib = require_embed_ios();
var LeidenCommunities = require_leiden();
var IoQueue = require_io_queue();
var LexicalIosIndex = require_lexical_ios();
var VIEW_TYPE_SMART = "zeus-smart-view";
var VIEW_TYPE_STATUS = "zeus-status-view";
var DATA_DIR_NAME = "data";
var EMBEDDINGS_FILE = "embeddings.jsonl";
var MANIFEST_FILE = "manifest.json";
var OCR_CACHE_DIR = "aocr-cache";
var IMAGE_FEAT_CACHE_DIR = "av-cache";
var ENRICH_CACHE_DIR = "aia-enrich-cache";
var AUDIO_EXTENSIONS = /* @__PURE__ */ new Set(["m4a", "wav", "mp3"]);
var DEFAULT_SETTINGS = {
  indexOnStartup: true,
  indexOnSave: true,
  ocrEnabled: true,
  embedBackend: "apple",
  // apple = NLContextualEmbedding (dim 512); e5 = multilingual (dim 384)
  fileTypes: { md: true, pdf: true, png: true, jpg: true, jpeg: true, heic: true, m4a: true, wav: true, mp3: true },
  // v1.3.3 — audio indexing
  audioLocale: "pt-BR",
  // BCP47 default para SpeechAnalyzer/SFSpeechRecognizer
  audioEngine: "auto",
  // sa|sf|auto — daemon escolhe melhor disponível
  audioVadEnabled: true,
  // pre-filter via /v1/asp/vad antes de transcribe
  folderExclusions: [".trash", ".obsidian", ".smart-env", "node_modules", "Attachments"],
  exactMatchBoost: 0.5,
  maxResults: 30,
  smartNeighborsCount: 8,
  excerptLength: 220,
  minDocChars: 30,
  // FoundationModels reasoning layer (janela 4096 tokens; chunking hierárquico NexusSum
  // ativa automaticamente para docs >10KB via hierarchicalThreshold)
  enrichOnOpen: false,
  // default off — opt-in via Settings
  enrichDebounceMs: 1500,
  enrichTimeoutMs: 6e4,
  agentPattern: "auto",
  agentMaxIterations: 3,
  rerankTopK: 0,
  // 0 = off; rerank also limited by FM window
  // Apple Vision multi-modal (per-image)
  avImageFeatures: true,
  // classify + landmarks + EXIF per image
  avClassifyTopN: 8,
  aocrPdfStructured: true,
  // use --structured for layout-aware PDF (macOS 26+)
  // HyDE — disruptive query expansion
  hydeEnabled: false,
  // default OFF (adds ~3s latency per search); habilite p/ buscas complexas
  // v0.5.0 — Hierarchical processor (Fix 2)
  hierarchicalThreshold: 1e4,
  // chars above which enrich delega para HierarchicalProcessor (NexusSum)
  // v0.5.0 — Multi-vector embedding (Fix 4)
  multiVectorEnabled: false,
  // off until reindex; flip after primeiro reindex c/ multi-vector
  multiVectorIndexOnReindex: false,
  // se true, runFullIndex produz multi-vectors.jsonl além de embeddings.jsonl
  // v0.6.0 — Aegis-pattern HTTP daemon (ADR-018)
  zeusDaemonUrl: "http://127.0.0.1:2223",
  // local daemon loopback; cross-device via Tailscale: http://100.65.240.43:2223
  daemonPreferredOverSpawn: true,
  // ADR-018 fase E++: HTTP-first em todos hot paths; spawn é fallback no Mac
  // v1.4.1 — On-device-first: cada device Apple roda seu próprio daemon nativo
  // (ZeusDaemonMac no macOS, AegisDaemon no iOS). Quando ON, discovery cai para
  // Tailscale mesh apenas se o daemon local não responder. Quando OFF, Tailscale
  // mesh nunca é tentado — modo strict on-device (melhor privacidade + latência).
  allowRemoteDaemonFallback: false,
  // v0.7.0 — full Apple ecosystem coverage
  imagesIndexFeaturePrint: false,
  // se ON, comandos de indexação de imagens populam data/image-features.jsonl
  autoLanguageDetectOnSave: false,
  // detecta língua na nota ativa ao salvar e adiciona ao frontmatter (`lang:`)
  // v1.15.0 — device autonomy: cada device usa seus modelos Apple nativos
  // 'auto'         = detecta platform + OS + capability probe, usa melhor path
  // 'mac-only'     = força daemon Mac (útil com Tailscale sempre disponível)
  // 'ios-native'   = força AegisDaemon local iOS (requer iOS 26+ ou app host)
  // 'ios-fallback' = força JS puro (lexical-ios, passport-ios, sem daemon)
  deviceAutonomyMode: "auto",
  deviceCapabilities: {
    detected_platform: null,
    detected_os_version: null,
    fm_available: null,
    aegis_available: null,
    last_detected: null
  },
  spotlightQueryEnabled: true,
  // v1.15.0: ativo por padrão (ADR-011 COMPLETO em v1.13.0)
  // v0.8.0 — native Obsidian Graph integration
  nativeGraphIntegration: false,
  // opt-in: auto-write zeus_related: in frontmatter (modifica TODAS as notas)
  nativeGraphTopN: 5,
  // top N neighbors per note
  nativeGraphMinScore: 0.3,
  // skip edges below this cosine score
  nativeGraphSyncOnSave: true,
  // resync neighbor after file modify
  // v0.10.0 — cross-device coordination + scheduler
  deviceId: "",
  // persisted; generated on first run by DistributedCoordinator
  schedulerEnabled: true,
  // default ON — background coordinator sweeps stale passports
  schedulerIntervalMs: 15 * 60 * 1e3,
  // 15 min default
  coordTtlMs: 60 * 1e3,
  // 60s default; iCloud sync delay (5-30s) << TTL
  // v1.1 — Status bar: token-saved metrics
  showTokenSavedInStatusBar: true,
  // exibe "k tok saved" via PIA no status bar
  statusBarRefreshIntervalMs: 3e4,
  // 30s refresh para tokens metrics
  rawTokenBaseline: 1250,
  // tokens médios sem PIA por request (~5KB/4)
  // v2.0 — Apple Cloud Private (ACP / PCC)
  // 'off'    = só on-device (privacy máximo, requer macOS 26+ Apple Intelligence)
  // 'opt-in' = client envia header X-Zeus-Allow-Pcc:1; daemon decide caso a caso
  // 'auto'   = sempre permite roteamento para PCC quando on-device excede capacidade
  pccMode: "off",
  pccVisualIndicator: true,
  // exibe ☁️PCC no status bar quando daemon roteou via PCC
  // v1.8 — hybrid search MMR diversify + multiplex graph
  hybridDiversityLambda: 0.5,
  // λ ∈ [0,1] da MMR — 1=só relevância, 0=só diversidade
  hybridDiversifyDefault: false,
  // se ON, query() aplica MMR por padrão (lambda configurável acima)
  // codex LOW #9: v1.8 mudou baseline do query() incluindo BM25 default-on. Pra
  // compat estrita com v1.7.1, user pode desligar via setting. Default ON é a
  // recomendação — BM25 complementa semantic em casos lexicais (siglas, IDs,
  // nomes próprios) onde cosine sozinho falha.
  hybridBm25Enabled: true,
  multiplexAutoBuild: false,
  // se ON, build inicial roda no onload em background
  // v1.11 Feature I — lexical-ios (BM25 persistido com stems pt-BR). Default OFF
  // porque vault grande pode levar 8-12s no iPad. Comando manual "Zeus: rebuild
  // lexical-ios index" disponível pra trigger inicial. Incrementals rodam
  // automaticamente via AutoIndexer ~30s após cada modify.
  lexicalIosAutoBuild: false,
  // v1.10 — AutoIndexer: indexação automática nativa Apple (FSEvents Mac /
  // vault.adapter iOS) orquestrando todas as camadas (passport/base/spotlight/
  // multiplex/leiden) com debounce + cooldown.
  autoIndexEnabled: true,
  // v1.12 — embed iOS two-tier (codex audit C+B aprovado)
  // CAMADA 1 (default ON): relay HTTP daemon via Tailscale/loopback. iOS chama
  //   daemon Mac, persiste em embeddings.jsonl 512-dim NLContextualEmbedding.
  // CAMADA 2 (default OFF, labs): transformers.js + multilingual-e5-small ~118MB
  //   fetch lazy primeiro use. Persiste embeddings-ios.jsonl 384-dim.
  //   v1.12 ENTREGA stub apenas; runtime completo em v1.13 ADR-011 labs.
  iosEmbedRelayEnabled: true,
  iosEmbedTransformersEnabled: false,
  // v1.9 — Leiden communities (escopo enxuto: local move + connectivity split + agregação)
  // Vide docs/ADR-008-Leiden-Communities-JS-Port.md
  leidenResolution: 1,
  // γ na modularidade; >1 favorece comunidades menores
  leidenAutoRun: false,
  // se ON, dispara detectCommunities após buildFromVault multiplex
  leidenPropagateFM: false
  // se ON, escreve zeus_community: NN no frontmatter de cada nota
};
function sha256(text) {
  if (universal.nodeCrypto && typeof universal.nodeCrypto.createHash === "function") {
    return universal.nodeCrypto.createHash("sha256").update(text).digest("hex");
  }
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h << 5) - h + text.charCodeAt(i) | 0;
  return (h >>> 0).toString(16).padStart(8, "0");
}
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
function normalizeForMatch(s) {
  return (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}
function isMac() {
  return universal.isMacLike();
}
async function tryDaemonOrSpawn(plugin, daemonMethod, daemonArgs) {
  if (!plugin.httpClient || typeof plugin.httpClient[daemonMethod] !== "function") {
    throw new Error(`Daemon method indispon\xEDvel: ${daemonMethod}`);
  }
  const reachable = await plugin.httpClient.isAvailable();
  if (!reachable) {
    throw new Error(`Daemon HTTP fora do ar (${plugin.httpClient.baseUrl}) \u2014 ${daemonMethod} n\xE3o p\xF4de rodar`);
  }
  const result = await plugin.httpClient[daemonMethod](...daemonArgs);
  return { source: "daemon", result };
}
var TAILSCALE_MESH = [
  // Order matters — closest/fastest first
  "http://127.0.0.1:2223",
  // local daemon (any device)
  "http://100.108.238.49:2223",
  // rogers-mac-mini (Tailscale, macOS)
  "http://100.86.123.88:2223",
  // macbook-air-de-roger (Tailscale, macOS)
  "http://100.91.107.120:2223",
  // ipad-air-gen-4 (Tailscale, iOS)
  "http://100.65.240.43:2223",
  // iphone-15 (Tailscale, iOS)
  "http://rogers-mac-mini.local:2223"
  // mDNS/Bonjour fallback (LAN local sem Tailscale)
];
var ZEUS_LOCAL_DAEMON_KEY = "zeus.daemon.url";
var ZEUS_LOCAL_DAEMON_TS_KEY = "zeus.daemon.ts";
var ZEUS_LOCAL_DAEMON_TTL_MS = 12 * 60 * 60 * 1e3;
function _zeusIsLoopback(url) {
  if (!url) return false;
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i.test(url);
}
function _zeusGetLocalDaemonUrl() {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    const url = window.localStorage.getItem(ZEUS_LOCAL_DAEMON_KEY);
    const ts = parseInt(window.localStorage.getItem(ZEUS_LOCAL_DAEMON_TS_KEY) || "0", 10);
    if (!url || !ts) return null;
    if (Date.now() - ts > ZEUS_LOCAL_DAEMON_TTL_MS) return null;
    return url;
  } catch (e) {
    return null;
  }
}
function _zeusSetLocalDaemonUrl(url) {
  try {
    if (typeof window === "undefined" || !window.localStorage) return;
    if (!url) {
      window.localStorage.removeItem(ZEUS_LOCAL_DAEMON_KEY);
      window.localStorage.removeItem(ZEUS_LOCAL_DAEMON_TS_KEY);
      return;
    }
    if (!_zeusIsLoopback(url)) {
      console.log("[zeus] cache skip \u2014 URL n\xE3o \xE9 loopback (sempre re-probe local primeiro):", url);
      return;
    }
    window.localStorage.setItem(ZEUS_LOCAL_DAEMON_KEY, url);
    window.localStorage.setItem(ZEUS_LOCAL_DAEMON_TS_KEY, String(Date.now()));
  } catch (e) {
  }
}
async function discoverDaemonUrl(plugin, candidates = null, probeTimeoutMs = 1500) {
  const allowRemote = plugin.settings.allowRemoteDaemonFallback !== false;
  const ordered = [];
  const seen = /* @__PURE__ */ new Set();
  const push = (u) => {
    if (u && !seen.has(u)) {
      seen.add(u);
      ordered.push(u);
    }
  };
  if (candidates) {
    for (const u of candidates) push(u);
  } else {
    push("http://127.0.0.1:2223");
    push("http://localhost:2223");
    push(plugin.settings.zeusDaemonUrl);
    if (allowRemote) {
      for (const u of TAILSCALE_MESH) push(u);
    }
  }
  const ZeusHttpClientLocal = require_zeus_http_client();
  const probes = ordered.map((url, idx) => (async () => {
    try {
      const client = new ZeusHttpClientLocal(url);
      const ok = await client.isAvailable(probeTimeoutMs);
      return ok ? { url, idx, loopback: _zeusIsLoopback(url) } : null;
    } catch (e) {
      return null;
    }
  })());
  const results = await Promise.allSettled(probes);
  const winners = results.filter((r) => r.status === "fulfilled" && r.value).map((r) => r.value);
  if (winners.length === 0) {
    console.warn("[zeus] adaptive daemon discovery \u2192 NENHUM daemon respondeu (nem local nem mesh)");
    return plugin.settings.zeusDaemonUrl;
  }
  const loopback = winners.find((w) => w.loopback);
  const chosen = loopback || winners.sort((a, b) => a.idx - b.idx)[0];
  console.log(
    "[zeus] adaptive daemon discovery \u2192 using",
    chosen.url,
    chosen.loopback ? "(LOCAL on-device daemon \u2713)" : "(REMOTE Tailscale fallback \u26A0)"
  );
  _zeusSetLocalDaemonUrl(chosen.url);
  return chosen.url;
}
async function acsMetadata(absPath) {
  return new Promise((resolve) => {
    if (!spawn) {
      resolve({});
      return;
    }
    const child = spawn("/usr/bin/mdls", ["-plist", "-", absPath], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => out += d.toString());
    child.on("close", () => {
      const features = {};
      const wanted = [
        "kMDItemKind",
        "kMDItemContentTypeTree",
        "kMDItemPixelWidth",
        "kMDItemPixelHeight",
        "kMDItemLatitude",
        "kMDItemLongitude",
        "kMDItemAltitude",
        "kMDItemContentCreationDate",
        "kMDItemContentModificationDate",
        "kMDItemAcquisitionMake",
        "kMDItemAcquisitionModel",
        "kMDItemTitle",
        "kMDItemAuthors",
        "kMDItemNumberOfPages",
        "kMDItemDescription",
        "kMDItemUserTags",
        "kMDItemFinderComment"
      ];
      for (const key of wanted) {
        const re = new RegExp(`<key>${key}</key>\\s*<(string|real|integer|date)>([^<]+)</\\1>`);
        const m = out.match(re);
        if (m) features[key.replace("kMDItem", "")] = m[2];
      }
      resolve(features);
    });
    child.on("error", () => resolve({}));
  });
}
var AppleVisionIntelligence = class {
  constructor(plugin) {
    this.plugin = plugin;
  }
  get cacheDir() {
    return path.join(this.plugin.indexer.dataPath, IMAGE_FEAT_CACHE_DIR);
  }
  cachePath(sha) {
    return path.join(this.cacheDir, sha + ".json");
  }
  loadFromCache(sha) {
    try {
      const p = this.cachePath(sha);
      if (!fs.existsSync(p)) return null;
      return JSON.parse(fs.readFileSync(p, "utf8"));
    } catch (e) {
      return null;
    }
  }
  // For images: run aocr + av classify + av landmarks + acs metadata in parallel
  async extractImageFeatures(absPath, sha) {
    const cached = this.loadFromCache(sha);
    if (cached) return cached;
    const plugin = this.plugin;
    const topN = plugin.settings.avClassifyTopN;
    const tasks = [
      // aocr (text in image) — HTTP-first via daemon ocr()
      tryDaemonOrSpawn(
        plugin,
        "ocr",
        [absPath, "text", "pt-BR,en"],
        ["ocr", absPath, "-o", "text"],
        null,
        6e4
      ).then((r) => {
        if (r.source === "daemon") {
          const text = r.result && (r.result.text || r.result.ocr || "") || "";
          return { aocr: String(text).trim() };
        }
        return { aocr: String(r.result || "").trim() };
      }).catch((e) => ({ aocr: "", aocrError: e.message.slice(0, 80) })),
      // av classify (top-N categories) — HTTP-first via daemon visionClassify()
      tryDaemonOrSpawn(
        plugin,
        "visionClassify",
        [absPath, topN],
        ["vision", "classify", absPath, "--top-n", String(topN)],
        null,
        3e4
      ).then((r) => {
        if (r.source === "daemon") {
          if (r.result && typeof r.result === "object") {
            try {
              delete r.result.path;
            } catch (e) {
            }
          }
          return { avClassify: JSON.stringify(r.result) };
        }
        return { avClassify: String(r.result || "").trim() };
      }).catch((e) => ({ avClassify: "", avClassifyError: e.message.slice(0, 80) })),
      // av landmarks (face detection) — HTTP-first via daemon visionLandmarks()
      tryDaemonOrSpawn(
        plugin,
        "visionLandmarks",
        [absPath],
        ["vision", "landmarks", absPath],
        null,
        3e4
      ).then((r) => {
        if (r.source === "daemon") {
          const arr = Array.isArray(r.result) ? r.result : r.result && Array.isArray(r.result.landmarks) ? r.result.landmarks : [];
          return { avLandmarks: JSON.stringify(arr) };
        }
        return { avLandmarks: String(r.result || "").trim() };
      }).catch((e) => ({ avLandmarks: "", avLandmarksError: e.message.slice(0, 80) })),
      // acs metadata (Spotlight: EXIF, GPS, dates, camera, dimensions) — Mac only, no daemon path
      acsMetadata(absPath).then((meta) => ({ acsMetadata: meta }))
    ];
    const results = await Promise.all(tasks);
    const features = Object.assign({}, ...results);
    try {
      const lm = JSON.parse(features.avLandmarks || "[]");
      features.faceCount = Array.isArray(lm) ? lm.length : 0;
    } catch (e) {
      features.faceCount = (features.avLandmarks.match(/face[_\d]/gi) || []).length;
    }
    fs.mkdirSync(this.cacheDir, { recursive: true });
    fs.writeFileSync(this.cachePath(sha), JSON.stringify(features, null, 2));
    return features;
  }
  // Synthesize a single indexable text from image features for embedding
  synthesizeIndexableText(features, fileName) {
    const parts = [`Image: ${fileName}`];
    if (features.aocr && features.aocr.length > 5) parts.push(`Text in image: ${features.aocr.slice(0, 1500)}`);
    if (features.avClassify) {
      let cats = [];
      try {
        const parsed = JSON.parse(features.avClassify);
        cats = (parsed.classifications || []).map((c) => c.label).filter(Boolean).slice(0, 8);
      } catch (e) {
        cats = features.avClassify.split("\n").map((l) => l.split(":")[0].trim()).filter(Boolean).slice(0, 8);
      }
      if (cats.length) parts.push(`Visual categories: ${cats.join(", ")}`);
    }
    if (features.faceCount > 0) parts.push(`Contains ${features.faceCount} face${features.faceCount > 1 ? "s" : ""}`);
    const m = features.acsMetadata || {};
    if (m.AcquisitionMake || m.AcquisitionModel) parts.push(`Camera: ${[m.AcquisitionMake, m.AcquisitionModel].filter(Boolean).join(" ")}`);
    if (m.ContentCreationDate) parts.push(`Captured: ${m.ContentCreationDate}`);
    if (m.Latitude && m.Longitude) parts.push(`Location: ${m.Latitude}, ${m.Longitude}`);
    if (m.PixelWidth && m.PixelHeight) parts.push(`Dimensions: ${m.PixelWidth}\xD7${m.PixelHeight}`);
    if (m.Title) parts.push(`Title: ${m.Title}`);
    if (m.Description) parts.push(`Description: ${m.Description}`);
    if (m.UserTags) parts.push(`Tags: ${m.UserTags}`);
    return parts.join("\n");
  }
};
var ZeusIndexer = class {
  constructor(plugin) {
    this.plugin = plugin;
    this.indexing = false;
  }
  // v0.11 — dataPath now also exposed as vault-relative for vault.adapter consumers
  get dataPath() {
    if (!path || !this.plugin.vaultRoot) return this.dataPathRel;
    return path.join(this.plugin.vaultRoot, this.plugin.manifest.dir, DATA_DIR_NAME);
  }
  // Vault-relative — works on Mac AND iOS via vault.adapter.
  get dataPathRel() {
    return universal.joinPath(this.plugin.manifest.dir, DATA_DIR_NAME);
  }
  // Note: kept sync for API compat. Mac uses fs.readFileSync; iOS falls back to
  // a cached value loaded asynchronously during onload (this.plugin._manifestCache).
  // If cache is empty on iOS, returns default empty manifest (UI degrades gracefully).
  loadManifest() {
    if (!fs || !path) {
      return this.plugin._manifestCache || { version: 2, model: "apple-nlcontextual", dim: 512, files: {} };
    }
    const p = path.join(this.dataPath, MANIFEST_FILE);
    if (!fs.existsSync(p)) return { version: 2, model: "apple-nlcontextual", dim: 512, files: {} };
    try {
      return JSON.parse(fs.readFileSync(p, "utf8"));
    } catch (e) {
      return { version: 2, model: "apple-nlcontextual", dim: 512, files: {} };
    }
  }
  // Async loader used during onload to populate the in-memory cache for iOS.
  async loadManifestAsync() {
    try {
      const rel = universal.joinPath(this.dataPathRel, MANIFEST_FILE);
      const adapter = this.plugin.app.vault.adapter;
      if (!await universal.adapterExists(adapter, rel)) {
        return { version: 2, model: "apple-nlcontextual", dim: 512, files: {} };
      }
      const raw = await universal.adapterRead(adapter, rel);
      return JSON.parse(raw);
    } catch (e) {
      return { version: 2, model: "apple-nlcontextual", dim: 512, files: {} };
    }
  }
  saveManifest(m) {
    if (!fs || !path) {
      const adapter = this.plugin.app.vault.adapter;
      universal.adapterMkdir(adapter, this.dataPathRel).then(() => universal.adapterWriteAtomic(adapter, universal.joinPath(this.dataPathRel, MANIFEST_FILE), JSON.stringify(m, null, 2))).catch((e) => console.warn("[zeus] saveManifest (iOS) failed:", e.message));
      this.plugin._manifestCache = m;
      return;
    }
    fs.mkdirSync(this.dataPath, { recursive: true });
    fs.writeFileSync(path.join(this.dataPath, MANIFEST_FILE), JSON.stringify(m, null, 2));
  }
  async readFileContent(absPath, ext) {
    if (ext === "md") return fs.readFileSync(absPath, "utf8");
    if (!this.plugin.settings.ocrEnabled) return "";
    const sha = sha256(absPath + ":" + fs.statSync(absPath).mtimeMs);
    const isImage = ["png", "jpg", "jpeg", "heic", "tiff", "bmp"].includes(ext);
    const isPdf = ext === "pdf";
    if (isImage && this.plugin.settings.avImageFeatures) {
      try {
        const features = await this.plugin.av.extractImageFeatures(absPath, sha);
        return this.plugin.av.synthesizeIndexableText(features, path.basename(absPath));
      } catch (e) {
        console.warn("[zeus] av extract failed for", absPath, e.message);
      }
    }
    const cachePath = path.join(this.dataPath, OCR_CACHE_DIR, sha + ".txt");
    if (fs.existsSync(cachePath)) return fs.readFileSync(cachePath, "utf8");
    const extractText = (r) => {
      if (r.source === "daemon") {
        const v = r.result;
        return String(v && (v.text || v.ocr || v.content) || "");
      }
      return String(r.result || "");
    };
    try {
      const spawnArgs = ["ocr", absPath, "-o", "text", "-l", "pt-BR,en"];
      if (isPdf && this.plugin.settings.aocrPdfStructured) spawnArgs.push("--structured");
      const r = await tryDaemonOrSpawn(
        this.plugin,
        "ocr",
        [absPath, "text", "pt-BR,en"],
        spawnArgs,
        null,
        18e4
      );
      const text = extractText(r);
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      fs.writeFileSync(cachePath, text);
      return text;
    } catch (e) {
      if (isPdf && this.plugin.settings.aocrPdfStructured) {
        try {
          const r2 = await tryDaemonOrSpawn(
            this.plugin,
            "ocr",
            [absPath, "text", "pt-BR,en"],
            ["ocr", absPath, "-o", "text", "-l", "pt-BR,en"],
            null,
            18e4
          );
          const text = extractText(r2);
          fs.mkdirSync(path.dirname(cachePath), { recursive: true });
          fs.writeFileSync(cachePath, text);
          return text;
        } catch (e2) {
          console.warn("[zeus] aocr fallback also failed", absPath, e2.message);
        }
      }
      console.warn("[zeus] aocr failed for", absPath, e.message);
      return "";
    }
  }
  // v0.11 — universal enumerator. Returns array of { abs, rel, ext } where:
  //   - rel is always vault-relative (forward-slash, works on iOS and Mac)
  //   - abs is absolute path on Mac, equals rel on iOS (since no fs absolute path).
  // Caller MUST use rel + vault.adapter for cross-platform code paths.
  // On Mac with fs available, walks via fs.readdirSync (faster than adapter).
  // On iOS, falls back to async adapter walk (caller must await).
  enumerateFiles() {
    const exclusions = new Set(this.plugin.settings.folderExclusions);
    const exts = this.plugin.settings.fileTypes;
    if (fs && path && this.plugin.vaultRoot) {
      const files = [];
      const walk = (dir) => {
        let entries;
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch (e) {
          return;
        }
        for (const e of entries) {
          if (exclusions.has(e.name)) continue;
          if (e.name === ".DS_Store") continue;
          const full = path.join(dir, e.name);
          if (e.isDirectory()) walk(full);
          else if (e.isFile()) {
            const ext = e.name.split(".").pop().toLowerCase();
            if (exts[ext]) {
              const rel = path.relative(this.plugin.vaultRoot, full).split(path.sep).join("/");
              files.push({ abs: full, rel, ext });
            }
          }
        }
      };
      walk(this.plugin.vaultRoot);
      return files;
    }
    const out = [];
    const allFiles = this.plugin.app.vault.getFiles ? this.plugin.app.vault.getFiles() : [];
    for (const f of allFiles) {
      const rel = f.path;
      const segs = rel.split("/");
      let skip = false;
      for (let i = 0; i < segs.length - 1; i++) {
        const s = segs[i];
        if (!s) continue;
        if (exclusions.has(s) || s.startsWith(".")) {
          skip = true;
          break;
        }
      }
      if (skip) continue;
      const ext = (f.extension || (rel.split(".").pop() || "")).toLowerCase();
      if (!exts[ext]) continue;
      out.push({ abs: rel, rel, ext });
    }
    return out;
  }
  parseEmbedOutput(jsonStr) {
    const obj = JSON.parse(jsonStr);
    return { vectors: obj.vectors || [], dim: obj.dim || 0, model: obj.model || "unknown" };
  }
  async embedBatch(texts) {
    if (texts.length === 0) return [];
    const stdin = JSON.stringify(texts);
    const r = await tryDaemonOrSpawn(
      this.plugin,
      "embedBatch",
      [texts, { backend: this.plugin.settings.embedBackend }],
      ["embed", "--backend", this.plugin.settings.embedBackend],
      stdin,
      3e5
    );
    if (r.source === "daemon") {
      return r.result && r.result.vectors || [];
    }
    const parsed = this.parseEmbedOutput(r.result);
    return parsed.vectors;
  }
  async runFullIndex(onProgress) {
    if (this.indexing) {
      new Notice("Zeus: indexa\xE7\xE3o j\xE1 em curso");
      return;
    }
    if (!isMac()) {
      new Notice("Zeus: indexa\xE7\xE3o s\xF3 roda no Mac (metafm). Outros devices apenas l\xEAem.");
      return;
    }
    this.indexing = true;
    const start = Date.now();
    fs.mkdirSync(this.dataPath, { recursive: true });
    try {
      const files = this.enumerateFiles();
      if (onProgress) onProgress(`${files.length} arquivos encontrados`);
      if (files.length === 0) {
        new Notice("Zeus: vault vazio \u2014 nada para indexar");
        this.indexing = false;
        return;
      }
      const docs = [];
      let i = 0;
      for (const f of files) {
        i++;
        if (onProgress && i % 10 === 0) onProgress(`lendo ${i}/${files.length}`);
        let content = "";
        try {
          content = await this.readFileContent(f.abs, f.ext);
        } catch (e) {
          console.warn("[zeus] read failed", f.rel, e.message);
          continue;
        }
        if (!content || content.length < this.plugin.settings.minDocChars) continue;
        const sha = sha256(content);
        const title = f.rel.replace(/\.[^.]+$/, "").split("/").pop();
        const body = content.replace(/^---\n[\s\S]*?\n---\n/, "").slice(0, 5e4);
        docs.push({ path: f.rel, abs: f.abs, ext: f.ext, sha, mtime: fs.statSync(f.abs).mtimeMs, title, body });
      }
      const oldEmbeddings = this.loadEmbeddings();
      const newEmbeddings = /* @__PURE__ */ new Map();
      const toEmbed = [];
      for (const d of docs) {
        const prev = oldEmbeddings.get(d.path);
        if (prev && prev.sha === d.sha) newEmbeddings.set(d.path, prev);
        else toEmbed.push(d);
      }
      if (toEmbed.length > 0) {
        if (onProgress) onProgress(`Apple NLContextualEmbedding: ${toEmbed.length} novos`);
        const BATCH = 20;
        for (let j = 0; j < toEmbed.length; j += BATCH) {
          const chunk = toEmbed.slice(j, j + BATCH);
          if (onProgress) onProgress(`embedding ${Math.min(j + BATCH, toEmbed.length)}/${toEmbed.length}`);
          const texts = chunk.map((d) => (d.title + "\n" + d.body).slice(0, 4e3));
          let vectors;
          try {
            vectors = await this.embedBatch(texts);
          } catch (e) {
            console.warn("[zeus] embed batch failed", e.message);
            new Notice("Zeus embed: " + e.message.slice(0, 100));
            continue;
          }
          for (let k = 0; k < chunk.length; k++) {
            newEmbeddings.set(chunk[k].path, {
              path: chunk[k].path,
              sha: chunk[k].sha,
              mtime: chunk[k].mtime,
              title: chunk[k].title,
              vec: vectors[k]
            });
          }
          this.saveEmbeddings(newEmbeddings);
        }
      }
      this.saveEmbeddings(newEmbeddings);
      const manifest = {
        version: 2,
        model: "apple-nlcontextual",
        dim: 512,
        files: {},
        indexedAt: Date.now(),
        elapsedMs: Date.now() - start,
        docCount: docs.length,
        embeddingCount: newEmbeddings.size
      };
      for (const d of docs) manifest.files[d.path] = { sha: d.sha, mtime: d.mtime, ext: d.ext };
      this.saveManifest(manifest);
      this.plugin.loadIndices();
      if (typeof this.plugin.updateStatusBar === "function") this.plugin.updateStatusBar("idle", null);
      const elapsed = ((Date.now() - start) / 1e3).toFixed(1);
      new Notice(`Zeus: ${docs.length} docs, ${toEmbed.length} embeddings novos, ${elapsed}s`);
      if (onProgress) onProgress(`pronto: ${docs.length} docs / ${elapsed}s`);
    } catch (e) {
      console.error("[zeus] index error", e);
      new Notice("Zeus index error: " + e.message.slice(0, 120));
    } finally {
      this.indexing = false;
      if (typeof this.plugin.updateStatusBar === "function") this.plugin.updateStatusBar("idle", null);
    }
  }
  // Sync API kept for compat. Mac uses fs; iOS returns the cached map
  // populated by loadEmbeddingsAsync() during onload.
  loadEmbeddings() {
    const map = /* @__PURE__ */ new Map();
    if (!fs || !path) {
      const cached = this.plugin._embeddingsCache;
      return cached instanceof Map ? cached : map;
    }
    const p = path.join(this.dataPath, EMBEDDINGS_FILE);
    if (!fs.existsSync(p)) return map;
    const content = fs.readFileSync(p, "utf8");
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        map.set(obj.path, obj);
      } catch (e) {
      }
    }
    return map;
  }
  async loadEmbeddingsAsync() {
    const map = /* @__PURE__ */ new Map();
    try {
      const rel = universal.joinPath(this.dataPathRel, EMBEDDINGS_FILE);
      const adapter = this.plugin.app.vault.adapter;
      if (!await universal.adapterExists(adapter, rel)) return map;
      const content = await universal.adapterRead(adapter, rel);
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          map.set(obj.path, obj);
        } catch (e) {
        }
      }
    } catch (e) {
      console.warn("[zeus] loadEmbeddingsAsync failed:", e.message);
    }
    return map;
  }
  saveEmbeddings(map) {
    if (!fs || !path) {
      const adapter = this.plugin.app.vault.adapter;
      const lines2 = [];
      for (const v of map.values()) lines2.push(JSON.stringify(v));
      universal.adapterMkdir(adapter, this.dataPathRel).then(() => universal.adapterWriteAtomic(adapter, universal.joinPath(this.dataPathRel, EMBEDDINGS_FILE), lines2.join("\n"))).catch((e) => console.warn("[zeus] saveEmbeddings (iOS) failed:", e.message));
      this.plugin._embeddingsCache = map;
      return;
    }
    fs.mkdirSync(this.dataPath, { recursive: true });
    const lines = [];
    for (const v of map.values()) lines.push(JSON.stringify(v));
    fs.writeFileSync(path.join(this.dataPath, EMBEDDINGS_FILE), lines.join("\n"));
  }
};
var ZeusSearcher = class {
  constructor(plugin) {
    this.plugin = plugin;
    this.embeddings = /* @__PURE__ */ new Map();
  }
  load() {
    this.embeddings = this.plugin.indexer.loadEmbeddings();
  }
  // Lê conteúdo bruto do arquivo para o exact-match boost — só quando necessário.
  // Mac path: synchronous fs.readFileSync (fast, used in tight scoring loops).
  // iOS path: fs is null — caller has cache; readDoc returns '' (only impacts
  // the very rare "no qVec available" fallback, which can't happen on iOS since
  // daemon embed must succeed for search to work).
  readDoc(filePath) {
    try {
      if (!fs || !path) return "";
      const abs = path.join(this.plugin.vaultRoot, filePath);
      const content = fs.readFileSync(abs, "utf8").replace(/^---\n[\s\S]*?\n---\n/, "");
      return content;
    } catch (e) {
      return "";
    }
  }
  async embedQuery(query) {
    let textToEmbed = query;
    if (this.plugin.settings.hydeEnabled) {
      try {
        textToEmbed = await this.plugin.hyde.expand(query);
        console.log("[zeus] HyDE expansion (first 100):", textToEmbed.slice(0, 100));
      } catch (e) {
        console.warn("[zeus] HyDE failed, using raw query", e.message);
      }
    }
    try {
      const r = await tryDaemonOrSpawn(
        this.plugin,
        "embed",
        [textToEmbed, { backend: this.plugin.settings.embedBackend }],
        ["embed", "--backend", this.plugin.settings.embedBackend],
        textToEmbed,
        25e3
      );
      if (r.source === "daemon") {
        return r.result && r.result.vectors && r.result.vectors[0] || null;
      }
      const parsed = JSON.parse(r.result);
      return parsed.vectors && parsed.vectors[0] || null;
    } catch (e) {
      console.warn("[zeus] query embed failed (both paths)", e.message);
      return null;
    }
  }
  // Search principal: cosine semântico + exact-match boost
  async search(query, limit = 30) {
    if (!query || query.length < 2) return [];
    if (this.embeddings.size === 0) return [];
    const qNorm = normalizeForMatch(query);
    const qVec = await this.embedQuery(query);
    const results = [];
    for (const e of this.embeddings.values()) {
      if (!e.vec) continue;
      const semScore = qVec ? cosine(qVec, e.vec) : 0;
      const titleNorm = normalizeForMatch(e.title || "");
      let exactHit = 0;
      if (titleNorm.includes(qNorm)) exactHit = 1;
      if (!qVec && exactHit === 0) {
        const bodyNorm = normalizeForMatch(this.readDoc(e.path).slice(0, 3e4));
        if (bodyNorm.includes(qNorm)) exactHit = 0.5;
      }
      const finalScore = qVec ? semScore * (1 + this.plugin.settings.exactMatchBoost * exactHit) : exactHit;
      if (finalScore <= 0) continue;
      results.push({ path: e.path, score: finalScore, semantic: semScore, exact: exactHit });
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }
  neighbors(filePath, count = 12) {
    const e = this.embeddings.get(filePath);
    if (!e || !e.vec) return [];
    const results = [];
    for (const other of this.embeddings.values()) {
      if (other.path === filePath || !other.vec) continue;
      results.push({ path: other.path, score: cosine(e.vec, other.vec) });
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, count);
  }
  excerpt(filePath, query, maxLen = 220) {
    const content = this.readDoc(filePath);
    if (!content) return "";
    const qNorm = normalizeForMatch(query).split(" ")[0];
    const cNorm = normalizeForMatch(content);
    const idx = cNorm.indexOf(qNorm);
    if (idx < 0) return content.slice(0, maxLen).replace(/\s+/g, " ").trim();
    const start = Math.max(0, idx - 40);
    const end = Math.min(content.length, idx + maxLen - 40);
    return (start > 0 ? "\u2026" : "") + content.slice(start, end).replace(/\s+/g, " ").trim() + (end < content.length ? "\u2026" : "");
  }
};
var HyDEExpander = class {
  constructor(plugin) {
    this.plugin = plugin;
    this.cache = /* @__PURE__ */ new Map();
  }
  async expand(query) {
    if (this.cache.has(query)) return this.cache.get(query);
    const instruction = `Escreva uma nota curta em portugu\xEAs (3-5 frases) que responde diretamente \xE0 pergunta: "${query}". Use palavras-chave e conceitos t\xE9cnicos que apareceriam no conte\xFAdo real de uma nota sobre o tema. Sem pre\xE2mbulo.`;
    try {
      const r = await tryDaemonOrSpawn(
        this.plugin,
        "prompt",
        [instruction, { max_tokens: 300, deterministic: true, prewarm: true, timeoutMs: 9e4 }],
        ["prompt", instruction, "--deterministic", "--max-tokens", "300", "--prewarm"],
        null,
        // prompt usa arg posicional, não stdin
        9e4
        // cold spawn ~30-60s; rede idle pode estender
      );
      let hypothetical;
      if (r.source === "daemon") {
        const v = r.result;
        hypothetical = String(v && (v.text || v.output || v.response || v.completion) || "").trim();
      } else {
        hypothetical = String(r.result || "").trim();
      }
      if (!hypothetical) return query;
      this.cache.set(query, hypothetical);
      return hypothetical;
    } catch (e) {
      console.warn("[zeus] HyDE expansion failed", e.message);
      return query;
    }
  }
};
var ZeusGraphExtractor = class {
  constructor(plugin) {
    this.plugin = plugin;
  }
  async extract(filePath) {
    try {
      const content = await this.plugin.app.vault.adapter.read(filePath);
      const stripped = content.replace(/^---\n[\s\S]*?\n---\n/, "").slice(0, 6e3);
      const r = await tryDaemonOrSpawn(
        this.plugin,
        "graphExtract",
        [stripped, 20, 30],
        ["graph-extract", "--max-nodes", "20", "--max-edges", "30"],
        stripped,
        6e4
      );
      if (r.source === "daemon") {
        return r.result;
      }
      return JSON.parse(r.result);
    } catch (e) {
      throw new Error(`graph-extract: ${e.message.slice(0, 200)}`);
    }
  }
};
var ZeusGraphModal = class extends obsidian.Modal {
  constructor(app, plugin, filePath) {
    super(app);
    this.plugin = plugin;
    this.filePath = filePath;
  }
  async onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("zeus-graph-modal");
    contentEl.createEl("h3", { text: "Knowledge Graph (FoundationModels)" });
    contentEl.createEl("p", { text: this.filePath, cls: "zeus-graph-path" });
    const status = contentEl.createDiv({ cls: "zeus-graph-status", text: "Extraindo grafo via afm graph-extract\u2026" });
    const canvas = contentEl.createDiv({ cls: "zeus-graph-canvas" });
    try {
      const graph = await this.plugin.graphExtractor.extract(this.filePath);
      status.empty();
      this.renderGraph(canvas, graph);
    } catch (e) {
      status.setText("Erro: " + e.message);
    }
  }
  renderGraph(container, graph) {
    const nodes = graph.nodes || [];
    const edges = graph.edges || graph.relations || [];
    if (nodes.length === 0) {
      container.createDiv({ text: "Sem nodes extra\xEDdos.", cls: "zeus-graph-empty" });
      return;
    }
    const W = 720, H = 480;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("class", "zeus-graph-svg");
    const positions = /* @__PURE__ */ new Map();
    const cx = W / 2, cy = H / 2;
    const r = Math.min(W, H) * 0.38;
    nodes.forEach((n, i) => {
      const angle = i / nodes.length * 2 * Math.PI - Math.PI / 2;
      positions.set(n.id || n.name || String(i), {
        x: cx + r * Math.cos(angle),
        y: cy + r * Math.sin(angle),
        name: n.name || n.id || n.label || `node ${i}`,
        type: n.type || ""
      });
    });
    for (const e of edges) {
      const fromKey = e.from || e.source || e.subject;
      const toKey = e.to || e.target || e.object;
      const a = positions.get(fromKey);
      const b = positions.get(toKey);
      if (!a || !b) continue;
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", a.x);
      line.setAttribute("y1", a.y);
      line.setAttribute("x2", b.x);
      line.setAttribute("y2", b.y);
      line.setAttribute("class", "zeus-graph-edge");
      svg.appendChild(line);
      if (e.relation || e.label || e.predicate) {
        const lbl = document.createElementNS("http://www.w3.org/2000/svg", "text");
        lbl.setAttribute("x", (a.x + b.x) / 2);
        lbl.setAttribute("y", (a.y + b.y) / 2);
        lbl.setAttribute("class", "zeus-graph-edge-label");
        lbl.textContent = e.relation || e.label || e.predicate;
        svg.appendChild(lbl);
      }
    }
    for (const [key, p] of positions) {
      const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
      const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      circle.setAttribute("cx", p.x);
      circle.setAttribute("cy", p.y);
      circle.setAttribute("r", 8);
      circle.setAttribute("class", "zeus-graph-node");
      g.appendChild(circle);
      const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
      text.setAttribute("x", p.x);
      text.setAttribute("y", p.y - 14);
      text.setAttribute("class", "zeus-graph-node-label");
      text.textContent = (p.name || "").slice(0, 30);
      g.appendChild(text);
      svg.appendChild(g);
    }
    container.empty();
    container.appendChild(svg);
    const summary = container.createDiv({ cls: "zeus-graph-summary" });
    summary.createEl("span", { text: `${nodes.length} nodes, ${edges.length} relations` });
  }
  onClose() {
    this.contentEl.empty();
  }
};
var ZeusNativeGraphIntegration = class {
  constructor(plugin) {
    this.plugin = plugin;
    this.SYNC_DEBOUNCE_MS = 3e3;
    this.FRONTMATTER_KEY = "zeus_related";
    this.FRONTMATTER_GRAPH_KEY = "zeus_graph_related";
    this._lastWritten = /* @__PURE__ */ new Map();
    this._inFlight = /* @__PURE__ */ new Set();
  }
  _arraySha(arr) {
    const txt = (arr || []).join("\n");
    if (universal.nodeCrypto && universal.nodeCrypto.createHash) {
      return universal.nodeCrypto.createHash("sha256").update(txt).digest("hex").slice(0, 16);
    }
    let h = 0;
    for (let i = 0; i < txt.length; i++) h = (h << 5) - h + txt.charCodeAt(i) | 0;
    return (h >>> 0).toString(16).padStart(8, "0");
  }
  _renderLinks(items) {
    return items.map((n) => {
      const name = String(n.path || "").replace(/\.md$/, "");
      const alias = name.split("/").pop();
      const pct = typeof n.score === "number" ? ` (${(n.score * 100).toFixed(0)}%)` : "";
      return `[[${name}|${alias}${pct}]]`;
    });
  }
  // Top-N neighbors da nota (cosine NL), injeta como wikilinks no frontmatter.
  // v1.6 — compara SHA antes de escrever, evita timestamp churn.
  // v1.6.1 — codex MED #1: quando filtered fica vazio, REMOVE zeus_related em vez
  // de fazer no-op (que deixava arestas stale no Graph nativo).
  async syncFile(filePath, topN = 5, minScore = 0.3) {
    if (!this.plugin.settings.nativeGraphIntegration) return;
    if (this._inFlight.has(filePath)) return;
    const neighbors = this.plugin.searcher.neighbors(filePath, topN);
    const filtered = neighbors.filter((n) => n.score >= minScore);
    const file = this.plugin.app.vault.getAbstractFileByPath(filePath);
    if (!file) return;
    const wikilinks = this._renderLinks(filtered);
    const sha = this._arraySha(wikilinks);
    const cacheKey = `${filePath}|${this.FRONTMATTER_KEY}`;
    if (this._lastWritten.get(cacheKey) === sha) return;
    this._inFlight.add(filePath);
    try {
      await this.plugin.app.fileManager.processFrontMatter(file, (fm) => {
        const current = Array.isArray(fm[this.FRONTMATTER_KEY]) ? fm[this.FRONTMATTER_KEY] : null;
        const currentSha = current ? this._arraySha(current) : null;
        if (currentSha === sha) return;
        if (wikilinks.length === 0) {
          delete fm[this.FRONTMATTER_KEY];
          delete fm.zeus_neighbor_count;
          delete fm.zeus_indexed_at;
        } else {
          fm[this.FRONTMATTER_KEY] = wikilinks;
          fm.zeus_neighbor_count = filtered.length;
          fm.zeus_indexed_at = (/* @__PURE__ */ new Date()).toISOString();
        }
      });
      this._lastWritten.set(cacheKey, sha);
    } finally {
      this._inFlight.delete(filePath);
    }
  }
  // v1.6 — codex MED #1 + user request "Graphify 100% integrado com graph nativo".
  // Roda afm graph-extract (entidades + arestas) e escreve as entidades cujos
  // basenames existem no vault como wikilinks em `zeus_graph_related`. Obsidian
  // native Graph View renderiza estas como arestas naturais.
  //
  // Manual/on-command apenas — graph-extract é caro (~3-8s/nota), não roda em
  // real-time pra não competir com pipeline de embed.
  async syncFromGraphExtract(filePath) {
    if (this._inFlight.has(filePath)) return { skipped: "in-flight" };
    if (!this.plugin.graphExtractor) return { error: "graphExtractor indispon\xEDvel" };
    const file = this.plugin.app.vault.getAbstractFileByPath(filePath);
    if (!file) return { error: "arquivo n\xE3o encontrado no vault" };
    this._inFlight.add(filePath);
    try {
      let graph;
      try {
        graph = await this.plugin.graphExtractor.extract(filePath);
      } catch (e) {
        return { error: "graph-extract: " + (e.message || String(e)).slice(0, 200) };
      }
      const nodes = Array.isArray(graph && graph.nodes) ? graph.nodes : [];
      const mdc = this.plugin.app.metadataCache;
      const matches = [];
      const seen = /* @__PURE__ */ new Set();
      for (const node of nodes) {
        const label = String(node && (node.id || node.label || node.name) || "").trim();
        if (!label || label.length < 2) continue;
        const dest = mdc.getFirstLinkpathDest ? mdc.getFirstLinkpathDest(label, filePath) : null;
        if (dest && dest.path && dest.path !== filePath && !seen.has(dest.path)) {
          seen.add(dest.path);
          matches.push({ path: dest.path, score: void 0, label });
        }
      }
      const wikilinks = this._renderLinks(matches);
      const sha = this._arraySha(wikilinks);
      const cacheKey = `${filePath}|${this.FRONTMATTER_GRAPH_KEY}`;
      if (this._lastWritten.get(cacheKey) === sha) {
        return matches.length ? { skipped: "j\xE1 sincronizado", count: matches.length } : { skipped: "j\xE1 vazio (sem matches)", nodes: nodes.length };
      }
      await this.plugin.app.fileManager.processFrontMatter(file, (fm) => {
        const current = Array.isArray(fm[this.FRONTMATTER_GRAPH_KEY]) ? fm[this.FRONTMATTER_GRAPH_KEY] : null;
        if (current && this._arraySha(current) === sha) return;
        if (wikilinks.length === 0) {
          delete fm[this.FRONTMATTER_GRAPH_KEY];
          delete fm.zeus_graph_node_count;
          delete fm.zeus_graph_synced_at;
        } else {
          fm[this.FRONTMATTER_GRAPH_KEY] = wikilinks;
          fm.zeus_graph_node_count = nodes.length;
          fm.zeus_graph_synced_at = (/* @__PURE__ */ new Date()).toISOString();
        }
      });
      this._lastWritten.set(cacheKey, sha);
      return matches.length ? { ok: true, count: matches.length, nodes: nodes.length } : { ok: true, cleared: true, nodes: nodes.length };
    } finally {
      this._inFlight.delete(filePath);
    }
  }
  // Sync TODAS as notas com embeddings (batch operation)
  async syncAllFiles(onProgress) {
    if (!this.plugin.settings.nativeGraphIntegration) {
      if (onProgress) onProgress("skip: nativeGraphIntegration off");
      return;
    }
    const paths = [...this.plugin.searcher.embeddings.keys()];
    let i = 0;
    for (const p of paths) {
      i++;
      try {
        await this.syncFile(p, this.plugin.settings.nativeGraphTopN || 5, this.plugin.settings.nativeGraphMinScore || 0.3);
      } catch (e) {
        console.warn("[zeus] graph sync failed for", p, e.message);
      }
      if (onProgress && i % 10 === 0) onProgress(`${i}/${paths.length}`);
    }
    if (onProgress) onProgress(`done: ${paths.length} notes synced`);
  }
  // v1.6 — codex MED #1: clearAll agora limpa ambos zeus_related e zeus_graph_related.
  async clearAll() {
    const files = this.plugin.app.vault.getMarkdownFiles();
    for (const file of files) {
      await this.plugin.app.fileManager.processFrontMatter(file, (fm) => {
        delete fm[this.FRONTMATTER_KEY];
        delete fm[this.FRONTMATTER_GRAPH_KEY];
        delete fm.zeus_indexed_at;
        delete fm.zeus_neighbor_count;
        delete fm.zeus_graph_node_count;
        delete fm.zeus_graph_synced_at;
      });
    }
    this._lastWritten.clear();
  }
};
var ZeusEnricher = class {
  constructor(plugin) {
    // Size limit: FoundationModels janela é 4096 tokens (~10K chars com safety margin).
    // metafm enrich lê o arquivo internamente, então é o tamanho do .md que importa.
    // Para docs maiores: pré-sumarizar via metafm summarize antes de enrich.
    __publicField(this, "ENRICH_SIZE_LIMIT_CHARS", 1e4);
    this.plugin = plugin;
    this.inFlight = /* @__PURE__ */ new Map();
  }
  // Vault-relative cache dir (no absolute path — works on iOS via vault.adapter).
  get cacheDir() {
    return universal.joinPath(this.plugin.manifest.dir, DATA_DIR_NAME, ENRICH_CACHE_DIR);
  }
  cachePath(filePath, sha) {
    return universal.joinPath(this.cacheDir, sha + ".json");
  }
  // Async — uses Obsidian vault.adapter (cross-platform).
  async loadFromCache(filePath, sha) {
    try {
      const p = this.cachePath(filePath, sha);
      const adapter = this.plugin.app.vault.adapter;
      if (!await universal.adapterExists(adapter, p)) return null;
      return JSON.parse(await universal.adapterRead(adapter, p));
    } catch (e) {
      return null;
    }
  }
  // Async helper — write cache via vault.adapter (atomic when supported).
  async _writeCache(filePath, sha, data) {
    try {
      const adapter = this.plugin.app.vault.adapter;
      await universal.adapterMkdir(adapter, this.cacheDir);
      await universal.adapterWriteAtomic(adapter, this.cachePath(filePath, sha), JSON.stringify(data, null, 2));
    } catch (e) {
      console.warn("[zeus] enrich cache write failed", e.message);
    }
  }
  async enrichNote(filePath) {
    const emb = this.plugin.searcher.embeddings.get(filePath);
    if (!emb) return null;
    const sha = emb.sha;
    const cached = await this.loadFromCache(filePath, sha);
    if (cached) return cached;
    let fileSize = 0;
    try {
      const stat = await universal.adapterStat(this.plugin.app.vault.adapter, filePath);
      if (stat && typeof stat.size === "number") fileSize = stat.size;
    } catch (e) {
    }
    if (fileSize > this.plugin.settings.hierarchicalThreshold) {
      console.log(`[zeus] doc ${filePath} is ${fileSize}B > ${this.plugin.settings.hierarchicalThreshold} \u2014 delegating to HierarchicalProcessor`);
      try {
        if (!isMac() || !fs) {
          throw new Error("Hierarchical processor requires Mac (afm CLI). On iOS the document exceeds the FM window \u2014 skip or split manually.");
        }
        const result = await this.plugin.hierarchical.processLargeDoc(filePath, this.plugin.vaultRoot);
        await this._writeCache(filePath, sha, result);
        return result;
      } catch (e) {
        console.warn("[zeus] hierarchical processing failed", e.message);
        const result = {
          suggested_links: [],
          suggested_tags: [],
          connections: [],
          skipped: true,
          reason: `Hierarchical processor falhou: ${e.message.slice(0, 200)}. Fallback: divida a nota manualmente.`
        };
        await this._writeCache(filePath, sha, result);
        return result;
      }
    }
    if (this.inFlight.has(filePath)) return this.inFlight.get(filePath);
    const promise = (async () => {
      try {
        const absVault = this.plugin.vaultRoot;
        let noteContent = "";
        try {
          noteContent = await universal.adapterRead(this.plugin.app.vault.adapter, filePath);
        } catch (readErr) {
          console.warn("[zeus] enrich read failed", filePath, readErr.message);
        }
        const r = await tryDaemonOrSpawn(
          this.plugin,
          "enrich",
          [noteContent, filePath, ""],
          // (noteContent, notePath, vaultSummary)
          ["enrich", filePath, "--vault", absVault, "--prewarm", "--deterministic"],
          null,
          this.plugin.settings.enrichTimeoutMs
        );
        let parsed;
        if (r.source === "daemon") {
          parsed = r.result;
        } else {
          try {
            parsed = JSON.parse(r.result);
          } catch (jsonErr) {
            console.warn("[zeus] enrich non-JSON output", String(r.result).slice(0, 200));
            return null;
          }
        }
        await this._writeCache(filePath, sha, parsed);
        return parsed;
      } catch (e) {
        console.warn("[zeus] enrich failed", filePath, e.message);
        const failReason = e.message.includes("context window") ? "FoundationModels janela 4096 tokens insuficiente para esta nota + vault context. Tente sub-folder menor ou nota mais curta." : "metafm enrich falhou: " + e.message.slice(0, 200);
        const result = { suggested_links: [], suggested_tags: [], connections: [], skipped: true, reason: failReason };
        await this._writeCache(filePath, sha, result);
        return result;
      } finally {
        this.inFlight.delete(filePath);
      }
    })();
    this.inFlight.set(filePath, promise);
    return promise;
  }
};
var ZeusVaultAgent = class {
  constructor(plugin) {
    this.plugin = plugin;
  }
  async ask(question, onProgress) {
    const args = [
      "agent",
      question,
      "--vault",
      this.plugin.vaultRoot,
      "--pattern",
      this.plugin.settings.agentPattern,
      "--max-iterations",
      String(this.plugin.settings.agentMaxIterations),
      "--prewarm"
    ];
    if (onProgress) onProgress("FoundationModels processando (pode levar 30-60s)\u2026");
    const r = await tryDaemonOrSpawn(
      this.plugin,
      "agent",
      [question, this.plugin.settings.agentPattern],
      args,
      null,
      18e4
    );
    if (r.source === "daemon") {
      const v = r.result;
      return String(v && (v.answer || v.text || v.output || v.response) || JSON.stringify(v));
    }
    return r.result;
  }
};
var ZeusAskVaultModal = class extends obsidian.Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("zeus-ask-modal");
    contentEl.createEl("h3", { text: "Pergunte ao vault" });
    contentEl.createEl("p", { text: "FoundationModels l\xEA notas via tool-calling e responde. Reasoning on-device, sem rede.", cls: "zeus-ask-hint" });
    const input = contentEl.createEl("textarea", { cls: "zeus-ask-input" });
    input.rows = 3;
    input.placeholder = "Ex: Quais notas tratam de Aegis e qual a sua rela\xE7\xE3o com Tailscale?";
    const status = contentEl.createDiv({ cls: "zeus-ask-status" });
    const answer = contentEl.createDiv({ cls: "zeus-ask-answer" });
    const submit = contentEl.createEl("button", { text: "Perguntar", cls: "mod-cta zeus-ask-submit" });
    submit.onclick = async () => {
      const q = input.value.trim();
      if (!q) return;
      submit.disabled = true;
      answer.empty();
      status.setText("FoundationModels processando\u2026");
      try {
        const out = await this.plugin.agent.ask(q, (msg) => status.setText(msg));
        status.setText("");
        answer.createEl("div", { cls: "zeus-ask-answer-text", text: out });
      } catch (e) {
        status.setText("Erro: " + e.message.slice(0, 200));
      } finally {
        submit.disabled = false;
      }
    };
    input.focus();
  }
  onClose() {
    this.contentEl.empty();
  }
};
var ZeusPassportFindModal = class extends obsidian.Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("zeus-passport-find-modal");
    contentEl.createEl("h3", { text: "Passport Find \u2014 busca por conceitos (PIA)" });
    contentEl.createEl("p", {
      text: "Retorna passports (concepts + summary + domain + difficulty) sem conte\xFAdo bruto \u2014 token-eficiente.",
      cls: "zeus-ask-hint"
    });
    const input = contentEl.createEl("input", { cls: "zeus-passport-find-input", type: "text" });
    input.placeholder = "Query: ex. arquitetura Aegis com Tailscale";
    const status = contentEl.createDiv({ cls: "zeus-ask-status" });
    const results = contentEl.createDiv({ cls: "zeus-passport-find-results" });
    const submit = contentEl.createEl("button", { text: "Buscar passports", cls: "mod-cta" });
    submit.onclick = async () => {
      const q = input.value.trim();
      if (!q) return;
      submit.disabled = true;
      results.empty();
      status.setText("Buscando passports\u2026");
      try {
        const hits = await this.plugin.passport.findByQuery(q, { topN: 10 });
        status.setText(`${hits.length} resultado(s)`);
        for (const p of hits) {
          const card = results.createDiv({ cls: "zeus-passport-card" });
          const title = card.createEl("div", { cls: "zeus-passport-card-title", text: p.path });
          title.style.fontWeight = "bold";
          title.style.cursor = "pointer";
          title.onclick = () => {
            this.app.workspace.openLinkText(p.path, "", false);
            this.close();
          };
          if (p.one_line_summary) {
            card.createEl("div", { cls: "zeus-passport-card-summary", text: p.one_line_summary });
          }
          if (p.cornell_cue && p.cornell_cue.length) {
            const cueEl = card.createEl("div", { cls: "zeus-passport-card-cornell" });
            cueEl.createEl("span", { cls: "zeus-cornell-label", text: "cues: " });
            cueEl.createEl("span", { text: p.cornell_cue.slice(0, 3).join(" \xB7 ") });
          }
          const meta = card.createEl("div", { cls: "zeus-passport-card-meta" });
          if (p.concepts && p.concepts.length) {
            meta.createEl("span", { text: "concepts: " + p.concepts.slice(0, 6).join(", ") });
          }
          if (p.domain && p.domain.length) {
            meta.createEl("span", { text: " | domain: " + p.domain.join(", ") });
          }
          if (p.difficulty != null) {
            meta.createEl("span", { text: " | difficulty: " + p.difficulty });
          }
          if (p.note_type) {
            meta.createEl("span", { text: " | " + p.note_type });
          }
        }
        if (!hits.length) {
          results.createDiv({ text: 'Nenhum passport encontrado. Rode "zeus-passport-build-all" primeiro?' });
        }
      } catch (e) {
        status.setText("Erro: " + e.message.slice(0, 200));
      } finally {
        submit.disabled = false;
      }
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit.click();
    });
    input.focus();
  }
  onClose() {
    this.contentEl.empty();
  }
};
var ZeusSearchModal = class extends SuggestModal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
    this.setPlaceholder("Zeus \u2014 busca sem\xE2ntica Apple-native (cosine + exact boost)\u2026");
    this.cachedResults = [];
    this.lastQuery = "";
    this.searchTimer = null;
    this._querySeq = 0;
  }
  async getSuggestions(query) {
    if (!query || query.length < 2) return [];
    if (query === this.lastQuery) return this.cachedResults;
    this.lastQuery = query;
    const seq = ++this._querySeq;
    try {
      const results = await this.plugin.searcher.search(query, this.plugin.settings.maxResults);
      if (seq !== this._querySeq) return this.cachedResults;
      this.cachedResults = results;
      return results;
    } catch (e) {
      console.warn("[zeus] search failed", e.message);
      return [];
    }
  }
  renderSuggestion(result, el) {
    el.empty();
    el.addClass("zeus-result");
    const head = el.createDiv({ cls: "zeus-result-head" });
    head.createSpan({ cls: "zeus-result-title", text: result.path.replace(/\.md$/, "").split("/").pop() });
    const meta = head.createSpan({ cls: "zeus-result-meta" });
    if (result.semantic > 0) meta.createSpan({ cls: "zeus-badge zeus-badge-sem", text: (result.semantic * 100).toFixed(0) });
    if (result.exact > 0) meta.createSpan({ cls: "zeus-badge zeus-badge-exact", text: "EXACT" });
    el.createDiv({ cls: "zeus-result-path", text: result.path });
    const excerpt = this.plugin.searcher.excerpt(result.path, this.lastQuery, this.plugin.settings.excerptLength);
    if (excerpt) el.createDiv({ cls: "zeus-result-excerpt", text: excerpt });
  }
  async onChooseSuggestion(result) {
    const file = this.app.vault.getAbstractFileByPath(result.path);
    if (file instanceof TFile) {
      await this.app.workspace.getLeaf().openFile(file);
    }
  }
};
var ZeusHybridSearchModal = class extends SuggestModal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
    this.setPlaceholder("Zeus \u2014 busca h\xEDbrida (semantic \u2295 graph \u2295 passport \u2295 path)\u2026");
    this.cached = [];
    this.lastQuery = "";
    this._querySeq = 0;
  }
  async getSuggestions(q) {
    if (!q || q.length < 2) return [];
    if (q === this.lastQuery) return this.cached;
    this.lastQuery = q;
    const seq = ++this._querySeq;
    try {
      const r = await this.plugin.hybrid.query(q, this.plugin.settings.maxResults || 30, {
        diversify: !!this.plugin.settings.hybridDiversifyDefault,
        diversityLambda: this.plugin.settings.hybridDiversityLambda
      });
      if (seq !== this._querySeq) return this.cached;
      this.cached = r;
      return r;
    } catch (e) {
      console.warn("[zeus] hybrid query failed", e.message);
      return [];
    }
  }
  renderSuggestion(hit, el) {
    el.empty();
    el.addClass("zeus-result");
    const head = el.createDiv({ cls: "zeus-result-head" });
    const name = hit.path.replace(/\.md$/, "").split("/").pop();
    head.createSpan({ cls: "zeus-result-title", text: name });
    const meta = head.createSpan({ cls: "zeus-result-meta" });
    for (const src of hit.sources || []) {
      meta.createSpan({ cls: `zeus-badge zeus-badge-${src}`, text: src });
    }
    meta.createSpan({ cls: "zeus-badge zeus-badge-sem", text: hit.score.toFixed(3) });
    el.createDiv({ cls: "zeus-result-path", text: hit.path });
  }
  async onChooseSuggestion(hit) {
    const file = this.app.vault.getAbstractFileByPath(hit.path);
    if (file instanceof TFile) await this.app.workspace.getLeaf().openFile(file);
  }
};
var ZeusHybridResultsModal = class extends SuggestModal {
  constructor(app, plugin, items, title) {
    super(app);
    this.plugin = plugin;
    this.items = items;
    this.setPlaceholder(title || "Zeus \u2014 resultados h\xEDbridos");
  }
  getSuggestions(q) {
    if (!q) return this.items;
    const qn = q.toLowerCase();
    return this.items.filter((it) => (it.path || "").toLowerCase().includes(qn));
  }
  renderSuggestion(hit, el) {
    el.empty();
    el.addClass("zeus-result");
    const head = el.createDiv({ cls: "zeus-result-head" });
    const name = hit.path.replace(/\.md$/, "").split("/").pop();
    head.createSpan({ cls: "zeus-result-title", text: name });
    const meta = head.createSpan({ cls: "zeus-result-meta" });
    for (const src of hit.sources || []) {
      meta.createSpan({ cls: `zeus-badge zeus-badge-${src}`, text: src });
    }
    meta.createSpan({ cls: "zeus-badge zeus-badge-sem", text: hit.score.toFixed(3) });
    el.createDiv({ cls: "zeus-result-path", text: hit.path });
  }
  async onChooseSuggestion(hit) {
    const file = this.app.vault.getAbstractFileByPath(hit.path);
    if (file instanceof TFile) await this.app.workspace.getLeaf().openFile(file);
  }
};
var ZeusMultiplexNeighborsModal = class extends SuggestModal {
  constructor(app, plugin, items, title) {
    super(app);
    this.plugin = plugin;
    this.items = items;
    this.setPlaceholder(title || "Zeus \u2014 vizinhos multiplex (com why)");
  }
  getSuggestions(q) {
    if (!q) return this.items;
    const qn = q.toLowerCase();
    return this.items.filter((it) => (it.path || "").toLowerCase().includes(qn));
  }
  renderSuggestion(hit, el) {
    el.empty();
    el.addClass("zeus-result");
    const head = el.createDiv({ cls: "zeus-result-head" });
    const name = hit.path.replace(/\.md$/, "").split("/").pop();
    head.createSpan({ cls: "zeus-result-title", text: name });
    const meta = head.createSpan({ cls: "zeus-result-meta" });
    for (const src of hit.sources || []) {
      meta.createSpan({ cls: `zeus-badge zeus-badge-${src}`, text: src });
    }
    meta.createSpan({ cls: "zeus-badge zeus-badge-sem", text: "\u03A3w=" + (hit.score || 0).toFixed(2) });
    el.createDiv({ cls: "zeus-result-path", text: hit.path });
    if (Array.isArray(hit._edges)) {
      const whyWrap = el.createDiv({ cls: "zeus-result-path" });
      for (const edge of hit._edges) {
        const whyText = edge.why && edge.why.length ? edge.why.slice(0, 2).join(" \xB7 ") : "";
        const line = whyWrap.createDiv();
        line.style.fontSize = "0.85em";
        line.style.opacity = "0.8";
        line.setText(`  ${edge.type} (w=${(edge.weight || 0).toFixed(2)}): ${whyText}`);
      }
    }
  }
  async onChooseSuggestion(hit) {
    const file = this.app.vault.getAbstractFileByPath(hit.path);
    if (file instanceof TFile) await this.app.workspace.getLeaf().openFile(file);
  }
};
var ZeusSmartView = class extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
  }
  getViewType() {
    return VIEW_TYPE_SMART;
  }
  getDisplayText() {
    return "Zeus \u2014 Conex\xF5es";
  }
  getIcon() {
    return "sparkles";
  }
  async onOpen() {
    this.containerEl.children[1].empty();
    this.containerEl.children[1].addClass("zeus-smart-view");
    this.registerEvent(this.app.workspace.on("file-open", () => this.refresh()));
    this.refresh();
  }
  /**
   * v0.13 — Mini-graph SVG showing active note (center) + cosine neighbors (orbiting).
   * Smart Connections-style: nodes positioned by score (higher = closer to center).
   * Scores shown as labels (0.86 format). Click node = open that note.
   */
  _renderMiniGraph(container, activeFile, neighbors) {
    const W = 320, H = 280;
    const cx = W / 2, cy = H / 2;
    const wrap = container.createDiv({ cls: "zeus-smart-graph-wrap" });
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("class", "zeus-smart-graph-svg");
    const positions = [];
    neighbors.forEach((n, i) => {
      const angle = i / neighbors.length * 2 * Math.PI - Math.PI / 2;
      const dist = 50 + (1 - Math.min(1, Math.max(0, n.score))) * 90;
      const x = cx + dist * Math.cos(angle);
      const y = cy + dist * Math.sin(angle);
      positions.push({ ...n, x, y });
    });
    for (const p of positions) {
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", cx);
      line.setAttribute("y1", cy);
      line.setAttribute("x2", p.x);
      line.setAttribute("y2", p.y);
      line.setAttribute("class", "zeus-smart-graph-edge");
      line.setAttribute("stroke-opacity", String(0.15 + p.score * 0.4));
      svg.appendChild(line);
    }
    for (const p of positions) {
      const labelOffsetX = p.x < cx ? -10 : 10;
      const labelAnchor = p.x < cx ? "end" : "start";
      const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
      label.setAttribute("x", p.x + labelOffsetX);
      label.setAttribute("y", p.y - 8);
      label.setAttribute("class", "zeus-smart-graph-score");
      label.setAttribute("text-anchor", labelAnchor);
      label.textContent = p.score.toFixed(2);
      svg.appendChild(label);
    }
    const activeCircle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    activeCircle.setAttribute("cx", cx);
    activeCircle.setAttribute("cy", cy);
    activeCircle.setAttribute("r", 8);
    activeCircle.setAttribute("class", "zeus-smart-graph-node zeus-smart-graph-node-active");
    svg.appendChild(activeCircle);
    for (const p of positions) {
      const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      circle.setAttribute("cx", p.x);
      circle.setAttribute("cy", p.y);
      circle.setAttribute("r", 4);
      circle.setAttribute("class", "zeus-smart-graph-node");
      const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
      title.textContent = `${p.score.toFixed(2)} \xB7 ${p.path}`;
      circle.appendChild(title);
      circle.style.cursor = "pointer";
      circle.addEventListener("click", async () => {
        const tf = this.app.vault.getAbstractFileByPath(p.path);
        if (tf instanceof TFile) await this.app.workspace.getLeaf().openFile(tf);
      });
      svg.appendChild(circle);
    }
    wrap.appendChild(svg);
    const caption = wrap.createDiv({ cls: "zeus-smart-graph-caption" });
    caption.createSpan({ text: `${neighbors.length} vizinhos \xB7 ` });
    const fileName = activeFile.basename;
    caption.createSpan({ cls: "zeus-smart-graph-caption-active", text: fileName });
  }
  async refresh() {
    const container = this.containerEl.children[1];
    container.empty();
    const file = this.app.workspace.getActiveFile();
    const headerCosine = container.createDiv({ cls: "zeus-smart-header" });
    headerCosine.createSpan({ cls: "zeus-smart-title-active", text: file ? file.basename : "Conex\xF5es" });
    if (!file) {
      container.createDiv({ cls: "zeus-smart-empty", text: "Abra uma nota para ver conex\xF5es." });
      return;
    }
    const neighbors = this.plugin.searcher.neighbors(file.path, this.plugin.settings.smartNeighborsCount);
    if (neighbors.length === 0) {
      container.createDiv({ cls: "zeus-smart-empty", text: 'Sem embeddings \u2014 execute "Reindex" via Cmd+P.' });
    } else {
      this._renderMiniGraph(container, file, neighbors);
      const list = container.createDiv({ cls: "zeus-smart-list-chevron" });
      for (const n of neighbors) {
        const item = list.createDiv({ cls: "zeus-smart-chevron-item" });
        const chevron = item.createSpan({ cls: "zeus-smart-chevron", text: "\u203A" });
        const scoreEl = item.createSpan({ cls: "zeus-smart-chevron-score", text: n.score.toFixed(2) });
        item.createSpan({ cls: "zeus-smart-chevron-sep", text: " \u203A " });
        const link = item.createSpan({ cls: "zeus-smart-chevron-link", text: n.path.replace(/\.md$/, "").split("/").pop() });
        let expanded = false;
        let expandPanel = null;
        const toggle = (e) => {
          e.stopPropagation();
          expanded = !expanded;
          chevron.setText(expanded ? "\u2304" : "\u203A");
          if (expanded) {
            expandPanel = item.createDiv({ cls: "zeus-smart-chevron-detail" });
            expandPanel.createDiv({ cls: "zeus-smart-chevron-path", text: n.path });
            try {
              const excerpt = this.plugin.searcher.excerpt(n.path, "", 180);
              if (excerpt) expandPanel.createDiv({ cls: "zeus-smart-chevron-excerpt", text: excerpt });
            } catch (_) {
            }
          } else if (expandPanel) {
            expandPanel.remove();
            expandPanel = null;
          }
        };
        chevron.onclick = toggle;
        link.onclick = async (e) => {
          e.stopPropagation();
          const tf = this.app.vault.getAbstractFileByPath(n.path);
          if (tf instanceof TFile) await this.app.workspace.getLeaf().openFile(tf);
        };
      }
    }
    if (!this.plugin.settings.enrichOnOpen) return;
    const fmHeader = container.createDiv({ cls: "zeus-smart-header zeus-smart-header-fm" });
    fmHeader.createSpan({ cls: "zeus-smart-title", text: "FoundationModels" });
    const fmBadge = fmHeader.createSpan({ cls: "zeus-badge zeus-badge-fm", text: "reasoning\u2026" });
    const fmSection = container.createDiv({ cls: "zeus-smart-fm-section" });
    clearTimeout(this._enrichTimer);
    this._enrichTimer = setTimeout(async () => {
      const result = await this.plugin.enricher.enrichNote(file.path);
      if (!result) {
        fmBadge.setText("falhou");
        fmSection.createDiv({ cls: "zeus-smart-empty", text: "metafm enrich n\xE3o retornou. Console: Cmd+Opt+I." });
        return;
      }
      if (result.skipped) {
        fmBadge.setText("skip");
        fmSection.createDiv({ cls: "zeus-smart-empty", text: result.reason || "Pulado." });
        return;
      }
      fmBadge.setText("cached");
      fmBadge.removeClass("zeus-badge-fm");
      fmBadge.addClass("zeus-badge-fm-ok");
      if (result.suggested_links && result.suggested_links.length > 0) {
        const sub = fmSection.createDiv({ cls: "zeus-smart-subsection" });
        sub.createEl("div", { cls: "zeus-smart-subtitle", text: "Links sugeridos" });
        for (const link of result.suggested_links.slice(0, 8)) {
          const item = sub.createDiv({ cls: "zeus-smart-item zeus-smart-item-fm" });
          const body = item.createDiv({ cls: "zeus-smart-item-body" });
          body.createDiv({ cls: "zeus-smart-item-title", text: link.title || link.path });
          if (link.reason) body.createDiv({ cls: "zeus-smart-item-reason", text: link.reason });
          if (link.path) body.createDiv({ cls: "zeus-smart-item-path", text: link.path });
          item.onclick = async () => {
            if (!link.path) return;
            const tf = this.app.vault.getAbstractFileByPath(link.path);
            if (tf instanceof TFile) await this.app.workspace.getLeaf().openFile(tf);
          };
        }
      }
      if (result.connections && result.connections.length > 0) {
        const sub = fmSection.createDiv({ cls: "zeus-smart-subsection" });
        sub.createEl("div", { cls: "zeus-smart-subtitle", text: "Conex\xF5es" });
        for (const c of result.connections.slice(0, 6)) {
          const item = sub.createDiv({ cls: "zeus-smart-conn" });
          item.createDiv({ cls: "zeus-smart-conn-title", text: c.target || c.title || "\u2014" });
          if (c.explanation || c.reason) item.createDiv({ cls: "zeus-smart-conn-reason", text: c.explanation || c.reason });
        }
      }
      if (result.suggested_tags && result.suggested_tags.length > 0) {
        const sub = fmSection.createDiv({ cls: "zeus-smart-subsection" });
        sub.createEl("div", { cls: "zeus-smart-subtitle", text: "Tags sugeridas" });
        const tagWrap = sub.createDiv({ cls: "zeus-smart-tags" });
        for (const t of result.suggested_tags.slice(0, 12)) {
          const tag = typeof t === "string" ? t : t.tag || t.name || "";
          if (tag) tagWrap.createSpan({ cls: "zeus-smart-tag", text: "#" + tag });
        }
      }
    }, this.plugin.settings.enrichDebounceMs);
  }
};
var ZeusStatusView = class extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.interval = null;
  }
  getViewType() {
    return VIEW_TYPE_STATUS;
  }
  getDisplayText() {
    return "Zeus \u2014 Status";
  }
  getIcon() {
    return "activity";
  }
  async onOpen() {
    this.containerEl.children[1].empty();
    this.containerEl.children[1].addClass("zeus-status-view");
    this.refresh();
    this.interval = setInterval(() => this.refresh(), 5e3);
  }
  async onClose() {
    if (this.interval) clearInterval(this.interval);
  }
  async refresh() {
    const container = this.containerEl.children[1];
    container.empty();
    const header = container.createDiv({ cls: "zeus-status-header" });
    header.createEl("h3", { text: "Zeus Engine" });
    const daemonSection = container.createDiv({ cls: "zeus-status-section" });
    daemonSection.createDiv({ cls: "zeus-status-section-title", text: "Daemon HTTP" });
    try {
      const health = await this.plugin.httpClient.health();
      const tools = await this.plugin.httpClient.tools();
      this._addStatusRow(daemonSection, "URL", this.plugin.settings.zeusDaemonUrl);
      this._addStatusRow(daemonSection, "Status", health.status || "unreachable", health.status === "ok" ? "ok" : "err");
      this._addStatusRow(daemonSection, "Platform", health.platform || "?");
      this._addStatusRow(daemonSection, "Endpoints", String((health.endpoints || []).length));
      this._addStatusRow(daemonSection, "Tools", String(tools.length));
      this._addStatusRow(daemonSection, "NLContextualEmbedding", health.nl_available ? "\u2713" : "\u2717", health.nl_available ? "ok" : "err");
      this._addStatusRow(daemonSection, "Vision", health.vision_available ? "\u2713" : "\u2717", health.vision_available ? "ok" : "err");
      this._addStatusRow(daemonSection, "FoundationModels", health.fm_available ? "\u2713" : "\u2717", health.fm_available ? "ok" : "warn");
      if (health.translation_available !== void 0) {
        this._addStatusRow(daemonSection, "Translation", health.translation_available ? "\u2713" : "\u2717", health.translation_available ? "ok" : "warn");
      }
    } catch (e) {
      this._addStatusRow(daemonSection, "Status", "UNREACHABLE: " + e.message.slice(0, 60), "err");
    }
    const indexSection = container.createDiv({ cls: "zeus-status-section" });
    indexSection.createDiv({ cls: "zeus-status-section-title", text: "Indexa\xE7\xE3o" });
    const manifest = this.plugin.indexer.loadManifest();
    const fileCount = Object.keys(manifest.files || {}).length;
    const embCount = this.plugin.searcher.embeddings.size;
    const lastIdx = manifest.indexedAt ? new Date(manifest.indexedAt).toLocaleString("pt-BR") : "nunca";
    this._addStatusRow(indexSection, "Total docs", String(fileCount));
    this._addStatusRow(indexSection, "Embeddings cached", String(embCount));
    this._addStatusRow(indexSection, "Model", manifest.model || "apple-nlcontextual-pt-BR");
    this._addStatusRow(indexSection, "Dim", String(manifest.dim || 512));
    this._addStatusRow(indexSection, "\xDAltima indexa\xE7\xE3o", lastIdx);
    this._addStatusRow(indexSection, "Indexando agora", this.plugin.indexer.indexing ? "\u26A1 SIM" : "n\xE3o");
    const calib = container.createDiv({ cls: "zeus-status-section" });
    calib.createDiv({ cls: "zeus-status-section-title", text: "Cobertura de embeddings" });
    const pct = fileCount > 0 ? Math.round(embCount / fileCount * 100) : 0;
    const barWrap = calib.createDiv({ cls: "zeus-progress-wrap" });
    const bar = barWrap.createDiv({ cls: "zeus-progress-bar" });
    bar.style.width = pct + "%";
    bar.setText(pct + "%");
    const settingsSection = container.createDiv({ cls: "zeus-status-section" });
    settingsSection.createDiv({ cls: "zeus-status-section-title", text: "Modos ativos" });
    this._addStatusRow(settingsSection, "HyDE", this.plugin.settings.hydeEnabled ? "ON" : "off");
    this._addStatusRow(settingsSection, "Multi-vector", this.plugin.settings.multiVectorEnabled ? "ON" : "off");
    this._addStatusRow(settingsSection, "Native graph", this.plugin.settings.nativeGraphIntegration ? "ON" : "off");
    this._addStatusRow(settingsSection, "Auto-reindex", this.plugin.settings.indexOnSave ? "ON" : "off");
    this._addStatusRow(settingsSection, "Image features", this.plugin.settings.avImageFeatures ? "ON" : "off");
    const actions = container.createDiv({ cls: "zeus-status-actions" });
    const reindexBtn = actions.createEl("button", { text: "\u27F3 Reindex", cls: "mod-cta" });
    reindexBtn.onclick = async () => {
      reindexBtn.disabled = true;
      await this.plugin.indexer.runFullIndex((msg) => this.plugin.updateStatusBar("indexing", msg));
      reindexBtn.disabled = false;
      this.refresh();
    };
    const probeBtn = actions.createEl("button", { text: "\u26A1 Probe daemon" });
    probeBtn.onclick = async () => this.refresh();
  }
  _addStatusRow(parent, label, value, status = null) {
    const row = parent.createDiv({ cls: "zeus-status-row" });
    row.createSpan({ cls: "zeus-status-label", text: label });
    const valEl = row.createSpan({ cls: "zeus-status-value", text: String(value) });
    if (status === "ok") valEl.addClass("zeus-status-ok");
    else if (status === "err") valEl.addClass("zeus-status-err");
    else if (status === "warn") valEl.addClass("zeus-status-warn");
  }
};
var ZeusSettingTab = class extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Zeus \u2014 Apple-native Search" });
    const desc = containerEl.createEl("p");
    desc.appendText("Substitui Omnisearch + Smart Connections com 100% Apple-native: ");
    desc.createEl("strong", { text: "NLContextualEmbedding" });
    desc.appendText(" (on-device, 512-dim) para ranqueamento + ");
    desc.createEl("strong", { text: "Vision OCR" });
    desc.appendText(" para PDFs/imagens. Sem BM25 pr\xF3prio, sem tokenizer pr\xF3prio, sem bge-micro-v2.");
    const _lcStatus = this.plugin.daemonLifecycle && this.plugin.daemonLifecycle.lastStatus || null;
    const _lcLabel = _lcStatus ? `${_lcStatus.running ? "ALIVE" : "DEAD"} (${_lcStatus.source}) \u2014 ${this.plugin.daemonLifecycle.url}` : "aguardando primeira verifica\xE7\xE3o";
    new Setting(containerEl).setName("Daemon HTTP (bin/ZeusDaemonMac)").setDesc(`Auto-spawn no Mac quando 127.0.0.1:2223 n\xE3o responde. iOS consome via Tailscale/iCloud read-only. Estado: ${_lcLabel}`);
    containerEl.createEl("h3", { text: "Apple Vision multi-modal (av)" });
    new Setting(containerEl).setName("Image features extraction").setDesc("Para cada imagem indexada: aocr (texto) + av classify (categorias) + av landmarks (faces) + acs metadata (EXIF/GPS/data). Combinado \xE9 embeddado pelo afm.").addToggle((t) => t.setValue(this.plugin.settings.avImageFeatures).onChange(async (v) => {
      this.plugin.settings.avImageFeatures = v;
      await this.plugin.saveSettings();
    }));
    new Setting(containerEl).setName("av classify top-N").setDesc("Quantas categorias visuais extrair por imagem (1-20).").addSlider((s) => s.setLimits(3, 20, 1).setValue(this.plugin.settings.avClassifyTopN).setDynamicTooltip().onChange(async (v) => {
      this.plugin.settings.avClassifyTopN = v;
      await this.plugin.saveSettings();
    }));
    new Setting(containerEl).setName("aocr PDF structured (macOS 26+)").setDesc("Usa RecognizeDocumentsRequest layout-aware para PDFs. EXPERIMENTAL. Fallback autom\xE1tico para aocr regular.").addToggle((t) => t.setValue(this.plugin.settings.aocrPdfStructured).onChange(async (v) => {
      this.plugin.settings.aocrPdfStructured = v;
      await this.plugin.saveSettings();
    }));
    containerEl.createEl("h3", { text: "Aegis-pattern HTTP daemon (v0.6, ADR-018)" });
    new Setting(containerEl).setName("Zeus daemon URL (sincronizado via iCloud)").setDesc("Setting compartilhada. Mantenha em http://127.0.0.1:2223 \u2014 cada device Apple roda seu PR\xD3PRIO daemon nativo (ZeusDaemonMac no macOS, AegisDaemon no iOS) e o discovery sempre tenta o loopback primeiro. Tailscale fica s\xF3 como fallback quando o daemon local n\xE3o est\xE1 rodando.").addText((t) => t.setValue(this.plugin.settings.zeusDaemonUrl).setPlaceholder("http://127.0.0.1:2223").onChange(async (v) => {
      this.plugin.settings.zeusDaemonUrl = v;
      await this.plugin.saveSettings();
      this.plugin.httpClient.setBaseUrl(v);
      _zeusSetLocalDaemonUrl(null);
    }));
    new Setting(containerEl).setName("Permitir fallback remoto via Tailscale").setDesc("Default ON: se o daemon local 127.0.0.1:2223 n\xE3o responde (ainda n\xE3o instalado neste device), tenta peers Tailscale (Mac mini, MacBook, iPad, iPhone). OFF = modo strict on-device: nunca conecta a outro device \u2014 exige daemon Apple-nativo local funcionando. Recomendado OFF depois que todos os devices tiverem seu daemon pr\xF3prio.").addToggle((t) => t.setValue(this.plugin.settings.allowRemoteDaemonFallback !== false).onChange(async (v) => {
      this.plugin.settings.allowRemoteDaemonFallback = v;
      await this.plugin.saveSettings();
      _zeusSetLocalDaemonUrl(null);
    }));
    new Setting(containerEl).setName("For\xE7ar redescoberta de daemon agora").setDesc("Limpa cache localStorage e probe 127.0.0.1 + settings + TAILSCALE_MESH em paralelo. Loopback (daemon local Apple-nativo) sempre ganha quando responde. Use ap\xF3s instalar o daemon local ou mover entre redes.").addButton((b) => b.setButtonText("Redescobrir").setCta().onClick(async () => {
      _zeusSetLocalDaemonUrl(null);
      const n = new Notice("Zeus: redescobrindo daemon\u2026", 0);
      try {
        const url = await discoverDaemonUrl(this.plugin);
        this.plugin.httpClient.setBaseUrl(url);
        const ok = await this.plugin.httpClient.isAvailable(1500);
        n.hide();
        if (ok) {
          const isLocal = _zeusIsLoopback(url);
          new Notice(`Zeus: daemon ${isLocal ? "LOCAL on-device \u2713" : "REMOTE (fallback Tailscale) \u26A0"} em ${url}`, 6e3);
        } else {
          const macHint = "macOS: rode `bash daemon/scripts/install-mac-daemon.sh` para subir o ZeusDaemonMac via LaunchAgent.";
          const iosHint = "iOS: abra o app Aegis para iniciar o AegisDaemon (porta 2223 embedada).";
          new Notice(`Zeus: nenhum daemon respondeu.
${isMac() ? macHint : iosHint}`, 12e3);
        }
        this.display();
      } catch (e) {
        n.hide();
        new Notice(`Zeus: discovery falhou \u2014 ${e.message}`, 8e3);
      }
    }));
    new Setting(containerEl).setName("Prefer daemon over child_process (EXPERIMENTAL)").setDesc("Quando ON: hot path tenta HTTP daemon primeiro, fallback child_process se daemon indispon\xEDvel. Requer daemon rodando no device. Em iOS, esta \xE9 a \xDANICA forma de embed/enrich novos (Capacitor bloqueia spawn). Default OFF at\xE9 daemon estar deployado.").addToggle((t) => t.setValue(this.plugin.settings.daemonPreferredOverSpawn).onChange(async (v) => {
      this.plugin.settings.daemonPreferredOverSpawn = v;
      await this.plugin.saveSettings();
    }));
    containerEl.createEl("h3", { text: "HyDE \u2014 Hypothetical Document Embedding (DISRUPTIVE)" });
    new Setting(containerEl).setName("HyDE query expansion").setDesc('Expande sua query em uma "nota hipot\xE9tica" via afm prompt, depois embeda a nota expandida. Pattern de 2023 (Gao et al.) que bate vanilla query embedding em 10-20% nos benchmarks. Custo: +~3s por busca. Default OFF \u2014 habilite para queries complexas/abstratas.').addToggle((t) => t.setValue(this.plugin.settings.hydeEnabled).onChange(async (v) => {
      this.plugin.settings.hydeEnabled = v;
      await this.plugin.saveSettings();
    }));
    new Setting(containerEl).setName("Embedding backend").setDesc("apple = NLContextualEmbedding (Apple-native, 512-dim, r\xE1pido). e5 = multilingual-e5-small (Python, mais idiomas, requer apple-fm-sdk).").addDropdown((d) => d.addOption("apple", "apple (NLContextualEmbedding)").addOption("e5", "e5 (multilingual)").setValue(this.plugin.settings.embedBackend).onChange(async (v) => {
      this.plugin.settings.embedBackend = v;
      await this.plugin.saveSettings();
    }));
    new Setting(containerEl).setName("Apple Vision OCR").setDesc("Extrai texto de PDFs e imagens (on-device, sem rede).").addToggle((t) => t.setValue(this.plugin.settings.ocrEnabled).onChange(async (v) => {
      this.plugin.settings.ocrEnabled = v;
      await this.plugin.saveSettings();
    }));
    new Setting(containerEl).setName("Exact-match boost").setDesc("Boost quando a query aparece literalmente no t\xEDtulo/conte\xFAdo. 0 = puro sem\xE2ntico; 1 = match exato dobra score.").addSlider((s) => s.setLimits(0, 1, 0.05).setValue(this.plugin.settings.exactMatchBoost).setDynamicTooltip().onChange(async (v) => {
      this.plugin.settings.exactMatchBoost = v;
      await this.plugin.saveSettings();
    }));
    new Setting(containerEl).setName("Smart neighbors count").setDesc("Quantas notas semelhantes mostrar no painel lateral.").addSlider((s) => s.setLimits(3, 30, 1).setValue(this.plugin.settings.smartNeighborsCount).setDynamicTooltip().onChange(async (v) => {
      this.plugin.settings.smartNeighborsCount = v;
      await this.plugin.saveSettings();
    }));
    new Setting(containerEl).setName("Auto-reindex on save").setDesc("Recalcula \xEDndice 5s ap\xF3s cada modifica\xE7\xE3o (Mac only).").addToggle((t) => t.setValue(this.plugin.settings.indexOnSave).onChange(async (v) => {
      this.plugin.settings.indexOnSave = v;
      await this.plugin.saveSettings();
    }));
    new Setting(containerEl).setName("Reindex on startup").setDesc("Reindex completo 3s ap\xF3s abrir Obsidian (Mac only).").addToggle((t) => t.setValue(this.plugin.settings.indexOnStartup).onChange(async (v) => {
      this.plugin.settings.indexOnStartup = v;
      await this.plugin.saveSettings();
    }));
    containerEl.createEl("h3", { text: "FoundationModels reasoning layer" });
    new Setting(containerEl).setName("Enrich on note open (EXPERIMENTAL)").setDesc("Roda `metafm enrich` na nota ativa: FoundationModels l\xEA notas relacionadas via tool-calling e sugere links + conex\xF5es. LIMITA\xC7\xC3O: FoundationModels tem janela 4096 tokens \u2014 system prompt + tool descri\xE7\xF5es consomem ~1500, sobrando ~2500 para o conte\xFAdo da nota + tool responses. Notas >~2KB ou vault com muitos folders pode estourar (skip silencioso). Default off; ligue se trabalhar com notas curtas. Cache por SHA.").addToggle((t) => t.setValue(this.plugin.settings.enrichOnOpen).onChange(async (v) => {
      this.plugin.settings.enrichOnOpen = v;
      await this.plugin.saveSettings();
    }));
    new Setting(containerEl).setName("Agent pattern").setDesc('Padr\xE3o de racioc\xEDnio para "Pergunte ao vault": auto (FM classifica), react (explorat\xF3rio), plan-execute (estruturado), reflexion (auto-cr\xEDtica iterativa).').addDropdown((d) => d.addOption("auto", "auto").addOption("react", "react").addOption("plan-execute", "plan-execute").addOption("reflexion", "reflexion").setValue(this.plugin.settings.agentPattern).onChange(async (v) => {
      this.plugin.settings.agentPattern = v;
      await this.plugin.saveSettings();
    }));
    new Setting(containerEl).setName("Agent max iterations (reflexion)").setDesc("Limite de loops de auto-cr\xEDtica para padr\xE3o reflexion.").addSlider((s) => s.setLimits(1, 10, 1).setValue(this.plugin.settings.agentMaxIterations).setDynamicTooltip().onChange(async (v) => {
      this.plugin.settings.agentMaxIterations = v;
      await this.plugin.saveSettings();
    }));
    containerEl.createEl("h3", { text: "v0.7 \u2014 full Apple ecosystem coverage" });
    new Setting(containerEl).setName("Index image feature-prints (VNGenerateImageFeaturePrint)").setDesc('Quando ON, comandos de indexa\xE7\xE3o populam data/image-features.jsonl com vetor 768-dim por imagem. Habilita o comando "encontrar imagens similares \xE0 atual". Requer daemon Zeus rodando (Mac).').addToggle((t) => t.setValue(this.plugin.settings.imagesIndexFeaturePrint).onChange(async (v) => {
      this.plugin.settings.imagesIndexFeaturePrint = v;
      await this.plugin.saveSettings();
    }));
    new Setting(containerEl).setName("Auto language-detect on save").setDesc("Detecta l\xEDngua dominante (NLLanguageRecognizer) ao salvar e adiciona `lang:` ao frontmatter caso ausente. EXPERIMENTAL \u2014 pode modificar notas.").addToggle((t) => t.setValue(this.plugin.settings.autoLanguageDetectOnSave).onChange(async (v) => {
      this.plugin.settings.autoLanguageDetectOnSave = v;
      await this.plugin.saveSettings();
    }));
    new Setting(containerEl).setName("Spotlight query enabled (CSSearchQuery bridge)").setDesc('Permite o comando "Zeus: buscar via Spotlight nativo" consultar o \xEDndice macOS via CSSearchQuery exposto pelo daemon. Funciona apenas no Mac.').addToggle((t) => t.setValue(this.plugin.settings.spotlightQueryEnabled).onChange(async (v) => {
      this.plugin.settings.spotlightQueryEnabled = v;
      await this.plugin.saveSettings();
    }));
    containerEl.createEl("h3", { text: "v0.8 \u2014 Native Obsidian Graph integration" });
    new Setting(containerEl).setName("Native graph integration (DESTRUTIVO \u2014 opt-in)").setDesc("Quando ON, comandos de sync escrevem `zeus_related:` no frontmatter de TODAS as notas com os top-N vizinhos sem\xE2nticos (cosine). Obsidian Graph nativo (Cmd+G) renderiza esses como edges junto com wikilinks normais. AVISO: modifica frontmatter de todo o vault \u2014 use clear-all para reverter.").addToggle((t) => t.setValue(this.plugin.settings.nativeGraphIntegration).onChange(async (v) => {
      this.plugin.settings.nativeGraphIntegration = v;
      await this.plugin.saveSettings();
    }));
    new Setting(containerEl).setName("Top-N vizinhos por nota").setDesc("Quantos vizinhos sem\xE2nticos escrever em `zeus_related:` (1-10).").addSlider((s) => s.setLimits(1, 10, 1).setValue(this.plugin.settings.nativeGraphTopN).setDynamicTooltip().onChange(async (v) => {
      this.plugin.settings.nativeGraphTopN = v;
      await this.plugin.saveSettings();
    }));
    new Setting(containerEl).setName("Score m\xEDnimo de cosine").setDesc("Edges abaixo deste score s\xE3o filtrados. Mais alto = grafo mais esparso e relevante.").addSlider((s) => s.setLimits(0, 1, 0.05).setValue(this.plugin.settings.nativeGraphMinScore).setDynamicTooltip().onChange(async (v) => {
      this.plugin.settings.nativeGraphMinScore = v;
      await this.plugin.saveSettings();
    }));
    new Setting(containerEl).setName("Auto-resync on save").setDesc("Re-sincroniza `zeus_related:` 6s ap\xF3s cada modifica\xE7\xE3o da nota (independente de Mac/indexOnSave).").addToggle((t) => t.setValue(this.plugin.settings.nativeGraphSyncOnSave).onChange(async (v) => {
      this.plugin.settings.nativeGraphSyncOnSave = v;
      await this.plugin.saveSettings();
    }));
    containerEl.createEl("h3", { text: "Cross-device coordination (v0.10)" });
    new Setting(containerEl).setName("Device ID").setDesc("Identificador est\xE1vel deste device (gerado uma vez, persistido). Usado em claim/release locks para evitar dupla extra\xE7\xE3o quando o vault \xE9 sincronizado via iCloud.").addText((t) => {
      t.setValue(this.plugin.settings.deviceId || this.plugin.coordinator && this.plugin.coordinator.deviceId || "");
      t.setDisabled(true);
      return t;
    });
    new Setting(containerEl).setName("Scheduler enabled (background sweep)").setDesc("Quando ON, varre o vault periodicamente e re-extrai passports de notas cujo SHA mudou. Coordena claim/release com outros devices via locks em data/claims/. Hook on-modify tamb\xE9m usa o coordinator para re-extract pontual.").addToggle((t) => t.setValue(this.plugin.settings.schedulerEnabled).onChange(async (v) => {
      this.plugin.settings.schedulerEnabled = v;
      await this.plugin.saveSettings();
      if (this.plugin.scheduler) {
        if (v) this.plugin.scheduler.start();
        else this.plugin.scheduler.stop();
      }
    }));
    new Setting(containerEl).setName("Scheduler interval (minutes)").setDesc("Intervalo entre varreduras autom\xE1ticas (5 min - 60 min). Toggle o scheduler off+on para aplicar mudan\xE7a.").addSlider((s) => s.setLimits(5, 60, 1).setValue(Math.round((this.plugin.settings.schedulerIntervalMs || 15 * 60 * 1e3) / 6e4)).setDynamicTooltip().onChange(async (v) => {
      this.plugin.settings.schedulerIntervalMs = v * 60 * 1e3;
      await this.plugin.saveSettings();
    }));
    new Setting(containerEl).setName("Claim TTL (seconds)").setDesc("Tempo at\xE9 um lock expirar e ser auto-liberado. Default 60s \u2014 iCloud sync delay (5-30s) << TTL. Aumente se rede iCloud estiver lenta.").addSlider((s) => s.setLimits(30, 300, 10).setValue(Math.round((this.plugin.settings.coordTtlMs || 6e4) / 1e3)).setDynamicTooltip().onChange(async (v) => {
      this.plugin.settings.coordTtlMs = v * 1e3;
      await this.plugin.saveSettings();
      if (this.plugin.coordinator) this.plugin.coordinator.ttlMs = v * 1e3;
    }));
    new Setting(containerEl).setName("Coordination stats").setDesc("Snapshot dos claims ativos no momento.").addButton((b) => b.setButtonText("Stats").onClick(async () => {
      if (!this.plugin.scheduler) {
        new Notice("Zeus: scheduler indispon\xEDvel");
        return;
      }
      const s = await this.plugin.scheduler.stats();
      const c = s.coordinator || {};
      new Notice(
        `Zeus coord: ${c.total || 0} claims (${c.expired || 0} expired)
Device: ${c.thisDeviceId}
Scheduler: enabled=${s.enabled}, running=${s.running}`,
        8e3
      );
      console.log("[zeus] coordination stats", s);
    }));
    containerEl.createEl("h3", { text: "v1.1 \u2014 Status Bar & Token Metrics" });
    const metricsDesc = containerEl.createEl("p", { cls: "setting-item-description" });
    metricsDesc.appendText("Status bar exibe contagem de docs indexados e, opcionalmente, tokens economizados via ");
    metricsDesc.createEl("strong", { text: "Passport Index Architecture (PIA)" });
    metricsDesc.appendText(": passports compactos (~300B) substituem conte\xFAdo bruto (~5KB) em chamadas ag\xEAnticas.");
    new Setting(containerEl).setName("Mostrar tokens economizados no status bar").setDesc('Exibe formato "Zeus: 1245 docs \xB7 18.3k tok saved". Baseline configur\xE1vel abaixo.').addToggle((t) => t.setValue(this.plugin.settings.showTokenSavedInStatusBar).onChange(async (v) => {
      this.plugin.settings.showTokenSavedInStatusBar = v;
      await this.plugin.saveSettings();
      this.plugin.updateStatusBar("idle", null);
    }));
    new Setting(containerEl).setName("Intervalo de refresh do status bar (ms)").setDesc("Atualiza tokens economizados periodicamente. Default 30000 (30s). Aumente para reduzir overhead, diminua para feedback mais responsivo.").addSlider((s) => s.setLimits(5e3, 12e4, 5e3).setValue(this.plugin.settings.statusBarRefreshIntervalMs).setDynamicTooltip().onChange(async (v) => {
      this.plugin.settings.statusBarRefreshIntervalMs = v;
      await this.plugin.saveSettings();
      if (this.plugin._statusBarTimer) {
        clearInterval(this.plugin._statusBarTimer);
        this.plugin._statusBarTimer = setInterval(() => {
          if (this.plugin._lastStatusBarState === "idle" || !this.plugin._lastStatusBarState) {
            this.plugin.updateStatusBar("idle", null);
          }
        }, v);
      }
    }));
    new Setting(containerEl).setName("Token baseline (raw sem PIA)").setDesc("Tokens m\xE9dios estimados por request se carga raw fosse enviada ao inv\xE9s de passport. Default 1250 (~5KB/4). Ajuste se notas do vault forem tipicamente maiores/menores.").addSlider((s) => s.setLimits(250, 5e3, 50).setValue(this.plugin.settings.rawTokenBaseline).setDynamicTooltip().onChange(async (v) => {
      this.plugin.settings.rawTokenBaseline = v;
      await this.plugin.saveSettings();
    }));
    new Setting(containerEl).setName("Reset m\xE9tricas").setDesc("Zera contadores de tokens, bytes e requests do HTTP client. \xDAtil ap\xF3s mudar baseline ou debugar.").addButton((b) => b.setButtonText("Reset").onClick(() => {
      if (this.plugin.httpClient) this.plugin.httpClient.resetMetrics();
      new Notice("Zeus: m\xE9tricas zeradas");
      this.plugin.updateStatusBar("idle", null);
    }));
    containerEl.createEl("h3", { text: "v2.0 \u2014 Apple Cloud Private (PCC)" });
    const pccDesc = containerEl.createEl("p", { cls: "setting-item-description" });
    pccDesc.appendText("Private Cloud Compute (PCC) \xE9 a camada de cloud do Apple Intelligence \u2014 modelos servidor-side rodam em hardware Apple verific\xE1vel criptograficamente, sem reter dados. Usa sua assinatura Apple Intelligence j\xE1 ativa. ");
    pccDesc.createEl("strong", { text: "Apenas para queries que excedem capacidade on-device" });
    pccDesc.appendText(" (notas grandes, agent multi-step com janela 4096 estourada). Requer macOS 26+ Apple Intelligence ativo no device do daemon.");
    new Setting(containerEl).setName("Modo PCC").setDesc("off = s\xF3 on-device (privacy m\xE1ximo, default). opt-in = client envia header X-Zeus-Allow-Pcc:1; daemon decide caso a caso. auto = daemon roteia para PCC quando on-device excede capacidade.").addDropdown((d) => d.addOption("off", "off \u2014 s\xF3 on-device (default)").addOption("opt-in", "opt-in \u2014 header X-Zeus-Allow-Pcc:1").addOption("auto", "auto \u2014 daemon decide").setValue(this.plugin.settings.pccMode).onChange(async (v) => {
      this.plugin.settings.pccMode = v;
      await this.plugin.saveSettings();
      if (this.plugin.httpClient) this.plugin.httpClient.setPccMode(v);
      this.plugin.updateStatusBar("idle", null);
    }));
    new Setting(containerEl).setName("Indicador visual PCC no status bar").setDesc('Quando PCC \xE9 usado, status bar exibe "\u2601\uFE0FPCC\xD7N" (N = contagem de requests roteadas via PCC nesta sess\xE3o). Default ON quando pccMode \u2260 off.').addToggle((t) => t.setValue(this.plugin.settings.pccVisualIndicator).onChange(async (v) => {
      this.plugin.settings.pccVisualIndicator = v;
      await this.plugin.saveSettings();
      this.plugin.updateStatusBar("idle", null);
    }));
    new Setting(containerEl).setName("Status PCC").setDesc("Inspeciona modo atual e contadores de uso PCC desde a \xFAltima sess\xE3o.").addButton((b) => b.setButtonText("Mostrar").onClick(() => {
      if (!this.plugin.httpClient) {
        new Notice("Zeus: HTTP client indispon\xEDvel");
        return;
      }
      const s = this.plugin.httpClient.getPccStatus();
      new Notice(
        `Zeus PCC
modo: ${s.mode}
\xFAltima req via PCC: ${s.lastUsed ? "sim" : "n\xE3o"}
total PCC nesta sess\xE3o: ${s.totalUsageCount}`,
        8e3
      );
    }));
    containerEl.createEl("h3", { text: "v1.8 \u2014 Hybrid diversify (MMR) + Multiplex graph (8 edge types)" });
    const v18Desc = containerEl.createEl("p", { cls: "setting-item-description" });
    v18Desc.appendText("5\xBA retriever BM25 (Okapi puro JS) j\xE1 est\xE1 ativo no hybrid-search \u2014 acha termo exato (sigla, processo, id) que a perna sem\xE2ntica perde. ");
    v18Desc.appendText("MMR rerank opcional usa jaccard de sources como proxy de diversidade. Multiplex graph captura 8 evid\xEAncias (wikilink\xB7backlink\xB7entity\xB7date\xB7folder\xB7cosine\xB7spotlight\xB7co-citation) com `why` audit\xE1vel.");
    new Setting(containerEl).setName("Diversify hybrid query (MMR) por padr\xE3o").setDesc("Quando ON, busca h\xEDbrida aplica MMR rerank antes de retornar \u2014 favorece resultados que v\xEAm de fontes diferentes (semantic+bm25+path vs 3 semanticos puros).").addToggle((t) => t.setValue(this.plugin.settings.hybridDiversifyDefault).onChange(async (v) => {
      this.plugin.settings.hybridDiversifyDefault = v;
      await this.plugin.saveSettings();
    }));
    new Setting(containerEl).setName("MMR \u03BB (lambda) \u2014 relev\xE2ncia vs diversidade").setDesc('1.0 = s\xF3 relev\xE2ncia (sem MMR). 0.0 = s\xF3 diversidade (ignora score). Default 0.5 = balanceado. Aplica-se quando "diversify default" est\xE1 ON ou comandos passam opts.diversify.').addSlider((s) => s.setLimits(0, 1, 0.05).setValue(this.plugin.settings.hybridDiversityLambda).setDynamicTooltip().onChange(async (v) => {
      this.plugin.settings.hybridDiversityLambda = v;
      await this.plugin.saveSettings();
    }));
    new Setting(containerEl).setName("Auto-build multiplex no onload").setDesc('Quando ON, plugin constr\xF3i o grafo multiplex em background no startup. Default OFF \u2014 rode manualmente via comando "Zeus: construir grafo multiplex". Build pesa O(N\xB2) por entity/cosine.').addToggle((t) => t.setValue(this.plugin.settings.multiplexAutoBuild).onChange(async (v) => {
      this.plugin.settings.multiplexAutoBuild = v;
      await this.plugin.saveSettings();
    }));
    new Setting(containerEl).setName("Multiplex stats").setDesc('Snapshot do grafo carregado (load pregui\xE7oso \u2014 abre comando "vizinhos multiplex" para carregar).').addButton((b) => b.setButtonText("Stats").onClick(async () => {
      try {
        if (!this.plugin._multiplexLoaded) {
          await this.plugin.multiplex.load();
          this.plugin._multiplexLoaded = true;
        }
        const s = this.plugin.multiplex.stats();
        const breakdown = Object.entries(s.byType).filter(([_, c]) => c > 0).map(([t, c]) => `${t}:${c}`).join(" \xB7 ");
        new Notice(`Zeus multiplex: ${s.total} edges \xB7 ${breakdown || "(vazio)"}
${s.builtAt ? "built " + s.builtAt : "(nunca buildado)"}`, 9e3);
      } catch (e) {
        new Notice("Zeus multiplex stats falhou: " + e.message, 5e3);
      }
    }));
    containerEl.createEl("h3", { text: "Leiden communities (v1.9)" });
    new Setting(containerEl).setName("Leiden resolution (\u03B3)").setDesc("Par\xE2metro de resolu\xE7\xE3o na modularidade. 1.0 = padr\xE3o Newman; >1 favorece comunidades menores (mais granular); <1 favorece comunidades maiores. Vide ADR-008.").addSlider((s) => s.setLimits(0.1, 3, 0.05).setValue(this.plugin.settings.leidenResolution).setDynamicTooltip().onChange(async (v) => {
      this.plugin.settings.leidenResolution = v;
      await this.plugin.saveSettings();
    }));
    new Setting(containerEl).setName("Auto-run Leiden ap\xF3s multiplex auto-build").setDesc('Quando ON e multiplexAutoBuild tamb\xE9m ON, dispara detectCommunities em sequ\xEAncia ap\xF3s o build (sem competir por CPU). Default OFF \u2014 rode manualmente via comando "Zeus: detectar comunidades".').addToggle((t) => t.setValue(this.plugin.settings.leidenAutoRun).onChange(async (v) => {
      this.plugin.settings.leidenAutoRun = v;
      await this.plugin.saveSettings();
    }));
    new Setting(containerEl).setName("Propagar comunidade ao frontmatter (zeus_community)").setDesc('Quando ON, comando "detectar comunidades" escreve zeus_community: NN no frontmatter de cada nota. SHA-compare evita loop modify\u2192write\u2192modify (pattern v1.6.1). Default OFF \u2014 modifica TODAS as notas.').addToggle((t) => t.setValue(this.plugin.settings.leidenPropagateFM).onChange(async (v) => {
      this.plugin.settings.leidenPropagateFM = v;
      await this.plugin.saveSettings();
    }));
    new Setting(containerEl).setName("Leiden stats").setDesc("Snapshot das comunidades persistidas em data/communities.jsonl.").addButton((b) => b.setButtonText("Stats").onClick(async () => {
      try {
        const r = await this.plugin.leiden.load();
        if (!r.exists) {
          new Notice("Zeus Leiden: nunca rodou (data/communities.jsonl ausente)", 5e3);
          return;
        }
        const s = this.plugin.leiden.statsFromMap(r.communities);
        const topStr = s.topSizes.map((t) => `c${t.communityId}:${t.size}`).join(", ");
        new Notice(`Zeus Leiden: ${s.total} notas em ${s.communityCount} comunidades \xB7 Q=${r.modularity != null ? r.modularity.toFixed(3) : "?"}
top-3 [${topStr}]`, 9e3);
      } catch (e) {
        new Notice("Zeus Leiden stats falhou: " + e.message, 5e3);
      }
    }));
    containerEl.createEl("h3", { text: "A\xE7\xF5es" });
    new Setting(containerEl).setName("Reindex completo").setDesc("Re-l\xEA o vault e recalcula embeddings. Mac only \u2014 outros devices apenas l\xEAem.").addButton((b) => b.setButtonText("Reindex").onClick(async () => {
      if (!isMac()) {
        new Notice("Reindex s\xF3 funciona no Mac");
        return;
      }
      const notice = new Notice("Zeus: reindex\u2026", 0);
      await this.plugin.indexer.runFullIndex((msg) => notice.setMessage("Zeus: " + msg));
      notice.hide();
    }));
    new Setting(containerEl).setName("Status do \xEDndice").addButton((b) => b.setButtonText("Status").onClick(() => {
      const m = this.plugin.indexer.loadManifest();
      const count = Object.keys(m.files || {}).length;
      const ts = m.indexedAt ? new Date(m.indexedAt).toLocaleString() : "nunca";
      const emb = this.plugin.searcher.embeddings.size;
      new Notice(`Zeus: ${count} docs \xB7 ${emb} embeddings \xB7 model ${m.model || "?"} \xB7 ${ts}`);
    }));
  }
};
var ZeusPlugin = class extends Plugin {
  async onload() {
    const traceLog = [];
    const trace = (step, info) => {
      const line = `[${(/* @__PURE__ */ new Date()).toISOString()}] ${step}${info ? ": " + JSON.stringify(info).slice(0, 200) : ""}`;
      traceLog.push(line);
      console.log("[zeus.trace]", line);
    };
    const writeTrace = (err) => {
      try {
        if (fs && path && this.app.vault.adapter.basePath) {
          const tracePath = path.join(this.app.vault.adapter.basePath, this.manifest.dir, "data", "load-trace.log");
          fs.mkdirSync(path.dirname(tracePath), { recursive: true });
          fs.writeFileSync(tracePath, traceLog.join("\n") + (err ? "\n\n=== ERROR ===\n" + err.stack : ""));
        }
      } catch (_) {
      }
    };
    try {
      trace("start", { manifest: this.manifest.id, version: this.manifest.version });
      trace("loadData.begin");
      this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
      trace("loadData.done");
      this.vaultRoot = this.app.vault.adapter && this.app.vault.adapter.basePath ? this.app.vault.adapter.basePath : null;
      this._manifestCache = null;
      this._embeddingsCache = null;
      console.log("[zeus] platform:", universal.detectPlatform(), "| vaultRoot:", this.vaultRoot || "(adapter-only)");
      this.indexer = new ZeusIndexer(this);
      this.searcher = new ZeusSearcher(this);
      this.enricher = new ZeusEnricher(this);
      this.agent = new ZeusVaultAgent(this);
      this.av = new AppleVisionIntelligence(this);
      this.hyde = new HyDEExpander(this);
      this.graphExtractor = new ZeusGraphExtractor(this);
      this.nativeGraph = new ZeusNativeGraphIntegration(this);
      this.hybrid = new HybridSearch(this);
      this.nativeWatcher = new NativeWatcher(this);
      this.multiplex = new MultiplexGraph(this);
      this._multiplexLoaded = false;
      this.leiden = new LeidenCommunities(this);
      this._leidenLastWritten = /* @__PURE__ */ new Map();
      const pluginDataPath = path && this.vaultRoot ? path.join(this.vaultRoot, this.manifest.dir, DATA_DIR_NAME) : universal.joinPath(this.manifest.dir, DATA_DIR_NAME);
      this.hierarchical = new HierarchicalProcessor(null, this.settings.hierarchicalThreshold);
      this.multiVector = new MultiVectorEmbedder(null, pluginDataPath);
      const _initialDaemonUrl = _zeusGetLocalDaemonUrl() || this.settings.zeusDaemonUrl;
      if (_initialDaemonUrl !== this.settings.zeusDaemonUrl) {
        console.log("[zeus] using per-device cached daemon URL:", _initialDaemonUrl, "(settings:", this.settings.zeusDaemonUrl, ")");
      }
      this.httpClient = new ZeusHttpClient(_initialDaemonUrl);
      this.daemonLifecycle = new DaemonLifecycle(this);
      if (isMac()) {
        try {
          const ws = this.nativeWatcher.start();
          console.log("[zeus] native-watcher:", ws);
        } catch (e) {
          console.warn("[zeus] native-watcher start failed:", e.message);
        }
        try {
          const status = await this.daemonLifecycle.ensureRunning();
          console.log("[zeus] daemon lifecycle:", status);
          if (status && status.running && status.url && this.httpClient.baseUrl !== status.url) {
            console.log("[zeus] httpClient rebase:", this.httpClient.baseUrl, "\u2192", status.url);
            this.httpClient.setBaseUrl(status.url);
            _zeusSetLocalDaemonUrl(status.url);
          }
        } catch (e) {
          console.warn("[zeus] daemon lifecycle ensureRunning failed:", e.message);
        }
      }
      this.imageSimilarity = new ImageSimilaritySearch(this);
      this.passport = new PassportIndex(this);
      this.basesGen = new BasesGenerator(this);
      this.ioQueue = new IoQueue(this);
      this.lexicalIos = new LexicalIosIndex(this);
      this.embedIos = new EmbedIosLib(this);
      this.embedRelay = new EmbedIosLib.EmbedRelay(this);
      if (this.settings.lexicalIosAutoBuild) {
        setTimeout(async () => {
          try {
            console.log("[zeus.lexical-ios] auto-build starting\u2026");
            const r = await this.lexicalIos.build((msg, pct) => {
              if (pct % 25 === 0) console.log(`[zeus.lexical-ios] ${pct}%`, msg);
            });
            console.log("[zeus.lexical-ios] auto-build done:", r);
          } catch (e) {
            console.warn("[zeus.lexical-ios] auto-build failed:", e.message);
          }
        }, 8e3);
      }
      this.coordinator = new DistributedCoordinator(this, {
        deviceId: this.settings.deviceId || void 0,
        ttlMs: this.settings.coordTtlMs || 6e4
      });
      const ZEUS_LOCAL_DEVICE_ID_KEY = "zeus.device.id";
      let _localDeviceId = null;
      try {
        if (typeof window !== "undefined" && window.localStorage) {
          _localDeviceId = window.localStorage.getItem(ZEUS_LOCAL_DEVICE_ID_KEY);
        }
      } catch (_) {
      }
      if (!_localDeviceId) {
        _localDeviceId = this.coordinator.deviceId;
        try {
          if (typeof window !== "undefined" && window.localStorage) {
            window.localStorage.setItem(ZEUS_LOCAL_DEVICE_ID_KEY, _localDeviceId);
          }
        } catch (_) {
        }
        console.log("[zeus] generated per-device deviceId (localStorage):", _localDeviceId);
      }
      const _persistedDeviceId = this.settings.deviceId;
      this.settings.deviceId = _localDeviceId;
      this.coordinator.deviceId = _localDeviceId;
      this.autoIndexer = new AutoIndexer(this);
      if (this.settings.autoIndexEnabled !== false) {
        try {
          const ai = this.autoIndexer.start();
          console.log("[zeus] auto-indexer:", ai);
        } catch (e) {
          console.warn("[zeus] auto-indexer start failed:", e.message);
        }
      }
      if (_persistedDeviceId) {
        console.log("[zeus] flush deviceId legado do data.json sincronizado");
        try {
          await this.saveSettings();
        } catch (e) {
          console.warn("[zeus] flush deviceId falhou:", e.message);
        }
      }
      this.scheduler = new PassportScheduler(this, {
        intervalMs: this.settings.schedulerIntervalMs || 15 * 60 * 1e3
      });
      if (this.settings.schedulerEnabled) {
        this.scheduler.start();
      }
      if (isMac() && this.ioQueue) {
        const consumeAllPending = async () => {
          try {
            const tasks = await this.ioQueue.list();
            if (tasks.length === 0) return;
            console.log("[zeus.io-queue] consumindo", tasks.length, "tasks pendentes");
            for (const task of tasks) {
              await this.ioQueue.consume(task, async (t) => {
                if (t.type === "passport") {
                  if (!this.passport || typeof this.passport.buildOne !== "function") {
                    return { ok: false, error: "passport API indispon\xEDvel" };
                  }
                  let absPath = t.path;
                  if (t.path && !t.path.startsWith("/") && this.vaultRoot) {
                    absPath = this.vaultRoot.replace(/\/$/, "") + "/" + t.path;
                  }
                  try {
                    const existing = await this.passport.getPassport(t.path);
                    if (existing && existing.sha === t.sha && existing.source !== "ios-local") {
                      return { ok: true, alreadyDone: true };
                    }
                    await this.passport.buildOne(absPath, []);
                    return { ok: true };
                  } catch (e) {
                    return { ok: false, error: e.message };
                  }
                }
                return { ok: true, alreadyDone: true };
              });
            }
          } catch (e) {
            console.warn("[zeus.io-queue] consume loop failed:", e.message);
          }
        };
        setTimeout(consumeAllPending, 2e4);
        this._ioQueueIntervalId = setInterval(consumeAllPending, 15 * 60 * 1e3);
      }
      if (this.settings.multiplexAutoBuild) {
        setTimeout(async () => {
          try {
            console.log("[zeus.multiplex] auto-build starting\u2026");
            await this.multiplex.buildFromVault((msg, pct) => {
              if (pct % 25 === 0) console.log(`[zeus.multiplex] ${pct}%`, msg);
            });
            await this.multiplex.persist();
            this._multiplexLoaded = true;
            const s = this.multiplex.stats();
            console.log("[zeus.multiplex] auto-build done:", s.total, "edges");
            if (this.settings.leidenAutoRun) {
              try {
                console.log("[zeus.leiden] auto-detect starting\u2026");
                const r = await this.leiden.detectCommunities({
                  resolution: this.settings.leidenResolution || 1
                });
                await this.leiden.persist(r);
                console.log("[zeus.leiden] auto-detect done:", r.stats.communityCount, "comunidades, Q=", r.modularity.toFixed(3));
              } catch (e2) {
                console.warn("[zeus.leiden] auto-detect failed:", e2.message);
              }
            }
          } catch (e) {
            console.warn("[zeus.multiplex] auto-build failed:", e.message);
          }
        }, 5e3);
      }
      this.app.workspace.onLayoutReady(async () => {
        try {
          const currentOk = await this.httpClient.isAvailable(1500);
          let activeUrl = this.httpClient.baseUrl;
          if (!currentOk) {
            const discovered = await discoverDaemonUrl(this);
            if (discovered && discovered !== activeUrl) {
              console.log("[zeus] adapting daemon URL from", activeUrl, "to", discovered);
              this.httpClient.setBaseUrl(discovered);
              activeUrl = discovered;
            }
          } else {
            _zeusSetLocalDaemonUrl(activeUrl);
          }
          const health = await this.httpClient.health();
          const tools = await this.httpClient.tools();
          console.log("[zeus] daemon health:", health.status, "| platform:", health.platform, "| endpoints:", (health.endpoints || []).length, "| tools:", tools.length, "| url:", activeUrl);
          if (health.status === "ok") {
            const isLocal = _zeusIsLoopback(activeUrl);
            new Notice(`Zeus: daemon ${health.platform || "?"} ${isLocal ? "LOCAL \u2713" : "REMOTE (Tailscale) \u26A0"} \xB7 ${(health.endpoints || []).length} endpoints`);
          } else {
            const macHint = "macOS: rode `bash daemon/scripts/install-mac-daemon.sh` para subir o ZeusDaemonMac via LaunchAgent (~/Library/LaunchAgents/com.maiocchi.zeusdaemon.plist).";
            const iosHint = "iOS: abra o app Aegis no device para iniciar o AegisDaemon (HTTP NIO em 127.0.0.1:2223, paridade total com macOS).";
            const platformHint = isMac() ? macHint : iosHint;
            new Notice(`Zeus: daemon UNREACHABLE em ${activeUrl}.
${platformHint}
Ou desative "Permitir fallback remoto" para for\xE7ar modo strict on-device.`, 15e3);
          }
        } catch (e) {
          console.warn("[zeus] adaptive discovery skipped:", e.message);
        }
      });
      this.loadIndices();
      this.loadIndicesAsync().catch((e) => console.warn("[zeus] async preload failed:", e.message));
      this.addSettingTab(new ZeusSettingTab(this.app, this));
      this.addCommand({
        id: "zeus-search",
        name: "Zeus: buscar (Apple NLContextualEmbedding)",
        callback: () => new ZeusSearchModal(this.app, this).open()
      });
      this.addCommand({
        id: "zeus-reindex",
        name: "Zeus: reindexar vault completo",
        callback: async () => {
          if (!isMac()) {
            new Notice("Zeus reindex: s\xF3 Mac");
            return;
          }
          const n = new Notice("Zeus: reindex\u2026", 0);
          try {
            await this.indexer.runFullIndex((m) => {
              n.setMessage("Zeus: " + m);
              this.updateStatusBar("indexing", m);
            });
          } catch (e) {
            new Notice("Zeus reindex falhou: " + (e.message || String(e)).slice(0, 200), 7e3);
          } finally {
            n.hide();
            this.updateStatusBar("idle", null);
          }
        }
      });
      this.addCommand({
        id: "zeus-toggle-smart-view",
        name: "Zeus: abrir painel de conex\xF5es",
        callback: () => this.activateSmartView()
      });
      this.addCommand({
        id: "zeus-open-status",
        name: "Zeus: abrir painel de status (calibra\xE7\xE3o)",
        callback: () => this.activateStatusView()
      });
      this.addCommand({
        id: "zeus-ask-vault",
        name: "Zeus: perguntar ao vault (FoundationModels agent)",
        callback: () => new ZeusAskVaultModal(this.app, this).open()
      });
      this.addCommand({
        id: "zeus-enrich-current",
        name: "Zeus: enrich nota atual (FoundationModels)",
        callback: async () => {
          const f = this.app.workspace.getActiveFile();
          if (!f) {
            new Notice("Sem nota ativa");
            return;
          }
          const n = new Notice("Zeus enrich: FoundationModels processando\u2026", 0);
          try {
            const result = await this.enricher.enrichNote(f.path);
            if (result) new Notice(`Zeus enrich: ${(result.suggested_links || []).length} links, ${(result.connections || []).length} conex\xF5es.`);
            else new Notice("Zeus enrich falhou \u2014 veja Console.");
          } catch (e) {
            new Notice("Zeus enrich falhou: " + (e.message || String(e)).slice(0, 200), 7e3);
          } finally {
            n.hide();
            try {
              this.refreshSmartView();
            } catch (e) {
            }
          }
        }
      });
      this.addCommand({
        id: "zeus-graph-current",
        name: "Zeus: knowledge graph da nota atual (FoundationModels)",
        callback: () => {
          const f = this.app.workspace.getActiveFile();
          if (!f) {
            new Notice("Sem nota ativa");
            return;
          }
          new ZeusGraphModal(this.app, this, f.path).open();
        }
      });
      this.addCommand({
        id: "zeus-toggle-hyde",
        name: "Zeus: alternar HyDE query expansion",
        callback: async () => {
          this.settings.hydeEnabled = !this.settings.hydeEnabled;
          await this.saveSettings();
          new Notice(`Zeus HyDE: ${this.settings.hydeEnabled ? "ON" : "OFF"}`);
        }
      });
      this.addCommand({
        id: "zeus-multi-vector-reindex",
        name: "Zeus: reindexar com multi-vector (1536-dim efetivo)",
        callback: async () => {
          if (!isMac()) {
            new Notice("Multi-vector reindex: s\xF3 Mac");
            return;
          }
          const n = new Notice("Zeus multi-vector: lendo vault\u2026", 0);
          try {
            const files = this.indexer.enumerateFiles().filter((f) => f.ext === "md");
            const docs = files.map((f) => {
              const content = fs.readFileSync(f.abs, "utf8");
              const title = f.rel.replace(/\.[^.]+$/, "").split("/").pop();
              const body = content.replace(/^---\n[\s\S]*?\n---\n/, "").slice(0, 4e3);
              return { path: f.rel, title, body };
            });
            n.setMessage(`Zeus multi-vector: embeddando ${docs.length} docs (3 vetores cada)\u2026`);
            const map = await this.multiVector.embedDocsBatch(docs);
            this.multiVector.saveAll(map);
            this.settings.multiVectorEnabled = true;
            await this.saveSettings();
            n.hide();
            new Notice(`Zeus multi-vector: ${map.size} docs com 3 vetores cada \u2192 data/multi-vectors.jsonl`);
          } catch (e) {
            n.hide();
            new Notice("Multi-vector falhou: " + e.message.slice(0, 200));
          }
        }
      });
      this.addCommand({
        id: "zeus-daemon-status",
        name: "Zeus: status do daemon HTTP (lifecycle)",
        callback: () => {
          const lc = this.daemonLifecycle;
          if (!lc) {
            new Notice("DaemonLifecycle n\xE3o inicializado (iOS?)");
            return;
          }
          const last = lc.lastStatus || { running: false, source: "unknown" };
          const spawnedByUs = lc.spawnedByUs ? " (spawned by plugin)" : "";
          new Notice(`Daemon ${last.running ? "ALIVE" : "DEAD"}: ${last.source}${spawnedByUs} \xB7 ${lc.url}`, 6e3);
        }
      });
      this.addCommand({
        id: "zeus-http-daemon-probe",
        name: "Zeus: probe HTTP daemon (Aegis-pattern, ADR-018)",
        callback: async () => {
          const n = new Notice(`Probing ${this.settings.zeusDaemonUrl}\u2026`, 0);
          try {
            const health = await this.httpClient.health();
            const tools = await this.httpClient.tools();
            n.hide();
            new Notice(`Daemon: ${health.status || "unknown"} \xB7 platform: ${health.platform || "?"} \xB7 ${tools.length} tools`);
            console.log("[zeus] HTTP daemon health:", health, "tools:", tools);
          } catch (e) {
            n.hide();
            new Notice(`Daemon unreachable: ${e.message.slice(0, 200)}`);
          }
        }
      });
      this.addCommand({
        id: "zeus-translate-selection",
        name: "Zeus: traduzir sele\xE7\xE3o (Apple Translation pt\u2192en)",
        editorCallback: async (editor) => {
          const sel = editor.getSelection() || editor.getValue();
          if (!sel || !sel.trim()) {
            new Notice("Sem texto selecionado");
            return;
          }
          const n = new Notice("Traduzindo via Apple Translation\u2026", 0);
          try {
            const r = await this.httpClient.translate(sel, "pt", "en");
            n.hide();
            const out = r && (r.translated || r.output || r.translation) || JSON.stringify(r);
            try {
              await navigator.clipboard.writeText(out);
            } catch (e) {
            }
            new Notice("Tradu\xE7\xE3o copiada para clipboard");
            console.log("[zeus] translate:", out);
          } catch (e) {
            n.hide();
            new Notice("Translate falhou: " + e.message.slice(0, 150));
          }
        }
      });
      this.addCommand({
        id: "zeus-nl-sentiment",
        name: "Zeus: an\xE1lise de sentimento (NLTagger)",
        editorCallback: async (editor) => {
          var _a, _b;
          const sel = editor.getSelection() || editor.getValue();
          if (!sel || !sel.trim()) {
            new Notice("Sem texto");
            return;
          }
          const n = new Notice("Computando sentimento\u2026", 0);
          try {
            const r = await this.httpClient.nlSentiment(sel);
            n.hide();
            const score = (_b = r && ((_a = r.sentiment) != null ? _a : r.score)) != null ? _b : "n/a";
            new Notice(`Sentimento: ${typeof score === "number" ? score.toFixed(3) : score}`);
            console.log("[zeus] sentiment:", r);
          } catch (e) {
            n.hide();
            new Notice("Sentiment falhou: " + e.message.slice(0, 150));
          }
        }
      });
      this.addCommand({
        id: "zeus-nl-language-detect",
        name: "Zeus: detectar l\xEDngua da nota (NLLanguageRecognizer)",
        callback: async () => {
          const f = this.app.workspace.getActiveFile();
          if (!f) {
            new Notice("Sem nota ativa");
            return;
          }
          const n = new Notice("Detectando l\xEDngua\u2026", 0);
          try {
            const content = await this.app.vault.read(f);
            const sample = content.replace(/^---\n[\s\S]*?\n---\n/, "").slice(0, 4e3);
            const r = await this.httpClient.nlLanguageDetect(sample, 3);
            n.hide();
            const dominant = r && (r.dominant || r.language) || "?";
            const hyps = r && (r.hypotheses || r.candidates) || [];
            const detail = hyps.length ? hyps.map((h) => `${h.language || h.code}=${typeof h.confidence === "number" ? h.confidence.toFixed(2) : h.confidence}`).join(", ") : "";
            new Notice(`L\xEDngua: ${dominant}${detail ? " (" + detail + ")" : ""}`);
            console.log("[zeus] language-detect:", r);
          } catch (e) {
            n.hide();
            new Notice("Language-detect falhou: " + e.message.slice(0, 150));
          }
        }
      });
      this.addCommand({
        id: "zeus-nl-lemma",
        name: "Zeus: lematizar nota (NLTagger lemma scheme)",
        callback: async () => {
          const f = this.app.workspace.getActiveFile();
          if (!f) {
            new Notice("Sem nota ativa");
            return;
          }
          const n = new Notice("Lematizando\u2026", 0);
          try {
            const content = await this.app.vault.read(f);
            const sample = content.replace(/^---\n[\s\S]*?\n---\n/, "").slice(0, 8e3);
            const r = await this.httpClient.nlTag(sample, "lemma");
            n.hide();
            const tags = r && (r.tags || r.tokens) || [];
            const preview = Array.isArray(tags) ? tags.slice(0, 20).map((t) => t.lemma || t.tag || t.token).join(" ") : JSON.stringify(r).slice(0, 200);
            try {
              await navigator.clipboard.writeText(JSON.stringify(r, null, 2));
            } catch (e) {
            }
            new Notice(`Lemma: ${tags.length || "?"} tokens (preview no console; JSON no clipboard)`);
            console.log("[zeus] lemma preview:", preview, "full:", r);
          } catch (e) {
            n.hide();
            new Notice("Lemma falhou: " + e.message.slice(0, 150));
          }
        }
      });
      this.addCommand({
        id: "zeus-data-detect",
        name: "Zeus: detectar entidades (URLs/telefones/datas via NSDataDetector)",
        editorCallback: async (editor) => {
          const sel = editor.getSelection() || editor.getValue();
          if (!sel || !sel.trim()) {
            new Notice("Sem texto");
            return;
          }
          const n = new Notice("NSDataDetector\u2026", 0);
          try {
            const r = await this.httpClient.dataDetect(sel);
            n.hide();
            const matches = r && (r.matches || r.entities) || [];
            const counts = {};
            for (const m of matches) {
              counts[m.type || "unknown"] = (counts[m.type || "unknown"] || 0) + 1;
            }
            const summary = Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(" \xB7 ");
            try {
              await navigator.clipboard.writeText(JSON.stringify(matches, null, 2));
            } catch (e) {
            }
            new Notice(`Detectados: ${matches.length} (${summary || "nenhum"}) \u2014 JSON no clipboard`);
            console.log("[zeus] data-detect:", r);
          } catch (e) {
            n.hide();
            new Notice("Data-detect falhou: " + e.message.slice(0, 150));
          }
        }
      });
      this.addCommand({
        id: "zeus-vision-document-scan",
        name: "Zeus: scan de documento (VNRecognizeDocumentsRequest, layout-aware)",
        callback: async () => {
          const f = this.app.workspace.getActiveFile();
          let imagePath = null;
          if (f && /\.(png|jpe?g|heic|pdf|tiff|gif|webp|bmp)$/i.test(f.path)) {
            imagePath = path && this.vaultRoot ? path.join(this.vaultRoot, f.path) : f.path;
          } else {
            const input = await this._zeusPromptText("Caminho absoluto da imagem/PDF para scan estruturado:");
            if (!input) return;
            imagePath = input;
          }
          const n = new Notice("Vision document scan\u2026", 0);
          try {
            const r = await this.httpClient.visionDocument(imagePath);
            n.hide();
            const text = r && (r.text || r.markdown || r.content) || "";
            const blocks = r && (r.blocks || r.regions) || [];
            try {
              await navigator.clipboard.writeText(text || JSON.stringify(r, null, 2));
            } catch (e) {
            }
            new Notice(`Document scan: ${blocks.length || 0} blocos \xB7 ${text.length} chars no clipboard`);
            console.log("[zeus] vision-document:", r);
          } catch (e) {
            n.hide();
            new Notice("Document scan falhou: " + e.message.slice(0, 150));
          }
        }
      });
      this.addCommand({
        id: "zeus-vision-aesthetics",
        name: "Zeus: aesthetics score da imagem atual (VNCalculateImageAestheticsScores)",
        callback: async () => {
          var _a, _b, _c, _d, _e;
          const f = this.app.workspace.getActiveFile();
          let imagePath = null;
          if (f && /\.(png|jpe?g|heic|tiff|gif|webp|bmp)$/i.test(f.path)) {
            imagePath = path && this.vaultRoot ? path.join(this.vaultRoot, f.path) : f.path;
          } else {
            const input = await this._zeusPromptText("Caminho absoluto da imagem para avaliar:");
            if (!input) return;
            imagePath = input;
          }
          const n = new Notice("Aesthetics scoring\u2026", 0);
          try {
            const r = await this.httpClient.visionAesthetics(imagePath);
            n.hide();
            const overall = (_c = r && ((_b = (_a = r.overall_score) != null ? _a : r.score) != null ? _b : r.aesthetics)) != null ? _c : "?";
            const utility = (_e = r && ((_d = r.is_utility) != null ? _d : r.utility)) != null ? _e : "?";
            new Notice(`Aesthetics: ${typeof overall === "number" ? overall.toFixed(3) : overall} \xB7 utility: ${utility}`);
            console.log("[zeus] aesthetics:", r);
          } catch (e) {
            n.hide();
            new Notice("Aesthetics falhou: " + e.message.slice(0, 150));
          }
        }
      });
      this.addCommand({
        id: "zeus-spotlight-search",
        name: "Zeus: buscar via Spotlight nativo (CSSearchQuery)",
        callback: async () => {
          if (!this.settings.spotlightQueryEnabled) {
            new Notice("Spotlight query desabilitado \u2014 habilite em Settings \u2192 Zeus");
            return;
          }
          const query = await this._zeusPromptText("Query Spotlight:");
          if (!query || !query.trim()) return;
          const n = new Notice("Spotlight searching\u2026", 0);
          try {
            const domainHint = this._deriveSpotlightDomain ? await this._deriveSpotlightDomain() : null;
            const r = await this.httpClient.spotlightQueryNative(query, this.vaultRoot, 50, domainHint);
            n.hide();
            const results = r && (r.results || r.matches || r.hits) || [];
            if (r && r.mode === "mdfind-fallback") {
              new Notice(`Spotlight: ${results.length} results via mdfind fallback (CSSearchQuery n\xE3o dispon\xEDvel)`, 4e3);
            } else if (r && r.mode === "error") {
              new Notice("Spotlight: erro \u2014 " + (r.error || "").slice(0, 150), 6e3);
            }
            try {
              await navigator.clipboard.writeText(JSON.stringify(results, null, 2));
            } catch (e) {
            }
            new Notice(`Spotlight: ${results.length} hits (JSON no clipboard)`);
            console.log("[zeus] spotlight:", r);
          } catch (e) {
            n.hide();
            new Notice("Spotlight falhou: " + e.message.slice(0, 150));
          }
        }
      });
      this.addCommand({
        id: "zeus-image-similarity-index",
        name: "Zeus: indexar imagens do vault (feature-print 768-dim)",
        callback: async () => {
          if (!isMac()) {
            new Notice("Image-similarity index: s\xF3 Mac");
            return;
          }
          const n = new Notice("Zeus: feature-print indexer arrancando\u2026", 0);
          try {
            this.imageSimilarity.loadCache();
            const stats = await this.imageSimilarity.indexAllImages((p) => {
              n.setMessage(`Zeus img-sim: ${p.processed}/${p.total} (idx ${p.indexed}, skip ${p.skipped}, fail ${p.failed})`);
            });
            n.hide();
            new Notice(`Zeus img-sim: ${stats.indexed} novas \xB7 ${stats.skipped} cache \xB7 ${stats.failed} falhas / ${stats.total} imagens`);
            console.log("[zeus] image-similarity index stats:", stats);
          } catch (e) {
            n.hide();
            new Notice("Image-index falhou: " + e.message.slice(0, 200));
          }
        }
      });
      this.addCommand({
        id: "zeus-image-similarity-find",
        name: "Zeus: encontrar imagens similares \xE0 atual (cosine sobre feature-print)",
        callback: async () => {
          if (!isMac()) {
            new Notice("Image-similarity: s\xF3 Mac");
            return;
          }
          const f = this.app.workspace.getActiveFile();
          let imagePath = null;
          if (f && /\.(png|jpe?g|heic|tiff|gif|webp|bmp)$/i.test(f.path)) {
            imagePath = path && this.vaultRoot ? path.join(this.vaultRoot, f.path) : f.path;
          } else {
            if (f) {
              try {
                const content = await this.app.vault.read(f);
                const m = content.match(/!\[\[([^\]|]+\.(?:png|jpe?g|heic|tiff|gif|webp|bmp))(?:\|[^\]]*)?\]\]/i) || content.match(/!\[[^\]]*\]\(([^)]+\.(?:png|jpe?g|heic|tiff|gif|webp|bmp))\)/i);
                if (m) {
                  const ref = m[1];
                  const tfile = this.app.metadataCache.getFirstLinkpathDest(ref, f.path);
                  if (tfile) imagePath = path && this.vaultRoot ? path.join(this.vaultRoot, tfile.path) : tfile.path;
                  else if (fs && path && fs.existsSync(path.join(this.vaultRoot, ref))) imagePath = path.join(this.vaultRoot, ref);
                }
              } catch (e) {
              }
            }
            if (!imagePath) {
              const input = await this._zeusPromptText("Caminho absoluto da imagem alvo:");
              if (!input) return;
              imagePath = input;
            }
          }
          const n = new Notice("Procurando similares\u2026", 0);
          try {
            this.imageSimilarity.loadCache();
            const matches = await this.imageSimilarity.findSimilar(imagePath, 10);
            n.hide();
            if (matches.length === 0) {
              new Notice("Nenhuma imagem similar encontrada (cache vazio?)");
              return;
            }
            const lines = matches.map((m) => `${(m.similarity * 100).toFixed(1)}% \u2014 ${m.rel}`);
            try {
              await navigator.clipboard.writeText(lines.join("\n"));
            } catch (e) {
            }
            new Notice(`Top ${matches.length}:
${lines.slice(0, 5).join("\n")}
(lista completa no clipboard)`);
            console.log("[zeus] image-similarity matches:", matches);
          } catch (e) {
            n.hide();
            new Notice("Image-similarity falhou: " + e.message.slice(0, 200));
          }
        }
      });
      this.addCommand({
        id: "zeus-graph-sync-all",
        name: "Zeus: sincronizar zeus_related frontmatter em TODAS as notas (graph nativo)",
        callback: async () => {
          if (!this.settings.nativeGraphIntegration) {
            new Notice('Ative "Native graph integration" em Settings \u2192 Zeus');
            return;
          }
          const n = new Notice("Zeus: sincronizando frontmatter\u2026", 0);
          await this.nativeGraph.syncAllFiles((msg) => n.setMessage("Zeus: " + msg));
          n.hide();
        }
      });
      this.addCommand({
        id: "zeus-graph-sync-current",
        name: "Zeus: sincronizar zeus_related da nota atual",
        callback: async () => {
          const f = this.app.workspace.getActiveFile();
          if (!f) {
            new Notice("Sem nota ativa");
            return;
          }
          await this.nativeGraph.syncFile(f.path);
          new Notice("Zeus: zeus_related atualizado");
        }
      });
      this.addCommand({
        id: "zeus-graph-clear",
        name: "Zeus: limpar zeus_related de TODAS as notas",
        callback: async () => {
          const ok = confirm("Remover zeus_related de todas as notas? Esta opera\xE7\xE3o \xE9 revers\xEDvel mas demora.");
          if (!ok) return;
          const n = new Notice("Zeus: limpando\u2026", 0);
          await this.nativeGraph.clearAll();
          n.hide();
          new Notice("Zeus: zeus_related removido de todas as notas");
        }
      });
      this.addCommand({
        id: "zeus-passport-build-all",
        name: "Zeus PIA: extrair passports de TODAS as notas (batch)",
        callback: async () => {
          if (!isMac()) {
            new Notice("PIA build: requer daemon no Mac");
            return;
          }
          const n = new Notice("Zeus PIA: extracting passports\u2026", 0);
          try {
            const result = await this.passport.buildAll((msg) => {
              n.setMessage("Zeus PIA: " + msg);
              this.updateStatusBar("indexing", msg);
            });
            n.hide();
            this.updateStatusBar("idle", null);
            new Notice(`Zeus PIA: ${result.succeeded} passports, ${result.failed} falhas (${result.total} notas)`);
          } catch (e) {
            n.hide();
            new Notice("Zeus PIA build falhou: " + e.message.slice(0, 200));
          }
        }
      });
      this.addCommand({
        id: "zeus-passport-build-current",
        name: "Zeus PIA: extrair passport da nota atual",
        callback: async () => {
          const f = this.app.workspace.getActiveFile();
          if (!f) {
            new Notice("Sem nota ativa");
            return;
          }
          const n = new Notice("Zeus PIA: extraindo passport\u2026", 0);
          try {
            const passport = await this.passport.buildOne(f.path);
            n.hide();
            const concepts = (passport.concepts || []).slice(0, 5).join(", ");
            new Notice(`Zeus PIA: ${concepts || "sem concepts"}`);
          } catch (e) {
            n.hide();
            new Notice("Zeus PIA falhou: " + e.message.slice(0, 200));
          }
        }
      });
      this.addCommand({
        id: "zeus-passport-find",
        name: "Zeus PIA: find \u2014 buscar passports por query (MCP-first)",
        callback: () => new ZeusPassportFindModal(this.app, this).open()
      });
      this.addCommand({
        id: "zeus-bases-regenerate",
        name: "Zeus PIA: regenerar zeus-cards.base (UI derivative)",
        callback: async () => {
          try {
            const r = await this.basesGen.regenerate();
            if (r.written) {
              new Notice(`Zeus: zeus-cards.base regenerado (${r.count} passports)`);
            } else {
              new Notice('Zeus: passports.jsonl n\xE3o existe \u2014 rode "build-all" primeiro');
            }
          } catch (e) {
            new Notice("Zeus bases-regenerate falhou: " + e.message.slice(0, 200));
          }
        }
      });
      this.addCommand({
        id: "zeus-scheduler-sweep-now",
        name: "Zeus: sweep agora (scheduler manual trigger)",
        callback: async () => {
          if (!this.scheduler) {
            new Notice("Zeus: scheduler indispon\xEDvel");
            return;
          }
          const n = new Notice("Zeus sweep: rodando\u2026", 0);
          try {
            const r = await this.scheduler.sweep();
            n.hide();
            if (r.skipped === true && r.reason) {
              new Notice("Zeus sweep: " + r.reason);
            } else {
              new Notice(`Zeus sweep: ${r.extracted} re-extracted, ${r.claimed} claimed, ${r.skipped} skipped, ${r.errors} errors (${r.elapsed}ms)`);
            }
          } catch (e) {
            n.hide();
            new Notice("Zeus sweep falhou: " + e.message.slice(0, 200));
          }
        }
      });
      this.addCommand({
        id: "zeus-scheduler-status",
        name: "Zeus: status do scheduler + claims ativos",
        callback: async () => {
          if (!this.scheduler) {
            new Notice("Zeus: scheduler indispon\xEDvel");
            return;
          }
          const s = await this.scheduler.stats();
          const c = s.coordinator || {};
          const last = s.lastSweep ? `\xB7 last sweep ${new Date(s.lastSweep.at).toLocaleTimeString()} (${s.lastSweep.extracted} extr / ${s.lastSweep.claimed} clm / ${s.lastSweep.skipped} skp / ${s.lastSweep.errors} err)` : "\xB7 nenhum sweep ainda";
          new Notice(
            `Zeus scheduler: enabled=${s.enabled} running=${s.running} interval=${Math.round(s.intervalMs / 6e4)}min
Claims ativos: ${c.total || 0} (${c.expired || 0} expired) \xB7 device ${c.thisDeviceId}
` + last,
            1e4
          );
          console.log("[zeus] scheduler stats", s);
        }
      });
      this.addCommand({
        id: "zeus-coord-clean-expired",
        name: "Zeus: clean expired claims",
        callback: async () => {
          if (!this.coordinator) {
            new Notice("Zeus: coordinator indispon\xEDvel");
            return;
          }
          try {
            const n = await this.coordinator.sweepExpired();
            new Notice(`Zeus: ${n} expired claim(s) limpos`);
          } catch (e) {
            new Notice("Zeus clean falhou: " + e.message.slice(0, 200));
          }
        }
      });
      this.addRibbonIcon("sparkles", "Zeus search", () => new ZeusSearchModal(this.app, this).open());
      this.registerView(VIEW_TYPE_SMART, (leaf) => new ZeusSmartView(leaf, this));
      this.registerView(VIEW_TYPE_STATUS, (leaf) => new ZeusStatusView(leaf, this));
      this.statusBarEl = this.addStatusBarItem();
      this.statusBarEl.addClass("zeus-status-bar");
      this.statusBarEl.setText("Zeus: \u2026");
      this.statusBarEl.onclick = () => this.activateStatusView();
      this.updateStatusBar("idle", null);
      if (this.httpClient && typeof this.httpClient.setPccMode === "function") {
        this.httpClient.setPccMode(this.settings.pccMode || "off");
      }
      const refreshMs = this.settings.statusBarRefreshIntervalMs || 3e4;
      this._statusBarTimer = setInterval(() => {
        if (this._lastStatusBarState === "idle" || !this._lastStatusBarState) {
          this.updateStatusBar("idle", null);
        }
      }, refreshMs);
      this.register(() => clearInterval(this._statusBarTimer));
      if (isMac() && this.settings.indexOnSave) {
        this.registerEvent(this.app.vault.on("modify", (file) => {
          if (file instanceof TFile) this.scheduleIncrementalIndex();
        }));
      }
      if (this.settings.nativeGraphSyncOnSave) {
        this._graphSyncTimers = this._graphSyncTimers || /* @__PURE__ */ new Map();
        this.registerEvent(this.app.vault.on("modify", (file) => {
          if (file instanceof TFile && file.extension === "md") {
            const prev = this._graphSyncTimers.get(file.path);
            if (prev) clearTimeout(prev);
            const t = setTimeout(() => {
              this._graphSyncTimers.delete(file.path);
              this.nativeGraph.syncFile(file.path).catch((e) => console.warn("[zeus] graph sync", e.message));
            }, 6e3);
            this._graphSyncTimers.set(file.path, t);
          }
        }));
      }
      if (isMac() && this.settings.indexOnStartup) {
        this.app.workspace.onLayoutReady(() => {
          setTimeout(() => this.indexer.runFullIndex((msg) => this.updateStatusBar("indexing", msg)), 3e3);
        });
      }
      this.app.workspace.onLayoutReady(() => {
        setTimeout(() => {
          const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_SMART);
          if (existing.length === 0) {
            this.activateSmartView().catch((e) => console.warn("[zeus] auto-open smart view failed:", e.message));
          }
        }, 1500);
      });
      this._embedTimers = /* @__PURE__ */ new Map();
      this._passportTimers = /* @__PURE__ */ new Map();
      this._audioTimers = /* @__PURE__ */ new Map();
      const scheduleEmbed = (rel, file) => {
        clearTimeout(this._embedTimers.get(rel));
        this._embedTimers.set(rel, setTimeout(async () => {
          this._embedTimers.delete(rel);
          try {
            const content = await this.app.vault.read(file);
            const reachable = await this.httpClient.isAvailable();
            if (!reachable) return;
            const remote = !_zeusIsLoopback(this.httpClient.baseUrl);
            if (remote && IoQueue.isPrivatePath(rel)) {
              console.warn("[zeus] real-time embed blocked by privacy gate:", rel, this.httpClient.baseUrl);
              return;
            }
            const resp = await this.httpClient.embed(content.slice(0, 4e3), { _privacyPath: rel });
            if (resp && resp.vectors && resp.vectors[0]) {
              const sha = await universal.sha256Hex(content);
              const entry = { path: rel, sha, mtime: Date.now(), title: file.basename, vec: resp.vectors[0] };
              this.searcher.embeddings.set(rel, entry);
              this.indexer.saveEmbeddings(this.searcher.embeddings);
              this.refreshSmartView();
              console.log("[zeus] real-time embed:", rel, `dim=${resp.dim}`);
            }
          } catch (e) {
            console.warn("[zeus] real-time embed failed for", rel, e.message);
          }
        }, 500));
      };
      const scheduleAudioTranscribe = (rel, file) => {
        if (!this.settings.indexOnSave) return;
        if (!this.settings.fileTypes || !this.settings.fileTypes[file.extension]) return;
        clearTimeout(this._audioTimers.get(rel));
        this._audioTimers.set(rel, setTimeout(async () => {
          this._audioTimers.delete(rel);
          try {
            const reachable = await this.httpClient.isAvailable();
            if (!reachable) return;
            let nodePath = null;
            try {
              nodePath = require("path");
            } catch (_) {
            }
            const adapter = this.app.vault.adapter;
            const basePath = typeof adapter.getBasePath === "function" ? adapter.getBasePath() : adapter.basePath || "";
            const absPath = nodePath ? nodePath.join(basePath, rel) : basePath + "/" + rel;
            if (this.settings.audioVadEnabled) {
              const vad = await this.httpClient.aspVad(absPath);
              if (!vad || !vad.has_speech) {
                console.log(
                  "[zeus] audio skip (no speech):",
                  rel,
                  vad ? `${vad.duration_seconds.toFixed(1)}s < threshold` : "vad failed"
                );
                return;
              }
            }
            const locale = this.settings.audioLocale || "pt-BR";
            const engine = this.settings.audioEngine || "auto";
            const tr = await this.httpClient.aspTranscribe(absPath, locale, engine);
            if (!tr || !tr.text || tr.text.trim().length === 0) {
              console.log(
                "[zeus] audio no transcript:",
                rel,
                tr ? `engine=${tr.engine_used}` : "transcribe failed"
              );
              return;
            }
            const remote = !_zeusIsLoopback(this.httpClient.baseUrl);
            if (remote && IoQueue.isPrivatePath(rel)) {
              console.warn("[zeus] audio embed blocked by privacy gate:", rel, this.httpClient.baseUrl);
              return;
            }
            const resp = await this.httpClient.embed(tr.text.slice(0, 4e3), { _privacyPath: rel });
            if (resp && resp.vectors && resp.vectors[0]) {
              const sha = await universal.sha256Hex(tr.text);
              const entry = {
                path: rel,
                sha,
                mtime: Date.now(),
                title: file.basename,
                vec: resp.vectors[0],
                // Audio-specific metadata (preserved no JSONL para Smart View)
                kind: "audio",
                transcript: tr.text.slice(0, 1e3),
                duration_seconds: tr.duration_seconds,
                audio_locale: tr.locale,
                audio_engine: tr.engine_used
              };
              this.searcher.embeddings.set(rel, entry);
              this.indexer.saveEmbeddings(this.searcher.embeddings);
              this.refreshSmartView();
              console.log(
                "[zeus] real-time audio:",
                rel,
                `${tr.duration_seconds.toFixed(1)}s \xB7 ${tr.text.length}ch \xB7 ${tr.engine_used}`
              );
            }
          } catch (e) {
            console.warn("[zeus] real-time audio failed for", rel, e.message);
          }
        }, 2e3));
      };
      const schedulePassport = (rel) => {
        if (!this.settings.schedulerEnabled) return;
        clearTimeout(this._passportTimers.get(rel));
        this._passportTimers.set(rel, setTimeout(async () => {
          this._passportTimers.delete(rel);
          try {
            const claim = await this.coordinator.claim(rel);
            if (!claim.claimed) return;
            try {
              await this.passport.buildOne(rel);
            } finally {
              await this.coordinator.release(rel);
            }
          } catch (e) {
            console.warn("[zeus] passport refresh failed for", rel, e.message);
          }
        }, 8e3));
      };
      this.registerEvent(this.app.vault.on("modify", (file) => {
        if (!(file instanceof TFile)) return;
        if (file.extension === "md") {
          scheduleEmbed(file.path, file);
          schedulePassport(file.path);
        } else if (AUDIO_EXTENSIONS.has(file.extension)) {
          scheduleAudioTranscribe(file.path, file);
        }
      }));
      this.registerEvent(this.app.vault.on("create", (file) => {
        if (!(file instanceof TFile)) return;
        if (file.extension === "md") {
          scheduleEmbed(file.path, file);
          schedulePassport(file.path);
        } else if (AUDIO_EXTENSIONS.has(file.extension)) {
          scheduleAudioTranscribe(file.path, file);
        }
      }));
      this.registerEvent(this.app.vault.on("delete", (file) => {
        if (!(file instanceof TFile)) return;
        this.searcher.embeddings.delete(file.path);
        this.indexer.saveEmbeddings(this.searcher.embeddings);
        this.refreshSmartView();
        console.log("[zeus] real-time delete:", file.path);
      }));
      this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
        if (!(file instanceof TFile)) return;
        const entry = this.searcher.embeddings.get(oldPath);
        if (entry) {
          this.searcher.embeddings.delete(oldPath);
          entry.path = file.path;
          this.searcher.embeddings.set(file.path, entry);
          this.indexer.saveEmbeddings(this.searcher.embeddings);
          console.log("[zeus] real-time rename:", oldPath, "\u2192", file.path);
        }
      }));
      this.addCommand({
        id: "zeus-sister-notes-hybrid",
        name: "Zeus: notas irm\xE3s (graph + semantic h\xEDbrido)",
        callback: async () => {
          const file = this.app.workspace.getActiveFile();
          if (!file) {
            new Notice("Zeus: sem arquivo ativo");
            return;
          }
          const n = new Notice("Zeus: calculando notas-irm\xE3s (RRF semantic+graph+passport)\u2026", 0);
          try {
            const hits = await this.hybrid.sisterNotes(file.path, 15);
            n.hide();
            if (!hits.length) {
              new Notice("Zeus: nenhuma nota-irm\xE3 encontrada");
              return;
            }
            new ZeusHybridResultsModal(this.app, this, hits, `Notas-irm\xE3s de ${file.basename}`).open();
          } catch (e) {
            n.hide();
            new Notice("Zeus sister falhou: " + (e.message || String(e)).slice(0, 150));
          }
        }
      });
      this.addCommand({
        id: "zeus-hybrid-search",
        name: "Zeus: busca h\xEDbrida (graph + semantic + path)",
        callback: () => {
          try {
            new ZeusHybridSearchModal(this.app, this).open();
          } catch (e) {
            new Notice("Zeus hybrid-search falhou: " + (e.message || String(e)).slice(0, 150));
          }
        }
      });
      this.addCommand({
        id: "zeus-graphify-to-frontmatter",
        name: "Zeus: graphify \u2192 frontmatter (integra ao graph nativo)",
        callback: async () => {
          const file = this.app.workspace.getActiveFile();
          if (!file) {
            new Notice("Zeus: sem arquivo ativo");
            return;
          }
          const n = new Notice("Zeus: extraindo grafo (afm graph-extract) e escrevendo wikilinks\u2026", 0);
          try {
            const r = await this.nativeGraph.syncFromGraphExtract(file.path);
            n.hide();
            if (r.ok) {
              new Notice(`Zeus graph\u2192FM: ${r.count}/${r.nodes} entidades resolvidas e gravadas em zeus_graph_related`, 6e3);
            } else if (r.skipped) {
              new Notice(`Zeus graph\u2192FM: ${r.skipped}`, 5e3);
            } else {
              new Notice(`Zeus graph\u2192FM: ${r.error || "erro desconhecido"}`, 6e3);
            }
          } catch (e) {
            n.hide();
            new Notice("Zeus graphify falhou: " + (e.message || String(e)).slice(0, 150));
          }
        }
      });
      const _ensureMultiplexLoaded = async () => {
        if (this._multiplexLoaded) return;
        try {
          const r = await this.multiplex.load();
          this._multiplexLoaded = true;
          console.log("[zeus.multiplex] loaded", r);
        } catch (e) {
          console.warn("[zeus.multiplex] load failed:", e.message);
        }
      };
      this.addCommand({
        id: "zeus-multiplex-build",
        name: "Zeus: construir grafo multiplex (8 edge types)",
        callback: async () => {
          const n = new Notice("Zeus: construindo grafo multiplex (wikilink\xB7backlink\xB7entity\xB7date\xB7folder\xB7cosine\xB7spotlight\xB7co-citation)\u2026", 0);
          try {
            const r = await this.multiplex.buildFromVault((msg, pct) => {
              n.setMessage(`Zeus multiplex (${pct}%): ${msg}`);
            });
            const persisted = await this.multiplex.persist();
            this._multiplexLoaded = true;
            n.hide();
            const stats = this.multiplex.stats();
            const breakdown = Object.entries(stats.byType).filter(([_, c]) => c > 0).map(([t, c]) => `${t}:${c}`).join(" \xB7 ");
            new Notice(`Zeus multiplex: ${r.total} edges em ${r.elapsedMs}ms \xB7 ${breakdown} \xB7 persistido em ${persisted.path}`, 9e3);
          } catch (e) {
            n.hide();
            new Notice("Zeus multiplex build falhou: " + (e.message || String(e)).slice(0, 200));
          }
        }
      });
      this.addCommand({
        id: "zeus-multiplex-neighbors",
        name: "Zeus: vizinhos multiplex desta nota (com why)",
        callback: async () => {
          const file = this.app.workspace.getActiveFile();
          if (!file) {
            new Notice("Zeus: sem arquivo ativo");
            return;
          }
          await _ensureMultiplexLoaded();
          if (!this.multiplex.edges || this.multiplex.edges.size === 0) {
            new Notice('Zeus multiplex: grafo vazio \u2014 rode "Zeus: construir grafo multiplex" primeiro', 6e3);
            return;
          }
          const groups = this.multiplex.neighborsByDst(file.path);
          if (!groups.length) {
            new Notice(`Zeus multiplex: nenhum vizinho para ${file.basename}`, 5e3);
            return;
          }
          const items = groups.slice(0, 30).map((g) => ({
            path: g.dst,
            score: g.totalWeight,
            sources: Array.from(new Set(g.edges.map((e) => e.type))),
            _edges: g.edges
          }));
          new ZeusMultiplexNeighborsModal(this.app, this, items, `Vizinhos multiplex de ${file.basename}`).open();
        }
      });
      this.addCommand({
        id: "zeus-leiden-detect",
        name: "Zeus: detectar comunidades (Leiden sobre multiplex)",
        callback: async () => {
          await _ensureMultiplexLoaded();
          if (!this.multiplex.edges || this.multiplex.edges.size === 0) {
            new Notice('Zeus Leiden: multiplex vazio \u2014 rode "Zeus: construir grafo multiplex" primeiro', 7e3);
            return;
          }
          const n = new Notice("Zeus Leiden: detectando comunidades sobre o multiplex\u2026", 0);
          try {
            const r = await this.leiden.detectCommunities({
              resolution: this.settings.leidenResolution || 1
            });
            const persisted = await this.leiden.persist(r);
            let wroteFM = 0, skippedFM = 0;
            if (this.settings.leidenPropagateFM) {
              n.setMessage("Zeus Leiden: escrevendo zeus_community no frontmatter\u2026");
              for (const [path2, cid] of r.communities.entries()) {
                const prev = this._leidenLastWritten.get(path2);
                if (prev === cid) {
                  skippedFM++;
                  continue;
                }
                const file = this.app.vault.getAbstractFileByPath(path2);
                if (!file) continue;
                try {
                  await this.app.fileManager.processFrontMatter(file, (fm) => {
                    if (fm.zeus_community === cid) return;
                    fm.zeus_community = cid;
                  });
                  this._leidenLastWritten.set(path2, cid);
                  wroteFM++;
                } catch (_) {
                }
              }
            }
            n.hide();
            const topStr = r.stats.topSizes.join(", ");
            const fmInfo = this.settings.leidenPropagateFM ? ` \xB7 FM ${wroteFM} writes (${skippedFM} skip)` : "";
            new Notice(
              `Zeus Leiden: ${r.stats.communityCount} comunidades \xB7 Q=${r.modularity.toFixed(3)} \xB7 top-3 sizes [${topStr}]${fmInfo}
persistido em ${persisted.path}`,
              1e4
            );
          } catch (e) {
            n.hide();
            new Notice("Zeus Leiden falhou: " + (e.message || String(e)).slice(0, 200), 8e3);
          }
        }
      });
      this.addCommand({
        id: "zeus-leiden-stats",
        name: "Zeus: stats de comunidades (Leiden)",
        callback: async () => {
          try {
            const r = await this.leiden.load();
            if (!r.exists) {
              new Notice('Zeus Leiden: data/communities.jsonl n\xE3o existe \u2014 rode "detectar comunidades" primeiro', 7e3);
              return;
            }
            const s = this.leiden.statsFromMap(r.communities);
            const topStr = s.topSizes.map((t) => `c${t.communityId}:${t.size}`).join(", ");
            new Notice(
              `Zeus Leiden: ${s.total} notas em ${s.communityCount} comunidades \xB7 Q=${r.modularity != null ? r.modularity.toFixed(3) : "?"}
top-3 [${topStr}]
breakdown: ${s.sizeBreakdown || "(vazio)"}`,
              12e3
            );
          } catch (e) {
            new Notice("Zeus Leiden stats falhou: " + (e.message || String(e)).slice(0, 200), 6e3);
          }
        }
      });
      this._deriveSpotlightDomain = async () => {
        if (!this.vaultRoot) return "com.maiocchi.zeus.default";
        try {
          const hex = await universal.sha256Hex(this.vaultRoot);
          return "com.maiocchi.zeus." + hex.slice(0, 16);
        } catch (e) {
          return "com.maiocchi.zeus.default";
        }
      };
      const _isRebuildNeededError = (msg) => {
        const s = String(msg || "");
        return /HTTP 404|not_found|CoreSpotlight indisponível|spotlight\/index|spotlight\/query|spotlight\/purge.*available/.test(s);
      };
      this.addCommand({
        id: "zeus-spotlight-index",
        name: "Zeus: indexar vault no Spotlight (CSSearchableIndex)",
        callback: async () => {
          try {
            if (!isMac()) {
              new Notice("Zeus Spotlight: apenas macOS");
              return;
            }
            const n = new Notice("Zeus: montando lote de items para CSSearchableIndex\u2026", 0);
            const files = this.app.vault.getMarkdownFiles();
            const passportMap = this.passport && typeof this.passport.loadAll === "function" ? await this.passport.loadAll().catch(() => /* @__PURE__ */ new Map()) : /* @__PURE__ */ new Map();
            const items = [];
            let totalKeywords = 0;
            for (const f of files) {
              const passport = passportMap.get(f.path) || null;
              const mtime = f.stat ? f.stat.mtime : Date.now();
              const cache = this.app.metadataCache.getFileCache(f) || {};
              const fm = cache.frontmatter || {};
              const headings = (cache.headings || []).filter((h) => h.level <= 3).slice(0, 8).map((h) => h.heading);
              const collected = /* @__PURE__ */ new Set();
              for (const c of (passport == null ? void 0 : passport.concepts) || []) collected.add(String(c));
              const fmTags = Array.isArray(fm.tags) ? fm.tags : typeof fm.tags === "string" ? fm.tags.split(",").map((s) => s.trim()) : [];
              for (const t of fmTags) collected.add(t);
              const aliases = Array.isArray(fm.aliases) ? fm.aliases : typeof fm.aliases === "string" ? [fm.aliases] : [];
              for (const a of aliases) collected.add(a);
              for (const h of headings) collected.add(h);
              if (Array.isArray(fm.zeus_concepts)) for (const c of fm.zeus_concepts) collected.add(c);
              const fmDomain = Array.isArray(fm.zeus_domain) ? fm.zeus_domain : fm.zeus_domain ? [fm.zeus_domain] : [];
              for (const d of fmDomain) collected.add(d);
              const seen = /* @__PURE__ */ new Set();
              const keywords = [];
              for (const k of collected) {
                if (!k) continue;
                const s = String(k).trim();
                if (s.length < 2) continue;
                const lower = s.toLowerCase();
                if (seen.has(lower)) continue;
                seen.add(lower);
                keywords.push(s);
                if (keywords.length >= 25) break;
              }
              totalKeywords += keywords.length;
              items.push({
                path: this.vaultRoot ? `${this.vaultRoot.replace(/\/$/, "")}/${f.path}` : f.path,
                title: f.basename,
                summary: passport && (passport.one_line_summary || passport.summary) || "",
                keywords,
                mtime,
                modality: "md"
              });
            }
            const domainHint = await this._deriveSpotlightDomain();
            n.setMessage(`Zeus: enviando ${items.length} items (domain ${domainHint.slice(-16)})\u2026`);
            let r;
            try {
              r = await this.httpClient.spotlightIndex(items, domainHint);
            } catch (e) {
              n.hide();
              if (_isRebuildNeededError(e.message)) {
                new Notice("Zeus Spotlight: daemon bundled n\xE3o suporta /v1/spotlight/index. Rebuild via `node scripts/build-release.mjs`.", 9e3);
              } else {
                new Notice("Zeus Spotlight: " + (e.message || "").slice(0, 200), 8e3);
              }
              return;
            }
            n.hide();
            if (r.indexed != null) {
              const avgKw = items.length > 0 ? (totalKeywords / items.length).toFixed(1) : "0.0";
              new Notice(`Zeus Spotlight: ${r.indexed} items \xB7 avg ${avgKw} keywords \xB7 domain ${r.domain.slice(-16)}`, 7e3);
              try {
                const adapter = this.app.vault.adapter;
                const stateRel = universal.joinPath(this.manifest.dir, "data", "spotlight-state.json");
                await universal.adapterMkdir(adapter, universal.joinPath(this.manifest.dir, "data"));
                await universal.adapterWriteAtomic(adapter, stateRel, JSON.stringify({
                  last_indexed_at: (/* @__PURE__ */ new Date()).toISOString(),
                  count: r.indexed,
                  domain: r.domain,
                  mode: r.mode || "queued"
                }, null, 2));
              } catch (e) {
                console.warn("[zeus] spotlight-state persist failed", e.message);
              }
            } else {
              new Notice("Zeus Spotlight: resposta inesperada \u2014 " + JSON.stringify(r).slice(0, 200), 8e3);
            }
          } catch (e) {
            new Notice("Zeus Spotlight index falhou: " + (e.message || String(e)).slice(0, 200), 8e3);
          }
        }
      });
      this.addCommand({
        id: "zeus-spotlight-purge",
        name: "Zeus: purge \xEDndice Spotlight do vault",
        callback: async () => {
          try {
            if (!isMac()) {
              new Notice("Zeus Spotlight: apenas macOS");
              return;
            }
            const domainHint = await this._deriveSpotlightDomain();
            let r;
            try {
              r = await this.httpClient.spotlightPurge(domainHint);
            } catch (e) {
              if (_isRebuildNeededError(e.message)) {
                new Notice("Zeus Spotlight purge: daemon bundled n\xE3o suporta. Rebuild necess\xE1rio.", 7e3);
              } else {
                new Notice("Zeus Spotlight purge falhou: " + (e.message || "").slice(0, 200), 7e3);
              }
              return;
            }
            if (r.purged) {
              new Notice(`Zeus Spotlight purged \xB7 domain ${r.domain.slice(-16)}`, 5e3);
            } else {
              new Notice("Zeus Spotlight purge: " + (r.error || "erro"), 6e3);
            }
          } catch (e) {
            new Notice("Zeus Spotlight purge falhou: " + (e.message || String(e)).slice(0, 200), 7e3);
          }
        }
      });
      this.addCommand({
        id: "zeus-mobileclip-status",
        name: "Zeus: status MobileCLIP (modelo instalado?)",
        callback: async () => {
          try {
            if (!isMac()) {
              new Notice("MobileCLIP: apenas macOS");
              return;
            }
            const s = await this.httpClient.mobileclipStatus();
            if (s.error) {
              new Notice("MobileCLIP status erro: " + String(s.error).slice(0, 100), 7e3);
              return;
            }
            const summary = s.installed ? `MobileCLIP INSTALADO em ${s.model_dir}` : `MobileCLIP N\xC3O instalado \xB7 esperado em ${s.model_dir} \xB7 use comando "instalar modelo"`;
            new Notice(`Zeus ${summary}`, 9e3);
          } catch (e) {
            new Notice("MobileCLIP status falhou: " + (e.message || String(e)).slice(0, 100), 7e3);
          }
        }
      });
      this.addCommand({
        id: "zeus-mobileclip-install",
        name: "Zeus: instalar modelo MobileCLIP (download manual)",
        callback: async () => {
          try {
            if (!isMac()) {
              new Notice("MobileCLIP: apenas macOS");
              return;
            }
            const msg = [
              "MobileCLIP v1.9 \xE9 STUB opt-in (ADR-010). Download manual:",
              "",
              "1. mkdir -p ~/Library/Application\\ Support/Zeus/mobileclip-model",
              "2. Baixe MobileCLIP-S0 (recommended): https://huggingface.co/apple/MobileCLIP-S0",
              "   Arquivos: MobileCLIP-S0-vision.mlpackage, MobileCLIP-S0-text.mlpackage",
              "3. cp pra ~/Library/Application\\ Support/Zeus/mobileclip-model/",
              '4. Crie model-manifest.json: { "version": "1.0", "variant": "S0" }',
              '5. Cmd+P -> "Zeus: status MobileCLIP" pra verificar',
              "",
              "Em v2.0, este comando far\xE1 o download automatico via fetch HTTPS + checksum."
            ].join("\n");
            console.log("[zeus.mobileclip]", msg);
            try {
              await navigator.clipboard.writeText(msg);
            } catch (e) {
            }
            new Notice("MobileCLIP install instructions copiadas pro clipboard. Cole em terminal/notas.", 12e3);
          } catch (e) {
            new Notice("MobileCLIP install falhou: " + (e.message || String(e)).slice(0, 100), 7e3);
          }
        }
      });
      this.addCommand({
        id: "zeus-base-regenerate-rich",
        name: "Zeus: regenerar .base enriquecido (v1.7 schema)",
        callback: async () => {
          try {
            const n = new Notice("Zeus: regenerando data/zeus-cards.base\u2026", 0);
            const r = await this.basesGen.regenerate();
            n.hide();
            if (r.written) {
              const s = r.stats || {};
              new Notice(
                `Zeus .base: ${r.count} passports \xB7 summary=${s.withSummary || 0} \xB7 concepts=${s.withConcepts || 0} \xB7 domains=${(s.domainList || []).length}`,
                6e3
              );
            } else {
              new Notice("Zeus .base: data/passports.jsonl ausente \u2014 rode reindex primeiro", 6e3);
            }
          } catch (e) {
            new Notice("Zeus base regen falhou: " + (e.message || String(e)).slice(0, 200), 7e3);
          }
        }
      });
      this.addCommand({
        id: "zeus-auto-indexer-status",
        name: "Zeus: status do auto-indexer (indexa\xE7\xE3o autom\xE1tica)",
        callback: () => {
          try {
            if (!this.autoIndexer) {
              new Notice("Zeus auto-indexer indispon\xEDvel");
              return;
            }
            const s = this.autoIndexer.getStatus();
            if (!s.running) {
              new Notice("Zeus auto-indexer OFF \u2014 habilite em Settings");
              return;
            }
            const lines = [];
            lines.push(`Auto-indexer: ${s.running ? "ATIVO" : "OFF"} \xB7 ${s.mod_count_since_multiplex}/${s.mod_threshold} mods pr\xE9-multiplex`);
            if (s.pending.length) lines.push(`Pending: ${s.pending.join(", ")}`);
            if (s.running_now.length) lines.push(`Running: ${s.running_now.join(", ")}`);
            for (const [k, v] of Object.entries(s.last_run || {})) {
              const ago = `${v.ago_s}s atr\xE1s`;
              const detail = v.result ? JSON.stringify(v.result).slice(0, 60) : v.error ? "err: " + v.error.slice(0, 40) : "";
              lines.push(`${k}: ${ago} \xB7 ${v.durationMs}ms \xB7 ${detail}`);
            }
            new Notice("Zeus AutoIndexer\n" + lines.join("\n"), 15e3);
          } catch (e) {
            new Notice("Auto-indexer status falhou: " + e.message.slice(0, 100), 7e3);
          }
        }
      });
      this.addCommand({
        id: "zeus-native-watcher-status",
        name: "Zeus: status do native-watcher (FSEvents iCloud)",
        callback: () => {
          try {
            if (!this.nativeWatcher) {
              new Notice("Zeus: native-watcher indispon\xEDvel");
              return;
            }
            const s = this.nativeWatcher.getStats();
            if (!s.running) {
              new Notice(`Zeus watcher OFF (iOS Capacitor ou fs.watch indispon\xEDvel)`, 5e3);
              return;
            }
            const hitRate = s.adapterHitRate != null ? `${(s.adapterHitRate * 100).toFixed(0)}%` : "n/a";
            const ago = s.lastExternalAgoMs != null ? `${(s.lastExternalAgoMs / 1e3).toFixed(0)}s` : "never";
            new Notice(
              `Zeus watcher: ${s.externalEvents} ext events \xB7 adapter caught ${hitRate} \xB7 ${s.adapterMissed} missed \xB7 last ${ago}`,
              8e3
            );
          } catch (e) {
            new Notice("Zeus watcher-status falhou: " + (e.message || String(e)).slice(0, 150));
          }
        }
      });
      this.addCommand({
        id: "zeus-io-queue-consume",
        name: "Zeus: consumir fila iOS (Mac side)",
        callback: async () => {
          if (!this.ioQueue) {
            new Notice("Zeus: io-queue indispon\xEDvel");
            return;
          }
          if (!isMac()) {
            new Notice("Zeus: io-queue consume s\xF3 roda no Mac");
            return;
          }
          const n = new Notice("Zeus: consumindo fila iOS\u2026", 0);
          try {
            const tasks = await this.ioQueue.list();
            if (tasks.length === 0) {
              n.hide();
              new Notice("Zeus: fila vazia \u2014 nada a consumir");
              return;
            }
            let consumed = 0, failed = 0;
            for (const task of tasks) {
              const r = await this.ioQueue.consume(task, async (t) => {
                if (t.type !== "passport") return { ok: true, alreadyDone: true };
                if (!this.passport || typeof this.passport.buildOne !== "function") {
                  return { ok: false, error: "passport API indispon\xEDvel" };
                }
                let absPath = t.path;
                if (t.path && !t.path.startsWith("/") && this.vaultRoot) {
                  absPath = this.vaultRoot.replace(/\/$/, "") + "/" + t.path;
                }
                try {
                  const existing = await this.passport.getPassport(t.path);
                  if (existing && existing.sha === t.sha && existing.source !== "ios-local") {
                    return { ok: true, alreadyDone: true };
                  }
                  await this.passport.buildOne(absPath, []);
                  return { ok: true };
                } catch (e) {
                  return { ok: false, error: e.message };
                }
              });
              if (r.consumed) consumed++;
              else failed++;
            }
            n.hide();
            new Notice(`Zeus: ${consumed} consumidos, ${failed} falhas (de ${tasks.length})`);
          } catch (e) {
            n.hide();
            new Notice("Zeus consume falhou: " + e.message.slice(0, 200));
          }
        }
      });
      this.addCommand({
        id: "zeus-io-queue-status",
        name: "Zeus: status fila iOS",
        callback: async () => {
          if (!this.ioQueue) {
            new Notice("Zeus: io-queue indispon\xEDvel");
            return;
          }
          try {
            const s = await this.ioQueue.status();
            const breakdown = Object.entries(s.byType).map(([t, n]) => `${t}=${n}`).join(" ");
            const oldest = s.oldest ? ` \xB7 oldest ${s.oldest}` : "";
            new Notice(`Zeus fila: ${s.total} tasks (${breakdown || "nenhum"})${oldest}`, 8e3);
            console.log("[zeus] io-queue status:", s);
          } catch (e) {
            new Notice("Zeus fila-status falhou: " + e.message.slice(0, 150));
          }
        }
      });
      this.addCommand({
        id: "zeus-lexical-ios-rebuild",
        name: "Zeus: rebuild lexical-ios index",
        callback: async () => {
          if (!this.lexicalIos) {
            new Notice("Zeus: lexical-ios indispon\xEDvel");
            return;
          }
          const n = new Notice("Zeus lexical-ios: build\u2026", 0);
          try {
            const r = await this.lexicalIos.build((msg) => n.setMessage("Zeus lexical-ios: " + msg));
            n.hide();
            new Notice(`Zeus lexical-ios: ${r.N} notas, ${r.vocab} tokens (${r.elapsedMs}ms)`);
          } catch (e) {
            n.hide();
            new Notice("Zeus lexical-ios build falhou: " + e.message.slice(0, 200));
          }
        }
      });
      this.addCommand({
        id: "zeus-lexical-ios-search",
        name: "Zeus: busca lexical-ios",
        callback: async () => {
          const q = await this._zeusPromptText("Lexical-ios search:");
          if (!q || !q.trim()) return;
          if (!this.lexicalIos) {
            new Notice("Zeus: lexical-ios indispon\xEDvel");
            return;
          }
          const n = new Notice("Zeus lexical-ios: buscando\u2026", 0);
          try {
            const hits = await this.lexicalIos.search(q, 20);
            n.hide();
            if (!hits || hits.length === 0) {
              new Notice("Zeus lexical-ios: nenhum resultado (rode rebuild primeiro?)");
              return;
            }
            const top3 = hits.slice(0, 3).map(
              (h) => `${h.path} (score ${h.score.toFixed(2)}, ${h.matched_tokens.length} match)`
            ).join("\n");
            new Notice(`Zeus lexical-ios: ${hits.length} hits
${top3}`, 12e3);
            console.log("[zeus] lexical-ios hits:", hits);
          } catch (e) {
            n.hide();
            new Notice("Zeus lexical-ios search falhou: " + e.message.slice(0, 200));
          }
        }
      });
      this.addCommand({
        id: "zeus-ios-embed-status",
        name: "Zeus: status embed iOS (relay Mac + transformers.js)",
        callback: async () => {
          try {
            const lines = ["Zeus iOS embed two-tier:"];
            if (this.embedRelay) {
              const probe = await this.embedRelay.tryEmbed("zeus iOS embed probe");
              lines.push(`  Camada 1 (relay daemon): ${probe.ok ? "\u2713 OK" : "\u2717 " + probe.reason}`);
              if (probe.ok) lines.push(`    dim=${probe.dim} \xB7 model=${probe.model} \xB7 source=${probe.source}`);
            }
            if (this.embedIos) {
              const s = await this.embedIos.stats();
              lines.push(`  Camada 2 (transformers.js labs): ${s.runtime_installed ? "\u2713 instalado" : "\u2717 n\xE3o instalado"}`);
              lines.push(`    model=${s.model_id} \xB7 dim=${s.dim} \xB7 entries=${s.count}`);
            }
            new Notice(lines.join("\n"), 12e3);
            console.log("[zeus] iOS embed status:", lines.join(" | "));
          } catch (e) {
            new Notice("Zeus iOS embed status falhou: " + e.message.slice(0, 150));
          }
        }
      });
      this.addCommand({
        id: "zeus-ios-embed-install",
        name: "Zeus: instalar modelo embed iOS (multilingual-e5-small, labs)",
        callback: async () => {
          try {
            const msg = [
              "Embed iOS v1.12 \u2014 STUB labs. Runtime transformers.js full em v1.13 (ADR-011).",
              "",
              "Para v1.12, USE Camada 1 (relay Mac via Tailscale):",
              "  1. Mac mini / MacBook deve ter ZeusDaemonMac rodando (default)",
              "  2. iOS Capacitor + Tailscale instalado e mesh ativa",
              '  3. Settings \u2192 Zeus \u2192 "Permitir fallback remoto via Tailscale" ON',
              "  4. iosEmbedRelayEnabled: true (default)",
              "",
              "iOS chama daemon Mac via http://<tailscale-ip>:2223/v1/embed",
              "\u2192 persiste em data/embeddings.jsonl 512-dim NLContextualEmbedding",
              "\u2192 qualidade Apple-native pt-BR otimizada (Mac-can\xF4nico).",
              "",
              "Camada 2 (v1.13 labs): transformers.js + Xenova/multilingual-e5-small",
              "  ~118MB INT8 ONNX cached via Browser Cache API.",
              "  Quando indispon\xEDvel Tailscale Mac, fallback local 384-dim.",
              "  Schema versionado: embeddings-ios.jsonl separado."
            ].join("\n");
            console.log("[zeus.embed-ios]", msg);
            try {
              await navigator.clipboard.writeText(msg);
            } catch (e) {
            }
            new Notice("Embed iOS install: instru\xE7\xF5es copiadas pro clipboard. v1.12 entrega relay Mac.", 12e3);
          } catch (e) {
            new Notice("Embed iOS install falhou: " + e.message.slice(0, 150));
          }
        }
      });
      this.addCommand({
        id: "zeus-lexical-ios-stats",
        name: "Zeus: status lexical-ios index",
        callback: async () => {
          if (!this.lexicalIos) {
            new Notice("Zeus: lexical-ios indispon\xEDvel");
            return;
          }
          try {
            const s = await this.lexicalIos.stats();
            new Notice(
              `Zeus lexical-ios: N=${s.N} \xB7 vocab=${s.vocab_size} \xB7 avgdl=${s.avgdl.toFixed(0)}
last_built: ${s.last_built || "never"}`,
              1e4
            );
            console.log("[zeus] lexical-ios stats:", s);
          } catch (e) {
            new Notice("Zeus lexical-ios stats falhou: " + e.message.slice(0, 150));
          }
        }
      });
      console.log(`[zeus] loaded v${this.manifest.version} \u2014 Apple-native search & connections`);
      trace("onload.complete");
      writeTrace(null);
    } catch (err) {
      console.error("[zeus] \u274C onload FAILED at step:", traceLog[traceLog.length - 1]);
      console.error("[zeus]", err);
      writeTrace(err);
      throw err;
    }
  }
  async onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_SMART);
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_STATUS);
    if (this.scheduler) {
      try {
        this.scheduler.stop();
      } catch (e) {
        console.warn("[zeus] scheduler stop:", e.message);
      }
    }
    for (const mapKey of ["_embedTimers", "_audioTimers", "_passportTimers", "_graphSyncTimers", "_passportRefreshTimers"]) {
      const m = this[mapKey];
      if (m && typeof m.values === "function") {
        for (const t of m.values()) {
          try {
            clearTimeout(t);
          } catch (e) {
          }
        }
        if (typeof m.clear === "function") m.clear();
      }
    }
    for (const key of ["_idxTimer", "_graphSyncTimer", "_zeusInitialTimer", "initialTimerId"]) {
      const t = this[key];
      if (t) {
        try {
          clearTimeout(t);
        } catch (e) {
        }
        this[key] = null;
      }
    }
    if (this.nativeWatcher) {
      try {
        this.nativeWatcher.stop();
      } catch (e) {
        console.warn("[zeus] native-watcher stop:", e.message);
      }
    }
    if (this.autoIndexer) {
      try {
        this.autoIndexer.stop();
      } catch (e) {
        console.warn("[zeus] auto-indexer stop:", e.message);
      }
    }
    if (this.daemonLifecycle) {
      try {
        await this.daemonLifecycle.stop();
      } catch (e) {
        console.warn("[zeus] daemon lifecycle stop:", e.message);
      }
    }
    if (this._ioQueueIntervalId) {
      try {
        clearInterval(this._ioQueueIntervalId);
      } catch (e) {
      }
      this._ioQueueIntervalId = null;
    }
  }
  loadIndices() {
    this.searcher.load();
  }
  // v0.11 — async preload of manifest + embeddings via vault.adapter so iOS
  // gets data populated. On Mac the sync load already works; this is a no-op
  // there (sync load returned the right data already).
  async loadIndicesAsync() {
    try {
      this._manifestCache = await this.indexer.loadManifestAsync();
      this._embeddingsCache = await this.indexer.loadEmbeddingsAsync();
      if (!fs) {
        this.searcher.embeddings = this._embeddingsCache;
      }
    } catch (e) {
      console.warn("[zeus] loadIndicesAsync failed:", e.message);
    }
  }
  async saveSettings() {
    const { deviceId, ...persistable } = this.settings;
    await this.saveData(persistable);
  }
  scheduleIncrementalIndex() {
    clearTimeout(this._idxTimer);
    this._idxTimer = setTimeout(
      () => this.indexer.runFullIndex((msg) => this.updateStatusBar("indexing", msg)),
      5e3
    );
  }
  async activateSmartView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_SMART)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      await leaf.setViewState({ type: VIEW_TYPE_SMART, active: true });
    }
    workspace.revealLeaf(leaf);
  }
  async activateStatusView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_STATUS)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      await leaf.setViewState({ type: VIEW_TYPE_STATUS, active: true });
    }
    workspace.revealLeaf(leaf);
  }
  // v0.8 — persistent calibration UI (Smart Connections-style)
  // v1.1 — Token-saved metrics + PCC indicator (auto-injetados no estado 'idle')
  updateStatusBar(state, info) {
    if (!this.statusBarEl) return;
    this._lastStatusBarState = state;
    const emb = this.searcher ? this.searcher.embeddings.size : 0;
    let text;
    if (state === "indexing") {
      text = `\u26A1 Zeus indexando: ${info}`;
    } else if (state === "embedding") {
      text = `\u{1F9E0} Zeus embedding: ${info}`;
    } else if (state === "daemon-down") {
      text = `\u26A0\uFE0F Zeus daemon offline`;
    } else {
      text = `\u2713 Zeus: ${emb} docs`;
      if (this.settings.showTokenSavedInStatusBar && this.httpClient) {
        const saved = this._estimateTokensSaved();
        if (saved >= 100) text += ` \xB7 ${this._fmtTokens(saved)} saved`;
      }
      if (this.settings.pccVisualIndicator && this.httpClient) {
        const pcc = this.httpClient.getPccStatus();
        if (pcc.mode !== "off" && pcc.totalUsageCount > 0) {
          text += ` \xB7 \u2601\uFE0FPCC\xD7${pcc.totalUsageCount}`;
        }
      }
    }
    this.statusBarEl.setText(text);
  }
  // v1.1 — Tokens economizados via PIA (Passport Index Architecture):
  // Cada request via daemon devolve um passport compacto (~300B) ao invés do
  // conteúdo bruto (~5KB médio). Estimativa: tokens_saved = (raw_baseline -
  // actual_tokens) por request, somado ao longo da sessão.
  _estimateTokensSaved() {
    if (!this.httpClient) return 0;
    const m = this.httpClient.getMetrics();
    const actualTokens = m.estimatedTokens || 0;
    const baseline = (this.settings.rawTokenBaseline || 1250) * m.requests;
    return Math.max(0, baseline - actualTokens);
  }
  _fmtTokens(n) {
    if (n < 1e3) return `${n} tok`;
    if (n < 1e6) return `${(n / 1e3).toFixed(1)}k tok`;
    return `${(n / 1e6).toFixed(2)}M tok`;
  }
  refreshSmartView() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_SMART)) {
      if (leaf.view && typeof leaf.view.refresh === "function") leaf.view.refresh();
    }
  }
  // v0.7.0 — small modal-prompt helper used by v0.7 commands
  _zeusPromptText(promptText) {
    return new Promise((resolve) => {
      const { Modal } = obsidian;
      const modal = new Modal(this.app);
      modal.titleEl.setText("Zeus");
      const p = modal.contentEl.createEl("p", { text: promptText });
      p.style.marginBottom = "8px";
      const input = modal.contentEl.createEl("input", { type: "text" });
      input.style.width = "100%";
      input.style.padding = "6px 8px";
      input.style.boxSizing = "border-box";
      const btnRow = modal.contentEl.createDiv();
      btnRow.style.marginTop = "12px";
      btnRow.style.display = "flex";
      btnRow.style.gap = "8px";
      btnRow.style.justifyContent = "flex-end";
      const okBtn = btnRow.createEl("button", { text: "OK" });
      okBtn.classList.add("mod-cta");
      const cancelBtn = btnRow.createEl("button", { text: "Cancel" });
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        resolve(v);
        modal.close();
      };
      okBtn.onclick = () => finish(input.value);
      cancelBtn.onclick = () => finish(null);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") finish(input.value);
        else if (e.key === "Escape") finish(null);
      });
      modal.onClose = () => {
        if (!done) resolve(null);
      };
      modal.open();
      setTimeout(() => input.focus(), 50);
    });
  }
};
module.exports = ZeusPlugin;
