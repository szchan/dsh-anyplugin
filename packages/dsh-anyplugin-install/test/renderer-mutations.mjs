#!/usr/bin/env node
/**
 * The derived renderer bridge's mutations, as a runnable audit rather than a
 * claim in a PR.
 *
 * Each entry breaks exactly one property `renderer.test.mjs` asserts, runs that
 * test file, and requires the run to fail. A mutation that stays green means
 * the test is not proving that property. The files here are plain modules the
 * test imports directly, so no bundle rebuild is needed; every mutated file is
 * restored in `finally`.
 *
 *   node packages/dsh-anyplugin-install/test/renderer-mutations.mjs
 *
 * This file deliberately does not match `*.test.mjs`: it mutates the working
 * tree, so it must not run inside `npm test`.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const FACES = 'packages/dsh-anyplugin-install/src/renderer-faces.js'
const CLIENT = 'packages/dsh-anyplugin-install/src/client/renderer.js'
const HOST = 'packages/dsh-anyplugin-install/src/renderer.ts'
const PANEL = 'packages/dsh-anyplugin-install/src/panel.ts'
const TEST = 'packages/dsh-anyplugin-install/test/renderer.test.mjs'
const HOOK = 'packages/dsh-anyplugin-materialize-hook/src/index.ts'
const HOOK_TEST = 'packages/dsh-anyplugin-materialize-hook/test/ui-tool.test.mjs'

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
    name: 'claim one served face is equivalent instead of derived',
    file: FACES,
    find: "    class: 'derived',\n    reason:\n      'registered into the host layout",
    replacement: "    class: 'equivalent',\n    reason:\n      'registered into the host layout",
  },
  {
    name: 'ship a face with an empty reason',
    file: FACES,
    find: 'export const RENDERER_FACES = Object.freeze([\n',
    replacement: "export const RENDERER_FACES = Object.freeze([\n  Object.freeze({ face: 'mutant', class: 'derived', reason: '' }),\n",
  },
  {
    name: 'widen the vocabulary to a fifth pinned tag',
    file: FACES,
    find: "export const ELEMENT_VOCABULARY = Object.freeze(['Box', 'Text', 'Button', 'Input'])",
    replacement: "export const ELEMENT_VOCABULARY = Object.freeze(['Box', 'Text', 'Button', 'Input', 'Select'])",
  },
  {
    name: 'translate an unknown tag instead of naming it unsupported',
    file: CLIENT,
    find: '    if (!ELEMENT_VOCABULARY.includes(node.type)) {',
    replacement: '    if (false && !ELEMENT_VOCABULARY.includes(node.type)) {',
  },
  {
    name: 'run paced work immediately instead of on a frame',
    file: CLIENT,
    find: '      pending = true\n      handle = frame(flush)',
    replacement: '      pending = true\n      flush()',
  },
  {
    name: 'measure synchronously on every observation instead of inside the paced callback',
    file: CLIENT,
    find: '  const observer = new Observer(() => {\n    pacer.schedule(measure)\n  })',
    replacement: '  const observer = new Observer(() => {\n    measure()\n  })',
  },
  {
    name: 'record focus from outside the pane subtree',
    file: CLIENT,
    find: '    if (contains(target)) last = target',
    replacement: '    last = target',
  },
  {
    name: 'accept a failed round trip as a good snapshot',
    file: CLIENT,
    find: '      if (response.ok !== true || isRecord(body) === false || body.ok !== true) {',
    replacement: '      if (false) {',
  },
  {
    name: 'let a throwing render source vanish without a refusal',
    file: HOST,
    find: '        } catch (error) {\n          refusals.push({',
    replacement: '        } catch (error) {\n          if (false) refusals.push({',
  },
  {
    name: 'drop the pane wire-budget refusal',
    file: HOST,
    find: '    if (bytes > paneBytes) {',
    replacement: '    if (false && bytes > paneBytes) {',
  },
  {
    name: 'let POST through the render read route',
    file: PANEL,
    find: "  if (url.pathname === RENDERER_PATH) {\n    if (request.method !== 'GET' && request.method !== 'HEAD') return methodNotAllowed('GET, HEAD')",
    replacement: "  if (url.pathname === RENDERER_PATH) {\n    if (false) return methodNotAllowed('GET, HEAD')",
  },
  {
    name: 'answer a throwing renderer with an empty 200 instead of a 500',
    file: PANEL,
    find: "    return json({ ok: false, code: 'render-failed', reason: error instanceof Error ? error.message : String(error) }, 500)",
    replacement: '    return json(rendererPayloadOf(undefined))',
  },
  {
    name: 'send a HEAD body',
    file: PANEL,
    find: '    return request.method === '
      + "'HEAD' ? new Response(null, { status: answer.status, headers: answer.headers }) : answer",
    replacement: '    return answer',
  },
  {
    name: 'drop the refresh from the keyboard command',
    file: CLIENT,
    find: '        focus()\n        if (store !== null && store !== undefined && typeof store.refresh === \'function\') store.refresh()',
    replacement: '        focus()',
  },
  {
    name: 'register the keyboard command under a different id',
    file: CLIENT,
    find: "    id: 'anyplugin.renderer.request',",
    replacement: "    id: 'anyplugin.renderer.other',",
  },
  {
    // The bridge's optional-service read once took a real Cordis context down:
    // a direct property probe throws `cannot get property "anypluginRenderer"
    // without inject`, so the materializer child never became active (install
    // smoke). The mutant restores that reach-in ahead of ctx.get; the fake ctx
    // in ui-tool.test.mjs models the refusal.
    name: 'probe the optional service as a bare context property before ctx.get',
    file: HOOK,
    test: HOOK_TEST,
    find: '    try {\n      const get = (ctx as { get?: unknown }).get',
    replacement:
      '    try {\n      const first = (ctx as { anypluginRenderer?: unknown }).anypluginRenderer\n'
      + '      if (first !== undefined) return first as { register: (source: () => unknown) => unknown }\n'
      + '      const get = (ctx as { get?: unknown }).get',
  },
  {
    // MUST 1: the wire budget is stated in bytes. A code-unit measure accepts
    // 40,000 CJK characters (40,031 code units) whose JSON is 120,031 bytes.
    name: 'measure the pane budget in UTF-16 code units instead of UTF-8 bytes',
    file: HOST,
    find: "      bytes = Buffer.byteLength(serialised, 'utf8')",
    replacement: '      bytes = serialised.length',
  },
  {
    // MUST 2: a self-cycle recurses until the stack dies when only the depth
    // cap is left.
    name: 'drop the seen-set so a cyclic tree recurses to the stack limit',
    file: HOST,
    find: '  if (budget.depth >= MAX_JSON_DEPTH || budget.seen.has(value)) return undefined',
    replacement: '  if (budget.depth >= MAX_JSON_DEPTH) return undefined',
  },
  {
    // MUST 2: without the live depth cap a 200-level chain is normalised whole
    // and keeps recursing for anything deeper; MAX_JSON_DEPTH becomes dead again.
    name: 'drop the live JSON depth cap',
    file: HOST,
    find: '  if (budget.depth >= MAX_JSON_DEPTH || budget.seen.has(value)) return undefined',
    replacement: '  if (budget.seen.has(value)) return undefined',
  },
  {
    // The seen-set must be a path, not a visited set: a DAG keeps one shared
    // object at both sibling positions.
    name: 'keep the seen-set global instead of per path',
    file: HOST,
    find: '    budget.seen.delete(value)\n',
    replacement: '\n',
  },
  {
    // MUST 2: one pane whose normalisation throws must become a refusal, not
    // abort the whole snapshot and with it every other pane.
    name: 'rethrow a pane normalisation failure and lose the whole snapshot',
    file: HOST,
    find: "            refusals.push({ code: 'pane-normalization-failed', reason: messageOf(error) })",
    replacement: '            throw error',
  },
  {
    // MUST 2: a source whose envelope getter throws is a refusal too, never a 500.
    name: 'rethrow a malformed source envelope and take the route down',
    file: HOST,
    find: "          refusals.push({ code: 'source-malformed', reason: messageOf(error) })",
    replacement: '          throw error',
  },
  {
    // SHOULD 5: a BigInt in a log line must not make JSON.stringify throw.
    name: 'leave the envelope logs un-normalised',
    file: HOST,
    find: '          sourceLogs = jsonSafe(logsOf(answer)) as unknown[]',
    replacement: '          sourceLogs = logsOf(answer) as unknown[]',
  },
  {
    // SHOULD 5: statuses were the one unbounded envelope list.
    name: 'leave the envelope statuses unbounded',
    file: HOST,
    find: ".filter((entry): entry is string => typeof entry === 'string').slice(0, MAX_SOURCE_STATUSES)",
    replacement: ".filter((entry): entry is string => typeof entry === 'string')",
  },
  {
    // SHOULD 6: the focus restore used to run every render and could steal focus.
    name: 'restore the focus steal on every render',
    file: CLIENT,
    find: '    }, [snapshot])',
    replacement: '    })',
  },
  {
    // NIT: an unmounted pane must cancel its queued frame.
    name: 'leave a queued pacer frame running after unmount',
    file: CLIENT,
    find: '      if (had && cancel !== null && handle !== null) cancel(handle)',
    replacement: '      if (false && had && cancel !== null && handle !== null) cancel(handle)',
  },
]

const originals = new Map()
for (const file of new Set(MUTANTS.map((mutant) => mutant.file))) {
  originals.set(file, readFileSync(join(REPO, file), 'utf8'))
}

const restore = () => {
  for (const [file, text] of originals) writeFileSync(join(REPO, file), text)
}

// Baseline first: a mutation run proves nothing while the unmutated test file
// already fails, because every mutant would be "killed" by that failure.
try {
  execFileSync(process.execPath, ['--experimental-vm-modules', '--test', TEST], {
    cwd: REPO,
    stdio: 'inherit',
    env: process.env,
  })
} catch {
  console.error('baseline renderer.test.mjs is not green; the mutation run would prove nothing')
  process.exit(1)
}

const testFails = (mutant) => {
  try {
    execFileSync(process.execPath, ['--experimental-vm-modules', '--test', mutant.test ?? TEST], {
      cwd: REPO,
      stdio: 'pipe',
      env: process.env,
    })
    return false
  } catch {
    return true
  }
}

let survived = 0
try {
  for (const mutant of MUTANTS) {
    const original = originals.get(mutant.file)
    writeFileSync(join(REPO, mutant.file), replaceOnce(original, mutant.find, mutant.replacement))
    const killed = testFails(mutant)
    if (killed) {
      console.log(`killed: ${mutant.name}`)
    } else {
      survived += 1
      console.log(`SURVIVED: ${mutant.name} (${mutant.file})`)
    }
  }
} finally {
  restore()
}

if (survived > 0) {
  console.error(`${survived} mutant(s) stayed green; the tests do not prove those properties`)
  process.exitCode = 1
} else {
  console.log(`all ${MUTANTS.length} mutants killed`)
}
