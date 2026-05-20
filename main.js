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
        if (!afmBinPath) throw new Error("HierarchicalProcessor: afmBinPath required");
        this.afmBin = afmBinPath;
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
      async _requestUrl({ url, method = "GET", body, contentType = "application/json", throw: throwOnError = true }) {
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
            body: body ? typeof body === "string" ? body : JSON.stringify(body) : void 0
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
      async _post(endpoint, body, timeoutMs = 6e4) {
        const ctrl = new (typeof AbortController !== "undefined" ? AbortController : class {
          constructor() {
            this.signal = null;
          }
          abort() {
          }
        })();
        const timer = setTimeout(() => ctrl.abort && ctrl.abort(), timeoutMs);
        const bodyStr = typeof body === "string" ? body : body ? JSON.stringify(body) : "";
        const bytesOut = bodyStr ? universal2.byteLength(bodyStr) : 0;
        try {
          const resp = await this._requestUrl({
            url: `${this.baseUrl}${endpoint}`,
            method: "POST",
            body: bodyStr
          });
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
        return await this._post("/v1/embed", { text, ...options });
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
        return await this._post("/v1/embed", { texts, ...options }, 12e4);
      }
      async enrich(noteContent, notePath, vaultSummary = "") {
        return await this._post("/v1/enrich", {
          note_content: noteContent,
          note_path: notePath,
          vault_summary: vaultSummary
        }, 9e4);
      }
      async agent(question, pattern = "auto") {
        return await this._post("/v1/agent", { question, pattern }, 18e4);
      }
      async ocr(filePath, outputFormat = "text", language = "pt-BR,en") {
        return await this._post("/v1/ocr", {
          path: filePath,
          output_format: outputFormat,
          language
        }, 12e4);
      }
      async summarize(text) {
        return await this._post("/v1/summarize", { text }, 6e4);
      }
      async graphExtract(text, maxNodes = 20, maxEdges = 30) {
        return await this._post("/v1/graph/extract", { text, max_nodes: maxNodes, max_edges: maxEdges }, 6e4);
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

// lib/passport-index.js
var require_passport_index = __commonJS({
  "lib/passport-index.js"(exports2, module2) {
    "use strict";
    var universal2 = require_universal_fs();
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
        if (!this.plugin.httpClient) {
          throw new Error("PassportIndex.buildOne: httpClient indispon\xEDvel");
        }
        let currentSha = null;
        try {
          if (await universal2.adapterExists(this._adapter, filePath)) {
            const content = await universal2.adapterRead(this._adapter, filePath);
            currentSha = await universal2.sha256Hex(content);
          }
        } catch (e) {
          console.warn("[zeus][passport] sha precompute failed for", filePath, e.message);
        }
        const passport = await this.plugin.httpClient.passportExtract(filePath, domainOptions);
        if (!passport || !passport.path) {
          throw new Error(`PassportIndex.buildOne: resposta inv\xE1lida para ${filePath}`);
        }
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
       * Mirror passport_sha / passport_extracted_by / passport_extracted_at into
       * manifest.json files[<path>] for fast staleness scans (without parsing JSONL).
       */
      async _updateManifestEntry(passport) {
        if (!this.plugin.indexer || typeof this.plugin.indexer.loadManifest !== "function") return;
        const m = await this.plugin.indexer.loadManifest();
        if (!m.files || typeof m.files !== "object") m.files = {};
        const entry = m.files[passport.path] || {};
        entry.passport_sha = passport.sha || null;
        entry.passport_extracted_by = passport.extracted_by || null;
        entry.passport_extracted_at = passport.extracted_at || null;
        m.files[passport.path] = entry;
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
        if (!this.plugin.httpClient) {
          throw new Error("PassportIndex.findByQuery: httpClient indispon\xEDvel");
        }
        const dataDir = this.dataPath;
        const opts = {
          topN: options.topN || 10,
          minScore: options.minScore || 0.3,
          conceptFilter: options.conceptFilter || null,
          embeddingsPath: options.embeddingsPath || universal2.joinPath(dataDir, "embeddings.jsonl"),
          passportsPath: options.passportsPath || this.jsonlPath
        };
        const resp = await this.plugin.httpClient.passportFind(query, opts);
        return resp && resp.results || (Array.isArray(resp) ? resp : []);
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
      /**
       * Regenerate zeus-cards.base from the canonical passports.jsonl in the data dir.
       * Convenience wrapper used by plugin onload + commands.
       */
      async regenerate() {
        return await this.generateBase(this.jsonlPath, this.basePath);
      }
      /**
       * Convert passports.jsonl into a YAML .base file.
       *
       * @param {string} jsonlPath
       * @param {string} outputPath
       * @returns {{written: boolean, count: number, path: string}}
       */
      async generateBase(jsonlPath, outputPath) {
        if (!await universal2.adapterExists(this._adapter, jsonlPath)) {
          console.warn("[zeus][bases] passports.jsonl missing \u2014 skipping .base regen");
          return { written: false, count: 0, path: outputPath };
        }
        const raw = await universal2.adapterRead(this._adapter, jsonlPath);
        const lines = raw.split("\n").filter((l) => l.trim());
        let count = 0;
        for (const ln of lines) {
          try {
            const obj = JSON.parse(ln);
            if (obj && obj.path) count++;
          } catch (e) {
          }
        }
        const generatedAt = (/* @__PURE__ */ new Date()).toISOString();
        const yaml = this._renderYaml(count, generatedAt);
        await universal2.adapterWriteAtomic(this._adapter, outputPath, yaml);
        return { written: true, count, path: outputPath };
      }
      _renderYaml(count, generatedAt) {
        return [
          "# zeus-cards.base \u2014 auto-generated from passports.jsonl",
          "# DO NOT EDIT MANUALLY \u2014 regenerated on each passport rebuild.",
          `# generated_at: ${generatedAt}`,
          `# passport_count: ${count}`,
          "#",
          "# Bases is a UI DERIVATIVE. Canonical source: data/passports.jsonl.",
          "",
          "filters:",
          "  and:",
          '    - file.ext == "md"',
          "",
          "properties:",
          "  file.path:",
          "    displayName: Note",
          "  zeus_concepts:",
          "    displayName: Atomic concepts",
          "  zeus_summary:",
          "    displayName: Summary",
          "  zeus_domain:",
          "    displayName: Domain",
          "  zeus_difficulty:",
          "    displayName: Difficulty",
          "",
          "views:",
          "  - type: table",
          "    name: All passports",
          "    order:",
          "      - file.path",
          "      - zeus_summary",
          "      - zeus_concepts",
          "      - zeus_domain",
          "      - zeus_difficulty",
          "    sort:",
          "      - property: file.path",
          "        direction: ASC",
          "  - type: cards",
          "    name: Cards by domain",
          "    order:",
          "      - zeus_summary",
          "      - zeus_concepts",
          "      - zeus_difficulty",
          "    groupBy: zeus_domain",
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
        try {
          child.kill("SIGTERM");
        } catch (e) {
        }
        await new Promise((r) => setTimeout(r, graceMs));
        try {
          child.kill("SIGKILL");
        } catch (e) {
        }
        return { stopped: true };
      }
    };
    module2.exports = DaemonLifecycle2;
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
  allowRemoteDaemonFallback: true,
  // v0.7.0 — full Apple ecosystem coverage
  imagesIndexFeaturePrint: false,
  // se ON, comandos de indexação de imagens populam data/image-features.jsonl
  autoLanguageDetectOnSave: false,
  // detecta língua na nota ativa ao salvar e adiciona ao frontmatter (`lang:`)
  spotlightQueryEnabled: false,
  // permite Zeus consultar Spotlight nativo macOS via CSSearchQuery
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
  pccVisualIndicator: true
  // exibe ☁️PCC no status bar quando daemon roteou via PCC
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
    this.lastSync = 0;
    this.SYNC_DEBOUNCE_MS = 3e3;
    this.FRONTMATTER_KEY = "zeus_related";
  }
  // Top-N neighbors da nota, injeta como frontmatter array de wikilinks
  async syncFile(filePath, topN = 5, minScore = 0.3) {
    if (!this.plugin.settings.nativeGraphIntegration) return;
    const neighbors = this.plugin.searcher.neighbors(filePath, topN);
    const filtered = neighbors.filter((n) => n.score >= minScore);
    if (filtered.length === 0) return;
    const file = this.plugin.app.vault.getAbstractFileByPath(filePath);
    if (!file) return;
    await this.plugin.app.fileManager.processFrontMatter(file, (fm) => {
      fm[this.FRONTMATTER_KEY] = filtered.map((n) => {
        const name = n.path.replace(/\.md$/, "");
        return `[[${name}|${name.split("/").pop()} (${(n.score * 100).toFixed(0)}%)]]`;
      });
      fm.zeus_indexed_at = (/* @__PURE__ */ new Date()).toISOString();
      fm.zeus_neighbor_count = filtered.length;
    });
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
  // Cleanup: remove zeus_related from all files
  async clearAll() {
    const files = this.plugin.app.vault.getMarkdownFiles();
    for (const file of files) {
      await this.plugin.app.fileManager.processFrontMatter(file, (fm) => {
        delete fm[this.FRONTMATTER_KEY];
        delete fm.zeus_indexed_at;
        delete fm.zeus_neighbor_count;
      });
    }
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
  }
  async getSuggestions(query) {
    if (!query || query.length < 2) return [];
    if (query === this.lastQuery) return this.cachedResults;
    this.lastQuery = query;
    try {
      const results = await this.plugin.searcher.search(query, this.plugin.settings.maxResults);
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
          const status = await this.daemonLifecycle.ensureRunning();
          console.log("[zeus] daemon lifecycle:", status);
        } catch (e) {
          console.warn("[zeus] daemon lifecycle ensureRunning failed:", e.message);
        }
      }
      this.imageSimilarity = new ImageSimilaritySearch(this);
      this.passport = new PassportIndex(this);
      this.basesGen = new BasesGenerator(this);
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
      this.settings.deviceId = _localDeviceId;
      this.coordinator.deviceId = _localDeviceId;
      if (_localDeviceId) {
      }
      this.scheduler = new PassportScheduler(this, {
        intervalMs: this.settings.schedulerIntervalMs || 15 * 60 * 1e3
      });
      if (this.settings.schedulerEnabled) {
        this.scheduler.start();
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
          await this.indexer.runFullIndex((m) => {
            n.setMessage("Zeus: " + m);
            this.updateStatusBar("indexing", m);
          });
          n.hide();
          this.updateStatusBar("idle", null);
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
          const result = await this.enricher.enrichNote(f.path);
          n.hide();
          if (result) new Notice(`Zeus enrich: ${(result.suggested_links || []).length} links, ${(result.connections || []).length} conex\xF5es.`);
          else new Notice("Zeus enrich falhou \u2014 veja Console.");
          this.refreshSmartView();
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
            const r = await this.httpClient.spotlightSearch(query, null, 50);
            n.hide();
            const results = r && (r.results || r.matches || r.hits) || [];
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
        this.registerEvent(this.app.vault.on("modify", (file) => {
          if (file instanceof TFile && file.extension === "md") {
            clearTimeout(this._graphSyncTimer);
            this._graphSyncTimer = setTimeout(() => {
              this.nativeGraph.syncFile(file.path).catch((e) => console.warn("[zeus] graph sync", e.message));
            }, 6e3);
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
            const resp = await this.httpClient.embed(content.slice(0, 4e3));
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
            const resp = await this.httpClient.embed(tr.text.slice(0, 4e3));
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
    if (this._passportRefreshTimers) {
      for (const t of this._passportRefreshTimers.values()) clearTimeout(t);
      this._passportRefreshTimers.clear();
    }
    if (this.daemonLifecycle) {
      try {
        await this.daemonLifecycle.stop();
      } catch (e) {
        console.warn("[zeus] daemon lifecycle stop:", e.message);
      }
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
