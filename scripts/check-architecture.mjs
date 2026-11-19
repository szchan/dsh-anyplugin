#!/usr/bin/env node
// Architecture as a check, not a paragraph.
//
// AGENTS.md says what the shape is; this file decides whether the tree still has
// it. Every rule below exists because breaking it silently costs us something we
// cannot see in a test: a dependency that makes the IR non-hub, a second event
// path, an eval that defeats auditability, a package that cannot be published.
//
// Run: node scripts/check-architecture.mjs [--json]
// Exit 0 when the tree matches the declared shape, 1 otherwise.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const json = process.argv.includes('--json')
const violations = []

function fail(rule, file, message, line = 0) {
  violations.push({ rule, file: relative(root, file), line, message })
}

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))

// ---------------------------------------------------------------------------
// R1. The layer graph. Only conformance may see the whole tree; nothing may
//     depend on conformance (the rig is a leaf by construction: if a package
//     imported it, the rig would stop being able to run the package).
// ---------------------------------------------------------------------------
const ALLOWED = {
  'dsh-anyplugin-ir': [],
  'dsh-anyplugin-intercept': [],
  'dsh-anyplugin-mod-scan': [],
  'dsh-anyplugin-hook-runner': [],
  'dsh-anyplugin-skill-template': [],
  'dsh-anyplugin-command-template': [],
  'dsh-anyplugin-trust': ['dsh-anyplugin-ir'],
  'dsh-anyplugin-emit': ['dsh-anyplugin-ir'],
  'dsh-anyplugin-install': ['dsh-anyplugin-dialect-claude-code', 'dsh-anyplugin-emit', 'dsh-anyplugin-trust'],
  'dsh-anyplugin-dialect-claude-code': ['dsh-anyplugin-ir'],
  'dsh-anyplugin-materialize-skill': ['dsh-anyplugin-ir'],
  'dsh-anyplugin-materialize-command': ['dsh-anyplugin-ir', 'dsh-anyplugin-command-template'],
  'dsh-anyplugin-materialize-hook': ['dsh-anyplugin-hook-runner'],
  'dsh-anyplugin-materialize-mcp': [],
  'dsh-anyplugin-conformance': '*',
}

const SOURCE = /\.(?:ts|mts|cts|js|mjs)$/
const IMPORT = /(?:^|\n)\s*(?:import|export)[^'"]*?from\s+['"]([^'"]+)['"]/g
const DYNAMIC = /\bimport\s*\(\s*['"]([^'"]+)['"]/g

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const file = join(dir, name)
    if (statSync(file).isDirectory()) walk(file, out)
    else if (SOURCE.test(name)) out.push(file)
  }
  return out
}

const packages = readdirSync(join(root, 'packages')).filter((name) =>
  existsSync(join(root, 'packages', name, 'src')),
)

