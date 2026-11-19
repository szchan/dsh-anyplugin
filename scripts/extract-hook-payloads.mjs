#!/usr/bin/env node
// Pull the canonical hook payload examples out of the pinned docs page and
// write them as fixtures. Run only when the pin moves; review the diff.
//
//   node scripts/extract-hook-payloads.mjs [--from <html>] [--url <url>]
//
// The doc examples are illustrative (they omit some fields the harness really
// sends, and show optional ones as present). Where a real capture exists under
// fixtures/hooks/captured/, the capture is the authority; see PROVENANCE.md.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const PIN = '2.1.322'
const DOCS_URL = 'https://code.claude.com/docs/en/hooks'
const outDir = new URL('../fixtures/hooks/payloads/', import.meta.url)

const args = process.argv.slice(2)
const local = args.indexOf('--from')
const html = local >= 0
  ? readFileSync(args[local + 1], 'utf8')
  : await (await fetch(DOCS_URL)).text()

const decode = (s) => s
  .replace(/<[^>]+>/g, '')
  .replace(/&quot;/g, '"')
  .replace(/&#x27;/g, "'")
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&amp;/g, '&')

const blocks = [...html.matchAll(/<code[^>]*>([\s\S]*?)<\/code>/g)].map((m) => decode(m[1]))
const payloads = new Map()
for (const block of blocks) {
  if (!block.includes('hook_event_name')) continue
  let parsed
  try {
    parsed = JSON.parse(block)
  } catch {
    continue
  }
  if (typeof parsed?.hook_event_name !== 'string') continue
  // Keep the first canonical block per event; later ones are variants.
  if (!payloads.has(parsed.hook_event_name)) payloads.set(parsed.hook_event_name, parsed)
}

mkdirSync(outDir, { recursive: true })
const names = [...payloads.keys()].sort()
for (const name of names) {
  const body = JSON.stringify({ __provenance: { source: 'docs', url: DOCS_URL, pin: `claude-code@${PIN}` }, payload: payloads.get(name) }, null, 2)
  writeFileSync(new URL(`${name}.json`, outDir), body + '\n')
}
console.log(`wrote ${names.length} payload fixtures: ${names.join(', ')}`)
