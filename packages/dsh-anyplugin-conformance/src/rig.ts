#!/usr/bin/env node
// arch-check: cli — this file is the command-line surface; stdout is its output.
/**
 * The conformance rig CLI.
 *
 *   rig capture --plugin <dir> [--out <file>] [--name <plugin-name>]
 *   rig verify  --plugin <dir> --golden <file> [--allow-pin-mismatch] [--verbose]
 *   rig diff    --expected <file> --actual <file> [--allow-pin-mismatch] [--verbose]
 *   rig trace   --left <a.jsonl> --right <b.jsonl> [--root <plugin-dir>] [--verbose]
 *   rig report  <plugin-dir> [--json]
 *
 * `capture` records what the upstream host reports about a plugin. `verify`
 * replays the probe and diffs it against that golden, which is how a pin bump
 * that changes behavior gets caught instead of silently redefining "100 %".
 * `report` compiles a plugin in memory and prints what the transplant would do
 * to it — no host, no golden, no installed harness.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { readClaudePlugin } from '../../dsh-anyplugin-dialect-claude-code/src/index.ts'
import type { ClaudePluginIr } from '../../dsh-anyplugin-ir/src/index.ts'
import { diffInventories, normalizeInventory, type Inventory } from './inventory.ts'
import { probeWithClaude, resolvePluginName } from './oracles/claude.ts'
import { readInventoryFile } from './oracles/file.ts'
import { buildTransplantReport, formatDiff, formatTransplantReport } from './report.ts'
import { diffTraces, formatTraceDiff, normalizeTrace, readTraceFile } from './trace.ts'

interface Args {
  command: string
  options: Map<string, string | boolean>
  positionals: string[]
}

function parseArgs(argv: string[]): Args {
  const [command, ...rest] = argv
  const options = new Map<string, string | boolean>()
  const positionals: string[] = []
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]
    if (!token.startsWith('--')) {
      positionals.push(token)
      continue
    }
    const key = token.slice(2)
    const next = rest[index + 1]
    if (next && !next.startsWith('--')) {
      options.set(key, next)
      index += 1
    } else {
      options.set(key, true)
    }
  }
  return { command, options, positionals }
}

function requiredOptions(args: Args, ...names: string[]): string[] {
  return names.map((name) => {
    const value = args.options.get(name)
    if (typeof value !== 'string') throw new Error(`missing --${name}`)
    return value
  })
}

const USAGE = `usage:
  rig capture --plugin <dir> [--out <file>] [--name <plugin-name>]
  rig verify  --plugin <dir> --golden <file> [--allow-pin-mismatch] [--verbose]
  rig diff    --expected <file> --actual <file> [--allow-pin-mismatch] [--verbose]
  rig trace   --left <a.jsonl> --right <b.jsonl> [--root <plugin-dir>] [--verbose]
  rig report  <plugin-dir> [--json]      what the transplant would do, compile-side
  rig report  --ir <file> [--json]       report a compiled IR instead of compiling a directory`

/**
 * The materializer set this build ships, named the way emit expects. The report
 * must ask emit with the real set: "skipped" has to mean the compiler decided
 * not to place a component, never that the reporter forgot to pass a seam.
 */
const MATERIALIZERS = {
  skill: new URL('../../dsh-anyplugin-materialize-skill/src/index.ts', import.meta.url).href,
  mcp: new URL('../../dsh-anyplugin-materialize-mcp/src/index.ts', import.meta.url).href,
  hooks: new URL('../../dsh-anyplugin-materialize-hook/src/index.ts', import.meta.url).href,
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv)
  const verbose = args.options.get('verbose') === true
  const allowPinMismatch = args.options.get('allow-pin-mismatch') === true
  if (args.command !== 'report' && args.positionals.length > 0) {
    throw new Error(`unexpected argument: ${args.positionals[0]}\n${USAGE}`)
  }

  if (args.command === 'report') {
    if (args.options.get('help') === true) {
      console.log(USAGE)
      return 0
    }
    const irPath = args.options.get('ir')
    let ir: ClaudePluginIr
    if (typeof irPath === 'string') {
      if (args.positionals.length > 0) {
        throw new Error(`--ir and <plugin-dir> are alternatives; got ${args.positionals[0]}`)
      }
      ir = JSON.parse(await readFile(irPath, 'utf8')) as ClaudePluginIr
    } else {
      const pluginDir = args.positionals[0]
      if (!pluginDir) throw new Error(`missing <plugin-dir>\n${USAGE}`)
      ir = readClaudePlugin(pluginDir)
    }
    const report = buildTransplantReport(ir, { materializers: MATERIALIZERS })
    console.log(args.options.get('json') === true ? JSON.stringify(report, null, 2) : formatTransplantReport(report))
    return report.ok ? 0 : 1
  }

  if (args.command === 'capture') {
    const [pluginDir] = requiredOptions(args, 'plugin')
    const nameOption = args.options.get('name')
    const probe = await probeWithClaude({
      pluginDir,
      ...(typeof nameOption === 'string' ? { name: nameOption } : {}),
    })
    const inventory = normalizeInventory({ ...probe.inventory, pin: probe.pin })
    const out = typeof args.options.get('out') === 'string'
      ? (args.options.get('out') as string)
      : join(pluginDir, '.inventory', `${probe.pin.tool}@${probe.pin.version}.json`)
    await mkdir(dirname(out), { recursive: true })
    // Keep the recorded source repo-relative so a golden captured here and a
    // golden captured in CI are comparable.
    const rel = relative(process.cwd(), pluginDir)
    const source = rel && !rel.startsWith('..') ? `plugin-dir:${rel}` : `plugin-dir:${pluginDir}`
    const body: Inventory = { ...inventory, plugin: { ...inventory.plugin, source } }
    await writeFile(out, `${JSON.stringify(body, null, 2)}\n`, 'utf8')
    console.log(`captured ${inventory.components.length} component(s) from ${probe.pin.tool}@${probe.pin.version} → ${out}`)
    for (const note of inventory.notes ?? []) console.log(`  note: ${note}`)
    return 0
  }

  if (args.command === 'verify') {
    const [pluginDir, golden] = requiredOptions(args, 'plugin', 'golden')
    const expected = await readInventoryFile(golden)
    const probe = await probeWithClaude({ pluginDir })
    const actual = normalizeInventory({ ...probe.inventory, pin: probe.pin })
    const report = diffInventories(expected, actual, { allowPinMismatch })
    console.log(formatDiff(report, { verbose }))
    return report.ok ? 0 : 1
  }

  if (args.command === 'diff') {
    const [expectedPath, actualPath] = requiredOptions(args, 'expected', 'actual')
    const report = diffInventories(await readInventoryFile(expectedPath), await readInventoryFile(actualPath), {
      allowPinMismatch,
    })
    console.log(formatDiff(report, { verbose }))
    return report.ok ? 0 : 1
  }

  if (args.command === 'trace') {
    const [leftPath, rightPath] = requiredOptions(args, 'left', 'right')
    const root = args.options.get('root')
    const options = typeof root === 'string' ? { root } : {}
    const left = normalizeTrace(readTraceFile(leftPath), options)
    const right = normalizeTrace(readTraceFile(rightPath), options)
    const diff = diffTraces(left, right)
    console.log(formatTraceDiff(diff, { verbose }))
    return diff.summary.differing === 0 && diff.summary.onlyLeft === 0 && diff.summary.onlyRight === 0 ? 0 : 1
  }

  throw new Error(`unknown command "${args.command}"\n${USAGE}`)
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 2
  })
