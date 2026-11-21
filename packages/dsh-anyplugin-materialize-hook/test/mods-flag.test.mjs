// D30 loads mods in a `node:vm` realm, and Node exposes SourceTextModule only
// behind --experimental-vm-modules. The default Desktop runtime does not pass
// the flag, so the honest behaviour is: one warning naming the flag, one
// refusal per mod in the trace, and classic hooks still running. This test
// spawns a Node without the flag (the repository's own test runner has it) and
// proves the warning is not repeated once per mod.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const applyUrl = new URL('../src/index.ts', import.meta.url).href

test('without --experimental-vm-modules: one warning for three mods, three trace refusals', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-anyplugin-vm-flag-'))
  try {
    for (const name of ['a', 'b', 'c']) writeFileSync(join(dir, `${name}.ts`), 'export function register(): void {}\n')
    const traceFile = join(dir, 'trace.jsonl')
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
        mods: [{ entry: 'a.ts' }, { entry: 'b.ts' }, { entry: 'c.ts' }],
        plugin: 'flag-probe',
        pluginRoot: ${JSON.stringify(dir)},
        pluginData: ${JSON.stringify(join(dir, 'data'))},
        traceFile: ${JSON.stringify(traceFile)},
      })
      process.stdout.write(JSON.stringify(warnings))
    `
    const out = execFileSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', script], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: '' },
    })
    const warnings = JSON.parse(out)
    assert.equal(warnings.length, 1, `expected one warning, got ${JSON.stringify(warnings)}`)
    assert.match(warnings[0], /NODE_OPTIONS=--experimental-vm-modules/)
    assert.doesNotMatch(warnings[0], /load refused/)

    const traced = readFileSync(traceFile, 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line))
      .filter((record) => typeof record.warning === 'string' && record.warning.includes('load refused'))
    assert.equal(traced.length, 3, `expected three per-mod trace refusals, got ${JSON.stringify(traced)}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
