---
name: replicate-web-ui
description: Rebuild a live web page's UI and UX so it matches the original pixel for pixel, by reading what the browser actually receives (minified JS chunks, CSSOM rules, rendered DOM, computed tokens, icon markup) and proving the result with screenshot diffs, element diffs and an interaction-state matrix. Use it whenever the user wants a component, block, dashboard or page to look and behave "igual", "identical" or "exactly like" a URL, asks to clone, port or reverse-engineer a site's UI from its client JS, says an earlier replica "no es fiel" or "doesn't match", or pastes a reference URL next to a local one and wants them to match, even if they never say "pixel-perfect".
---

# Replicate a web UI from its live bundle

Everything that makes a page look and feel the way it does ships to the browser:
the client JS holds the data, formulas and animation parameters; the CSSOM holds the
design-system rules and hover/focus states; the rendered DOM holds the final class
lists (after tailwind-merge/cva) and every server-rendered part; computed styles hold
the tokens. A faithful replica comes from reading those, not from eyeballing a
screenshot or recalling how a library "usually" looks. And it is only done when a
diff says so: agents that stop at "looks the same" miss 1px shifts, a wrong bar
width, a hover that turns text dark instead of keeping it gray.

## Ground rules

- **The page is the source of truth.** Use only the sources the user allows. If they
  say "only the page", don't read the vendor's registry JSON, published source, docs,
  or notes that describe the original; don't even use them to double-check.
- **Paid templates:** if the original is a commercial kit, mention the licensing risk
  once, then follow the user's decision.
- **Copy, don't improve.** Keep the original's data, copy (even typos such as
  "last last 30 days"), spacing and quirks unless the user asks otherwise. Improvements
  belong in a separate, explicit step.
- It is a long task: tell the user in a line what you are doing between phases.

## Workspace

```bash
WS=$(node ~/.claude/skills/replicate-web-ui/scripts/setup.mjs)   # prints the workspace path
```

Node resolves imports next to the script file, so `setup.mjs` copies the scripts beside
their `node_modules` in `~/.cache/replicate-web-ui` and keeps that workspace between
sessions: it installs once, and afterwards only refreshes the scripts. Run the tools as
`node "$WS/<script>.mjs"`; keep configs, captures and outputs in the session scratchpad.
It installs Chromium with `PLAYWRIGHT_SKIP_BROWSER_GC=1`: the browser cache is shared by
every project on the machine and a plain `playwright install` deletes the builds it
believes unused. Without network, pin the playwright version that matches a folder
already in `ms-playwright` (chromium-1181 ↔ 1.54, 1200 ↔ 1.57).

Every script prints its usage in its header comment. A value that starts with `--` needs
the `=` form: `--decl="--foreground:"`.

| Script | Use it to |
|---|---|
| **`snapshot.mjs`** | **Static pixel-exact clone of a rendered page in seconds (`live` or `frozen` mode)** |
| **`snapdiff.mjs`** | **Cheap numeric check of a clone: pixels + element boxes, `--crop` for the hot box** |
| `capture.mjs` | Full-page screenshot, all JS/CSS/HTML responses, stack fingerprint, "settled?" check |
| `bundle-modules.mjs` | Split Turbopack/webpack chunks into modules; find them by visible text; follow imports |
| `rsc-refs.mjs` | Which client components an RSC page mounts, and their module ids |
| `behaviour-probe.mjs` | What the original does on its own, on hover and on the keyboard, before you build |
| `dom-dump.mjs` | Readable rendered DOM of a region, optionally after opening overlays |
| `css-rules.mjs` | CSS rules from the live CSSOM by selector regex (`--match`) or by declaration (`--decl`) |
| `tokens.mjs` | Custom properties and typography, light and dark |
| `icons.mjs` | Exact icon markup and the extra classes each icon carries |
| `measure.mjs` | Boxes and computed styles for a selector, original vs replica, after actions |
| **`verify.mjs`** | **The whole verification from one config: runs the checks below, short report, verdict** |
| `compare.mjs` | Full-page pixel diff at several widths |
| `element-diff.mjs` | Pixel diff of one element per page (a block inside a bigger page), position-aligned |
| `dom-diff.mjs` | Per-element box/font/color diff with normalized colors |
| `states.mjs` | Interaction matrix: same actions on both pages, diffed, with "did anything happen" checks |
| `computed-diff.mjs` | *Every* computed property of every element, per state — sees what pixels cannot |
| `theme-leak.mjs` | Theme scales (`--ease-*`, `--radius-*`, `--text-*`) the host redefines under the block |
| `png-tools.mjs` | Diff two PNGs; zoomed side-by-side crop of a hot cell |
| `fingerprint-version.mjs` | Which npm versions of a library contain a code fingerprint |

