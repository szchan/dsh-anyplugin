// D30 loads mods in a `node:vm` realm, and Node exposes SourceTextModule only
// behind --experimental-vm-modules. The default Desktop runtime does not pass
// the flag, so the honest behaviour is: one warning naming the flag for the
// whole process, one refusal per mod in each trace, and classic hooks still
// running. This test spawns a Node without the flag (the repository's own test
// runner has it) and calls `apply()` twice, so a regression to once-per-apply
// would warn twice and fail here.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { pinnedMod } from './pinned.mjs'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const applyUrl = new URL('../src/index.ts', import.meta.url).href

test('without --experimental-vm-modules: one warning for two apply() calls, one trace refusal per mod', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-anyplugin-vm-flag-'))
  try {
    for (const name of ['a', 'b', 'c', 'd', 'e']) {
      writeFileSync(join(dir, `${name}.ts`), 'export function register(): void {}\n')
    }
    const traceFile = join(dir, 'trace.jsonl')
    const traceFile2 = join(dir, 'trace-2.jsonl')
    const script = `
      const { apply } = await import(${JSON.stringify(applyUrl)})
      const warnings = []
      const ctx = {
        on() { return () => {} },
        effect(register) { return register() },
        logger: { warn(message) { warnings.push(String(message)) } },
      }
      await apply(ctx, {
        hooks: [],
        mods: ${JSON.stringify(['a.ts', 'b.ts', 'c.ts'].map((entry) => pinnedMod(dir, entry)))},
        plugin: 'flag-probe',
        pluginRoot: ${JSON.stringify(dir)},
        pluginData: ${JSON.stringify(join(dir, 'data'))},
        traceFile: ${JSON.stringify(traceFile)},
      })
      await apply(ctx, {
        hooks: [],
        mods: ${JSON.stringify(['d.ts', 'e.ts'].map((entry) => pinnedMod(dir, entry)))},
        plugin: 'flag-probe-2',
        pluginRoot: ${JSON.stringify(dir)},
        pluginData: ${JSON.stringify(join(dir, 'data-2'))},
        traceFile: ${JSON.stringify(traceFile2)},
      })
      process.stdout.write(JSON.stringify(warnings))
    `
    const out = execFileSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', script], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: '' },
    })
    const warnings = JSON.parse(out)
    assert.equal(warnings.length, 1, `expected one warning for the process, got ${JSON.stringify(warnings)}`)
    assert.match(warnings[0], /NODE_OPTIONS=--experimental-vm-modules/)
    assert.doesNotMatch(warnings[0], /load refused/)

    const refusals = (file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line))
        .filter((record) => typeof record.warning === 'string' && record.warning.includes('load refused'))
    assert.equal(refusals(traceFile).length, 3, 'the first apply must trace one refusal per mod')
    assert.equal(refusals(traceFile2).length, 2, 'the second apply must trace one refusal per mod')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
