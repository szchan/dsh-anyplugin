# S14 — load a `.tsx` mod graph through the classic pragma

**Question.** Can the pinned `diff` mod's graph — 579 `.ts` and 21 `.tsx`
modules — be loaded end to end when every `.tsx` module goes through one narrow
classic JSX transform and the `node:vm` realm provides only `h` and `Fragment`,
and does the loaded graph register the same `on()` sites the static scanner
sees?

**Answer.** Yes. All 21 `.tsx` modules transform, type-strip, link and evaluate
in one realm; the whole graph loads; its 10 registrations are the scanner's 10
`on()` sites over the same 8 unique events, with the scanner's 23 `$.` calls and
0 dynamic sites. Nothing renders: `h()` builds `{ type, props, children }`
descriptors, nothing more. The spike runs **122 checks, all green**:

```bash
node --experimental-vm-modules spikes/s14-jsx/run.mjs
# S14: 122/122 checks passed
# report: spikes/s14-jsx/out/report.json
```

Every check prints and lands in `out/report.json`. A run that records zero
checks exits 1 (the rule stated in `docs/ARCHITECTURE.md` §10, the S9 note), as
does any failed check. `out/` is gitignored.

## Pin and artifact

| Field | Value |
| --- | --- |
| claude-code | `2.1.322` |
| commit | `6e1e44f6433bfa17d198e932bff53373aa229eea` |
| directory | `mods/diff/hooks` |
| entry | `register.ts`, 33,891 bytes |
| sha256 | `cce8adf7b3218f33347707ffbfb25ff3294c184d440dfb49fa540656146debab` |
| tree | 579 `.ts`, 21 `.tsx` |

The spike reads `ANYPLUGIN_MOD_TREE` when set, else `.mods/<commit>`, else runs
`node scripts/fetch-mod.mjs` itself. The entry sha256 and byte count are
asserted before the run and again after it. The sources are never committed or
edited.

## Q1 — the transform is narrow and gated

Each `.tsx` file's **leading comment block** must declare:

```tsx
/* @jsxRuntime classic */
/* @jsx h */
/* @jsxFrag Fragment */
```

The host reads only that leading block (the pragma is not accepted from later
comments), requires `@jsx` to be exactly the identifier `h`, and refuses a
non-`classic` `@jsxRuntime` or a `@jsxFrag` other than `Fragment`. Refusals are
`ModHostError` with code `ERR_MOD_HOST_TSX`, and the reason names the file:

- no pragma → "must declare the classic pragma (`@jsx h`) in its leading
  comment block";
- `@jsx h2` → "only the identifier `h` is loadable";
- `@jsxRuntime automatic` → "only the classic runtime is loadable".

The spike runs those three refusals as negative checks. All 21 pinned `.tsx`
declare the pragma, and none imports `h` or `Fragment` — they are realm globals.

The transform is `@babel/plugin-transform-react-jsx` with runtime `classic`,
pragma `h`, fragment pragma `Fragment`, over a parser that already understands
JSX and TypeScript. It is a real parser, not a regular-expression rewrite, and
it runs in memory at load time. 21/21 transform; 20 emit `h()` calls (the
JSX-free `views/body/list-block-of.tsx` emits none); 21/21 then type-strip with
`module.stripTypeScriptTypes(source, { mode: 'strip' })` and parse as
`vm.SourceTextModule`.

**What "narrow" does not claim.** Babel reprints the module, so bytes and source
positions are not preserved. The semantic claim is narrower: only JSX syntax is
rewritten, and nothing else is transformed (no bundling, no module rewriting,
no down-levelling). The scanner still runs on the authored text; it never sees
this output.

## Q2 — one realm holds the real graph

The realm is `vm.createContext({ ...jsxRealmGlobals(), console })`: `h` and the
`Fragment` symbol are the only additions. `typeof $`, `typeof process` and
`typeof URL` are all `undefined`, so a mod cannot reach a host object at load
time.

Linking the entry builds the whole authored graph once: **505 `.ts` modules and
21 `.tsx` modules**. All 21 `.tsx` modules are reachable through
`views/index.ts`, linked, and evaluated; each is also evaluated by its own
`evaluate()` call in the spike. Resolution counts are:

| Behavior | Resolutions |
| --- | --- |
| directory index (extensionless, `'.'`) | 795 |
| `.js` specifier → `.ts` | 246 |
| `.jsx` specifier → `.tsx` | 21 |

S13 counted 737 directory resolutions with name-preserving `.tsx` **stubs**.
The real `.tsx` modules import their own siblings, which adds 58 directory
resolutions and no new modules — the stub graph could not see those imports.

Calling the authored `divider()` from `views/sections/divider.tsx` returns
`{ type: 'Text', props: { dimColor: true, wrap: 'truncate-end' }, children:
['───'] }`: the evaluated JSX really calls the realm's `h`.

## Q3 — registrations are the scanner's

`register.ts` is evaluated in the same realm and its authored `register(on)` is
called with a recorder:

| Claim | Value |
| --- | --- |
| runtime `on()` sites | 10 |
| unique runtime events | 8 |
| scanner `on()` sites | 10 |
| unique scanner events | 8 |
| scanner `$.` calls | 23 |
| scanner dynamic sites | 0 |

The runtime event order and the scanner's order are identical
(`q3.runtime.matches-scan`), matcher presence matches
(`q3.runtime.matchers-match-scan`), every handler is a function, and the entry
sha256 is unchanged after the load.

## Negative results

| Probe | Result |
| --- | --- |
| `.tsx` without the pragma | `ERR_MOD_HOST_TSX`, reason names the file and the leading comment block |
| `.tsx` with `@jsx h2` | `ERR_MOD_HOST_TSX`, "only the identifier `h` is loadable" |
| `.tsx` with `@jsxRuntime automatic` | `ERR_MOD_HOST_TSX`, "only the classic runtime is loadable" |
| stock Node with the `.tsx` extension | `ERR_UNKNOWN_FILE_EXTENSION` (S13 Q1); extension handling alone never loads a mod |
| a direct `.tsx` import specifier | still `ERR_MOD_HOST_TSX`; authored JSX imports spell `.jsx` (D30) |

## What this establishes, and what it does not

Establishes: the pinned graph can load with one declared transform and two
realm globals; all 21 `.tsx` modules are exercised; registration parity with
the scanner holds end to end; the pragma gate refuses the cases D34 says it
must.

Does not establish: rendering. `h()` returns a descriptor triple and the host
does not draw it (D34 keeps the element runtime out of scope). It also does not
establish source-position preservation, byte-for-byte preservation, support for
a foreign pragma or the automatic runtime, or that every `.tsx` mod in the wild
follows this convention — only the pinned 21 do.

## Reproduce

```bash
ANYPLUGIN_MOD_TREE=/path/to/.mods/6e1e44f6... \
  node --experimental-vm-modules spikes/s14-jsx/run.mjs
```

Without `ANYPLUGIN_MOD_TREE`, the spike uses `.mods/<commit>` or fetches the
pin with `node scripts/fetch-mod.mjs`. The run is deterministic against the
pin; the only environment-dependent step is that fetch.
