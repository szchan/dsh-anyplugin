#!/usr/bin/env node
/**
 * The panel's mutations, as a runnable audit rather than a claim in a PR.
 *
 * Each entry breaks exactly one property the tests assert, rebuilds the panel
 * (the client half is a bundle, so the build is part of the mutation), runs
 * `panel.test.mjs`, and requires the run to fail. A mutation that stays green
 * means the test is not proving that property.
 *
 *   DSH_HARNESS_DIR=$PWD/.harness/0.2.2-rc.5 \
 *   DSH_HARNESS_VERSION=0.2.2-rc.5 \
 *     node packages/dsh-anyplugin-install/test/panel-mutations.mjs
 *
 * This file deliberately does not match `*.test.mjs`: it mutates the working
 * tree, so it must not run inside `npm test`. It restores every file and
 * rebuilds in `finally`.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const SERVER = 'packages/dsh-anyplugin-install/src/panel.ts'
const CLIENT = 'packages/dsh-anyplugin-install/src/client/panel.js'
const TEST = 'packages/dsh-anyplugin-install/test/panel.test.mjs'

function replaceOnce(text, find, replacement, occurrence = 0) {
  let index = -1
  for (let seen = 0; seen <= occurrence; seen += 1) {
    index = text.indexOf(find, index + 1)
    if (index === -1) throw new Error(`mutation anchor not found (occurrence ${occurrence}): ${find.slice(0, 60)}`)
  }
  return text.slice(0, index) + replacement + text.slice(index + find.length)
}

const MUTANTS = [
  {
    name: 'drop the Origin equality check',
    file: SERVER,
    find: '    if (!sameOrigin(request)) {',
    replacement: '    if (false) {',
  },
  {
    name: 'drop the application/json check',
    file: SERVER,
    find: '    if (!isJson(request)) {',
    replacement: '    if (false) {',
  },
  {
    name: 'read a 70 KiB body instead of refusing it by Content-Length',
    file: SERVER,
    find: '  if (declared !== null && declared > MAX_BODY_BYTES) return { ok: false }',
    replacement: '  if (declared !== null && declared > MAX_BODY_BYTES * 2) return { ok: false }',
  },
  {
    name: 'count UTF-16 units instead of bytes',
    file: SERVER,
    find: '    total += value.byteLength',
    replacement: '    total += new TextDecoder().decode(value).length',
  },
  {
    name: 'leave the over-limit stream uncancelled',
    file: SERVER,
    find: '      await reader.cancel()\n',
    replacement: '',
  },
  {
    name: 'drop the host gate on the read route',
    file: SERVER,
    find: '    if (hostRefusal !== null) return hostRefusal\n    return list(config)',
    replacement: '    return list(config)',
  },
  {
    name: 'drop the host gate on the install route',
    file: SERVER,
    find: '    if (hostRefusal !== null) return hostRefusal\n    if (!sameOrigin(request)) {',
    replacement: '    if (!sameOrigin(request)) {',
  },
  {
    name: 'leave a refused request connection open',
    file: SERVER,
    find: "    if (result.status >= 400) headers.connection = 'close'\n",
    replacement: '',
  },
  {
    name: 'register the slot without the inject handshake',
    file: CLIENT,
    find: `  return ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      { name: 'settings.section', id: 'anyplugin-ui', order: 45, label: () => 'AnyPlugin' },
      Panel,
    ),
  )`,
    replacement:
      "  return ctx.slots.register({ name: 'settings.section', id: 'anyplugin-ui', order: 45, label: () => 'AnyPlugin' }, Panel)",
  },
  {
    name: 'report every record enabled at the user scope',
    file: SERVER,
    find: '    enabled: effective.enabled === true,',
    replacement: '    enabled: true,',
  },
  {
    name: 'hide refused components behind a bare installed message',
    file: CLIENT,
    find: '        const refused = body.report?.totals?.refused ?? 0',
    replacement: '        const refused = 0',
  },
]

function build() {
  execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: REPO, stdio: 'pipe' })
}

function testPasses() {
  try {
    execFileSync(process.execPath, ['--experimental-vm-modules', '--test', TEST], {
      cwd: REPO,
      stdio: 'pipe',
      env: process.env,
    })
    return true
  } catch {
    return false
  }
}

let failed = 0
for (const mutant of MUTANTS) {
  const path = join(REPO, mutant.file)
  const original = readFileSync(path, 'utf8')
  try {
    const mutated = replaceOnce(original, mutant.find, mutant.replacement)
    if (mutated === original) throw new Error('the mutation changed nothing')
    writeFileSync(path, mutated)
    build()
    const green = testPasses()
    console.log(`${green ? 'FAIL' : 'PASS'}  ${mutant.name} → ${green ? 'test stayed green' : 'test reddened'}`)
    if (green) failed += 1
  } finally {
    writeFileSync(path, original)
  }
}

build()
if (failed > 0) {
  console.error(`mutations: ${failed}/${MUTANTS.length} stayed green`)
  process.exit(1)
}
console.log(`mutations: ${MUTANTS.length}/${MUTANTS.length} reddened their test`)
