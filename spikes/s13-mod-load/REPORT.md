# S13 — load an authored mod unmodified and run one of its hooks

Ticket: [#30](https://github.com/szchan/dsh-anyplugin/issues/30) · worker-s13

**Question.** Can the host take upstream's `diff` mod *as authored* — no
transpile, bundle, minify or rewrite — load it, see the same registration the
static scanner sees, and fire one event through it?

**Answer.** Yes for the `.ts` graph, with a host resolver for three resolution
behaviors and a `node:vm` realm. No for mods that reach JSX (`.tsx`): type
stripping refuses 20 of the 21 modules, and the one it accepts still cannot be
loaded as `.tsx` by stock Node. The spike runs 89 assertions, all green:

```bash
npm run spike:s13          # node --experimental-vm-modules spikes/s13-mod-load/run.mjs
# S13: 89/89 checks passed
# report: spikes/s13-mod-load/out/report.json
```

Every claim below is a named check in `out/report.json`. A run that records
zero checks exits 1 (the rule stated at `docs/ARCHITECTURE.md:1332`; D19 is the
waterfalls decision), as does any failed check.

## Pin and artifact

| Field | Value |
| --- | --- |
| claude-code | `2.1.322` |
| commit | `6e1e44f6433bfa17d198e932bff53373aa229eea` |
| path | `mods/diff/hooks/register.ts` |
| bytes | 33,891 |
| sha256 | `cce8adf7b3218f33347707ffbfb25ff3294c184d440dfb49fa540656146debab` |
| tree | 579 `.ts`, 21 `.tsx` under `mods/diff/hooks` |

`run.mjs` fetches the raw entry plus a sparse checkout (`git init`,
`sparse-checkout set mods/diff/hooks`, `fetch --depth 1 <sha>`) into
`out/cache/`, asserts size and sha256 before loading, and asserts the sha
again after every run (`q1.artifact.*`, `q1.tree.*`, `q1.tree.sha256-after-run`).
The artifact is never committed or edited; `out/` is gitignored. `--refresh`
refetches.

## Q1 — can Node load the `.ts` source unmodified?

**Stock Node 24.22.2 cannot resolve the graph.** Node's type stripping is
sufficient for parsing — all 579 `.ts` files strip with 0 failures
(`q1.strip.all-ts`) — but the authored specifiers are not stock Node ESM, and
stock Node refuses the `.tsx` extension.

Type stripping, with `module.stripTypeScriptTypes(source, { mode: 'strip' })`:

- entry output is **33,891 bytes / 1342 lines**, byte-identical length to the
  input (`q1.strip.bytes-preserved`, `q1.strip.lines-preserved`);
- `on('session.start', ...)` stays at **line 938**
  (`q1.strip.session-start-line-preserved`);
- the only bare specifier is `import type { ... } from 'claude-code'`; it is
  erased (`q1.strip.claude-code-import-erased`), so the shim is never requested
  (`q2.*.claude-code-requests` = 0 in both realms);
- no `import type` remains (`q1.strip.no-typescript-left`).

Positions are preserved because `strip` replaces type syntax with whitespace
rather than deleting it. That matters for the scanner: it runs on the authored
text and its line numbers are the authored ones.

### The three resolution behaviors the graph needs

The graph is 505 reachable `.ts` modules out of 579. It uses four specifier
shapes that exercise **three** host resolution behaviors. These are our host
obligation, not an upstream specification:

| Authored shape | Example | Host behavior | Reachable hits |
| --- | --- | --- | --- |
| extensionless path | `import ... from './ask'` | resolve to `ask/index.ts` | 737 directory-index resolutions (with `'.'`) |
| `'.'` self-import | `export * as default from '.'` | resolve to the importing directory's `index.ts` | included above |
| `.js` specifier, `.ts` file | `export * from './array-of.js'` | resolve to `array-of.ts` | 246 |
| `.jsx` specifier, `.tsx` file | `from './detail-view.jsx'` | resolve to `detail-view.tsx` | 21 |

The resolver has **no other candidate branches**: no exact-file fallback, no
`.js`→`.tsx`, no explicit extension fallback, no `index.tsx`. The spike asserts
the exercised set is exactly `directoryIndex`, `jsToTs`, `jsxToTsx`
(`q1.rule.exercised-behaviors`, `q2.*.resolution`).

Resolution changes **no bytes**; the only transform is type stripping, which
is in-memory and length-preserving. The scanner still sees the authored
`on('event')` / `$.ns.method` call sites.

The failure of each stock shape, captured by child processes that import a
minimal fixture (not the mod):

- extensionless directory: `ERR_UNSUPPORTED_DIR_IMPORT` —
  `Directory import '<...>/hooks/ask' is not supported resolving ES modules imported from <...>/register.ts`
  (`q1.plain-import.refused`, `q1.plain-import.states-directory`).
- `.js` specifier with only `.ts` present: `ERR_MODULE_NOT_FOUND` —
  `Cannot find module '<...>/helper.js' imported from '<...>/entry.ts'`
  (`q1.stock.js-specifier.refused`).
- `'.'` self-import: `ERR_UNSUPPORTED_DIR_IMPORT` —
  `Directory import '<...>/res/' is not supported resolving ES modules imported from '<...>/res/index.ts'`
  (`q1.stock.dot-self.refused`).

### The `.tsx` wall

There are 21 `.tsx` modules and 21 `.jsx` specifiers that point at them. With
the resolver above and nothing else, loading stops at:

```
TypeError [ERR_UNKNOWN_FILE_EXTENSION]: Unknown file extension ".tsx" for
<...>/views/detail/detail-view.tsx
```

`stripTypeScriptTypes` was run on **every** `.tsx` module in both modes. **20 of
21 refuse**, and the two modes agree on every file
(`q1.tsx.strip-refused-count`, `q1.tsx.strip-error-ident`,
`q1.tsx.strip-error-comma`, `q1.tsx.transform-agrees`):

- 19 fail with `ERR_INVALID_TYPESCRIPT_SYNTAX: Expected '>', got 'ident'`;
- one, `views/prelude-of/prelude-of.tsx`, fails with
  `ERR_INVALID_TYPESCRIPT_SYNTAX: Expected ',', got '.'`;
- one, `views/body/list-block-of.tsx`, is JSX-free and strips in both modes.
  It is still not loadable: a direct stock import of that file returns
  `ERR_UNKNOWN_FILE_EXTENSION: Unknown file extension ".tsx" for
  <...>/views/body/list-block-of.tsx`
  (`q1.tsx.strippable`, `q1.stock.tsx-extension.*`).

To answer the `.ts` questions the spike substitutes a **name-preserving stub**
for each `.tsx` leaf: the stub re-exports every top-level `export function` /
`const` / `let` / `var` / `class` name as `undefined`, so imports resolve and
the `.ts` spine evaluates. The stub is generated in `out/`, never written into
the tree, and is a probe scaffold — **not** a host design. It proves the 505
`.ts` modules load and register; it does not make the mod runnable.

What this means for §3.7: type stripping is the only transform applied, and it
is position-preserving and purely syntactic. JSX is a second, unavoidable
transform (classic `h`/`Fragment` factory, per the `.d.ts` header) that
produces different text, so it needs an explicit decision; it cannot ride on
"type stripping". The one JSX-free `.tsx` does not change that conclusion, and
its extension is still refused by stock Node.

## Q2 — which realm?

Both realms load the same authored graph: **505 `.ts` modules + 21 stubs**
(`q2.realm.module-count-parity`), register the same 10 sites
(`q3.realm.register-parity`), and see no `$` binding.

| | same-thread `import()` + `module.registerHooks` | `node:vm` `SourceTextModule` |
| --- | --- | --- |
| flag | none | `--experimental-vm-modules` (`q2.vm.flag-required`; without it `SourceTextModule` is `undefined`) |
| globals | shares the host realm: `process` and `URL` are visible (`q2.same-thread.realm-has-node`) | own context: `process`, `URL` and `$` are all `undefined` (`q2.vm.realm-isolated`); evaluating `$` throws `ReferenceError` (`q2.vm.dollar-read-throws`) |
| resolution | host resolve/load hooks | host linker + explicit `stripTypeScriptTypes` |
| lifecycle | one import, no handle | create → `link()` → `evaluate()` |
| scanner | unaffected | unaffected |

**Build on `vm.SourceTextModule`.** The `.d.ts` header states a hooks module
runs *"in an environment of its own: no DOM, no Node"*; a same-thread import
contradicts that before the mod executes a line. The vm route also gives a
single choke point for the loader and a per-mod context, which is what a
capability boundary needs.

`$` must provide **nothing at load time**. It is not a global in the mod
source: it is the first parameter of each handler (`($, e, next)`), and the
module-level code is only imports plus `export function register(on)`. The
same-thread route installs a counting getter for `$` around `import()` and
`register()`: it records **0 reads** and would throw `ReferenceError` on a
read (`q2.same-thread.dollar-reads`). The vm context has no `$` binding at all
(`q2.vm.realm-isolated`, `q2.vm.dollar-read-throws`). Only when a handler runs
does the host pass the per-event `$`.

The vm phase order is load-bearing: create every module first, call
`entry.link(linker)` **once**, then `evaluate()`. Linking children from inside
the linker throws
`ERR_VM_MODULE_LINK_FAILURE: ... that is not linked` (observed while building
the spike; the working loader is the two-phase one in `run.mjs`).

Caveats: `vm.SourceTextModule` is experimental; the spike proves isolation of
the *global surface* it tests, not memory/CPU containment, and does not claim
a security boundary. A host must still cap timers, promises, and allocation.

## Q3 — does registration match the scanner?

Yes. `scanModSource` on the authored file reports **10 `on` sites, 8 unique
events, 23 `$.` calls, 0 dynamic** (`q3.scanner.*`). The runtime `register(on)`
records the same 10 calls in source order, in both realms
(`q3.runtime-matches-scanner`, `q3.vm-matches-scanner`), and the same 8
matchers (`q3.runtime.match-count`,
`q3.runtime.matcher-keys-seen-by-scanner`).

| # | line | event | matcher (runtime value) |
| --- | --- | --- | --- |
| 1 | 938 | `session.start` | — |
| 2 | 982 | `ui.render` | `{ component: 'PromptHint' }` |
| 3 | 1003 | `ui.render` | `{ component: 'Pane' }` |
| 4 | 1057 | `command.run` | `{ command: 'diff' }` |
| 5 | 1116 | `ui.close` | `{ id: <Names.PANE_ID> }` |
| 6 | 1158 | `ui.focus` | `{ plugin: <Names.PLUGIN_NAMES> }` |
| 7 | 1180 | `ui.scroll` | `{ requestId: <Names.PANE_ID> }` |
| 8 | 1201 | `command.run` | `{ command: ['clear', 'resume'] }` |
| 9 | 1276 | `tool.call` | `{ tool: [...Tools.EDITING_TOOLS, ...Tools.SHELL_TOOLS] }` |
| 10 | 1294 | `prompt.submit` | — |

Unique events: `session.start`, `ui.render`, `command.run`, `ui.close`,
`ui.focus`, `ui.scroll`, `tool.call`, `prompt.submit`.

`register` has **arity 1** (`register(on)`), so the `.d.ts`
`Register = (on, options) => ...` second argument is ignored by this mod;
calling it with `options` is safe but has no observable effect here.

The scanner needs no realm: it reads the authored text lexically. That is the
point of §3.7 — the capability list and the runtime registration come from the
same bytes.

## Q4 — fire one event

`session.start` is registered with two arguments (`on('session.start',
handler)`), so the handler is the last argument. Firing the synthesized event

```js
{ cwd: '/tmp/s13-fixture', hook_event_name: 'SessionStart' }
```

calls three `$` methods when `$.session.usage()` returns a timestamp
(`q4.*.dollar-calls`):

| call | args | host return used | why |
| --- | --- | --- | --- |
| `$.session.usage()` | none | `{ startedAt: 1700000000000 }` | a number short-circuits the handler's `clock.now()` fallback |
| `$.command.register(...)` | `{ name: 'diff', ... }` | `undefined` | registers the slash command |
| `$.session.messages()` | none | `[]` | empty history |

The count is **conditional**. The authored handler has
`startedAt() ?? engine.now()`; when `usage()` returns `undefined`, the fallback
inserts `$.clock.now()` before `$.command.register(...)`, so the sequence is
**4 calls** (`q4.*.usage-undefined.dollar-calls`):

```
session.usage → clock.now → command.register → session.messages
```

The handler then returns `next(e)`'s value unchanged, and `next` receives the
same event object (`q4.*.returns-next-result`, `q4.*.next-got-same-event`).

The handler's bridge table (`register.ts:938–970`) declares **22** `$`
methods:

```
clock.now  clock.after  clock.every  process.run
fs.stat    fs.list      fs.read      store.get     store.set
settings.read  env.get
session.messages  session.id  session.usage
ui.invalidate  ui.status  ui.log  ui.open  ui.close
command.register
telemetry.mark  telemetry.log
```

`session.start` reaches 3 of them with a timestamp, or 4 with the clock
fallback. The rest are needed only when the handlers that use them fire, which
is why the host should expose `$` as a lazy, per-handler object rather than
construct all 22 eagerly.

The 23rd `$.` call site is `$.ui.resolve` at line 1008, inside the
`ui.render` handler — not part of the `session.start` bridge table.

## Negative results (verbatim)

From `report.negative`; paths are run-specific (`<out>` is
`spikes/s13-mod-load/out`).

1. `stripTypeScriptTypes` on every `.tsx`, modes `strip` and `transform`:
   20 of 21 refuse. 19 with
   `ERR_INVALID_TYPESCRIPT_SYNTAX: Expected '>', got 'ident'`; one
   (`views/prelude-of/prelude-of.tsx`) with
   `ERR_INVALID_TYPESCRIPT_SYNTAX: Expected ',', got '.'`. The exception,
   `views/body/list-block-of.tsx`, returns normally in both modes.
2. Plain `import()` of the entry: `ERR_UNSUPPORTED_DIR_IMPORT: Directory
   import '<out>/cache/tree/mods/diff/hooks/ask' is not supported resolving ES
   modules imported from '<out>/cache/tree/mods/diff/hooks/register.ts'`.
3. Stock `./helper.js` with only `helper.ts` present:
   `ERR_MODULE_NOT_FOUND: Cannot find module '<out>/probes/js/helper.js'
   imported from '<out>/probes/js/entry.ts'`.
4. Stock `from '.'`: `ERR_UNSUPPORTED_DIR_IMPORT: Directory import
   '<out>/probes/dot/res/' is not supported resolving ES modules imported
   from '<out>/probes/dot/res/index.ts'`.
5. Resolver, then stock `.tsx` load: `ERR_UNKNOWN_FILE_EXTENSION: Unknown file
   extension ".tsx" for <...>/views/detail/detail-view.tsx`.
6. Stock import of the one strippable `.tsx`:
   `ERR_UNKNOWN_FILE_EXTENSION: Unknown file extension ".tsx" for
   <...>/views/body/list-block-of.tsx`.
7. Node without the flag: `typeof vm.SourceTextModule === 'undefined'`.

## What this does and does not establish

- Establishes: the `.ts` source loads as authored under a host resolver; the
  registration surface matches the scanner exactly; `session.start` runs with
  a `$` that is passed per handler; the vm realm provides the declared
  no-Node/no-`$` global surface.
- Does not establish: a host, a materializer, an emit path, or IR changes. The
  spike is a probe; the resolver, linker, fake `$`, and `.tsx` stubs are all
  throwaway scaffolding in `run.mjs`. It also does not establish the element
  runtime, `$.ui`, hooks longer than `session.start`, or containment (timers,
  promises, memory, permissions).
- Does not establish `.tsx` support. 20 of 21 `.tsx` modules refuse type
  stripping; the one that strips is still not loadable as `.tsx`. Without a
  sanctioned JSX transform the mod is not runnable end-to-end. That is the
  §3.7 boundary this ticket hits, and it is the subject of the proposed
  decision in the PR.

## Reproduce

```bash
npm run spike:s13                 # uses out/cache if complete; else fetches
node --experimental-vm-modules spikes/s13-mod-load/run.mjs --refresh
```

`out/report.json` contains every check, the scanner output, the runtime
registration in both realms, the `session.start` trace, and the negative
probes. `out/` is gitignored.
