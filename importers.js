// Importers: turn drawings the CAD engine cannot read itself (DWG, PDF, DWFX) into DXF text,
// so they open in the program like any other DXF. Everything runs in the browser and each
// converter is only downloaded the first time a file of its kind is opened.
//
//   DWG  -> go-cad (Apache-2.0, gocad/), which writes a full DXF of the drawing.
//   PDF  -> pdf.js (Apache-2.0, pdfjs/): vector paths become polylines, text becomes TEXT.
//   DWFX -> read here: a DWFX is a zip whose 2D sheets are XPS FixedPages (paths and glyphs).
//
// PDF and DWFX carry no CAD objects, only what is printed on the sheet, so the result is
// lines, polylines and texts in millimetres, one layer per page/sheet, laid side by side.

const MM_PER_PT = 25.4 / 72;      // PDF user unit
const MM_PER_XPS = 25.4 / 96;     // XPS / DWFX unit
const PAGE_GAP_MM = 20;
const MAX_ENTITIES = 400000;

const here = (path) => new URL(path, import.meta.url).href;

// ---------- Format detection ----------

export const IMPORT_EXTENSIONS = [".dxf", ".dwg", ".pdf", ".dwfx"];

export function detectFormat(name, bytes) {
  const head = String.fromCharCode(...bytes.subarray(0, 8));
  if (/^AC1\d{3}/.test(head) || /^AC2\.\d/.test(head) || head.startsWith("MC0.0")) return "dwg";
  if (head.startsWith("%PDF")) return "pdf";
  if (head.startsWith("(DWF V")) return "dwf";
  const ext = (name.toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || "";
  if (head.startsWith("PK")) return "dwfx";
  if (ext === "pdf") return "pdf";
  if (ext === "dwg") return "dwg";
  return "dxf";
}

// Returns { name, bytes, format, summary } with DXF bytes, or the input itself for DXF.
export async function importDrawing(name, bytes, onStatus = () => {}) {
  const format = detectFormat(name, bytes);
  const dxfName = name.replace(/\.[^./\\]*$/, "") + ".dxf";
  switch (format) {
    case "dxf":
      return { name, bytes, format, summary: "" };
    case "dwg": {
      onStatus("Converting DWG…");
      const out = await dwgToDxf(bytes);
      return { name: dxfName, bytes: out, format, summary: "converted from DWG" };
    }
    case "pdf": {
      onStatus("Reading PDF…");
      const { bytes: out, summary } = await pdfToDxf(bytes, onStatus);
      return { name: dxfName, bytes: out, format, summary };
    }
    case "dwfx": {
      onStatus("Reading DWFX…");
      const { bytes: out, summary } = await dwfxToDxf(bytes);
      return { name: dxfName, bytes: out, format, summary };
    }
    case "dwf":
      throw new Error("classic binary DWF is not supported: export the sheet as DWFX, PDF or DWG");
  }
}

// ---------- DXF writer (R12 ASCII: lines, polylines, texts) ----------

const ACI_RGB = [[1, 255, 0, 0], [2, 255, 255, 0], [3, 0, 255, 0], [4, 0, 255, 255], [5, 0, 0, 255],
  [6, 255, 0, 255], [8, 128, 128, 128], [9, 192, 192, 192]];

// Nearest AutoCAD colour index; black and white both become 7 (black on paper, white on screen).
export function aciFromRgb(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  if (max - min < 24 && (max < 64 || min > 224)) return 7;
  let best = 7, bestD = Infinity;
  for (const [aci, cr, cg, cb] of ACI_RGB) {
    const d = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2;
    if (d < bestD) { bestD = d; best = aci; }
  }
  return best;
}

function num(v) {
  if (!Number.isFinite(v)) return "0";
  const s = v.toFixed(6);
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

function dxfString(text) {
  let out = "";
  for (const ch of String(text).replace(/[\r\n\t]+/g, " ")) {
    const code = ch.codePointAt(0);
    if (code < 32) continue;
    if (code < 127) out += ch;
    else if (code <= 0xffff) out += "\\U+" + code.toString(16).toUpperCase().padStart(4, "0");
  }
  return out;
}

class DxfWriter {
  constructor() { this.parts = []; this.layers = new Map(); this.count = 0; this.truncated = false; }
  layer(name, color = 7) { if (!this.layers.has(name)) this.layers.set(name, color); return name; }
  full() {
    if (this.count >= MAX_ENTITIES) { this.truncated = true; return true; }
    this.count++;
    return false;
  }
  color(aci) { return aci && aci !== 256 ? "62\n" + aci + "\n" : ""; }
  line(layer, a, b, aci) {
    if (this.full()) return;
    this.parts.push("0\nLINE\n8\n" + layer + "\n" + this.color(aci) + "10\n" + num(a[0]) + "\n20\n" + num(a[1]) +
      "\n30\n0\n11\n" + num(b[0]) + "\n21\n" + num(b[1]) + "\n31\n0\n");
  }
  // pts: [[x, y], ...]; consecutive duplicates already removed.
  poly(layer, pts, closed, aci) {
    if (pts.length < 2) return;
    if (pts.length === 2 && !closed) { this.line(layer, pts[0], pts[1], aci); return; }
    if (this.full()) return;
    let s = "0\nPOLYLINE\n8\n" + layer + "\n" + this.color(aci) + "66\n1\n10\n0\n20\n0\n30\n0\n70\n" + (closed ? 1 : 0) + "\n";
    for (const p of pts) s += "0\nVERTEX\n8\n" + layer + "\n10\n" + num(p[0]) + "\n20\n" + num(p[1]) + "\n30\n0\n";
    s += "0\nSEQEND\n8\n" + layer + "\n";
    this.parts.push(s);
  }
  text(layer, at, height, angleDeg, str, aci) {
    const value = dxfString(str).trim();
    if (!value || !(height > 0) || this.full()) return;
    this.parts.push("0\nTEXT\n8\n" + layer + "\n" + this.color(aci) + "10\n" + num(at[0]) + "\n20\n" + num(at[1]) +
      "\n30\n0\n40\n" + num(height) + "\n1\n" + value + "\n" + (Math.abs(angleDeg) > 1e-6 ? "50\n" + num(angleDeg) + "\n" : ""));
  }
  toBytes() {
    let tables = "0\nSECTION\n2\nTABLES\n0\nTABLE\n2\nLTYPE\n70\n1\n0\nLTYPE\n2\nCONTINUOUS\n70\n0\n3\nSolid line\n72\n65\n73\n0\n40\n0.0\n0\nENDTAB\n";
    tables += "0\nTABLE\n2\nLAYER\n70\n" + (this.layers.size + 1) + "\n0\nLAYER\n2\n0\n70\n0\n62\n7\n6\nCONTINUOUS\n";
    for (const [name, color] of this.layers) tables += "0\nLAYER\n2\n" + name + "\n70\n0\n62\n" + color + "\n6\nCONTINUOUS\n";
    tables += "0\nENDTAB\n0\nENDSEC\n";
    const header = "0\nSECTION\n2\nHEADER\n9\n$ACADVER\n1\nAC1009\n9\n$INSUNITS\n70\n4\n0\nENDSEC\n";
    const text = header + tables + "0\nSECTION\n2\nENTITIES\n" + this.parts.join("") + "0\nENDSEC\n0\nEOF\n";
    return new TextEncoder().encode(text);
  }
}

// ---------- Geometry helpers ----------

// 2D affine matrices as [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f.
function mul(m, n) {
  return [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
}
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const IDENTITY = [1, 0, 0, 1, 0, 0];

// Points of a cubic Bezier after p0 (p0 itself excluded), already in the output space.
function flattenCubic(p0, p1, p2, p3, out, unit) {
  const len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) + Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) +
    Math.hypot(p3[0] - p2[0], p3[1] - p2[1]);
  const n = Math.max(2, Math.min(48, Math.ceil(len / unit)));
  for (let i = 1; i <= n; i++) {
    const t = i / n, u = 1 - t;
    const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
    out.push([a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]]);
  }
}

