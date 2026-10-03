// One-shot cheap check of a snapshot: screenshots original and replica, diffs in code,
// prints numbers (no image goes to the LLM). Also compares computed styles node by node.
//
//   node snapdiff.mjs --url <original> --replica <dir|url> [--width 1440] [--height 900] [--dark]
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PNG } from "pngjs";
import { chromium } from "playwright";

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i < 0 ? d : (process.argv[i + 1] ?? true); };
const url = arg("url");
let rep = arg("replica");
if (!/^https?:/.test(rep)) rep = pathToFileURL(path.resolve(rep, "index.html")).href;
const width = +arg("width", 1440);
const height = +arg("height", 900);
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: arg("dark", false) ? "dark" : "light" });

async function shoot(u, replica) {
  const p = await ctx.newPage();
  await p.goto(u, { waitUntil: replica ? "load" : "networkidle" });
  if (!replica) {
    const h = await p.evaluate(() => document.documentElement.scrollHeight);
    for (let y = 0; y < h; y += height * 0.8) { await p.evaluate((v) => scrollTo(0, v), y); await p.waitForTimeout(150); }
    await p.evaluate(() => scrollTo(0, 0));
    await p.waitForTimeout(1500);
  } else {
    const h = await p.evaluate(() => document.documentElement.scrollHeight);
    for (let y = 0; y < h; y += height * 0.8) { await p.evaluate((v) => scrollTo(0, v), y); await p.waitForTimeout(100); }
    await p.evaluate(() => scrollTo(0, 0));
    await p.waitForTimeout(800);
  }
  // freeze motion so both sides rest in the same frame
  await p.addStyleTag({ content: "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}" });
  const full = await p.evaluate(() => document.documentElement.scrollHeight);
  const png = await p.screenshot({ fullPage: true });
  // rendered-tree signature: tag + rect + a few styles per element
  const tree = await p.evaluate(() => [...document.body.querySelectorAll("*")].filter((e) => !/^(SCRIPT|STYLE|NOSCRIPT|LINK|META)$/.test(e.tagName)).map((e) => {
    const r = e.getBoundingClientRect(), c = getComputedStyle(e);
    return [e.localName, Math.round(r.x), Math.round(r.y + scrollY), Math.round(r.width), Math.round(r.height), c.color, c.backgroundColor, c.fontSize, c.fontWeight];
  }));
  await p.close();
  return { png: PNG.sync.read(png), full, tree };
}

const a = await shoot(url, false);
const b = await shoot(rep, true);
await browser.close();

const W = a.png.width, H = Math.max(a.png.height, b.png.height);
let bad = 0, faint = 0, minX = W, minY = H, maxX = 0, maxY = 0;
const at = (img, x, y) => (x < img.width && y < img.height ? (y * img.width + x) * 4 : -1);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const i = at(a.png, x, y), j = at(b.png, x, y);
  let d = 255;
  if (i >= 0 && j >= 0) d = Math.max(...[0, 1, 2].map((k) => Math.abs(a.png.data[i + k] - b.png.data[j + k])));
  if (d > 40) { bad++; minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); } else if (d > 4) faint++;
}
const cropOut = arg("crop");
if (cropOut && bad) {
  const x0 = Math.max(0, minX - 10), y0 = Math.max(0, minY - 10), cw = Math.min(W, maxX + 10) - x0, ch = Math.min(900, maxY - minY + 20);
  const o = new PNG({ width: cw * 2 + 10, height: ch });
  o.data.fill(255);
  [a.png, b.png].forEach((img, k) => { for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) { const i = at(img, x0 + x, y0 + y); if (i < 0) continue; const j = (y * o.width + x + k * (cw + 10)) * 4; for (let c = 0; c < 4; c++) o.data[j + c] = img.data[i + c]; } });
  fs.writeFileSync(cropOut, PNG.sync.write(o));
}
let treeBad = 0, first = null;
const byField = { tag: 0, x: 0, y: 0, w: 0, h: 0, color: 0, bg: 0, fontSize: 0, fontWeight: 0 };
const names = Object.keys(byField);
const nodes = Math.min(a.tree.length, b.tree.length);
for (let i = 0; i < nodes; i++) if (JSON.stringify(a.tree[i]) !== JSON.stringify(b.tree[i])) {
  treeBad++;
  names.forEach((n, k) => { if (a.tree[i][k] !== b.tree[i][k]) byField[n]++; });
  if (!first && a.tree[i][3] > 2) first = { i, orig: a.tree[i], replica: b.tree[i] };
}
console.log(JSON.stringify({
  page: `${W}x${a.png.height} vs ${b.png.width}x${b.png.height}`,
  pixelsOver40: bad, pct: +((bad / (W * H)) * 100).toFixed(4), faint,
  hotBox: bad ? [minX, minY, maxX, maxY] : null,
  elements: `${a.tree.length} vs ${b.tree.length}`, treeMismatches: treeBad, byField, firstMismatch: first,
}, null, 1));