## Fast path: clone the rendered result (start here)

Don't re-derive what the browser already resolved. Two scripts, no LLM and no images in the loop:

```bash
node "$WS/snapshot.mjs" --url <original> --out clone            # ~10 s; --mode frozen for CSS-in-JS pages; --dark
node "$WS/snapdiff.mjs" --url <original> --replica clone --width 390   # prints numbers only
```

`snapshot` writes a static `index.html` (no JS) with the DOM as rendered, the site's own CSS
verbatim (layers, media/container queries, hover, keyframes, `@font-face`) and every asset
downloaded; lazy images are made eager and running animations are cancelled to read their base
state. `snapdiff` screenshots both sides, diffs in code and compares every element's box and
colors; read the JSON, and only if `pixelsOver40 > 0` use `--crop out.png` to look at the hot box.
Check 390, 768, 1024, 1440 and `--dark`. Measured on a Next/Tailwind portfolio: 0 differing
pixels and 0 element mismatches at all four widths and dark, 57 KB of HTML+CSS.

Go on to the manual workflow below only for what a static clone cannot hold: logic (menus,
tabs, charts, search), state driven by JS, or turning the clone into reusable components. In
that case use the clone as the reference and refactor under `snapdiff`.

## Workflow

### 1. Recon

```bash
node "$WS/capture.mjs" --url <original> --out capture
```

Look at `capture/shot-1440.png` and the printed stack. If the capture says the page had
not settled, raise `--wait`: charts and entry animations keep moving after
`networkidle` (the first shot of a dashboard showed every bar flat). If scripts
reference public sourcemaps, fetch them first; readable sources beat minified code.

### 2. Map the page

Write down the parts before extracting anything: the app shell (sidebar, header),
each section, every overlay (menus, popovers, dialogs, sheets), keyboard shortcuts,
responsive variants (below `md` a sidebar usually becomes a sheet) and dark mode.
Unrequested parts are easy to miss: if the page shows a shell around the content,
the shell is part of "igual". When unsure what a region does, hover and click it in a
headless Playwright session and screenshot.

Write down the **units** too, because they decide the shape of what you deliver:

- *Install units.* A gallery page that lists two install commands, or two "Preview / Code"
  frames, is two components, even when they share a page and half their sections. One
  deliverable per unit; never one file with everything the page shows.
- *The module graph.* `bundle-modules.mjs --deps` shows which parts the original keeps as
  their own modules (a gradient, a number ticker, a stat band, a button). Those are the
  original's own component boundaries: keep them, as components the user can take alone,
  and let the page import them. A section pasted into two pages is a port that lost them.

Then find out what it *does*, before writing any code:

```bash
node "$WS/behaviour-probe.mjs" --url <original> --scope "<region>" [--dark]
```

It lists what animates on its own and, per control, what hover changes and what Enter,
Space and the arrows do. Twenty seconds here is worth an hour later: one dropdown
replica was finished and diffing at 0 px before anyone noticed Enter did not open the
original's menu. Write down every "(no effect)" too — that is behaviour to reproduce.

### 3. Extract, part by part

- **Which modules to read at all** (on a React Server Components page) →
  `rsc-refs.mjs capture/000-document-<page>`: the streamed payload names every client
  component the page mounts, so you grep a handful of modules instead of hundreds.
- **Logic, data, animation** → `bundle-modules.mjs --grep "<text visible in that part>" --deps`.
  Text found in no module means that part is server-rendered: use the DOM instead.
  Read `references/bundle-forensics.md` for chunk formats, import following and
  library fingerprints.
- **Structure and classes** → `dom-dump.mjs --selector <region>`; open overlays first
  with `--click`. The dump keeps icon classes and collapses repeated siblings with
  counts ("×32 … ×22"), which often *is* the data.