function cleanPoints(pts) {
  const out = [];
  for (const p of pts) {
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
    const last = out[out.length - 1];
    if (!last || Math.abs(last[0] - p[0]) > 1e-9 || Math.abs(last[1] - p[1]) > 1e-9) out.push(p);
  }
  return out;
}

// Emits sub-paths ([{pts, closed}]) of points in DXF space.
function emitPaths(w, layer, subpaths, forceClosed, aci) {
  for (const sp of subpaths) {
    let pts = cleanPoints(sp.pts);
    let closed = sp.closed || forceClosed;
    if (pts.length > 2) {
      const a = pts[0], b = pts[pts.length - 1];
      if (Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9) { pts = pts.slice(0, -1); closed = true; }
    }
    if (pts.length < 2) continue;
    if (pts.length === 2) closed = false;
    w.poly(layer, pts, closed, aci);
  }
}

// ---------- Shared loading helpers ----------

async function fetchGzip(url) {
  if (typeof DecompressionStream !== "function") throw new Error("this browser has no DecompressionStream");
  const response = await fetch(url);
  if (!response.ok) throw new Error(url.split("/").pop() + ": HTTP " + response.status);
  const inflated = (await response.blob()).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(inflated).arrayBuffer());
}

// ---------- DWG (go-cad) ----------

