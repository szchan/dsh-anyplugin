// Identity is a composition, so it has to be injective: a group id built from
// one plugin must never equal a child id built from another. The separator is
// `#`, which `mangleId` cannot emit (its alphabet is [A-Za-z0-9_.@-] plus ~xx).
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

import { CLAUDE_CODE_PIN } from '../../dsh-anyplugin-dialect-claude-code/src/index.ts'
import { childEntryId, pluginEntryId, pluginScope } from '../src/identity.ts'
import { compileEntries, reconcile } from '../src/index.ts'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const fixture = join(repoRoot, 'fixtures', 'claude-skills-only')
const materializer = pathToFileURL(
  join(repoRoot, 'packages', 'dsh-anyplugin-materialize-skill', 'src', 'index.ts'),
).href

test('the dotted pair produces different group and child ids', () => {
  const dottedGroup = pluginEntryId('claude-code', 'x.skill')
  const childOfX = childEntryId(pluginScope('claude-code', 'x'), 'skill')
  const childOfDotted = childEntryId(pluginScope('claude-code', 'x.skill'), 'skill')

  assert.equal(dottedGroup, 'anyplugin.claude-code~3ax.skill')
  assert.equal(childOfX, 'anyplugin.claude-code~3ax#skill')
  assert.equal(childOfDotted, 'anyplugin.claude-code~3ax.skill#skill')
  assert.notEqual(dottedGroup, childOfX, 'group x.skill is not the child of x')
  assert.notEqual(childOfX, childOfDotted)
})

test('a surface id containing the marker is escaped, so the composition stays injective', () => {
  assert.equal(childEntryId('s', 'a#b'), 'anyplugin.s#a~23b')
  assert.notEqual(childEntryId('s', 'a#b'), childEntryId('s', 'a') + '#b')
})

class Loader {
  constructor() {
    this.root = {}
    this.store = new Map()
    this.creates = 0
  }
  entries() {
    return [...this.store.values()]
  }
  resolve(id) {
    const entry = this.store.get(id)
    if (!entry) throw new Error(`no entry ${id}`)
    return entry
  }
  async await() {}
  async create(options) {
    this.creates++
    const entry = { options, parent: this.root, subgroup: {}, fiber: { state: 2 } }
    this.store.set(options.id, entry)
    for (const child of options.config ?? []) {
      this.store.set(child.id, { options: child, parent: entry.subgroup, fiber: { state: 2 } })
    }
    return options.id
  }
  async update(id, options) {
    const entry = this.resolve(id)
    for (const child of entry.options.config ?? []) this.store.delete(child.id)
    entry.options = options
    entry.subgroup = {}
    for (const child of options.config ?? []) {
      this.store.set(child.id, { options: child, parent: entry.subgroup, fiber: { state: 2 } })
    }
  }
  remove(id) {
    const entry = this.resolve(id)
    for (const child of entry.options.config ?? []) this.store.delete(child.id)
    this.store.delete(id)
  }
}

test('two plugins whose names differ only by a dot both install', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anyplugin-identity-'))
  const roots = {}
  for (const name of ['x', 'x.skill']) {
    const root = join(dir, name)
    cpSync(fixture, root, { recursive: true })
    const manifestPath = join(root, '.claude-plugin', 'plugin.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.name = name
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
    roots[name] = root
  }
  const installs = {
    schema: 'dsh-anyplugin/installs@1',
    plugins: ['x', 'x.skill'].map((name) => ({
      dialect: 'claude-code',
      name,
      version: '0.0.1',
      root: roots[name],
      dataDir: join(dir, 'data', name),
      pin: `${CLAUDE_CODE_PIN.tool}@${CLAUDE_CODE_PIN.version}`,
    })),
  }
  const enablements = {
    project: {
      plugins: Object.fromEntries(
        ['claude-code:x', 'claude-code:x.skill'].map((id) => [id, { enabled: true, grants: [] }]),
      ),
    },
  }
  const desired = compileEntries(installs, { materializers: { skill: materializer }, enablements })
  assert.equal(desired.length, 2)
  assert.deepEqual(
    desired.map((entry) => entry.id),
    ['anyplugin.claude-code~3ax', 'anyplugin.claude-code~3ax.skill'],
    'both groups are addressable and distinct',
  )
  assert.deepEqual(
    desired.map((entry) => entry.config[0].id),
    ['anyplugin.claude-code~3ax#skill', 'anyplugin.claude-code~3ax.skill#skill'],
    'both children are distinct even though the names differ only by a dot',
  )

  const loader = new Loader()
  const first = await reconcile(loader, desired)
  assert.deepEqual(first, {
    created: ['anyplugin.claude-code~3ax', 'anyplugin.claude-code~3ax.skill'],
    updated: [],
    removed: [],
    kept: [],
    failed: [], refused: [],
  })
  assert.equal(loader.creates, 2)

  const second = await reconcile(loader, desired)
  assert.deepEqual(second, {
    created: [],
    updated: [],
    removed: [],
    kept: ['anyplugin.claude-code~3ax', 'anyplugin.claude-code~3ax.skill'],
    failed: [], refused: [],
  })
  assert.equal(loader.creates, 2, 'the second pass wrote nothing')
})
