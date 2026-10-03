// Deterministic clone of a rendered page: no LLM, no screenshots in the loop.
//
//   node snapshot.mjs --url <url> --out <dir> [--width 1440] [--height 900] [--wait 1500] [--dark] [--mode live|frozen]
//
// live (default): site CSS verbatim + original classes -> responsive, hover, dark all keep working.
// frozen: computed styles at the captured width only; for CSS-in-JS / styles injected by script.
//
// Walks the live DOM, stores for every element the computed properties that differ from
// the browser default of its tag (deduplicated into classes, inside @layer snap), keeps
// ::before/::after, inline SVG, @font-face, @keyframes and every original rule that
// carries a pseudo state or sits in @media/@container/@supports (unlayered, so hover and
// responsive keep working and beat the frozen base). Assets are downloaded to <out>/assets.
// Output: <out>/index.html (static, no JS) and <out>/snapshot.json (stats).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { chromium } from "playwright";

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i < 0 ? d : process.argv[i + 1]?.startsWith("--") || process.argv[i + 1] === undefined ? true : process.argv[i + 1];
};
const url = arg("url");
const out = path.resolve(arg("out", "snapshot"));
const width = +arg("width", 1440);
const height = +arg("height", 900);
const wait = +arg("wait", 1500);
if (!url) throw new Error("--url required");
fs.mkdirSync(path.join(out, "assets"), { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width, height },
  colorScheme: arg("dark", false) ? "dark" : "light",
});
const page = await ctx.newPage();
await page.goto(url, { waitUntil: "networkidle" });
// trigger lazy content / whileInView, then return to top
const total = await page.evaluate(() => document.documentElement.scrollHeight);
for (let y = 0; y < total; y += height * 0.8) {
  await page.evaluate((v) => window.scrollTo(0, v), y);
  await page.waitForTimeout(150);
}
await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForTimeout(wait);

