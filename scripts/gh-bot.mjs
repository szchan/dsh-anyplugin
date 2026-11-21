#!/usr/bin/env node
// Run `gh` as the agent identity.
//
// Every GitHub write an agent makes goes through this script. The account is
// what separates an agent's comment from the human's; the `<!-- dsh-anyplugin-agent -->`
// marker is only a fallback for logs and for threads written before the bot
// existed. See docs/TRIAGE.md §1 and docs/WORKFLOW.md "Identity".

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DEFAULT_TOKEN_FILE = join(homedir(), '.config', 'dsh-anyplugin', 'gh-bot.token')
const TOKEN_FILE = process.env.DSH_ANYPLUGIN_BOT_TOKEN_FILE ?? DEFAULT_TOKEN_FILE
const REPO = process.env.DSH_ANYPLUGIN_REPO ?? 'szchan/dsh-anyplugin'

function fail(message) {
  console.error(`gh-bot: ${message}`)
  process.exit(2)
}

function readToken() {
  let raw
  try {
    raw = readFileSync(TOKEN_FILE, 'utf8')
  } catch {
    fail(`cannot read the bot token at ${TOKEN_FILE}
  Create a classic PAT on the bot account (scopes: repo, workflow), write it
  there, and chmod 600. See docs/WORKFLOW.md "Identity".`)
  }
  const token = raw.trim()
  if (token === '') fail(`the bot token file ${TOKEN_FILE} is empty`)
  if (/\s/.test(token)) fail(`the bot token file ${TOKEN_FILE} contains whitespace`)
  return token
}

function gh(args, { capture = false } = {}) {
  const result = spawnSync('gh', args, {
    env: { ...process.env, GH_TOKEN: readToken() },
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  })
  if (result.error) fail(`cannot run gh: ${result.error.message}`)
  return result
}

const argv = process.argv.slice(2)

if (argv[0] === '--whoami') {
  const who = gh(['api', 'user', '--jq', '.login'], { capture: true })
  if (who.status !== 0) fail(`gh api user failed: ${who.stderr.trim()}`)
  console.log(who.stdout.trim())
  const perms = gh(['api', `repos/${REPO}`, '--jq', '.permissions'], { capture: true })
  if (perms.status === 0) console.error(`  permissions: ${perms.stdout.trim()}`)
  process.exit(0)
}

if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
  console.log(`gh-bot — run gh as the agent identity

usage: node scripts/gh-bot.mjs <gh args...>
       node scripts/gh-bot.mjs --whoami

env:
  DSH_ANYPLUGIN_BOT_TOKEN_FILE  default ~/.config/dsh-anyplugin/gh-bot.token
  DSH_ANYPLUGIN_REPO            default szchan/dsh-anyplugin`)
  process.exit(0)
}

const child = gh(argv)
process.exit(child.status ?? 1)