- **Rules not visible as utilities** (design-system classes like `.cn-button-*`,
  hover/focus/active, keyframes) → `css-rules.mjs --match … --scope …`.
- **Tokens and typography** → `tokens.mjs`, then the declarations themselves with
  `css-rules.mjs --decl="--background:|--accent:"`. Note `font-feature-settings`: a host
  that sets `"cv11","ss01"` changes Geist's glyphs.
- **Icons** → the icon modules in the bundle (one tiny module per icon, exact path data),
  or `icons.mjs`, opening menus with `--click` so their icons are included.
- **Anything ambiguous** (an icon with no size class, an offset, a value the CSSOM
  printed as empty) → `measure.mjs`. Measure, don't guess.
- **Rendering math that depends on a library version** (bar widths, tick rounding,
  arc paths, fuzzy search) → grep the minified expression in the original, then
  `fingerprint-version.mjs` and pin that exact version.

### 4. Build

Port the code; don't reinterpret it. Read `references/replica-architecture.md` before
writing: it covers scoping tokens so the host theme cannot leak, translating
design-system classes into utilities without breaking layer precedence, containing an
app shell (sidebar overlay, portals, sticky header) inside a block, container queries
instead of viewport breakpoints, and giving the user a full-page route.

Deliver it where the project keeps such things, the way its siblings are built (find the
closest existing component and follow its package, demo, registry entry and stylesheet).
A faithful monolith is only half the job: **make it something a person can reuse.**

- One deliverable per install unit, and one component per module of the original's graph.
- A page is a composition: export every section with its copy as props (the original's
  text as defaults), a root that carries the palette, and a default component that
  composes them. Data — arrays, labels, hrefs, image URLs, presets — is never a constant
  the user has to go and find.
- Keep the original's children exactly as it builds them. `["About ", brand]` is two text
  nodes; the string `"About beUI"` is one, and it kerns 1/64px narrower.
- Files that use hooks or motion start with `"use client"`: they get copied into projects
  with server components.
- **Refactor under verification.** Get the straight port to PASS first, then split it, and
  run `verify` again: componentizing must not move a pixel, and this is what proves it.

### 5. Verify until the verdict is PASS or every difference is explained

One config, one command. Copy `replica.config.example.mjs`, keep the sections that apply
(`page` for a whole page, `elements` for a block inside someone else's page, `states` for
the interaction matrix), and verify against a **production build** of the replica:

```bash
node "$WS/verify.mjs" --config replica.config.mjs            # full pass, original from cache
node "$WS/verify.mjs" --config replica.config.mjs --changed  # after each fix: only what failed
node "$WS/verify.mjs" --config replica.config.mjs --final    # before delivering: original recaptured
```

It runs the same checks you could run by hand — pixels at every width and theme, the
element diff, the DOM diff, the interaction matrix, every computed property per state, the
theme scales — writes each one's full output to `<out>/logs`, and prints about thirty
lines: one per check, the worst items, the computed differences grouped by cause, and a
verdict. Read the summary, not the logs; open a log only for the item you are fixing.

- The loop is `--changed`: the original is cached and only failing items rerun, so it
  costs seconds. It can end at **LOOP CLEAN**, never at PASS — a fix in one place moves
  another (a dependency pin, a wrapper), so only a full pass can say PASS.
- Deliver on `--final` only. A full pass on a cached original says so in its verdict.
- A pixel diff fails on anything over the threshold **and** on faint pixels (threshold 4)
  that fill a cell — a surface, a gradient, a glow. Sparse faint pixels are edge
  antialiasing and are only counted. A thin faint line (a border a few levels off) is
  sparse too: computed-diff is what catches it, so keep `states` in the config.
- An action that changes nothing fails unless the state says `noEffect: true`, which you
  set only after reading the computed value that proves it.
- Cover both sides of each breakpoint (1024 and 1023, 768 and 767): a container query
  that is off by the width of a padding only shows at the edge.

For every failing item: zoom the hot cell with `png-tools.mjs pair`, `measure.mjs` the
element on both pages, read the relevant source or library code, fix, rebuild,
`--changed`. `references/verification.md` has the investigation playbook and the traps
that produce false passes and false failures — read it before the first run, because
several of them are configuration (tall viewports for `whileInView`, freezing loops,
the position anchor).

