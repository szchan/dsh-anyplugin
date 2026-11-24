# Writing a mod for dsh-anyplugin

This page is for someone authoring a mod that dsh-anyplugin loads. It is not a
description of Claude Code and it does not redistribute anything from the
pinned `claude-code.d.ts` (D14). The declaration shipped in the root package as
`types/mod.d.ts` is *ours*: it is generated from the fidelity ledger,
`fixtures/mods/coverage.json` (D55), by `scripts/gen-mod-types.mjs`, and it
describes exactly the surface this layer serves.

## The types describe what this layer serves

- The 9 served `$` namespaces and their 26 members
  (`fixtures/mods/coverage.json` `totals.namespaces`, `totals.methods`) are
  typed with the shapes the mod host actually returns: `$.fs.read(path)` is
  `Promise<string | {base64: string}>`, `$.vcs.detect({path})` resolves to the
  working-copy record or `null`, `$.command.register({name, description})`
  resolves to `{command: string}`.
- The 24 served event routes (`fixtures/mods/coverage.json` `totals.events`) are
  the keys of `ServedEvent`/`Hook`: the 21 `classic.*` routes, `prompt.context`,
  `session.start` and `tool.call`. An unserved event name is not in that union,
  so registering one is a compile error.
- Inside a served shape, fields this layer does not model stay declared as
  optional with a `planned` note rather than being guessed — the matcher grammar
  and the classic-hook payload fields are the main examples. Served members keep
  the pin's class (D57: an async host method stays async in the declaration),
  while the declaration itself is our authored surface, not a copy of the pin
  (D95).

## Unsupported members are compile errors by design

Members the layer does not serve are still declared, but typed `never` with a
`@deprecated` note that gives the reason:

```ts
// inside the Dollar interface
vcs: {
  /** @deprecated this layer does not serve it: vcs.isolate is refused with ERR_MOD_HOST_VCS_UNSUPPORTED ... */
  isolate: never;
};
/** @deprecated this layer does not serve it: see the fidelity report */
state: never;
```

So `$.process.run(...)` fails on your machine at type-check time, with the same
reason the runtime would give you at run time. That is deliberate: an absent
member is not a stub to work around, it is a surface this layer does not have
yet. The runtime refuses with a typed `ERR_MOD_HOST_*` code, never a silent
no-op.

## No Claude Code installation is needed

The `claude-code` module specifier is the authoring convention foreign mods
already use; dsh-anyplugin does not resolve it and does not need Claude Code
installed to load or check your mod (D96). Map the specifier to the shipped
declaration in your project's `tsconfig.json`:

```json
{
  "compilerOptions": {
    "paths": {
      "claude-code": ["./node_modules/dsh-anyplugin/types/mod.d.ts"]
    }
  }
}
```

`claude` itself is a development and CI oracle for this repository only (D8);
it is never part of an install or run path.

## The generated file is not hand-editable

`types/mod.d.ts` is generated. Do not edit it:

- `npm run gen:types` rewrites it from the ledger;
- `npm run check:types` (part of `npm run check` and a CI step) fails when the
  committed file and the ledger disagree, and when the file grows past the
  16 KiB raw cap the decision sets.

If the declaration says something you believe the runtime does not do, the
runtime and the ledger are the authority, not the file: report it against
`scripts/gen-mod-types.mjs` / `fixtures/mods/coverage.json` and let the
generator change. The per-fixture fidelity report is what records what is
served, and it is what the generator is checked against.
