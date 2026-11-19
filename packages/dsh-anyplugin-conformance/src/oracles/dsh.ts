/**
 * DSH-side oracle — boots the *installed* harness packages and reads what they
 * report about a plugin we materialized.
 *
 * The installed tree is a real directory, not an asar archive, so plain Node
 * can import it. That matters for fidelity of the rig itself: the oracle runs
 * the exact `dsh-skill` / `cordis` builds the desktop app runs
 * (`0.2.2-rc.2` / `4.1.0`), not npm copies that may lag or not exist.
 *
 * One rule that is easy to get wrong: the `Context` must come from the
 * *installed* cordis. Two copies of cordis in one process give two `Service`
 * base classes, and the registry would never see the context that owns it.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { EntryOptions } from '../../dsh-anyplugin-emit/src/index.ts'
import type { Inventory } from '../inventory.ts'
import { emptyInventory, INVENTORY_SCHEMA } from '../inventory.ts'

export interface DshProbeOptions {
  /** Directory holding the installed `@deepseek-ai/*` packages. */
  installedDir: string
  /** The group entry the emitter produced. */
  entry: EntryOptions
  /** How long to wait for plugins to apply, in milliseconds. */
  timeoutMs?: number
}

export interface DshSkillReport {
  name: string
  description: string
  provider: string
}

export interface DshProbeResult {
  inventory: Inventory
  dshVersion: string
  skills: DshSkillReport[]
}

interface BootedHarness {
  ctx: any
  loader: any
  skills: any
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function loadInstalled(installedDir: string, specifier: string): Promise<any> {
  return import(pathToFileURL(join(installedDir, specifier)).href)
}

async function until(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return
    await sleep(5)
  }
  throw new Error(`dsh oracle: timed out waiting for ${label}`)
}

async function boot(installedDir: string, timeoutMs: number): Promise<BootedHarness> {
  const { Context } = await loadInstalled(installedDir, 'cordis/lib/index.js')
  const Loader = (await loadInstalled(installedDir, 'cordis-plugin-loader/lib/index.js')).default
  const SkillRegistry = (await loadInstalled(installedDir, 'dsh-skill/lib/index.js')).default

  const ctx = new Context()
  ctx.plugin(Loader, { baseUrl: pathToFileURL(join(installedDir, 'dsh') + '/').href })
  ctx.plugin(SkillRegistry, {})
  await until(() => Boolean(ctx.loader) && Boolean(ctx.skills), timeoutMs, 'loader and skills services')
  return { ctx, loader: ctx.loader, skills: ctx.skills }
}

export function dshVersion(installedDir: string): string {
  const manifest = JSON.parse(readFileSync(join(installedDir, 'dsh', 'package.json'), 'utf8')) as { version?: string }
  return manifest.version ?? 'unknown'
}

/**
 * Materialize `entry` into a real harness, wait for the registry to settle, and
 * read the inventory back. The wait is stability-based rather than
 * count-based: a plugin that registers three skills and then one more should
 * not be sampled halfway.
 */
export async function probeWithDsh(options: DshProbeOptions): Promise<DshProbeResult> {
  const timeoutMs = options.timeoutMs ?? 5000
  const { ctx, loader, skills } = await boot(options.installedDir, timeoutMs)

  try {
    await loader.create(options.entry)
    let lastSignature = ''
    let stable = 0
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      const names = (await skills.list({})).map((skill: { name: string }) => skill.name).join(',')
      if (names === lastSignature) stable += 1
      else {
        lastSignature = names
        stable = 0
      }
      if (stable >= 3) break
      await sleep(10)
    }

    const listed = (await skills.list({})) as DshSkillReport[]
    const inventory = emptyInventory({
      name: options.entry.id,
      version: undefined,
      source: `dsh:${dshVersion(options.installedDir)}`,
    })
    inventory.pin = { tool: 'dsh', version: dshVersion(options.installedDir) }
    inventory.components = listed.map((skill) => ({ surface: 'skills' as const, name: skill.name }))
    inventory.notes = [
      `${INVENTORY_SCHEMA}: ${listed.length} skill(s) reported by dsh-skill`,
      ...listed.map((skill) => `skills/${skill.name} via ${skill.provider}`),
    ]
    return { inventory, dshVersion: dshVersion(options.installedDir), skills: listed }
  } finally {
    try {
      loader.stop?.()
      await sleep(20)
    } catch {
      // Teardown failures must not mask the assertion that follows.
    }
  }
}
