#!/usr/bin/env node
// arch-check: cli — this file is the command-line surface; stdout is its output.
/**
 * The conformance rig CLI.
 *
 *   rig capture --plugin <dir> [--out <file>] [--name <plugin-name>]
 *   rig verify  --plugin <dir> --golden <file> [--allow-pin-mismatch] [--verbose]
 *   rig diff    --expected <file> --actual <file> [--allow-pin-mismatch] [--verbose]
 *   rig trace   --left <a.jsonl> --right <b.jsonl> [--root <plugin-dir>] [--verbose]
 *
 * `capture` records what the upstream host reports about a plugin. `verify`
 * replays the probe and diffs it against that golden, which is how a pin bump
 * that changes behavior gets caught instead of silently redefining "100 %".
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { diffInventories, normalizeInventory, type Inventory } from './inventory.ts'
import { probeWithClaude, resolvePluginName } from './oracles/claude.ts'
import { readInventoryFile } from './oracles/file.ts'
import { formatDiff } from './report.ts'
import { diffTraces, formatTraceDiff, normalizeTrace, readTraceFile } from './trace.ts'

interface Args {
  command: string
  options: Map<string, string | boolean>
}

function parseArgs(argv: string[]): Args {
  const [command, ...rest] = argv
  const options = new Map<string, string | boolean>()
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]
    if (!token.startsWith('--')) throw new Error(`unexpected argument: ${token}`)
    const key = token.slice(2)
    const next = rest[index + 1]
    if (next && !next.startsWith('--')) {
      options.set(key, next)
      index += 1
    } else {
      options.set(key, true)
    }
  }
  return { command, options }
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
  rig trace   --left <a.jsonl> --right <b.jsonl> [--root <plugin-dir>] [--verbose]`

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv)
  const verbose = args.options.get('verbose') === true
  const allowPinMismatch = args.options.get('allow-pin-mismatch') === true

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
