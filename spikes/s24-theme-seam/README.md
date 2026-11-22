# S24 — the theme seam

**Question.** Can a plugin — not the host bootstrap — register a terminal
palette, and can such a palette express every colour in Claude Code's
`themes/<slug>.json`?

**Answer: partially, at both pins. The recorded probe is a partial seam.**
A plugin can register an alias-token CSS theme through the documented
`ctx.theme` service, and that seam is real. Two of Claude Code's 72 named theme
roles reach the terminal through it: `text` → `--dsw-alias-label-primary` and
`background` → `--dsw-alias-bg-base`, applied by the layout presenter to
`document.body` and read back by the terminal as computed foreground/background.
The other 70 roles have no DSH terminal counterpart, and the terminal's ANSI 16
are written only from xterm OSC 4/104. F2 stays `planned`; the ANSI-16 palette
is the named host gap (D75).

Pins: DSH Desktop `0.2.2-rc.2` and fetched `0.2.2-rc.5`; Claude Code
`2.1.329`.

## What was reached

The theme package is not a rumour:

- `@deepseek-ai/dsh-client-ui-theme` is present in the Desktop `0.2.2-rc.2`
  install and is published at `0.2.2-rc.5` on npm. The rc.5 package was only
  absent from the fetched `.harness/0.2.2-rc.5` **union**, not from upstream.
  This spike adds the theme, layout and terminal packages to
  `HARNESS_PACKAGES`, so both pins are exercised from fetched trees in CI.
- Its README documents the plugin surface: “A composition can register a
  third-party theme id with alias-token overrides through `ctx.theme`; the
  override layer folds into the active snapshot's tokens in registration
  order.”
- `ThemeDefinition.tokens` is documented in-source as “Alias-layer overrides
  applied as inline CSS variables over the base palette.” `ThemeTokens` is
  `Record<string, string>`: the inspector's 14 built-in tokens are a curated
  list, not a registration limit. A spike-registered
  `--dsw-alias-s24-probe` token is accepted and exported as a CSS value.
- The spike loads the real `lib/client.js` in `node:vm`, enumerates its
  exports and `ThemeRuntime` prototype/own keys, instantiates the runtime,
  registers a theme, activates it, and observes the CSS tokens in the active
  snapshot.
- The two-role bridge is real:
  `dsh-client-ui-layout/src/client/theme-presenter.ts` writes every active
  token with `body.style.setProperty(name, value)`;
  `dsh-client-ui-sidebar-terminal/src/client/terminal.module.css` consumes
  `--dsw-alias-label-primary` and `--dsw-alias-bg-base`; and
  `terminal.tsx:142` passes the resulting computed
  `style.backgroundColor`/`style.color` to xterm.

## The remaining anchor

`@deepseek-ai/dsh-client-ui-sidebar-terminal/src/client/terminal-theme.ts:57-64`:

```ts
update(background: string, foreground: string): void {
  if (this.defaults.background === background && this.defaults.foreground === foreground) return
  this.defaults = {
    background, foreground, cursor: foreground, cursorAccent: background,
    selectionBackground: foreground, selectionForeground: background, selectionInactiveBackground: foreground,
  }
  this.apply()
}
```

The only arguments are the resolved CSS background and text colour. There is
no palette argument. `apply()` (`terminal-theme.ts:72-79`) writes ANSI keys
only from `this.indexed`, which is populated exclusively by the xterm OSC 4
handler and cleared/deleted by OSC 104. No `ctx.theme`, `ThemeDefinition`,
`--dsw-*` token or theme token reaches that map. The spike also executes the
real `TerminalTheme` class with a fake xterm parser and observes exactly seven
`theme` keys after `update()`.

“No client-plugin surface” would be too strong: `ctx.webTerminals` is public,
and a client plugin can write pty **input** through a terminal view. That is
not a palette registration. The accurate statement is: there is no direct
ANSI-16/palette output API, and the only palette writer is OSC 4/104.

The view is the second half of the same anchor: `terminal.tsx:142` calls
`colors.current!.update(style.backgroundColor, style.color)` with the computed
style of the terminal element. `terminal.tsx` reads only
`theme.fontFamilies.terminal` and `theme.fontSizes.terminal` from the theme
snapshot. The package injects the `theme` service but never registers a
palette.

## Claude Code's theme surface