// go-cad (github.com/unitedrhino/go-cad, Apache-2.0) compiled to WebAssembly with gocad/main.go:
// it reads DWG R9 to 2018 and writes a DXF of the whole drawing.
let gocadPromise = null;

function loadGocad() {
  gocadPromise ??= (async () => {
    const [, wasm] = await Promise.all([import(here("./gocad/wasm_exec.js")), fetchGzip(here("./gocad/gocad.gz.wasm"))]);
    const go = new globalThis.Go();
    const { instance } = await WebAssembly.instantiate(wasm, go.importObject);
    go.run(instance); // never resolves: the Go program stays alive to answer calls
    if (typeof globalThis.gocadDwgToDxf !== "function") throw new Error("the DWG converter did not start");
    return globalThis.gocadDwgToDxf;
  })();
  gocadPromise.catch(() => { gocadPromise = null; });
  return gocadPromise;
}

async function dwgToDxf(bytes) {
  const convert = await loadGocad();
  const result = convert(bytes);
  if (!result || result.error || !result.dxf || result.dxf.length < 32) {
    throw new Error("could not read this DWG" + (result && result.error ? " (" + result.error + ")" : ""));
  }
  return result.dxf;
}

// ---------- PDF (pdf.js) ----------

let pdfjsPromise = null;

function loadPdfjs() {
  pdfjsPromise ??= import(here("./pdfjs/pdf.min.mjs")).then((lib) => {
    lib.GlobalWorkerOptions.workerSrc = here("./pdfjs/pdf.worker.min.mjs");
    return lib;
  });
  pdfjsPromise.catch(() => { pdfjsPromise = null; });
  return pdfjsPromise;
}