const live = arg("mode", "live") === "live";
const data = await page.evaluate(async (live) => {
  // read base styles, not a mid-flight frame: the animation-* properties stay and replay in the clone
  document.getAnimations().forEach((a) => a.cancel());
  const SKIP = new Set(["SCRIPT", "NOSCRIPT", "LINK", "META", "STYLE", "TEMPLATE", "BASE"]);
  const abs = (u) => { try { return new URL(u, document.baseURI).href; } catch { return u; } };

  // default computed style per tag, from a pristine iframe
  const frame = document.createElement("iframe");
  frame.style.cssText = "position:fixed;left:-9999px;width:1440px;height:900px";
  frame.srcdoc = "<!doctype html><html><body></body></html>";
  document.body.appendChild(frame);
  await new Promise((r) => { frame.onload = r; setTimeout(r, 2000); });
  const fdoc = frame.contentDocument;
  const fwin = frame.contentWindow;
  const defaults = new Map();
  const defaultFor = (el) => {
    const key = el.namespaceURI + ":" + el.localName;
    if (!defaults.has(key)) {
      const probe = fdoc.createElementNS(el.namespaceURI, el.localName);
      fdoc.body.appendChild(probe);
      const cs = fwin.getComputedStyle(probe);
      const m = {};
      for (const p of cs) m[p] = cs.getPropertyValue(p);
      defaults.set(key, m);
      probe.remove();
      // properties the UA stylesheet sets for this tag (ul margin 1em, h1 font-size...): their
      // default is relative to the context, so an author value that merely equals it must still travel
      if (el.namespaceURI === "http://www.w3.org/1999/xhtml" && el.localName !== "div") {
        const base = defaultFor(document.createElement("div"));
        m.__ua = new Set(Object.keys(m).filter((p) => m[p] !== base[p]));
      } else m.__ua = new Set();
    }
    return defaults.get(key);
  };

  const classes = new Map(); // css text -> class name
  const rules = [];
  const cls = (decl) => {
    if (!classes.has(decl)) classes.set(decl, "s" + classes.size.toString(36));
    return classes.get(decl);
  };
  const diff = (cs, def, parent) => {
    let s = "";
    for (const p of cs) {
      const v = cs.getPropertyValue(p);
      if (p.startsWith("--")) { if (parent && parent.getPropertyValue(p) !== v) s += `${p}:${v};`; }
      else if (v !== def[p] || def.__ua.has(p)) s += `${p}:${v};`;
      // computed width is 0px while style is none, so it equals the default; once a style is
      // emitted the initial `medium` (3px) would apply unless the width travels with it
      else if (/-width$/.test(p) && /^(border|outline|column-rule)/.test(p) && cs.getPropertyValue(p.replace(/-width$/, "-style")) !== "none") s += `${p}:${v};`;
    }
    return s;
  };

  const urls = new Set();
  const esc = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const escA = (t) => t.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  const VOID = new Set(["AREA", "BR", "COL", "EMBED", "HR", "IMG", "INPUT", "SOURCE", "TRACK", "WBR"]);
  let n = 0;

  function pseudo(el, which, id) {
    const cs = getComputedStyle(el, which);
    const c = cs.content;
    if (!c || c === "none" || c === "normal") return;
    const decl = diff(cs, defaultFor(el));
    if (decl) rules.push(`[data-sn="${id}"]${which}{${decl}}`);
  }

  function walk(node) {
    if (node.nodeType === 3) return esc(node.nodeValue);
    if (node.nodeType !== 1 || SKIP.has(node.tagName) || node === frame) return "";
    const el = node;
    const id = n++;
    const cs = getComputedStyle(el);
    let c = "";
    if (!live) {
      const decl = diff(cs, defaultFor(el), el.parentElement && getComputedStyle(el.parentElement));
      c = decl ? cls(decl) : "";
      pseudo(el, "::before", id);
      pseudo(el, "::after", id);
    }
    const tag = el.localName;
    let attrs = ` data-sn="${id}"`;
    for (const a of el.attributes) {
      let v = a.value;
      if (/^on/.test(a.name) || a.name === "data-sn" || a.name === "nonce" || (a.name === "loading" && a.value === "lazy")) continue;
      if (["src", "href", "poster"].includes(a.name) && !/^(#|javascript:|data:|mailto:|tel:)/.test(v)) {
        v = abs(v);
        if (a.name !== "href" || tag === "image") urls.add(v);
      }
      if (a.name === "srcset") { v = v.split(",").map((p) => { const [u, ...r] = p.trim().split(/\s+/); urls.add(abs(u)); return [abs(u), ...r].join(" "); }).join(", "); }
      attrs += ` ${a.name}="${escA(v)}"`;
    }
    if (tag === "img" && el.currentSrc) attrs = attrs.replace(/ src="[^"]*"/, "") + ` src="${escA(el.currentSrc)}"`, urls.add(el.currentSrc);
    if (tag === "input" || tag === "textarea") if (el.value) attrs += ` value="${escA(el.value)}"`;
    if (!live) {
      if (c) attrs = attrs.replace(/ class="[^"]*"/, "") + ` class="${c}"`;
      attrs = attrs.replace(/ style="[^"]*"/, "");
    }
    if (VOID.has(el.tagName)) return `<${tag}${attrs}>`;
    let inner = "";
    for (const ch of el.childNodes) inner += walk(ch);
    return `<${tag}${attrs}>${inner}</${tag}>`;
  }

  // original rules worth keeping verbatim
  const STATE = /:(hover|focus|active|focus-visible|focus-within|checked|disabled|target|placeholder-shown)|::(placeholder|selection|marker|backdrop|-webkit-scrollbar)/;
  const keep = [];
  const blocked = [];
  const fonts = [];
  const collect = (list, wrapped, base) => {
    for (const r of list) {
      const t = r.constructor.name;
      if (t === "CSSImportRule") { try { collect(r.styleSheet.cssRules, false, r.styleSheet.href || base); } catch { blocked.push(new URL(r.href, base).href); } continue; }
      if (live && t !== "CSSFontFaceRule") {
        // live mode: the site's own CSS, verbatim (layers, media, container queries, hover...)
        keep.push(r.cssText.replace(/url\(\s*(["']?)(?!data:)([^)"']+)\1\s*\)/g, (_, q, u) => { try { return `url("${new URL(u, base).href}")`; } catch { return _; } }));
        continue;
      }
      if (t === "CSSFontFaceRule") fonts.push(r.cssText.replace(/url\(\s*(["']?)(?!data:)([^)"']+)\1\s*\)/g, (_, q, u) => { try { return `url("${new URL(u, base).href}")`; } catch { return _; } }));
      else if (t === "CSSKeyframesRule") keep.push(r.cssText);
      else if (t === "CSSLayerBlockRule") collect(r.cssRules, wrapped, base);
      else if (t === "CSSMediaRule" || t === "CSSContainerRule" || t === "CSSSupportsRule") {
        if (r.cssText.includes("{")) keep.push(r.cssText);
      } else if (t === "CSSStyleRule" && STATE.test(r.selectorText)) {
        // keep only the selectors that carry a state; reset lists like `*, ::backdrop` must not leak in
        const sels = r.selectorText.split(/,(?![^(]*\))/).map((s) => s.trim()).filter((s) => STATE.test(s) && !/^(\*|::?(before|after|backdrop|file-selector-button))\b/.test(s));
        if (sels.length) keep.push(`${sels.join(",")}{${r.style.cssText}}`);
      }
    }
  };
  for (const sh of document.styleSheets) {
    try { collect(sh.cssRules, false, sh.href || document.baseURI); } catch { if (sh.href) blocked.push(sh.href); }
  }

  const html = document.documentElement;
  const body = walk(document.body);
  frame.remove();
  const hcs = getComputedStyle(html);
  const rootDecl = diff(hcs, defaultFor(html));
  const rootVars = [...hcs].filter((p) => p.startsWith("--")).map((p) => `${p}:${hcs.getPropertyValue(p)};`).join("");
  return {
    lang: html.lang || "en",
    title: document.title,
    body,
    rootClass: live ? html.className : rootDecl ? cls(rootDecl) : "",
    rootStyle: live ? html.getAttribute("style") || "" : "",
    classes: [...classes].map(([d, c]) => `.${c}{${d}}`),
    rules, keep, fonts, blocked, urls: [...urls], rootVars,
    // families the original itself failed to load: the site renders with the fallback, so must the clone
    brokenFonts: (() => {
      const st = {};
      for (const ff of document.fonts) (st[ff.family.replace(/^["']|["']$/g, "")] ||= new Set()).add(ff.status);
      return Object.keys(st).filter((k) => st[k].has("error") && !st[k].has("loaded"));
    })(),
    count: n,
  };
}, live);

// scroll behaviour: sticky/fixed headers that change class/style (shrink, hide on scroll down, blur...)
const scrollFx = await page.evaluate(async () => {
  const SKIP = new Set(["SCRIPT", "NOSCRIPT", "LINK", "META", "STYLE", "TEMPLATE", "BASE"]);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const all = [document.body, ...document.body.querySelectorAll("*")].filter((e) => !SKIP.has(e.tagName));
  const path = (el) => { const p = []; for (let e = el; e && e !== document.body; e = e.parentElement) p.unshift([...e.parentElement.children].filter((c) => !SKIP.has(c.tagName)).indexOf(e)); return p; };
  const IGN = /^(data-sn|nonce|loading|src|srcset|href)$/;
  const st = (e) => { const o = {}; for (const a of e.attributes) if (!IGN.test(a.name)) o[a.name] = a.value; return o; };
  const snap = () => new Map(all.map((e) => [e, st(e)]));
  const J = JSON.stringify;
  const room = document.documentElement.scrollHeight - innerHeight;
  if (room < 200) return null;
  scrollTo(0, 0); await wait(400);
  const base = snap();
  // tracked = fixed/sticky elements and their descendants
  const tracked = new Set([document.body]);
  const mark = () => { for (const e of all) { const p = getComputedStyle(e).position; if (p === "fixed" || p === "sticky") { tracked.add(e); e.querySelectorAll("*").forEach((d) => tracked.add(d)); } } };
  mark();
  let T = null;
  for (let y = 10; y <= Math.min(1200, room); y += y < 100 ? 10 : 40) {
    scrollTo(0, y); await wait(120);
    const s = snap();
    if ([...tracked].some((e) => J(s.get(e)) !== J(base.get(e)))) { T = y; break; }
  }
  if (T == null) { scrollTo(0, 0); return { threshold: null }; }
  const goDown = async () => { for (let y = 0; y <= T + 400; y += 40) { scrollTo(0, y); await wait(40); } await wait(700); return snap(); };
  const down = await goDown();
  for (let y = T + 400; y > T + 200; y -= 40) { scrollTo(0, y); await wait(40); }
  await wait(700);
  const up = snap();
  scrollTo(0, 0); await wait(500);
  mark();
  const diffs = [];
  for (const e of tracked) {
    const b = J(base.get(e)), d = J(down.get(e)), u = J(up.get(e));
    if (b !== d || b !== u) diffs.push({ p: path(e), tag: e.localName, down: down.get(e), up: up.get(e) });
  }
  return { threshold: T, diffs, directional: diffs.some((x) => J(x.down) !== J(x.up)) };
});
await browser.close();

// cross-origin stylesheets (Google Fonts, CDN css) are unreadable from the page: fetch them here
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
const remote = [];
for (const href of data.blocked) {
  try {
    const t = await (await fetch(href, { headers: { "user-agent": UA } })).text();
    remote.push(t.replace(/url\(\s*(["']?)(?!data:)([^)"']+)\1\s*\)/g, (m, q, u) => { try { return `url("${new URL(u, href).href}")`; } catch { return m; } }));
  } catch { /* leave it out */ }
}
data.fonts.unshift(...remote);
if (data.brokenFonts.length) {
  const fam = (t) => (t.match(/font-family:s*["']?([^;"'}]+)/) || [])[1]?.trim();
  data.fonts = data.fonts.filter((t) => !data.brokenFonts.includes(fam(t)));
  console.log("dropped @font-face that failed on the original:", data.brokenFonts.join(", "));
}

// download assets (images, svg, css background urls, fonts)
const bgUrls = new Set();
const re = /url\(\s*["']?(https?:[^)"']+)["']?\s*\)/g;
for (const t of [...data.classes, ...data.rules, ...data.fonts, ...data.keep]) for (const m of t.matchAll(re)) bgUrls.add(m[1]);
const map = new Map();
const wanted = new Set([...data.urls.filter((u) => /^https?:/.test(u) && /\.(png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|mp4|webm)(\?|$)|\/_next\/image|\/_next\/static\/media/i.test(u)), ...bgUrls]);
await Promise.all([...wanted].map(async (u) => {
  try {
    const r = await fetch(u);
    if (!r.ok) return;
    const buf = Buffer.from(await r.arrayBuffer());
    const ext = (new URL(u).pathname.match(/\.(\w{2,5})$/) || [, ""])[1] || ({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/avif": "avif", "image/svg+xml": "svg" }[r.headers.get("content-type")?.split(";")[0]] ?? "bin");
    const name = crypto.createHash("sha1").update(u).digest("hex").slice(0, 12) + "." + ext;
    fs.writeFileSync(path.join(out, "assets", name), buf);
    map.set(u, "assets/" + name);
  } catch { /* keep remote url */ }
}));
const rewrite = (t) => {
  for (const [u, l] of map) t = t.split(u).join(l).split(u.replace(/&/g, "&amp;")).join(l);
  return t;
};

const css = [
  data.fonts.join("\n"),
  live ? "" : `html{${data.rootVars}}`,
  `@layer snap{${data.classes.join("\n")}}`,
  data.rules.join("\n"),
  data.keep.join("\n"),
].join("\n");
const rootCls = data.rootClass ? ` class="${data.rootClass}"` : "";

let fxScript = "";
if (scrollFx && scrollFx.threshold != null && scrollFx.diffs.length) {
  const T = scrollFx.threshold, D = scrollFx.diffs.map((d) => [d.p, d.down, d.up]);
  fxScript = "<script>(function(){var SKIP=/^(SCRIPT|NOSCRIPT|LINK|META|STYLE|TEMPLATE|BASE)$/,T=" + T + ",D=" + JSON.stringify(D).replace(/</g, "\u003c") + ",last=0;" +
    "function find(p){var e=document.body;for(var i=0;i<p.length&&e;i++)e=[].filter.call(e.children,function(c){return !SKIP.test(c.tagName)})[p[i]];return e}" +
    "var els=D.map(function(d){var e=find(d[0]);if(!e)return null;var b={};[].forEach.call(e.attributes,function(a){b[a.name]=a.value});return{e:e,b:b,d:d[1],u:d[2]}}).filter(Boolean);" +
    "function set(e,v){[].slice.call(e.attributes).forEach(function(a){if(!(a.name in v)&&!/^(src|srcset|href|loading)$/.test(a.name))e.removeAttribute(a.name)});for(var k in v)if(e.getAttribute(k)!==v[k])e.setAttribute(k,v[k])}" +
    "function f(){var y=scrollY,k=y<T?'b':y>=last?'d':'u';last=y;els.forEach(function(x){set(x.e,x[k])})}" +
    "addEventListener('scroll',f,{passive:true});f()})()</script>";
}
const html = `<!doctype html><html lang="${data.lang}"${rootCls}${data.rootStyle ? ` style="${data.rootStyle.replace(/"/g, "&quot;")}"` : ""}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${data.title}</title><style>${rewrite(css)}</style></head>${rewrite(data.body.replace(/^<body/, "<body"))}${fxScript}</html>`;
fs.writeFileSync(path.join(out, "index.html"), html);
fs.writeFileSync(path.join(out, "snapshot.json"), JSON.stringify({ url, width, elements: data.count, classes: data.classes.length, keptRules: data.keep.length, assets: map.size, bytes: html.length }, null, 1));
if (scrollFx) console.log(scrollFx.threshold == null ? "scroll: no header/state change detected" : `scroll: ${scrollFx.diffs.length} elements change at scrollY>=${scrollFx.threshold}${scrollFx.directional ? " (direction-dependent)" : ""} -> replayed with a small script`);
console.log(`snapshot: ${data.count} elements, ${data.classes.length} classes, ${data.keep.length} state/media rules, ${map.size} assets, ${(html.length / 1024).toFixed(0)} KB -> ${out}/index.html`);