From the pinned native binary
`.claude-code/2.1.329/node_modules/@anthropic-ai/claude-code-linux-x64/claude`:

- Six bases: `light`, `light-ansi`, `dark-ansi`, `light-daltonized`,
  `dark-daltonized`, plus the default dark palette.
- Every base has exactly **72** named TUI roles (`text`, `background`,
  `success`, `error`, `diffAdded`, the `rainbow_*` family, …).
- A theme value is validated as `rgb(r,g,b)`, `#rgb`, `#rrggbb`,
  `ansi256(n)`, or `ansi:<name>`; `ansi:<name>` must be one of the 16 SGR
  names (`black` … `whiteBright`).
- Overrides are filtered to keys that already exist in the base palette
  (`Object.hasOwn(r,n) && Uce(g)`).
- Plugin manifests can declare `themes` / `experimental.themes` component
  paths, but the pinned npm package ships no `themes/` directory and
  `sdk-tools.d.ts` has no theme declaration.

Mapping to DSH:

| Claude theme field | DSH terminal target | Coverage |
| --- | --- | --- |
| `text` | `--dsw-alias-label-primary` → computed `style.color` → xterm `foreground` | 1 role |
| `background` | `--dsw-alias-bg-base` → computed `style.backgroundColor` → xterm `background` | 1 role |
| the other 70 named roles | none | 0 |
| `ansi:<name>` / `ansi256(n)` **values** | no host palette entry | 0 |
| ANSI 16 palette slots | OSC 4/104 only, not themeable | 0 |

The terminal's two computed inputs are CSS-derived, not a mapping of Claude's
roles; they cannot carry the other 70 roles and cannot set the 16 ANSI entries.
F2's acceptance test — “every declared colour” — is therefore not met, but the
seam is partial, not absent, so the row stays `planned`.

## Falsifiability

The spike is not a line-number snapshot. It enumerates:

- the theme bundle's exports and `ThemeRuntime` prototype/own keys;
- the runtime snapshot and active-theme keys;
- the terminal bundle's exports, every `src/client` export name and
  registration call;
- the executed `TerminalTheme` instance's own keys, prototype, and the exact
  seven `update()` fields; and
- the layout presenter and terminal CSS that carry the two mapped roles.

A mutation that adds `ThemeRuntime.prototype.registerTerminalPalette` reddens
two assertions; a mutation that adds a `palette` field plus an ANSI write to
`TerminalTheme` reddens four. Both mutations were applied to the fetched
`0.2.2-rc.5` tree and the spike exited `1`; PR #218 records the output. This is
why D75 may claim the spike fails on a palette channel.

## Fixture

No `themes/<slug>.json` fixture was captured and none was invented. The pinned
CLI has no `theme` subcommand or `--theme` flag; `/theme` is an interactive TUI
command, and the compiled schema above is the strongest non-interactive
evidence available. A fixture would not close F2: even a perfect `themes/` file
would land only on the two CSS roles until the terminal exposes an ANSI-16
palette.

## Running it

```bash
# one fetched pin (from CI, or after scripts/fetch-harness.mjs)
DSH_HARNESS_DIR=$PWD/.harness/0.2.2-rc.5 \
DSH_HARNESS_VERSION=0.2.2-rc.5 \
CLAUDE_BIN=$PWD/.claude-code/2.1.329/node_modules/@anthropic-ai/claude-code-linux-x64/claude \
node spikes/s24-theme-seam/run.mjs

# rc.2: repeat with .harness/0.2.2-rc.2 and DSH_HARNESS_VERSION=0.2.2-rc.2
```

The spike exits `0` only when the recorded answer holds at every assertion,
`1` when an assertion fails (including a missing pinned Claude binary), and `2`
when the environment or harness packages are missing. It reads the real
packages from `DSH_HARNESS_DIR`; it does not vendor or transform either
artifact. The terminal class is copied to a temporary directory for execution
only because Node refuses type-stripped imports from `node_modules`.

## Why the class stays `planned`

F2 is `planned`, not `unsupported`: the plugin theme API exists, two roles have
a real DSH destination, and the v0.4 roadmap keeps the slot. The ANSI-16
sub-surface is the named host gap. D75 says F2 cannot be complete until DSH
exposes a palette channel or a decision formally removes that sub-surface from
the declared set; no “every declared colour” bar is invented. A fixture and a
materializer follow when that host gap closes.