A residual difference is acceptable only when you can name its cause and it is not a
design difference. Prove it instead of assuming it; the playbook lists the proofs
(same compositing mode on both sides, the replica against itself at another offset,
a forced repaint).

### 6. Deliver

Tell the user, in their language:

- where to see it, including a full-page URL: a docs preview narrower than the
  original's `md` breakpoint shows the mobile layout, which reads as "the sidebar
  doesn't expand";
- what was checked (the `--final` summary: widths, number of states, dark, mobile) and
  the result;
- every residual difference with its cause, and everything that was frozen or hidden for
  the diff (a canvas, a loop) and how its motion was verified instead;
- side effects: version pins, files you removed or rewrote, new routes.

## Build lessons that cost the most time

Verification traps live in `references/verification.md`. These are about getting the
replica right in the first place.

- **Hover color vs utility color.** In shadcn "style-*" systems the component rules
  live in `@layer base`; any utility on the element wins. A `text-muted-foreground`
  utility on a sidebar item beats the base rule's hover color, so hovered items stay
  gray while only the background changes. Reproduce the precedence, not just the
  declarations.
- **Library math.** recharts 3.9+ rounds bar width, 3.8 floors it: 19px vs 18px at
  1280 wide, invisible at 1440. Pin the version the original ships.
- **Stale local installs.** A package with its own `node_modules`/lockfile inside a
  workspace kept resolving the old version after `bun add`. Check the version the
  *app* resolves, not the one in `package.json`.
- **Write tokens the way the original declares them — every rule that declares them.**
  Reading `--foreground` back from the browser gives a converted value, and re-declaring
  that converts it again (`#0b0b0b` came back as rgb(10,10,10)). Copy the declaration
  verbatim, and look for a second one: a build emits hex first and the real value under
  `@supports (color: lab(0% 0 0))`, for `:root` *and* for `.dark`. Missing the dark
  `@supports` block made every accent rgb(0,218,219) instead of rgb(0,223,225).
- **Invisible characters in minified strings.** A word separator that reads as `" "` was a
  non-breaking space: with a plain space the inline-block collapsed to zero height and the
  headline lost 11px per line. When a string's only job is spacing, check its bytes.
- **`theme()` bakes in the host's light value.** Rewrite `theme(--color-x/.4)` in
  arbitrary values as `--theme(...)`, or the dark variant uses the light color.
- **The host page's base layer is part of the block.** The original inherits rules that
  belong to its page, not to the component: `button:not(:disabled) { cursor: pointer }`,
  `body { font-synthesis-weight: none; text-rendering: optimizeLegibility }`. No
  screenshot shows a cursor. Find them with `css-rules.mjs --decl` and re-declare them
  scoped to the block root.
- **The host theme redefines Tailwind's scales.** A project that sets `--ease-out` or
  `--radius-lg` in its own `@theme` changes what `ease-out` and `rounded-md` mean inside
  your block: same classes, different animation curve and corners. `theme-leak.mjs`
  lists them; redeclare the scales on the block root.
- **A portal leaves the block's scope.** An overlay portaled to `<body>` stops
  inheriting the root's `color`, `font-*` and tokens, and picks up the host's instead —
  visible only in dark mode, where the two foregrounds differ. Give the portal wrapper
  the same classes and `data-slot` as the root.
- **Use the original's font files when the license allows.** The same family from another
  distribution (an npm package instead of the site's own woff2) is a different build of
  the font: boxes match to 0.1px and every glyph still differs.
- **The trigger is not the component.** A dropdown replica matched pixel for pixel and
  still behaved differently: the original's trigger was a motion button whose press
  gesture dispatches a synthetic `pointerdown` for keyboard presses, and the menu
  toggles on `pointerdown` as well as on Enter — so the first Enter opened and closed
  it, and Space was what opened the menu. Test the keyboard on every control and
  reproduce the mechanism you find, not the one you assume.
- **Viewport vs container.** The user viewed the replica inside a 748px docs preview
  and concluded the hover sidebar was missing. Use container queries in the block and
  provide a full-page route.
