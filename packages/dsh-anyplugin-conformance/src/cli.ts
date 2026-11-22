#!/usr/bin/env node
// arch-check: cli — this file is the published command surface; stdout is its output.
/**
 * The published `dsh-anyplugin` command.
 *
 * `scripts/build.mjs` bundles this file to `lib/cli.js`, which is the single
 * `bin` the npm package declares. It has no parser and no command logic of its
 * own: `USAGE` and `runCli` are imported from the conformance rig, so the npm
 * artifact and the checkout run the *same* command surface (D49) — a flag
 * cannot mean one thing here and another in `npm run rig --`.
 *
 * The front door is the only deliberate difference. `rig --help` with no
 * command is D49's known rough edge (exit 2); a published command that
 * answered `--help` with an error would read as a broken install, so
 * `dsh-anyplugin --help` prints the rig's usage, prefixed by this binary's
 * name, and exits 0. Every other invocation is handed to `runCli` unchanged,
 * including unknown flags and `--flag=value`, which exit 2 there.
 *
 * No static import reaches an `@deepseek-ai/*` package, so `--help` and
 * `install <dir> --dry-run` work on a machine with no DSH installation;
 * commands that genuinely need the upstream oracle fail through the rig's own
 * named error, not through a module-not-found.
 */
import { USAGE, runCli } from './rig.ts'

const HEADER = `dsh-anyplugin — install foreign agent plugins into DeepSeek Harness.

The \`rig\` names below are the conformance rig's; this binary runs that same
CLI, so every command and flag is identical. In a checkout the same surface is
\`npm run rig -- <command>\`.
`

const argv = process.argv.slice(2)
const first = argv[0]
const wantsHelp = first === '--help' || first === '-h' || first === 'help'

if (wantsHelp) {
  process.stdout.write(`${HEADER}\n${USAGE}\n`)
  process.exitCode = 0
} else if (first === undefined) {
  process.stderr.write(`${HEADER}\n${USAGE}\n`)
  process.exitCode = 2
} else {
  process.exitCode = await runCli(argv)
}