async function pdfToDxf(bytes, onStatus) {
  const pdfjs = await loadPdfjs();
  const OPS = pdfjs.OPS;
  const doc = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, disableFontFace: true,
    useSystemFonts: false, stopAtErrors: false }).promise;
  const w = new DxfWriter();
  const K = MM_PER_PT;
  let offset = 0, texts = 0;
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      if (w.truncated) break;
      onStatus("Reading PDF page " + p + " of " + doc.numPages + "…");
      const page = await doc.getPage(p);
      const vp = page.getViewport({ scale: 1 });
      const layer = w.layer(doc.numPages > 1 ? "PDF-P" + p : "PDF");
      const ox = offset;
      // Viewport space is y-down points; flip into DXF millimetres.
      const toOut = (pt) => [(pt[0] + ox) * K, (vp.height - pt[1]) * K];
      // Page border, so each sheet's extent stays visible.
      w.poly(w.layer("PDF-SHEET", 8), [toOut([0, 0]), toOut([vp.width, 0]), toOut([vp.width, vp.height]), toOut([0, vp.height])], true, 256);

      const list = await page.getOperatorList({ annotationMode: pdfjs.AnnotationMode.DISABLE });
      const stack = [];
      let ctm = vp.transform.slice(), stroke = 7, fill = 7;
      let subpaths = [], cur = null, last = null;
      const startSub = (pt) => { cur = { pts: [pt], closed: false }; subpaths.push(cur); last = pt; };
      const lineTo = (pt) => { if (!cur) startSub(last || pt); cur.pts.push(pt); last = pt; };
      const close = () => { if (cur) { cur.closed = true; last = cur.pts[0]; cur = null; } };
      const out = (x, y) => toOut(apply(ctm, x, y));
      const unit = 1.5; // flatten curves to ~1.5 mm chords (points are already in mm)

      for (let i = 0; i < list.fnArray.length; i++) {
        const fn = list.fnArray[i], args = list.argsArray[i];
        switch (fn) {
          case OPS.save: stack.push({ ctm, stroke, fill }); break;
          case OPS.restore: if (stack.length) ({ ctm, stroke, fill } = stack.pop()); break;
          case OPS.transform: ctm = mul(ctm, args); break;
          case OPS.paintFormXObjectBegin:
            stack.push({ ctm, stroke, fill });
            if (args && Array.isArray(args[0]) && args[0].length === 6) ctm = mul(ctm, args[0]);
            break;
          case OPS.paintFormXObjectEnd: if (stack.length) ({ ctm, stroke, fill } = stack.pop()); break;
          case OPS.setStrokeRGBColor: stroke = aciFromRgb(args[0], args[1], args[2]); break;
          case OPS.setFillRGBColor: fill = aciFromRgb(args[0], args[1], args[2]); break;
          case OPS.constructPath: {
            const [ops, c] = args;
            let j = 0;
            for (const op of ops) {
              switch (op | 0) {
                case OPS.rectangle: {
                  const x = c[j++], y = c[j++], rw = c[j++], rh = c[j++];
                  startSub(out(x, y));
                  if (rw === 0 || rh === 0) lineTo(out(x + rw, y + rh));
                  else { lineTo(out(x + rw, y)); lineTo(out(x + rw, y + rh)); lineTo(out(x, y + rh)); close(); }
                  break;
                }
                case OPS.moveTo: startSub(out(c[j], c[j + 1])); j += 2; break;
                case OPS.lineTo: lineTo(out(c[j], c[j + 1])); j += 2; break;
                case OPS.curveTo: {
                  const p0 = last || out(c[j], c[j + 1]);
                  const pts = [];
                  flattenCubic(p0, out(c[j], c[j + 1]), out(c[j + 2], c[j + 3]), out(c[j + 4], c[j + 5]), pts, unit);
                  pts.forEach(lineTo); j += 6; break;
                }
                case OPS.curveTo2: { // first control point = current point
                  const p0 = last || out(c[j], c[j + 1]);
                  const pts = [];
                  flattenCubic(p0, p0, out(c[j], c[j + 1]), out(c[j + 2], c[j + 3]), pts, unit);
                  pts.forEach(lineTo); j += 4; break;
                }
                case OPS.curveTo3: { // second control point = end point
                  const p0 = last || out(c[j], c[j + 1]);
                  const end = out(c[j + 2], c[j + 3]);
                  const pts = [];
                  flattenCubic(p0, out(c[j], c[j + 1]), end, end, pts, unit);
                  pts.forEach(lineTo); j += 4; break;
                }
                case OPS.closePath: close(); break;
              }
            }
            break;
          }
          case OPS.stroke: emitPaths(w, layer, subpaths, false, stroke); subpaths = []; cur = null; break;
          case OPS.closeStroke: emitPaths(w, layer, subpaths, true, stroke); subpaths = []; cur = null; break;
          case OPS.fill: case OPS.eoFill:
            emitPaths(w, layer, subpaths, true, fill); subpaths = []; cur = null; break;
          case OPS.fillStroke: case OPS.eoFillStroke: case OPS.closeFillStroke: case OPS.closeEOFillStroke:
            emitPaths(w, layer, subpaths, true, stroke); subpaths = []; cur = null; break;
          case OPS.endPath: subpaths = []; cur = null; break;
        }
      }

      const content = await page.getTextContent();
      for (const item of content.items) {
        if (!item.str || !item.str.trim() || !item.transform) continue;
        const m = mul(vp.transform, item.transform);
        const size = Math.hypot(m[2], m[3]);
        const angle = Math.atan2(-m[1], m[0]) * 180 / Math.PI;
        w.text(layer, toOut([m[4], m[5]]), size * 0.7 * K, angle, item.str, 7);
        texts++;
      }
      offset += vp.width + PAGE_GAP_MM / K;
      page.cleanup();
    }
  } finally {
    doc.destroy();
  }
  return { bytes: w.toBytes(), summary: summaryOf(w, doc.numPages, "page", texts) };
}

function summaryOf(w, pages, word, texts) {
  let s = pages + " " + word + (pages === 1 ? "" : "s") + ", " + w.count + " objects";
  if (texts) s += " (" + texts + " texts)";
  if (w.truncated) s += "; stopped at " + MAX_ENTITIES + " objects";
  return s;
}

// ---------- Zip reader (for DWFX) ----------