for (const pkg of packages) {
  if (!(pkg in ALLOWED)) {
    fail('R1 unknown-package', join(root, 'packages', pkg), `${pkg} is not in the layer graph; declare it in scripts/check-architecture.mjs`)
    continue
  }
  const allowed = ALLOWED[pkg]
  for (const file of walk(join(root, 'packages', pkg, 'src'))) {
    const source = readFileSync(file, 'utf8')
    const isCli = source.slice(0, 400).includes('arch-check: cli')
    const lineOf = (index) => source.slice(0, index).split('\n').length
    for (const match of [...source.matchAll(IMPORT)]) {
      const specifier = match[1]
      const target = specifier.match(/dsh-anyplugin-[a-z-]+/)
      if (!target) continue
      const dep = target[0]
      if (dep === pkg) continue
      if (allowed !== '*' && !allowed.includes(dep)) {
        fail('R1 layer', file, `${pkg} may not import ${dep} (allowed: ${allowed.length ? allowed.join(', ') : 'nothing'})`, lineOf(match.index))
        continue
      }
      if (dep === 'dsh-anyplugin-conformance' && allowed !== '*') {
        fail('R1 rig-is-leaf', file, `${pkg} imports the conformance rig`, lineOf(match.index))
      }
      if (!specifier.endsWith('/src/index.ts')) {
        fail('R2 deep-import', file, `${specifier} must go through the package entry (src/index.ts)`, lineOf(match.index))
      }
    }
    for (const match of [...source.matchAll(DYNAMIC)]) {
      const target = match[1].match(/dsh-anyplugin-[a-z-]+/)
      if (!target) continue
      const dep = target[0]
      if (dep !== pkg && allowed !== '*' && !allowed.includes(dep)) {
        fail('R1 layer', file, `dynamic import of ${dep} from ${pkg}`, lineOf(match.index))
      }
    }

    // R3. Emission is data: no code generation, no evaluation.
    for (const pattern of [/\beval\s*\(/, /\bnew\s+Function\s*\(/, /\bfunction\s*\(\s*['"]return/]) {
      const match = pattern.exec(source)
      if (match) fail('R3 no-eval', file, 'code generation or eval in a package source', lineOf(match.index))
    }

    // R4. No host-specific absolute paths: the tree must run on another machine.
    const absolute = /['"]\/(?:home|Users|tmp|nix\/store)\//.exec(source)
    if (absolute) fail('R4 no-host-paths', file, 'absolute host path in a package source', lineOf(absolute.index))

    // R5. ESM only.
    if (/\brequire\s*\(/.test(source) || /\bmodule\.exports\b/.test(source)) {
      fail('R5 esm-only', file, 'CommonJS in a package source')
    }

    // R6. Diagnostics go through the plugin context, never straight to stdout.
    const log = isCli ? null : /\bconsole\.log\s*\(/.exec(source)
    if (log) fail('R6 no-console', file, 'console.log in a package source; use ctx.logger', lineOf(log.index))
  }
}

// R7. A package manifest is its contract: private, ESM, and one entry point.
for (const pkg of packages) {
  const manifestPath = join(root, 'packages', pkg, 'package.json')
  if (!existsSync(manifestPath)) {
    fail('R7 manifest', manifestPath, `${pkg} has src/ but no package.json`)
    continue
  }
  const manifest = readJson(manifestPath)
  if (manifest.private !== true) fail('R7 manifest', manifestPath, 'private must be true')
  if (manifest.type !== 'module') fail('R7 manifest', manifestPath, 'type must be module')
  if (manifest.exports?.['.'] !== './src/index.ts') {
    fail('R7 manifest', manifestPath, 'exports["."] must be ./src/index.ts')
  }
  if (!existsSync(join(root, 'packages', pkg, 'src', 'index.ts'))) {
    fail('R7 manifest', manifestPath, 'missing src/index.ts')
  }
}

// R8. Spikes are throwaway; nothing shipped may import one.
for (const pkg of packages) {
  for (const file of walk(join(root, 'packages', pkg, 'src'))) {
    const source = readFileSync(file, 'utf8')
    if (/from\s+['"][^'"]*\/spikes\//.test(source)) fail('R8 no-spike', file, 'a package imports a spike')
  }
}

// R9. The ratchet lives in one place. Two files claiming the coverage totals
//     would let one drift while the other stays green.
const totalsFiles = walk(join(root, 'packages')).filter((file) => /coverage\.test\.mjs$/.test(file))
if (totalsFiles.length > 1) {
  for (const file of totalsFiles.slice(1)) fail('R9 single-ratchet', file, 'coverage totals are asserted in more than one file')
}

const summary = {
  ok: violations.length === 0,
  packages: packages.length,
  files: packages.reduce((n, pkg) => n + walk(join(root, 'packages', pkg, 'src')).length, 0),
  violations,
}

if (json) {
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n')
} else if (summary.ok) {
  process.stdout.write(`architecture: ${summary.packages} packages / ${summary.files} files, no violations\n`)
} else {
  for (const v of violations) {
    process.stdout.write(`${v.file}${v.line ? ':' + v.line : ''}  ${v.rule}  ${v.message}\n`)
  }
  process.stdout.write(`\narchitecture: ${violations.length} violation(s) in ${summary.packages} packages\n`)
}
process.exit(summary.ok ? 0 : 1)
