// S5 — the tool-name budget probe.
//
// Question: is DSH's 32-character `serverName` cap a property of the *runtime*,
// or only of one plugin's config schema? And is the 64-character tool-name
// contract enforced anywhere locally?
//
// Why it matters: Claude's plugin tool name is
// `mcp__plugin_<plugin>_<server>__<tool>`, and D11 measured that DSH's server
// namespace must fit 32 characters while Claude imposes no such limit. If the
// cap is only a schema rule in `dsh-mcp-client`, this repository can own its MCP
// path and register the byte-exact name without asking upstream for anything.
//
// This is a throwaway experiment (AGENTS.md §4). Its findings go to
// docs/DECISIONS.md (D12) and docs/ARCHITECTURE.md §10.
//
// Run: node spikes/s5-tool-names/run.mjs   (needs DSH_INSTALL_DIR)

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const installedDir = process.env.DSH_INSTALL_DIR ? join(process.env.DSH_INSTALL_DIR, '..') : undefined
if (!installedDir) {
  console.log('skip: DSH_INSTALL_DIR is not set (the probe measures the installed harness, not npm — D9)')
  process.exit(0)
}

const load = (pkg) => import(pathToFileURL(join(installedDir, pkg, 'lib', 'index.js')).href)
const { Context } = await load('cordis')
const { ToolsService } = await load('dsh-tools')
const SystemPrompt = (await load('dsh-system-prompt')).default
const { SERVER_NAME_PATTERN } = await load('dsh-mcp-client')

const checks = []
const check = (name, ok, detail) => checks.push({ name, ok, detail })

const settle = async (probe) => {
  for (let i = 0; i < 200; i++) {
    if (probe()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('service did not come up')
}

const ctx = new Context()
ctx.plugin(SystemPrompt)
await settle(() => ctx.systemPrompt !== undefined)
ctx.plugin(ToolsService, {})
await settle(() => typeof ctx.tools?.register === 'function')

const definition = (name) => ({
  name,
  description: 'S5 probe tool',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  output: { schema: { type: 'object', properties: {}, additionalProperties: false }, render: () => [] },
  execute: async () => ({}),
})

// The shape a Claude plugin would need: 12 + plugin + 1 + server + 2 + tool.
const serverNamespace = 'plugin_some-org-plugin-name_github-server' // 42 chars, > 32
const exactName = `mcp__${serverNamespace}__create_issue` // 59 chars
const oversized = `mcp__${serverNamespace}__create_issue_with_a_very_long_suffix_aaaaaaaaaa` // > 64

// Q1 — does the 32-character cap live in the runtime's registration path?
const dispose = ctx.tools.register(definition(exactName))
const stored = ctx.tools.get(exactName)
check('a 42-char server namespace registers', stored?.name === exactName, `${exactName.length} chars`)
check('the schema carries the name byte for byte', JSON.stringify(ctx.tools.schemas()).includes(exactName), '')

// Q2 — is the 64-character contract enforced locally?
let oversizeError
try {
  ctx.tools.register(definition(oversized))
} catch (error) {
  oversizeError = error instanceof Error ? error.message : String(error)
}
check('nothing rejects a name past 64 locally', oversizeError === undefined, oversizeError ?? `${oversized.length} chars accepted`)

// Q3 — where the cap actually lives: the client's own config schema.
check('dsh-mcp-client rejects the same namespace', SERVER_NAME_PATTERN.test(serverNamespace) === false, String(SERVER_NAME_PATTERN))
check('dsh-mcp-client accepts a short namespace', SERVER_NAME_PATTERN.test('plugin_demo_github') === true, '')

// Q4 — the registration is disposable like any other tool.
dispose()
check('dispose removes the tool', ctx.tools.get(exactName) === undefined, '')

const failed = checks.filter((c) => !c.ok)
mkdirSync(join(here, 'out'), { recursive: true })
writeFileSync(
  join(here, 'out', 'report.json'),
  JSON.stringify({ tool: 'dsh', version: (await import(pathToFileURL(join(installedDir, 'dsh', 'package.json')).href, { with: { type: 'json' } })).default.version, checks }, null, 2),
)
for (const c of checks) console.log(`${c.ok ? '✔' : '✘'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