async function readZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip file");
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  if (p === 0xffffffff) throw new Error("zip64 archives are not supported");
  const entries = new Map();
  const dec = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) throw new Error("damaged zip directory");
    const method = view.getUint16(p + 10, true);
    const size = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true), extraLen = view.getUint16(p + 30, true), commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    entries.set(name.replace(/\\/g, "/").replace(/^\//, ""), { method, size, local });
    p += 46 + nameLen + extraLen + commentLen;
  }
  // Lower-case index: OPC part names are case-insensitive.
  const lower = new Map([...entries.keys()].map((k) => [k.toLowerCase(), k]));
  async function read(name) {
    const key = lower.get(name.replace(/^\//, "").toLowerCase());
    if (!key) return null;
    const e = entries.get(key);
    const start = e.local + 30 + view.getUint16(e.local + 26, true) + view.getUint16(e.local + 28, true);
    const data = bytes.subarray(start, start + e.size);
    if (e.method === 0) return data;
    if (e.method !== 8) throw new Error("unsupported zip compression in " + key);
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return { names: [...entries.keys()], read, async text(name) { const b = await read(name); return b && new TextDecoder().decode(b); } };
}

// Resolve an OPC part reference relative to the part that holds it.
function resolvePart(base, ref) {
  ref = decodeURIComponent(ref.replace(/\\/g, "/")).split("#")[0];
  if (ref.startsWith("/")) return ref.slice(1);
  const parts = base.split("/").slice(0, -1);
  for (const seg of ref.split("/")) {
    if (seg === "..") parts.pop(); else if (seg && seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}

const parseXml = (text) => {
  const doc = new DOMParser().parseFromString(text.replace(/^﻿/, ""), "application/xml");
  if (doc.getElementsByTagName("parsererror").length) throw new Error("invalid XML in DWFX");
  return doc;
};
const childrenOf = (el) => Array.from(el.children || []);
const byLocal = (el, name) => childrenOf(el).filter((c) => c.localName === name);

// ---------- DWFX (XPS FixedPages) ----------

async function dwfxPages(zip) {
  const pages = [];
  const seen = new Set();
  const addPage = (p) => { const k = p.toLowerCase(); if (!seen.has(k)) { seen.add(k); pages.push(p); } };
  // Follow the fixed document sequence named in the package relationships.
  let seqName = null;
  const rels = await zip.text("_rels/.rels");
  if (rels) {
    for (const r of parseXml(rels).getElementsByTagName("*")) {
      if (r.localName === "Relationship" && /fixedrepresentation$/i.test(r.getAttribute("Type") || "")) {
        seqName = resolvePart("", r.getAttribute("Target") || "");
      }
    }
  }
  seqName ??= zip.names.find((n) => /\.fdseq$/i.test(n));
  if (seqName) {
    const seq = await zip.text(seqName);
    if (seq) {
      for (const ref of parseXml(seq).getElementsByTagName("*")) {
        if (ref.localName !== "DocumentReference") continue;
        const docName = resolvePart(seqName, ref.getAttribute("Source") || "");
        const fdoc = await zip.text(docName);
        if (!fdoc) continue;
        for (const pc of parseXml(fdoc).getElementsByTagName("*")) {
          if (pc.localName === "PageContent" && pc.getAttribute("Source")) addPage(resolvePart(docName, pc.getAttribute("Source")));
        }
      }
    }
  }
  if (!pages.length) {
    zip.names.filter((n) => /\.fpage$/i.test(n))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).forEach(addPage);
  }
  return pages;
}

function parseMatrix(s) {
  if (!s) return null;
  const v = s.trim().split(/[\s,]+/).map(Number);
  return v.length === 6 && v.every(Number.isFinite) ? v : null;
}

function parseColor(s) {
  if (!s) return null;
  s = s.trim();
  let m = /^#([0-9a-f]{2})?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(s);
  if (m) {
    if (m[1] && parseInt(m[1], 16) === 0) return { transparent: true };
    return { aci: aciFromRgb(parseInt(m[2], 16), parseInt(m[3], 16), parseInt(m[4], 16)) };
  }
  m = /^sc#\s*([\d.e+-]+)\s*,\s*([\d.e+-]+)\s*,\s*([\d.e+-]+)(?:\s*,\s*([\d.e+-]+))?$/i.exec(s);
  if (m) {
    const v = m.slice(1).filter((x) => x !== undefined).map(Number);
    if (v.length === 4 && v[0] === 0) return { transparent: true };
    const [r, g, b] = v.slice(-3).map((x) => Math.round(Math.max(0, Math.min(1, x)) * 255));
    return { aci: aciFromRgb(r, g, b) };
  }
  return { aci: 7 };
}

// XPS abbreviated geometry ("M 0,0 L 10,0 C ... Z"), into sub-paths of raw page points.
function parsePathData(data, unit) {
  const tokens = data.match(/[A-Za-z]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) || [];
  const subpaths = [];
  let i = 0, cmd = null, cur = null, x = 0, y = 0, sx = 0, sy = 0, lastCtrl = null, lastQ = null;
  const isNum = () => i < tokens.length && !/^[A-Za-z]$/.test(tokens[i]);
  const n = () => Number(tokens[i++]);
  const move = (px, py) => { cur = { pts: [[px, py]], closed: false }; subpaths.push(cur); x = sx = px; y = sy = py; };
  const line = (px, py) => { if (!cur) move(x, y); cur.pts.push([px, py]); x = px; y = py; };
  while (i < tokens.length) {
    if (!isNum()) cmd = tokens[i++];
    if (!cmd) { i++; continue; }
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    const ox = rel ? x : 0, oy = rel ? y : 0;
    switch (C) {
      case "F": if (isNum()) n(); cmd = null; break;
      case "M": move(n() + ox, n() + oy); cmd = rel ? "l" : "L"; lastCtrl = lastQ = null; break;
      case "L": line(n() + ox, n() + oy); lastCtrl = lastQ = null; break;
      case "H": line(n() + ox, y); lastCtrl = lastQ = null; break;
      case "V": line(x, n() + (rel ? y : 0)); lastCtrl = lastQ = null; break;
      case "C": case "S": {
        let c1;
        if (C === "C") c1 = [n() + ox, n() + oy];
        else c1 = lastCtrl ? [2 * x - lastCtrl[0], 2 * y - lastCtrl[1]] : [x, y];
        const c2 = [n() + ox, n() + oy], e = [n() + ox, n() + oy];
        const pts = []; flattenCubic([x, y], c1, c2, e, pts, unit);
        if (!cur) move(x, y);
        pts.forEach((p) => cur.pts.push(p));
        x = e[0]; y = e[1]; lastCtrl = c2; lastQ = null; break;
      }
      case "Q": {
        const q = [n() + ox, n() + oy], e = [n() + ox, n() + oy];
        const c1 = [x + 2 / 3 * (q[0] - x), y + 2 / 3 * (q[1] - y)], c2 = [e[0] + 2 / 3 * (q[0] - e[0]), e[1] + 2 / 3 * (q[1] - e[1])];
        const pts = []; flattenCubic([x, y], c1, c2, e, pts, unit);
        if (!cur) move(x, y);
        pts.forEach((p) => cur.pts.push(p));
        x = e[0]; y = e[1]; lastQ = q; lastCtrl = null; break;
      }
      case "A": {
        const rx = n(), ry = n(), rot = n(), large = n(), sweep = n(), ex = n() + ox, ey = n() + oy;
        if (!cur) move(x, y);
        arcPoints(x, y, rx, ry, rot, large !== 0, sweep !== 0, ex, ey, unit).forEach((p) => cur.pts.push(p));
        x = ex; y = ey; lastCtrl = lastQ = null; break;
      }
      case "Z": if (cur) { cur.closed = true; x = sx; y = sy; cur = null; } cmd = null; lastCtrl = lastQ = null; break;
      default: i++; cmd = null;
    }
    if (lastQ && C !== "Q") lastQ = null;
  }
  return subpaths;
}

// Endpoint-parameterised elliptical arc (SVG/XPS), as points after the start point.
function arcPoints(x1, y1, rx, ry, rotDeg, large, sweep, x2, y2, unit) {
  rx = Math.abs(rx); ry = Math.abs(ry);
  if (!rx || !ry || (x1 === x2 && y1 === y2)) return [[x2, y2]];
  const phi = rotDeg * Math.PI / 180, cos = Math.cos(phi), sin = Math.sin(phi);
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const xp = cos * dx + sin * dy, yp = -sin * dx + cos * dy;
  const lam = (xp * xp) / (rx * rx) + (yp * yp) / (ry * ry);
  if (lam > 1) { rx *= Math.sqrt(lam); ry *= Math.sqrt(lam); }
  const num2 = rx * rx * ry * ry - rx * rx * yp * yp - ry * ry * xp * xp;
  let coef = Math.sqrt(Math.max(0, num2 / (rx * rx * yp * yp + ry * ry * xp * xp)));
  if (large === sweep) coef = -coef;
  const cxp = coef * rx * yp / ry, cyp = -coef * ry * xp / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2, cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const ang = (ux, uy, vx, vy) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const t1 = ang(1, 0, (xp - cxp) / rx, (yp - cyp) / ry);
  let dt = ang((xp - cxp) / rx, (yp - cyp) / ry, (-xp - cxp) / rx, (-yp - cyp) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI; else if (sweep && dt < 0) dt += 2 * Math.PI;
  const steps = Math.max(4, Math.min(96, Math.ceil(Math.abs(dt) * Math.max(rx, ry) / unit)));
  const pts = [];
  for (let k = 1; k <= steps; k++) {
    const t = t1 + dt * k / steps;
    pts.push([cx + rx * Math.cos(t) * cos - ry * Math.sin(t) * sin, cy + rx * Math.cos(t) * sin + ry * Math.sin(t) * cos]);
  }
  pts[pts.length - 1] = [x2, y2];
  return pts;
}

const attrPoint = (s) => { const v = (s || "").trim().split(/[\s,]+/).map(Number); return [v[0] || 0, v[1] || 0]; };
const attrPoints = (s) => {
  const v = (s || "").trim().split(/[\s,]+/).filter(Boolean).map(Number);
  const out = []; for (let k = 0; k + 1 < v.length; k += 2) out.push([v[k], v[k + 1]]); return out;
};

// PathGeometry element (verbose form), into sub-paths of raw points.
function parsePathGeometry(geo, unit, resolveRes) {
  let subpaths = [];
  const figuresAttr = geo.getAttribute("Figures");
  if (figuresAttr) subpaths = parsePathData(figuresAttr, unit);
  for (const fig of geo.getElementsByTagName("*")) {
    if (fig.localName !== "PathFigure") continue;
    let p = attrPoint(fig.getAttribute("StartPoint"));
    const sp = { pts: [p], closed: fig.getAttribute("IsClosed") === "true" };
    for (const seg of childrenOf(fig)) {
      const last = () => sp.pts[sp.pts.length - 1];
      switch (seg.localName) {
        case "LineSegment": sp.pts.push(attrPoint(seg.getAttribute("Point"))); break;
        case "PolyLineSegment": sp.pts.push(...attrPoints(seg.getAttribute("Points"))); break;
        case "BezierSegment": case "PolyBezierSegment": {
          const ps = seg.localName === "BezierSegment"
            ? [attrPoint(seg.getAttribute("Point1")), attrPoint(seg.getAttribute("Point2")), attrPoint(seg.getAttribute("Point3"))]
            : attrPoints(seg.getAttribute("Points"));
          for (let k = 0; k + 2 < ps.length; k += 3) flattenCubic(last(), ps[k], ps[k + 1], ps[k + 2], sp.pts, unit);
          break;
        }
        case "QuadraticBezierSegment": case "PolyQuadraticBezierSegment": {
          const ps = seg.localName === "QuadraticBezierSegment"
            ? [attrPoint(seg.getAttribute("Point1")), attrPoint(seg.getAttribute("Point2"))]
            : attrPoints(seg.getAttribute("Points"));
          for (let k = 0; k + 1 < ps.length; k += 2) {
            const s = last(), q = ps[k], e = ps[k + 1];
            flattenCubic(s, [s[0] + 2 / 3 * (q[0] - s[0]), s[1] + 2 / 3 * (q[1] - s[1])],
              [e[0] + 2 / 3 * (q[0] - e[0]), e[1] + 2 / 3 * (q[1] - e[1])], e, sp.pts, unit);
          }
          break;
        }
        case "ArcSegment": {
          const s = last(), e = attrPoint(seg.getAttribute("Point")), size = attrPoint(seg.getAttribute("Size"));
          sp.pts.push(...arcPoints(s[0], s[1], size[0], size[1], Number(seg.getAttribute("RotationAngle")) || 0,
            seg.getAttribute("IsLargeArc") === "true", seg.getAttribute("SweepDirection") === "Clockwise", e[0], e[1], unit));
          break;
        }
      }
    }
    subpaths.push(sp);
  }
  const t = geo.getAttribute("Transform");
  let m = parseMatrix(t);
  if (!m && t && /^\{StaticResource/.test(t)) m = resolveRes(t) && matrixFromElement(resolveRes(t));
  for (const el of byLocal(geo, "PathGeometry.Transform")) { const mt = el.getElementsByTagName("*")[0]; m = mt && matrixFromElement(mt); }
  if (m) subpaths.forEach((sp) => { sp.pts = sp.pts.map((p) => apply(m, p[0], p[1])); });
  return subpaths;
}

function matrixFromElement(el) {
  if (!el) return null;
  if (el.localName === "MatrixTransform") return parseMatrix(el.getAttribute("Matrix"));
  return null;
}

async function dwfxToDxf(bytes) {
  const zip = await readZip(bytes);
  const pageNames = await dwfxPages(zip);
  if (!pageNames.length) throw new Error("this DWFX has no 2D sheets (3D models cannot be imported)");
  const w = new DxfWriter();
  const K = MM_PER_XPS;
  const unit = 1.5 / K;
  let offset = 0, texts = 0, sheets = 0;

  for (const [index, pageName] of pageNames.entries()) {
    if (w.truncated) break;
    const xml = await zip.text(pageName);
    if (!xml) continue;
    const page = parseXml(xml).documentElement;
    const width = Number(page.getAttribute("Width")) || 0, height = Number(page.getAttribute("Height")) || 0;
    const layer = w.layer(pageNames.length > 1 ? "DWFX-S" + (index + 1) : "DWFX");
    const ox = offset;
    const toOut = (p) => [(p[0] + ox) * K, (height - p[1]) * K];
    sheets++;
    if (width && height) {
      w.poly(w.layer("DWFX-SHEET", 8), [toOut([0, 0]), toOut([width, 0]), toOut([width, height]), toOut([0, height])], true, 256);
    }

    // Resources: inline dictionaries anywhere in the page, plus remote .dict parts.
    const resources = new Map();
    const collect = (root) => {
      for (const el of root.getElementsByTagName("*")) {
        const key = el.getAttribute("x:Key") || el.getAttributeNS("http://schemas.microsoft.com/xps/2005/06/resourcedictionary-key", "Key");
        if (key) resources.set(key, el);
      }
    };
    collect(page);
    for (const dict of page.getElementsByTagName("*")) {
      if (dict.localName === "ResourceDictionary" && dict.getAttribute("Source")) {
        const text = await zip.text(resolvePart(pageName, dict.getAttribute("Source")));
        if (text) collect(parseXml(text).documentElement);
      }
    }
    const resolveRes = (ref) => {
      const m = /\{StaticResource\s+([^}\s]+)\s*\}/.exec(ref || "");
      return m ? resources.get(m[1]) : null;
    };
    const brush = (el, prop) => {
      const attr = el.getAttribute(prop);
      if (attr) {
        if (attr.startsWith("{")) { const r = resolveRes(attr); return r && r.localName === "SolidColorBrush" ? parseColor(r.getAttribute("Color")) : (r ? { aci: 7 } : null); }
        return parseColor(attr);
      }
      for (const holder of byLocal(el, el.localName + "." + prop)) {
        const b = holder.children[0];
        if (!b) continue;
        return b.localName === "SolidColorBrush" ? parseColor(b.getAttribute("Color")) : { aci: 7 };
      }
      return null;
    };
    const renderTransform = (el) => {
      let m = null;
      const attr = el.getAttribute("RenderTransform");
      if (attr) m = attr.startsWith("{") ? matrixFromElement(resolveRes(attr)) : parseMatrix(attr);
      for (const holder of byLocal(el, el.localName + ".RenderTransform")) m = matrixFromElement(holder.children[0]);
      return m;
    };

    const walk = (el, ctm) => {
      if (w.truncated) return;
      const name = el.localName;
      if (name.includes(".") || name === "ResourceDictionary") return; // property elements, resources
      if (el.getAttribute("Opacity") === "0") return;
      const local = renderTransform(el);
      const m = local ? mul(ctm, local) : ctm;
      if (name === "Path") {
        let subpaths = [];
        const data = el.getAttribute("Data");
        if (data) {
          if (data.startsWith("{")) { const r = resolveRes(data); if (r) subpaths = parsePathGeometry(r, unit, resolveRes); }
          else subpaths = parsePathData(data, unit);
        }
        for (const holder of byLocal(el, "Path.Data")) {
          for (const geo of childrenOf(holder)) if (geo.localName === "PathGeometry") subpaths.push(...parsePathGeometry(geo, unit, resolveRes));
        }
        const stroke = brush(el, "Stroke"), fill = brush(el, "Fill");
        const paint = stroke && !stroke.transparent ? stroke : (fill && !fill.transparent ? fill : null);
        if (!paint) return;
        for (const sp of subpaths) sp.pts = sp.pts.map((p) => toOut(apply(m, p[0], p[1])));
        emitPaths(w, layer, subpaths, !(stroke && !stroke.transparent), paint.aci);
        return;
      }
      if (name === "Glyphs") {
        let str = el.getAttribute("UnicodeString") || "";
        if (str.startsWith("{}")) str = str.slice(2);
        const size = Number(el.getAttribute("FontRenderingEmSize")) || 0;
        if (!str.trim() || !size) return;
        const fill = brush(el, "Fill");
        if (fill && fill.transparent) return;
        const at = toOut(apply(m, Number(el.getAttribute("OriginX")) || 0, Number(el.getAttribute("OriginY")) || 0));
        const scale = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
        const angle = Math.atan2(-m[1], m[0]) * 180 / Math.PI;
        w.text(layer, at, size * scale * 0.7 * K, angle, str, fill ? fill.aci : 7);
        texts++;
        return;
      }
      for (const child of childrenOf(el)) walk(child, m);
    };
    for (const child of childrenOf(page)) walk(child, IDENTITY);
    offset += (width || 0) + PAGE_GAP_MM / K;
  }
  if (!w.count) throw new Error("no 2D graphics found in this DWFX");
  return { bytes: w.toBytes(), summary: summaryOf(w, sheets, "sheet", texts) };
}
