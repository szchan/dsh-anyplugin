// Drift check for the fetched harness union.
//
// `scripts/fetch-harness.mjs` installs one union at a pin. That only stays
// true if the union is the set of packages the conformance rig and the spikes
// the CI runs actually load: a new `@deepseek-ai/dsh-*` in a test or a CI
// spike that is not in the union would otherwise be hand-installed into the
// fetched tree again, which is exactly the failure #41 fixed.
//
// The check is offline and deterministic: it reads source files, the workflow,
// and the union export. It does not look at `.harness/`, npm, or the network.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { HARNESS_PACKAGES } from '../../../scripts/fetch-harness.mjs'

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const CONFORMANCE = join(REPO_ROOT, 'packages', 'dsh-anyplugin-conformance')

// Strings that look like a harness package but are not one:
// - `dsh-home` is a temp directory in grant-cli.test.mjs;
// - `dsh-harness-under-test` is the generated manifest name in fetch-harness;
// - the repository's own packages share the `dsh-anyplugin` prefix.
const NOT_A_HARNESS_PACKAGE = new Set(['dsh-home', 'dsh-harness-under-test'])
const isRepoTool = (name) => name.startsWith('dsh-anyplugin')

const TOKEN = /(?<![\w@\/-])(?:@deepseek-ai\/)?(dsh-[a-z0-9]+(?:-[a-z0-9]+)*)/g

function filesUnder(dir, predicate) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && predicate(entry.name))
    .map((entry) => join(entry.parentPath ?? entry.path, entry.name))
}

/** The spikes the workflow runs, resolved from `npm run spike:sN` to `spikes/sN-<name>/run.mjs`. */
function ciSpikeFiles() {
  const workflow = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'verify.yml'), 'utf8')
  const ids = [...new Set([...workflow.matchAll(/npm run spike:(s\d+)/g)].map((match) => match[1]))]
  assert.ok(ids.length > 0, 'verify.yml runs no spike: the drift check lost its reference set')
  const spikeDirs = readdirSync(join(REPO_ROOT, 'spikes'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
  return ids.map((id) => {
    const matches = spikeDirs.filter((name) => name === id || name.startsWith(`${id}-`))
    assert.equal(matches.length, 1, `expected exactly one spikes/ directory for CI step ${id}, found ${matches.join(', ') || 'none'}`)
    const run = join(REPO_ROOT, 'spikes', matches[0], 'run.mjs')
    assert.ok(existsSync(run), `${relative(REPO_ROOT, run)} is missing`)
    return run
  })
}

/** Every file whose package references must be covered by the union. */
function consumerFiles() {
  return [
    ...filesUnder(join(CONFORMANCE, 'src'), (name) => name.endsWith('.ts')),
    ...filesUnder(join(CONFORMANCE, 'test'), (name) => name.endsWith('.test.mjs')),
    ...ciSpikeFiles(),
  ].filter((file) => !file.endsWith('harness-union.test.mjs'))
}

test('the union gives every entry a consumer note', () => {
  for (const [name, note] of Object.entries(HARNESS_PACKAGES)) {
    assert.match(name, /^dsh-[a-z0-9]+(?:-[a-z0-9]+)*$/)
    assert.equal(typeof note, 'string')
    assert.ok(note.trim().length >= 10, `${name} has no consumer note`)
    assert.ok(!note.trim().toLowerCase().startsWith('todo'), `${name} has only a TODO as its consumer note`)
  }
})

test('every harness package named in a test or CI spike is in the fetched union', () => {
  const missing = new Map()
  for (const file of consumerFiles()) {
    const lines = readFileSync(file, 'utf8').split('\n')
    lines.forEach((line, index) => {
      for (const match of line.matchAll(TOKEN)) {
        const name = match[1]
        if (NOT_A_HARNESS_PACKAGE.has(name) || isRepoTool(name)) continue
        if (name in HARNESS_PACKAGES) continue
        const where = `${relative(REPO_ROOT, file)}:${index + 1}`
        if (!missing.has(name)) missing.set(name, where)
      }
    })
  }
  assert.deepEqual(
    [...missing.entries()],
    [],
    `harness packages used by the rig or a CI spike but missing from HARNESS_PACKAGES in scripts/fetch-harness.mjs: ${[...missing]
      .map(([name, where]) => `${name} (${where})`)
      .join(', ')}`,
  )
})
