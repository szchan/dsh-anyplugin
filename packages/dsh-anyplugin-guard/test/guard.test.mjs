// The guard is the repository's own call-time policy. These tests drive the
// public `apply` mount with a fake context and assert the verdict a call would
// actually get, plus the two composition paths a reviewer runs by hand:
// `guardTable` (the dry-run proof) and `renderBlock`/`applyBlock` (the install
// block). They are deliberately adversarial: every deny case has an allow case
// one flag away, so a rule that fires on the wrong thing fails here.
import assert from 'node:assert/strict'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { execFileSync, spawnSync } from 'node:child_process'

import { apply, agentCwd, isWorker } from '../src/index.ts'
import {
  BLOCK_END,
  BLOCK_START,
  applyBlock,
  captureState,
  composeGuard,
  formatTable,
  guardTable,
  readBlock,
  readGitWorktrees,
  readState,
  readWorktrees,
  renderBlock,
  runTable,
  uninstallText,
} from '../src/composition.ts'
import { guardWorktrees, parseBlock, sameValue } from '../src/block.ts'
import { currentBranch, isMainRef } from '../src/git.ts'
import { chooseWorktree, messageText, renderBrief } from '../src/brief.ts'
import { insideGitDirectory, isWorktreeGlob, judgeCall, matchWorktree, resolvePolicy } from '../src/policy.ts'
import {
  hooksDirectory,
  installPrePushHook,
  prePushStatus,
  readPrePushHook,
  removePrePushHook,
  renderPrePushHook,
} from '../../../scripts/guard-hooks.mjs'

const checkout = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/u, '')
const repo = '/work/repo'
const worktree = '/work/wt/ticket-80'
const reviewedHead = '0123456789abcdef0123456789abcdef01234567'

// The guard now records every denial (F16). These tests deny on purpose, so
// point the recorder at a scratch directory: the checkout's `.audit/` is for
// real sessions, not for this matrix, and an audit reading it must not count a
// test run as evidence.
process.env.DSH_ANYPLUGIN_AUDIT_DIR = mkdtempSync(join(tmpdir(), 'guard-test-denials-'))

// A minimal main checkout that carries the current sources: a linked worktree
// refuses installs (its hooks dir is the main checkout's), so the rollback path
// has to run in an ordinary repository.
function scratchCheckout() {
  const dir = mkdtempSync(join(tmpdir(), 'guard-scratch-checkout-'))
  mkdirSync(join(dir, 'packages/dsh-anyplugin-guard'), { recursive: true })
  mkdirSync(join(dir, 'packages/dsh-anyplugin-conformance/test'), { recursive: true })
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  mkdirSync(join(dir, 'docs'), { recursive: true })
  cpSync(join(checkout, 'packages/dsh-anyplugin-guard/src'), join(dir, 'packages/dsh-anyplugin-guard/src'), { recursive: true })
  cpSync(
    join(checkout, 'packages/dsh-anyplugin-conformance/test/coverage.test.mjs'),
    join(dir, 'packages/dsh-anyplugin-conformance/test/coverage.test.mjs'),
  )
  cpSync(join(checkout, 'docs/FEATURES.md'), join(dir, 'docs/FEATURES.md'))
  cpSync(join(checkout, 'scripts/guard-install.mjs'), join(dir, 'scripts/guard-install.mjs'))
  cpSync(join(checkout, 'scripts/guard-status.mjs'), join(dir, 'scripts/guard-status.mjs'))
  cpSync(join(checkout, 'scripts/guard-hooks.mjs'), join(dir, 'scripts/guard-hooks.mjs'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'guard-scratch', private: true, type: 'module' }))
  execFileSync('git', ['init', '-q', dir])
  return dir
}

const config = {
  worktrees: [worktree],
  protectedRoots: [repo],
  brief: {
    ratchet: ['32 declared / 31 matched / 0 missing / 1 refused'],
    fixtures: '13 fixtures',
    open: ['mcpServers:a-server-name-that-is-long-enough:refused'],
  },
}

const worker = { id: 'worker-1', cwd: repo, worker: true }
const root = { id: 'root-1', cwd: repo, worker: false }

function verdict(tool, args, agent = worker, branch = 'ticket/80') {
  const checkoutBranch = branch === null ? undefined : branch
  return judgeCall(
    { tool, args, agent, ...(agent.worker ? { worktree } : {}) },
    resolvePolicy(config),
    { branch: () => checkoutBranch },
  )
}

const shell = (command, agent = worker, branch = 'ticket/80') =>
  verdict('bash', { command }, agent, branch)

test('a push to main is denied for every role; the ticket branch is allowed', () => {
  for (const agent of [worker, root]) {
    assert.equal(shell('git push origin main', agent).kind, 'deny')
    assert.equal(shell('git push origin HEAD:main', agent).kind, 'deny')
    assert.equal(shell('git push origin +refs/heads/main:refs/heads/main', agent).kind, 'deny')
    assert.equal(shell('git push --all origin', agent).kind, 'deny')
    assert.equal(shell('git push origin --delete main', agent).kind, 'deny')
    assert.equal(shell('git -C /work/repo push origin master', agent).kind, 'deny')
  }
  assert.equal(shell('git push -u origin ticket/80').kind, 'allow')
  assert.equal(shell('cd /work/wt/ticket-80 && git push origin ticket/80').kind, 'allow')
})

test('a bare push is refused for every role: remote.<r>.push and push.default can retarget it', () => {
  // The two configs a bare push obeys: `remote.origin.push=refs/heads/main`
  // and `push.default=upstream` with `branch.ticket/80.merge=refs/heads/main`.
  // Reading git config is not needed when the ambiguous form is refused.
  for (const branch of ['main', 'ticket/80', null]) {
    const outcome = shell('git push', worker, branch)
    assert.equal(outcome.kind, 'deny')
    assert.equal(outcome.rule, 'git-push-bare')
    assert.match(outcome.reason, /remote.<name>.push|push.default|refspec/u)
  }
  assert.equal(shell('git push origin HEAD:refs/heads/ticket/80').kind, 'allow')
})

test('a nested shell in bash -c cannot smuggle the push past the guard', () => {
  assert.equal(shell(`bash -c 'git push origin main'`).kind, 'deny')
  assert.equal(shell(`sh -lc "git push origin main"`).kind, 'deny')
  assert.equal(shell('git status --short && git push origin main').kind, 'deny')
  assert.equal(shell('sudo -u root git push origin main').kind, 'deny')
})

test('an unpinned merge is denied for the root', () => {
  for (const command of [
    'gh pr merge 82',
    'gh pr merge 82 --squash',
    'gh pr merge 82 --delete-branch',
    'gh -R szchan/dsh-anyplugin pr merge 82 --merge',
  ]) {
    const denied = shell(command, root)
    assert.equal(denied.kind, 'deny', command)
    assert.equal(denied.rule, 'gh-pr-merge-pin', command)
    assert.match(denied.reason, /cannot know which commit was reviewed/u)
    assert.match(denied.reason, /--match-head-commit <40-hex reviewed head>/u)
  }
})

test('--auto does not exempt a merge from the pin', () => {
  for (const command of ['gh pr merge --auto 82', 'gh pr merge 82 --auto', 'gh pr merge --auto 82 --squash']) {
    const denied = shell(command, root)
    assert.equal(denied.kind, 'deny', command)
    assert.equal(denied.rule, 'gh-pr-merge-pin', command)
  }
  assert.equal(shell(`gh pr merge --auto 82 --match-head-commit ${reviewedHead}`, root).kind, 'allow')
})

test('a merge pin must be a full 40-hex head', () => {
  for (const pin of ['abc1234', reviewedHead.slice(0, 39), `${reviewedHead}0`, 'g'.repeat(40)]) {
    const denied = shell(`gh pr merge 82 --match-head-commit ${pin}`, root)
    assert.equal(denied.kind, 'deny', pin)
    assert.equal(denied.rule, 'gh-pr-merge-pin', pin)
    assert.match(denied.reason, /not a full 40-hex commit sha/u)
  }
  assert.equal(shell('gh pr merge 82 --match-head-commit', root).rule, 'gh-pr-merge-pin')
  assert.equal(shell(`gh pr merge 82 -- --match-head-commit ${reviewedHead}`, root).rule, 'gh-pr-merge-pin')
})

test('a pinned merge is allowed for the root', () => {
  for (const command of [
    `gh pr merge 82 --squash --match-head-commit ${reviewedHead}`,
    `gh pr merge 82 --auto --match-head-commit ${reviewedHead}`,
    `gh pr merge 82 --match-head-commit=${reviewedHead}`,
    `gh pr merge --squash --match-head-commit ${reviewedHead} 82`,
    `gh -R szchan/dsh-anyplugin pr merge 82 --squash --match-head-commit ${reviewedHead}`,
  ]) {
    assert.equal(shell(command, root).kind, 'allow', command)
  }
})

test('a worker cannot merge even with a pin', () => {
  for (const command of [
    'gh pr merge 82 --squash',
    `gh pr merge 82 --squash --match-head-commit ${reviewedHead}`,
  ]) {
    const denied = shell(command, worker)
    assert.equal(denied.kind, 'deny', command)
    assert.equal(denied.rule, 'gh-pr-merge-worker', command)
  }
  assert.equal(shell('gh pr view 82', worker).kind, 'allow')
})

test('a value flag cannot swallow the merge pin', () => {
  for (const [short, long] of [
    ['-b', '--body'],
    ['-F', '--body-file'],
    ['-t', '--subject'],
    ['-A', '--author-email'],
    ['-R', '--repo'],
  ]) {
    for (const flag of [short, long]) {
      for (const form of [flag, `${flag}=`]) {
        const command =
          form === `${flag}=`
            ? `gh pr merge 82 ${form}--match-head-commit=${reviewedHead}`
            : `gh pr merge 82 ${form} --match-head-commit=${reviewedHead}`
        const denied = shell(command, root)
        assert.equal(denied.kind, 'deny', command)
        assert.equal(denied.rule, 'gh-pr-merge-pin', command)
        assert.match(denied.reason, /consumed as the value of/u, command)
      }
    }
  }
  assert.equal(shell(`gh pr merge 82 --body text --match-head-commit ${reviewedHead}`, root).kind, 'allow')
  assert.equal(shell(`gh pr merge 82 --body=text --match-head-commit=${reviewedHead}`, root).kind, 'allow')
})

test('a help request is not a merge', () => {
  for (const agent of [root, worker]) {
    for (const flag of ['--help', '-h', '--help=true', '-h=true']) {
      assert.equal(shell(`gh pr merge 82 ${flag}`, agent).kind, 'allow', `${agent.id} ${flag}`)
    }
  }
  const missing = shell('gh pr merge 82 --help=false', root)
  assert.equal(missing.kind, 'deny')
  assert.equal(missing.rule, 'gh-pr-merge-pin')
  assert.equal(shell(`gh pr merge 82 --help=false --match-head-commit ${reviewedHead}`, root).kind, 'allow')
  // `--help` as body text is not a help request; the real pin is still checked.
  assert.equal(shell('gh pr merge 82 --body --help', root).kind, 'deny')
  assert.equal(shell(`gh pr merge 82 --body --help --match-head-commit ${reviewedHead}`, root).kind, 'allow')
})

test('disabling auto-merge is not a merge', () => {
  for (const flag of ['--disable-auto', '--disable-auto=true']) {
    assert.equal(shell(`gh pr merge 82 ${flag}`, root).kind, 'allow', flag)
  }
  // A false disable/auto flag does not cancel the merge; it merges immediately.
  for (const flag of ['--disable-auto=false', '--auto=false']) {
    const immediate = shell(`gh pr merge 82 ${flag}`, root)
    assert.equal(immediate.kind, 'deny', flag)
    assert.equal(immediate.rule, 'gh-pr-merge-pin', flag)
    assert.equal(shell(`gh pr merge 82 ${flag} --match-head-commit ${reviewedHead}`, root).kind, 'allow', flag)
  }
})

test('a merge is judged at the gh command position', () => {
  for (const agent of [root, worker]) {
    assert.equal(shell('gh pr list --search pr merge', agent).kind, 'allow')
    assert.equal(shell('gh pr view 82 --json merge', agent).kind, 'allow')
  }
  assert.equal(shell('gh -R szchan/dsh-anyplugin pr merge 82', root).rule, 'gh-pr-merge-pin')
})

test('a persistent repo flag cannot hide the merge subcommand', () => {
  for (const command of [
    'gh pr -R szchan/dsh-anyplugin merge 82',
    'gh pr --repo szchan/dsh-anyplugin merge 82',
    'gh pr --repo=szchan/dsh-anyplugin merge 82',
    'gh pr -Rszchan/dsh-anyplugin merge 82',
    'gh pr -R=szchan/dsh-anyplugin merge 82',
    'gh pr --hostname enterprise.example merge 82',
    'gh --hostname enterprise.example pr merge 82',
  ]) {
    const denied = shell(command, root)
    assert.equal(denied.kind, 'deny', command)
    assert.equal(denied.rule, 'gh-pr-merge-pin', command)
    const workerDenied = shell(command, worker)
    assert.equal(workerDenied.kind, 'deny', command)
    assert.equal(workerDenied.rule, 'gh-pr-merge-worker', command)
  }
  assert.equal(
    shell(`gh pr -R szchan/dsh-anyplugin merge 82 --match-head-commit ${reviewedHead}`, root).kind,
    'allow',
  )
})

test('a line continuation cannot hide a merge or a main push', () => {
  const continuation = (left, right) => left + '\\' + '\n' + right
  const merge = continuation('gh pr ', 'merge 161 --squash')
  assert.equal(shell(merge, root).rule, 'gh-pr-merge-pin')
  assert.equal(shell(merge, worker).rule, 'gh-pr-merge-worker')
  assert.equal(shell(continuation('git push origin m', 'ain'), worker).rule, 'git-push-main')
  assert.equal(shell(continuation('g', 'it push origin ticket/80'), worker).kind, 'allow')
  assert.equal(
    shell(continuation('gh pr ', `merge 161 --squash --match-head-commit ${reviewedHead}`), root).kind,
    'allow',
  )
})

test('a raw gh api merge is refused because it cannot carry the pin', () => {
  for (const command of [
    'gh api -X PUT repos/szchan/dsh-anyplugin/pulls/82/merge',
    'gh api -XPUT repos/szchan/dsh-anyplugin/pulls/82/merge',
    'gh api --method POST repos/szchan/dsh-anyplugin/pulls/82/merge',
    'gh api -X PUT repos/szchan/dsh-anyplugin/pulls/82/merge?merge_method=squash',
    'gh api -X PUT repos/szchan/dsh-anyplugin/pulls/82/merge#fragment',
    'gh api -X PUT https://api.github.com/repos/szchan/dsh-anyplugin/pulls/82/merge#fragment',
    'gh api -X PUT repos/szchan/dsh-anyplugin/pulls/82/merge?x=1#fragment',
    'gh api -f merge_method=squash repos/szchan/dsh-anyplugin/pulls/82/merge',
    'gh api --raw-field merge_method=squash repos/szchan/dsh-anyplugin/pulls/82/merge',
    'gh api repos/szchan/dsh-anyplugin/pulls/82/merge',
  ]) {
    const denied = shell(command, root)
    assert.equal(denied.kind, 'deny', command)
    assert.equal(denied.rule, 'gh-pr-merge-pin', command)
    assert.match(denied.reason, /gh api/u)
  }
})

test('a shell wrapper cannot hide an unpinned merge', () => {
  for (const command of [
    `bash -c 'gh pr merge 82 --squash'`,
    `sh -lc "gh pr merge 82 --squash"`,
    'git status --short && gh pr merge 82 --squash',
    'env -i gh pr merge 82 --squash',
  ]) {
    const denied = shell(command, root)
    assert.equal(denied.kind, 'deny', command)
    assert.equal(denied.rule, 'gh-pr-merge-pin', command)
  }
  assert.equal(shell(`sh -s <<'EOF'\ngh pr merge 82 --squash\nEOF`, root).rule, 'shell-unmodelled')
})

test('DECISIONS.md is append-only: every writer is denied except the sanctioned update', () => {
  assert.equal(verdict('write', { file_path: `${worktree}/docs/DECISIONS.md`, content: '## D99' }).kind, 'deny')
  assert.equal(verdict('edit', { file_path: `${worktree}/docs/DECISIONS.md`, old_string: 'a', new_string: 'b' }).kind, 'deny')
  assert.equal(shell(`${worktree}/docs/DECISIONS.md`).kind, 'deny', 'a bare path is not a command the guard can judge')
  assert.equal(shell('printf x >> docs/DECISIONS.md').kind, 'deny')
  assert.equal(shell('sed -i s/a/b/ docs/DECISIONS.md').kind, 'deny')
  assert.equal(shell('git checkout -- docs/DECISIONS.md').kind, 'deny')
  assert.equal(shell('cp /tmp/decisions.md docs/DECISIONS.md').kind, 'deny')
  assert.equal(shell('node -e "require(\'fs\').writeFileSync(\'docs/DECISIONS.md\', \'\')"').kind, 'deny')
  assert.equal(shell('node scripts/check-decisions.mjs --update').kind, 'allow')
  assert.equal(shell('npm run check:decisions -- --update').kind, 'allow')
})

test('writes are confined to the recorded worktree, with the main checkout protected', () => {
  assert.equal(verdict('write', { file_path: `${worktree}/src/a.ts`, content: 'x' }).kind, 'allow')
  assert.equal(verdict('write', { file_path: `${repo}/packages/x/src/a.ts`, content: 'x' }).kind, 'deny')
  assert.equal(verdict('write', { file_path: '/tmp/elsewhere/a.ts', content: 'x' }).kind, 'deny')
  assert.equal(verdict('read', { file_path: `${repo}/README.md` }).kind, 'allow', 'reads are not writes')
  assert.equal(shell(`touch ${worktree}/notes.md`).kind, 'allow')
  assert.equal(shell(`touch ${repo}/notes.md`).kind, 'deny')
  const outside = shell('touch /tmp/elsewhere/notes.md')
  assert.equal(outside.kind, 'deny')
  assert.match(outside.reason, /worktree/u)
  assert.equal(verdict('apply_patch', { input: `*** Begin Patch\n*** Update File: ${worktree}/src/a.ts\n*** End Patch` }).kind, 'allow')
  assert.equal(verdict('apply_patch', { input: `*** Begin Patch\n*** Add File: ${repo}/src/b.ts\n*** End Patch` }).kind, 'deny')
})

test('a root agent is not confined, but is still bound by the push and decisions rules', () => {
  assert.equal(verdict('write', { file_path: `${repo}/README.md`, content: 'x' }, root).kind, 'allow')
  assert.equal(shell('git push origin main', root).kind, 'deny')
  assert.equal(verdict('write', { file_path: `${repo}/docs/DECISIONS.md`, content: 'x' }, root).kind, 'deny')
})

test('read-only and build commands stay allowed', () => {
  for (const command of ['npm run check', 'npm run check:arch', 'git status --short', 'git log --oneline -5', 'rg "foo" packages', 'cat README.md', 'bun install', 'bun --version', 'bun run check', 'npx -c "npm run check"', 'npx -c "tsc --noEmit"', 'npx -c "echo \'npm test\'"', 'npx -c "grep \'npm test\' file"']) {
    assert.equal(shell(command).kind, 'allow', command)
  }
})

test('the suite, the build and the spikes run in CI, not here (#175)', () => {
  for (const command of [
    'npm test',
    'npm t',
    'npm run test',
    'npm run verify',
    'npm run build',
    'npm run check:pack',
    'npm run perf',
    'npm run bench',
    'npm run spike:s24',
    'node scripts/gate-slot.mjs -- node --test',
    // The runner itself, and the launchers: the review found each of these
    // reaching the suite with the wrapper rule in place.
    'node --test',
    'node --experimental-vm-modules --test --test-concurrency=2 "packages/**/*.test.mjs"',
    'node --run verify',
    'node --run=build',
    'npm --prefix . run verify',
    'npm --prefix . test',
    'npm run -w . verify',
    'npm --workspace x run verify',
    'npm rum verify',
    'npm urn verify',
    'npm tst',
    'npx npm test',
    'npx --no-install vitest',
    'npm exec vitest',
    'npm x vitest',
    'node_modules/.bin/vitest',
    'vitest run',
    'jest',
    // Launcher wrappers the second review reached (#226): a package operand, a
    // shell-string call, a launcher over node, a launcher over a launcher, and
    // the pnpm/yarn/bun aliases of the same scripts.
    'npx -p npm npm test',
    'npx --package npm npm test',
    'npx -c "npm test"',
    'npx --call "npm run verify"',
    'npx node --test',
    'npx npx npm test',
    'pnpm verify',
    'yarn verify',
    'bun test',
    'bun run verify',
    'pnpm --dir . run verify',
    // A `-c` string is a command list; every segment is judged, not the first.
    'npx -c "npm run check; npm test"',
    'npx -c "npm run check && npm test"',
    'npx -c "npm run check || npm run build"',
    'npx -c "cd . && npm test"',
    'npx -c "sh -c \\"npm test\\""',
    'npm exec -c "npm run check; npm test"',
    // Bun only when it runs the suite; `bun install` is not a suite run.
    'bun --watch test',
    // A quoted nested list must be read the same way: splitting before quote
    // handling let the suite hide behind an inner shell (reviewer #226).
    `npx -c "sh -c 'npm run check; npm test'"`,
    `npx -c "sh -c 'npm run check && npm test'"`,
    `npx -c "bash -c 'npm run check; npm test'"`,
    `npm exec -c "sh -c 'npm run check; npm test'"`,
    `npx -c "npm run check | npm test"`,
    `npx -c "npm run check & npm test"`,
    // Wrappers that hide the list are refused as unmodelled, not guessed at.
    `npx -c "eval 'npm test'"`,
    `npx -c "sudo sh -c 'npm test'"`,
    `npx -c "dash -c 'npm test'"`,
    `npx -c "bash -lc 'npm test'"`,
    `npx -c "env sh -c 'npm test'"`,
    `npx -c "command sh -c 'npm test'"`,
    // Quotes are removed by the shell, so the reader must remove them too.
    'npx -c "npm run \\"verify\\""',
    `npx -c 'npm run "verify"'`,
    `npx -c '"npm" test'`,
    `npx -c "sh -c 'npm run \\"test\\"'"`,
    // Grouping, control constructs and unlisted wrappers are the same policy.
    'npx -c "(npm test)"',
    'npx -c "{ npm test; }"',
    'npx -c "if true; then npm test; fi"',
    'npx -c "for x in 1; do npm test; done"',
    'npx -c "! npm test"',
    `npx -c "nice sh -c 'npm test'"`,
    `npx -c "FOO=1 sh -c 'npm test'"`,
    'npx -c "stdbuf -oL npm test"',
    'npx -c "setsid npm test"',
    'npx -c "flock /tmp/x npm test"',
    `npx -c "busybox sh -c 'npm test'"`,
  ]) {
    const outcome = shell(command)
    assert.equal(outcome.kind, 'deny', command)
    assert.equal(outcome.rule, 'local-verify-refused', command)
  }
  for (const command of ['npm run check', 'npm run check:arch', 'npm run check:audit', 'npm run inbox', 'npm run ci', 'npm run guard:status', 'npm run verify:release -- --version 0.3.0', 'npx tsc --noEmit', 'node scripts/check-decisions.mjs']) {
    assert.equal(shell(command).kind, 'allow', command)
  }
  assert.equal(shell('ANYPLUGIN_LOCAL_VERIFY=1 npm run verify', root).kind, 'allow', 'the root may opt into one deliberate run')
  assert.equal(shell('ANYPLUGIN_LOCAL_VERIFY=1 npm run verify').kind, 'deny', 'a worker may not opt in')
  for (const value of ['0', 'false', '00', '']) {
    assert.equal(shell(`ANYPLUGIN_LOCAL_VERIFY=${value} npm test`, root).kind, 'deny', `${value || 'empty'} does not opt in`)
  }
  assert.equal(shell('ANYPLUGIN_LOCAL_VERIFY=1 npm test', root).kind, 'allow', 'the hatch opens a deliberate run')
  assert.equal(shell('ANYPLUGIN_LOCAL_VERIFY=1 npm run build', root).kind, 'allow', 'the hatch names what it is for')
  assert.equal(shell('npm run check && npm test', root).kind, 'deny', 'one CI-only script in a chain is enough')
  const twoRuns = shell('ANYPLUGIN_LOCAL_VERIFY=1 npm test; ANYPLUGIN_LOCAL_VERIFY=1 npm run build', root)
  assert.equal(twoRuns.kind, 'deny', 'the hatch covers one command segment, so a second escaped run is refused')
  assert.equal(twoRuns.rule, 'local-verify-refused')
})

test('a launcher is not an exemption: its target is judged by the whole policy (#226)', () => {
  const deny = (command, rule, agent = worker) => {
    const outcome = shell(command, agent)
    assert.equal(outcome.kind, 'deny', command)
    assert.equal(outcome.rule, rule, command)
  }
  // Each of these was allowed before the launcher target was re-judged: the
  // wrapper was read, the command it would run was not.
  deny(`npx node -e "require('child_process').execSync('npm test')"`, 'interpreter-exec')
  deny(`npx node -e "require('child_process').execSync('git push origin main')"`, 'interpreter-exec')
  deny(`npx bash -lc 'npm test'`, 'local-verify-refused')
  deny(`npx env -i npm test`, 'local-verify-refused')
  deny('npx sudo npm test', 'sudo-refused')
  deny('npx git push origin main', 'git-push-main')
  deny('npx -c "git push origin main"', 'git-push-main')
  deny('npx -c "gh pr merge 82 --squash"', 'gh-pr-merge-worker')
  deny(`npx -c "rm -rf ${repo}/tmp"`, 'write-outside-worktree')
  deny('npx -c "git push origin main"', 'git-push-main', root)
  // The `-c`/`--call` string is judged the same way as a direct command.
  deny('npx -c "npm test"', 'local-verify-refused')
  // A call string the reader cannot see into (parentheses here) is refused as
  // an unmodelled shell list before the full-policy pass gets to name a rule.
  deny('npx -c "node -e \'require(\\"child_process\\").execSync(\\"npm test\\")\'"', 'local-verify-refused')
  // The same target behind the rest of the launcher family.
  deny(`npm exec node -e "require('child_process').execSync('npm test')"`, 'interpreter-exec')
  deny('npm exec -c "git push origin main"', 'git-push-main')
  deny('npm x --call "gh pr merge 82 --squash"', 'gh-pr-merge-worker')
  deny('pnpm exec -c "rm -rf /tmp/elsewhere"', 'write-outside-worktree')
  deny('pnpm exec vitest', 'local-verify-refused')
  deny('pnpm dlx vitest', 'local-verify-refused')
  deny('yarn exec vitest', 'local-verify-refused')
  deny('yarn dlx vitest', 'local-verify-refused')
  deny('bun x vitest', 'local-verify-refused')
  // A launcher can wrap a launcher; the policy follows both without looping.
  deny(`npx npx bash -lc 'npm test'`, 'local-verify-refused')
  deny('npx -p typescript npx npx node --test', 'local-verify-refused')
})

test('the launcher target that the policy allows still runs (#226)', () => {
  for (const command of [
    'npx tsc --noEmit',
    'npx -p tsc tsc --noEmit',
    'npx -p npm',
    'npx --no-install tsc --noEmit',
    'npx -y tsc --noEmit',
    'npx -- tsc --noEmit',
    `npx bash -lc 'npm run check'`,
    'npx node -e "console.log(1)"',
    'npx -c "echo test"',
    'npx --call "echo test"',
    'npx -c "tsc --noEmit"',
    'npx -c "git status --short"',
    'npx -c "npm run check"',
    `npx -c "echo 'npm test'"`,
    'npm exec tsc -- --noEmit',
    'npm x tsc --noEmit',
    'npx npx tsc --noEmit',
    'pnpm exec tsc --noEmit',
    'yarn dlx tsc --noEmit',
    'bun x tsc --noEmit',
  ]) {
    assert.equal(shell(command).kind, 'allow', command)
  }
  // The hatch prefixes one segment; a launcher in front of that segment does
  // not swallow the prefix, and it does not unlock a second CI-only script.
  assert.equal(shell('ANYPLUGIN_LOCAL_VERIFY=1 npx -c "npm test"', root).kind, 'allow', 'the hatch reaches the target it prefixes')
  const two = shell('ANYPLUGIN_LOCAL_VERIFY=1 npx -c "npm test; npm run build"', root)
  assert.equal(two.kind, 'deny', 'the hatch is one script, not a launcher-shaped exemption')
  assert.equal(two.rule, 'local-verify-refused')
})

test('a launcher flag value is never mistaken for the target (#226)', () => {
  const deny = (command, rule = 'local-verify-refused') => {
    const outcome = shell(command)
    assert.equal(outcome.kind, 'deny', command)
    assert.equal(outcome.rule, rule, command)
  }
  // The reviewer's flag matrix: each of these values is an operand, so the
  // command after it is the target that gets judged. A naïve reader takes the
  // last word as the command and misses the suite in front of it.
  deny('npx -p typescript npm test')
  deny('npx --package typescript npm test')
  deny('npx --cwd . npm test')
  deny('npx --dir . npm test')
  deny('npx -C . npm test')
  deny('npx --registry http://example.test npm test')
  deny('npx -w foo npm test')
  deny('npx --workspace foo npm test')
  deny('npx --cache /tmp/cache npm test')
  deny('npx -y npm test')
  deny('npx -- npm test')
  deny('npm exec --cwd . npm test')
  deny('npm exec -- node --test')
  // pnpm/yarn workspace selectors are values too: without them the selector
  // word reads as the verb and `pnpm --filter pkg run verify` looks like a
  // `pkg` script.
  deny('pnpm --dir . run verify')
  deny('pnpm --filter pkg run verify')
  deny('pnpm -F pkg run verify')
  deny('pnpm --filter pkg test')
  deny('yarn --filter pkg run verify')
  for (const command of [
    'npx -p tsc tsc --noEmit',
    'npx -y tsc --noEmit',
    'npx -- tsc --noEmit',
    'npx --cwd . tsc --noEmit',
    'npx --registry http://example.test tsc --noEmit',
    'npx --cache /tmp/cache tsc --noEmit',
    'pnpm --filter pkg exec tsc --noEmit',
    'pnpm --filter pkg run check',
    'pnpm --dir . run check',
    'yarn --filter pkg run check',
  ]) {
    assert.equal(shell(command).kind, 'allow', command)
  }
})

test('a launcher flag whose value executes is folded into the judged command (#226)', () => {
  const deny = (command, rule = 'local-verify-refused') => {
    const outcome = shell(command)
    assert.equal(outcome.kind, 'deny', command)
    assert.equal(outcome.rule, rule, command)
  }
  // `--node-arg`/`--node-options` are arguments to the node that runs the
  // target, so folding the value before the target judges the command node
  // will actually run instead of skipping the value as an npx operand.
  deny('npx --node-arg --test node')
  deny('npx --node-arg --run=verify node')
  deny('npx --node-arg=--test node')
  deny('npx --node-arg=--run=verify node')
  deny('npx --node-options=--test node')
  deny('npx --node-arg --test')
  deny('npm exec --node-arg --test node')
  deny('npm exec --node-arg --test')
  deny('npm x --node-arg --test')
  // An executed payload is judged by the rest of the policy, not CI-only.
  deny(`npx --node-arg -e --node-arg "require('child_process').execSync('npm test')" node`, 'interpreter-exec')
  // A launcher can wrap the chain; every layer folds the same way.
  deny('npx npx --node-arg --test node')
  deny('npx -c "npx --node-arg --test node"')
  // `--shell <program>` runs the target through that program. A bare known
  // shell is the same command; a shell with its own flags, or an unknown
  // program, is a layer the reader refuses rather than guesses at.
  deny('npx --shell bash --node-arg --test node')
  deny(`npx --shell 'bash -c "npm test"' node`, 'shell-unmodelled')
  deny('npx --shell=fish node --version', 'shell-unmodelled')
  // `x` is the target here (npx has no `x` verb); it is refused as a command.
  deny('npx x --node-arg --test', 'shell-unmodelled')
  for (const command of ['npx --node-arg --version node', 'npx --shell bash node --version', 'npx --shell=bash node --version']) {
    assert.equal(shell(command).kind, 'allow', command)
  }
})

test('yarn workspace and workspaces hand off to the command they run (#226)', () => {
  const deny = (command, rule = 'local-verify-refused') => {
    const outcome = shell(command)
    assert.equal(outcome.kind, 'deny', command)
    assert.equal(outcome.rule, rule, command)
  }
  // The workspace selector is not the command: `exec`, `dlx` and a bare
  // command all reach the target underneath, and `run <script>` keeps the
  // npm verb grammar the CI-only rule reads.
  deny('yarn workspace pkg exec npm test')
  deny('yarn workspace pkg exec vitest')
  deny('yarn workspace pkg dlx vitest')
  deny('yarn workspace pkg node --test')
  deny('yarn workspace pkg run verify')
  deny('yarn workspaces run test')
  deny('yarn workspaces foreach exec npm test')
  deny('yarn -s workspace pkg run verify')
  deny('yarn --cwd . workspace pkg run verify')
  for (const command of [
    'yarn workspace pkg run check',
    'yarn workspace pkg exec tsc --noEmit',
    'yarn workspaces list',
    'yarn -s workspace pkg run check',
    'yarn workspaces foreach -A run check',
  ]) {
    assert.equal(shell(command).kind, 'allow', command)
  }
})

test('a launcher chain is bounded instead of followed forever (#226)', () => {
  assert.equal(shell('npx npx npx npx tsc --noEmit').kind, 'allow', 'four modelled launchers are shallow enough')
  const deep = shell('npx npx npx npx npx tsc --noEmit')
  assert.equal(deep.kind, 'deny')
  assert.equal(deep.rule, 'shell-unmodelled')
  assert.match(deep.reason, /launcher/u)
  // A chain whose inner command already breaks a rule is denied by that rule
  // first: the depth cap is not what makes the suite run wrong.
  const inner = shell('npx npx npx npx npm test')
  assert.equal(inner.kind, 'deny')
  assert.equal(inner.rule, 'local-verify-refused')
})

test('an alias, a git config write and an unknown subcommand cannot hide a push', () => {
  for (const command of [
    "git -c alias.p='push --no-verify origin main' p",
    "git config alias.p 'push --no-verify origin main'",
    'git config --global alias.p "push origin main"',
    'git config core.hooksPath /tmp/hooks',
    'git -c core.hooksPath=/tmp/hooks status',
  ]) {
    const outcome = shell(command)
    assert.equal(outcome.kind, 'deny', command)
    assert.equal(outcome.rule, 'git-config-write', command)
  }
  assert.equal(shell('git config --get user.name').kind, 'allow', 'workers may read config')
  assert.equal(shell('git config --get alias.p', root).kind, 'allow', 'the root may read config')
  const unknown = shell('git p')
  assert.equal(unknown.kind, 'deny')
  assert.equal(unknown.rule, 'git-unknown-subcommand')
  assert.match(unknown.reason, /alias/u)
})

test('a pre-existing git alias is a documented root residual', () => {
  // Root may run an unknown git subcommand, so an alias already in config is
  // outside the tool layer's model; the worker still gets `git-unknown-subcommand`.
  assert.equal(shell('git pm 82', root).kind, 'allow')
  const workerView = shell('git pm 82')
  assert.equal(workerView.kind, 'deny')
  assert.equal(workerView.rule, 'git-unknown-subcommand')
})

test('ordinary work survives: non-exec -c keys, local history verbs, reads and lease pushes', () => {
  for (const command of [
    'git -c user.name=X -c user.email=Y commit -m "x"',
    'git rebase main',
    'git stash',
    'git config --get user.name',
    'git config --list',
    'git push --force-with-lease origin ticket/80',
    'git push --force-if-includes origin ticket/80',
  ]) {
    const outcome = shell(command)
    assert.equal(outcome.kind, 'allow', command)
  }
  for (const command of [
    'git -c core.fsmonitor=touch status',
    'git -c core.sshCommand="sh -c x" pull',
    'git -c core.pager=less log',
    'git -c diff.external=/tmp/x diff',
    'git -c filter.x.clean=/tmp/x status',
    'git -c credential.helper=/tmp/x fetch',
    'git -c gpg.program=/tmp/x log',
    'git config user.name X',
  ]) {
    const outcome = shell(command)
    assert.equal(outcome.kind, 'deny', command)
    assert.equal(outcome.rule, 'git-config-write', command)
  }
  assert.equal(shell('git config user.name X', root).kind, 'allow', 'the root may write a non-exec key')
  const hooks = shell('git config core.hooksPath /tmp/hooks', root)
  assert.equal(hooks.kind, 'deny')
  assert.equal(hooks.rule, 'git-config-write')
})

test('a leading assignment on a worker git segment is refused', () => {
  for (const command of [
    'FOO=1 git push origin main',
    'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.fsmonitor GIT_CONFIG_VALUE_0=x git status',
    'env GIT_SSH_COMMAND="sh -c x" git fetch',
  ]) {
    const outcome = shell(command)
    assert.equal(outcome.kind, 'deny', command)
    assert.equal(outcome.rule, 'git-env-prefix', command)
  }
  assert.equal(shell('FOO=1 git status', root).kind, 'allow', 'the root may carry an environment prefix')
})

test('wildcard and range refspecs are refused before they can address main', () => {
  for (const command of [
    'git push origin "refs/heads/*:refs/heads/ticket/*"',
    'git push origin "HEAD:refs/heads/*"',
    'git push origin "HEAD:ticket/[a-z]"',
    'git push origin "HEAD:refs/heads/main..tmp"',
  ]) {
    const outcome = shell(command)
    assert.equal(outcome.kind, 'deny', command)
    assert.equal(outcome.rule, 'git-push-shape', command)
  }
})

test('literal process-spawn payloads are refused; a plain one-liner is not', () => {
  for (const command of [
    `node -e "require('child_process').execSync('git push origin main')"`,
    `python3 -c "import subprocess; subprocess.run(['git','push','origin','main'])"`,
    `ruby -e "system('git push origin main')"`,
    `ruby -e 'exec("git","push","--no-verify","origin","HEAD:main")'`,
    `python3 -c 'import os; os.popen("git push --no-verify origin HEAD:main")'`,
    `php -r "system('git push origin main');"`,
  ]) {
    const outcome = shell(command)
    assert.equal(outcome.kind, 'deny', command)
    assert.equal(outcome.rule, 'interpreter-exec', command)
  }
  assert.equal(shell(`node -e "require('fs').readFileSync('README.md')"`).kind, 'allow')
})

test('send-pack, update-ref and --no-verify do not get a second route to main', () => {
  assert.equal(shell('git push --no-verify origin main').kind, 'deny')
  const send = shell('git send-pack ../remote.git HEAD:refs/heads/main')
  assert.equal(send.kind, 'deny')
  assert.equal(send.rule, 'git-push-plumbing')
  assert.match(send.reason, /send-pack/u)
  assert.equal(shell('git update-ref refs/heads/main HEAD').kind, 'deny')
})

test('exec config keys and the push shape are refused, not inspected', () => {
  for (const command of [
    "git -c core.fsmonitor='sh -c \"git push origin main\"' status",
    'git --config-env=core.fsmonitor=ENV status',
    "git -c Alias.p='push origin main' p",
    'git -c core.pager=less status',
    'git --config-env=alias.p=PAYLOAD p',
  ]) {
    for (const agent of [worker, root]) {
      const outcome = shell(command, agent)
      assert.equal(outcome.kind, 'deny', command)
      assert.equal(outcome.rule, 'git-config-write', command)
    }
  }
  assert.equal(shell('git -c core.quotepath=false status', root).kind, 'allow', 'a root may set a non-exec key')
  for (const command of [
    "git push --receive-pack='sh -c \"git push origin main\"' origin ticket/80",
    'git push --exec=/tmp/x origin ticket/80',
    'git push -o ci.skip origin main',
    'git push origin ticket/80 ticket/81',
    'git push ../remote.git main',
  ]) {
    const outcome = shell(command)
    assert.equal(outcome.kind, 'deny', command)
    assert.ok(['git-push-exec', 'git-push-shape'].includes(outcome.rule), command + ' → ' + outcome.rule)
  }
})

test('here-strings, process substitution and /dev/stdin are refused', () => {
  assert.match(shell("sh -s <<< 'git push origin main'").reason, /here-string/u)
  assert.match(shell('bash <(echo git push origin main)').reason, /process substitution/u)

  for (const command of [
    "sh -s <<< 'git push origin main'",
    "bash <<< 'git push origin main'",
    'bash <(echo git push origin main)',
    "bash /dev/stdin <<< 'git push origin main'",
    "sh -c 'bash <(echo git push origin main)'",
  ]) {
    const outcome = shell(command)
    assert.equal(outcome.kind, 'deny', command)
    assert.equal(outcome.rule, 'shell-unmodelled', command)
  }
})

test('redirections that capture output are not background jobs', () => {
  for (const command of ['git status 2>&1', 'git log 2>&1 | tail -20', 'node --version 1>&2', `git status > ${worktree}/out 2>&1`]) {
    assert.equal(shell(command).kind, 'allow', command)
  }
  assert.equal(shell('git status &').kind, 'deny', 'a real background job is still refused')
})

test('$ is literal in single quotes and at a boundary that cannot start an expansion', () => {
  for (const command of [
    "awk '{print $1}' README.md",
    "echo '$HOME'",
    "sed 's/x$//' notes.md",
    'echo cost$',
    'echo $/path',
  ]) {
    assert.equal(shell(command).kind, 'allow', command)
  }
  for (const command of ['echo "$HOME"', 'echo $1', 'echo ${HOME}', 'echo $((1+2))']) {
    const outcome = shell(command)
    assert.equal(outcome.kind, 'deny', command)
    assert.equal(outcome.rule, 'shell-unmodelled', command)
  }
})

test('script files are unverified for workers; stdin and here-strings are refused', () => {
  const script = shell('bash scripts/test.sh')
  assert.equal(script.kind, 'deny')
  assert.equal(script.rule, 'shell-script-unverified')
  assert.match(script.reason, /does not read script contents/u)
  assert.equal(shell('bash scripts/test.sh', root).kind, 'allow', 'the root may run a committed script')
  for (const command of ["bash -s <<'EOF'\nrm -rf x\nEOF", "bash <<'EOF'\nrm -rf x\nEOF", "sh -s <<< 'git push origin main'", "bash <(echo git push origin main)", 'bash < /dev/stdin']) {
    const outcome = shell(command)
    assert.equal(outcome.kind, 'deny', command)
    assert.equal(outcome.rule, 'shell-unmodelled', command)
  }
})

test('ruby and php write payloads are refused like node and python', () => {
  for (const command of [
    `ruby -e 'File.write("/tmp/rx","a")'`,
    `ruby -e 'IO.write("/tmp/rx","a")'`,
    `php -r 'file_put_contents("/tmp/rx","a")'`,
    `php -r 'fopen("/tmp/rx","w")'`,
  ]) {
    assert.equal(shell(command).kind, 'deny', command)
  }
})

function harness(agents) {
  const listeners = new Map()
  const disposers = []
  const ctx = {
    on(event, listener) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return () => list.splice(list.indexOf(listener), 1)
    },
    effect(register) {
      disposers.push(register())
    },
    // The loader's service registry: a session event carries the session, so
    // the guard resolves its id back to the live Agent object the seams use.
    get(name) {
      return name === 'agents' ? agents : undefined
    },
  }
  return { ctx, listeners, disposers }
}

test('the plugin mounts one pre-execute listener and denies before the tool runs', async () => {
  const { ctx, listeners, disposers } = harness()
  await apply(ctx, config)
  assert.equal(listeners.get('tools/pre-execute')?.length, 1)
  assert.equal(listeners.get('agent/pre-step')?.length, 1)
  assert.equal(listeners.get('session/event')?.length, 1)
  assert.equal(disposers.length, 5, 'three seam mounts plus the created/disposed pair')

  // D80: the seams read the session header, not a hand-built view.
  const runtime = (agent) => ({ session: { header: { id: agent.id, cwd: agent.cwd, ...(agent.worker ? { origin: 'subagent' } : {}) } } })
  const exec = (name, args, agent = worker) => ({ callId: 1, name, arguments: args, agent: runtime(agent) })
  let ran = 0
  const next = async () => {
    ran += 1
    return { kind: 'accept' }
  }
  const denied = await listeners.get('tools/pre-execute')[0](exec('bash', { command: 'git push origin main' }), next)
  assert.equal(denied.kind, 'deny')
  assert.equal(ran, 0, 'the host never executes a denied call')
  assert.equal(
    (await listeners.get('tools/pre-execute')[0](exec('bash', { command: 'npm run check' }), next)).kind,
    'accept',
  )
  assert.equal(ran, 1)
})

test('the installed guard denies an unpinned merge and allows a pinned one', async () => {
  // The dry-run table proves the policy; this proves the installed block names
  // a plugin that actually mounts the listener. A dormant finding needs that
  // second observation: the rule bites wherever the guard is loaded.
  const composition = composeGuard({
    repoRoot: checkout,
    worktrees: [{ path: checkout, branch: 'main', main: true }],
  })
  const profile = mkdtempSync(join(tmpdir(), 'guard-install-merge-'))
  try {
    const patchPath = join(profile, 'cordis.patch.yml')
    writeFileSync(patchPath, applyBlock('', composition.block))
    const installed = readBlock(readFileSync(patchPath, 'utf8'))
    assert.equal(installed.present, true)
    const source = installed.block.match(/name:\s*"([^"]+)"/u)?.[1]
    assert.equal(source, composition.source, 'the installed block names the guard source')
    const plugin = await import(pathToFileURL(source).href)

    const { ctx, listeners } = harness()
    await plugin.apply(ctx, composition.config)
    const listener = listeners.get('tools/pre-execute')[0]
    assert.equal(typeof listener, 'function')

    const rootAgent = { session: { header: { id: 'root-1', cwd: checkout } } }
    let ran = 0
    const next = async () => {
      ran += 1
      return { kind: 'accept' }
    }
    const call = (command) => ({ callId: 1, name: 'bash', arguments: { command }, agent: rootAgent })

    const denied = await listener(call('gh pr merge 161 --squash'), next)
    assert.equal(denied.kind, 'deny')
    assert.equal(ran, 0, 'the host never executes a denied call')
    assert.match(denied.reason, /--match-head-commit <40-hex reviewed head>/u)
    assert.match(denied.reason, /cannot know which commit was reviewed/u)

    const allowed = await listener(
      call(`gh pr merge 161 --squash --match-head-commit ${reviewedHead}`),
      next,
    )
    assert.equal(allowed.kind, 'accept')
    assert.equal(ran, 1)
  } finally {
    rmSync(profile, { recursive: true, force: true })
  }
})

test('the brief is appended to the worker continuation once, and never to the root', async () => {
  const { ctx, listeners } = harness()
  await apply(ctx, config)
  const preStep = listeners.get('agent/pre-step')[0]
  const continuation = async () => ({
    kind: 'enter',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'runtime context' }] }],
  })

  const spawned = (id, prompt) => ({
    session: { header: { id, cwd: repo, ...(id === 'worker-1' ? { parentSession: 'root-1' } : {}) } },
    prompt,
  })
  const child = spawned('worker-1', `work in ${worktree}, ticket/80`)
  const first = await preStep({ agent: child, step: 1, messages: [{ role: 'user', content: `work in ${worktree}` }] }, continuation)
  assert.equal(first.messages.length, 2, 'the host continuation is kept and the brief appended')
  assert.equal(first.messages[0].content[0].text, 'runtime context')
  const brief = first.messages[1].content[0].text
  assert.match(brief, /<anyplugin-guard-brief>/u)
  assert.match(brief, new RegExp(worktree.replaceAll('/', '\\/'), 'u'))
  assert.match(brief, /32 declared \/ 31 matched \/ 0 missing \/ 1 refused/u)
  assert.match(brief, /13 fixtures/u)
  const message = first.messages[1]
  assert.match(message.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u, 'the loop reads message.source; the id is a real UUID')
  assert.equal(message.source.kind, 'user', 'runtime-context is the snapshot kind; a queued prompt is user')
  assert.notEqual(message.source.kind, 'runtime-context')

  const second = await preStep({ agent: child, step: 2, messages: [] }, continuation)
  assert.equal(second.messages.length, 1, 'the brief is delivered at most once')

  const rootAgent = spawned('root-1', 'do the thing')
  const rootStep = await preStep({ agent: rootAgent, step: 1, messages: [] }, continuation)
  assert.equal(rootStep.messages.length, 1)
})

test('the worktree recorded from the spawn prompt is the one a write is confined to', async () => {
  const other = '/work/wt/ticket-81'
  const { ctx, listeners } = harness()
  await apply(ctx, { ...config, worktrees: [worktree, other] })
  const agent = { session: { header: { id: 'worker-2', cwd: repo, origin: 'subagent', parentSession: 'root-1' } } }
  // The prompt names ticket-80, so that worktree is recorded even though two
  // are installed.
  await listeners.get('agent/pre-step')[0](
    { agent, step: 1, messages: [{ role: 'user', content: `work in ${worktree}, ticket/80` }] },
    async () => ({ kind: 'enter', messages: [] }),
  )
  const denied = await listeners.get('tools/pre-execute')[0](
    { callId: 2, name: 'write', arguments: { file_path: `${other}/src/x.ts`, content: 'x' }, agent },
    async () => ({ kind: 'accept' }),
  )
  assert.equal(denied.kind, 'deny')
  assert.ok(denied.reason.includes(worktree), 'the reason names the recorded worktree')
  assert.equal(
    (
      await listeners.get('tools/pre-execute')[0](
        { callId: 3, name: 'write', arguments: { file_path: `${worktree}/src/x.ts`, content: 'x' }, agent },
        async () => ({ kind: 'accept' }),
      )
    ).kind,
    'accept',
  )
})

test('a glob config admits the worktree the prompt named and refuses a sibling at the tool seam', async () => {
  const pattern = '/work/wt/ticket-*'
  const created = '/work/wt/ticket-2001'
  const { ctx, listeners } = harness()
  await apply(ctx, { ...config, worktrees: [pattern] })
  const agent = { session: { header: { id: 'worker-3', cwd: repo, origin: 'subagent', parentSession: 'root-1' } } }
  const continued = await listeners.get('agent/pre-step')[0](
    { agent, step: 1, messages: [{ role: 'user', content: `work in ${created}, ticket/2001` }] },
    async () => ({ kind: 'enter', messages: [] }),
  )
  assert.match(continued.messages[0].content[0].text, new RegExp(created.replaceAll('/', '\\/'), 'u'))
  const tools = listeners.get('tools/pre-execute')[0]
  assert.equal(
    (await tools({ callId: 20, name: 'write', arguments: { file_path: `${created}/src/x.ts`, content: 'x' }, agent }, async () => ({ kind: 'accept' }))).kind,
    'accept',
  )
  const sibling = await tools(
    { callId: 21, name: 'write', arguments: { file_path: '/work/wt/ticket-2002/src/x.ts', content: 'x' }, agent },
    async () => ({ kind: 'accept' }),
  )
  assert.equal(sibling.kind, 'deny')
  assert.match(sibling.reason, /only inside its worktree \/work\/wt\/ticket-2001/u)
  const review = await tools(
    { callId: 22, name: 'write', arguments: { file_path: '/work/wt/review-1/src/x.ts', content: 'x' }, agent },
    async () => ({ kind: 'accept' }),
  )
  assert.equal(review.kind, 'deny')
})

test('a reviewer prompt that names only the branch records no worktree and writes nothing', async () => {
  // The real review prompt shape: the branch under review is in the text, the
  // reviewer's cwd is the master checkout, and no worktree path is given.
  const { ctx, listeners } = harness()
  await apply(ctx, config)
  const reviewer = { session: { header: { id: 'reviewer-1', cwd: repo, origin: 'subagent', parentSession: 'root-1' } } }
  const text = 'Review PR #89 on branch `ticket/80`. Do not merge. Report findings in a comment.'
  await listeners.get('agent/pre-step')[0](
    { agent: reviewer, step: 1, messages: [{ role: 'user', content: text }] },
    async () => ({ kind: 'enter', messages: [] }),
  )
  for (const path of [`${worktree}/src/a.ts`, `${repo}/src/a.ts`, 'notes.md']) {
    const denied = await listeners.get('tools/pre-execute')[0](
      { callId: 9, name: 'write', arguments: { file_path: path, content: 'x' }, agent: reviewer },
      async () => ({ kind: 'accept' }),
    )
    assert.equal(denied.kind, 'deny', path)
    assert.match(denied.reason, /protected checkout|no worktree is recorded/u)
  }
})

test('a seat that misses its first step retries and admits writes once the prompt arrives (#250)', async () => {
  // A fresh child's first pre-step can arrive before the message that names
  // its worktree does. Marking the attempt resolved turned that timing race
  // into a session that could never write; the seat must keep looking.
  const { ctx, listeners } = harness()
  await apply(ctx, config)
  const preStep = listeners.get('agent/pre-step')[0]
  const tools = listeners.get('tools/pre-execute')[0]
  const continuation = async () => ({ kind: 'enter', messages: [] })
  const agent = { session: { header: { id: 'worker-250', cwd: repo, origin: 'subagent', parentSession: 'root-1' } } }

  const first = await preStep({ agent, step: 1, messages: [] }, continuation)
  assert.equal(first.messages.length, 1, 'the brief is delivered even when the seat is unknown')
  const early = await tools(
    { callId: 30, name: 'write', arguments: { file_path: `${worktree}/src/x.ts`, content: 'x' }, agent },
    async () => ({ kind: 'accept' }),
  )
  assert.equal(early.kind, 'deny', 'nothing is recorded yet, so nothing is writable')
  assert.match(early.reason, /re-spawned with the worktree named in its prompt/u, 'the refusal says what to do')

  const second = await preStep(
    { agent, step: 2, messages: [{ role: 'user', content: `work in ${worktree}` }] },
    continuation,
  )
  assert.equal(second.messages.length, 0, 'the brief is not repeated while the seat is retried')

  const allowed = await tools(
    { callId: 31, name: 'write', arguments: { file_path: `${worktree}/src/x.ts`, content: 'x' }, agent },
    async () => ({ kind: 'accept' }),
  )
  assert.equal(allowed.kind, 'accept')
  const outside = await tools(
    { callId: 32, name: 'write', arguments: { file_path: '/work/wt/ticket-9999/src/x.ts', content: 'x' }, agent },
    async () => ({ kind: 'accept' }),
  )
  assert.equal(outside.kind, 'deny')
  assert.match(outside.reason, /only inside its worktree/u)
})

test('a seat is never derived from the header cwd, which a child copies from its parent (#250)', async () => {
  // `dsh-session` freezes the header and `dsh-subagent` copies the parent's
  // cwd into a child, so a child spawned elsewhere carries its parent's cwd.
  // Seating from it would lock the child to the parent's worktree; the spawn
  // cwd reaches it only as a working-directory notice in its messages.
  const elsewhere = '/work/wt/ticket-9997'
  const policy = { ...config, worktrees: [worktree, elsewhere] }
  const { ctx, listeners } = harness()
  await apply(ctx, policy)
  const agent = { session: { header: { id: 'worker-252', cwd: worktree, origin: 'subagent', parentSession: 'root-1' } } }
  const tools = listeners.get('tools/pre-execute')[0]
  const preStep = listeners.get('agent/pre-step')[0]
  // The #250 ordering: the first pre-step carries nothing yet, and the child's
  // header cwd is the parent's worktree. A cwd seat here would accept a write
  // into the parent's worktree.
  await preStep({ agent, step: 1, messages: [] }, async () => ({ kind: 'enter', messages: [] }))
  for (const path of [`${worktree}/src/y.ts`, `${elsewhere}/src/y.ts`]) {
    const denied = await tools(
      { callId: 40, name: 'write', arguments: { file_path: path, content: 'y' }, agent },
      async () => ({ kind: 'accept' }),
    )
    assert.equal(denied.kind, 'deny', `${path} is not writable before a seat exists`)
  }
  // A later step naming the child's real worktree seats it there, not at the
  // parent's cwd worktree.
  await preStep(
    { agent, step: 2, messages: [{ role: 'user', content: `your worktree is ${elsewhere}` }] },
    async () => ({ kind: 'enter', messages: [] }),
  )
  const allowed = await tools(
    { callId: 41, name: 'write', arguments: { file_path: `${elsewhere}/src/y.ts`, content: 'y' }, agent },
    async () => ({ kind: 'accept' }),
  )
  assert.equal(allowed.kind, 'accept')
  const parentWorktree = await tools(
    { callId: 42, name: 'write', arguments: { file_path: `${worktree}/src/y.ts`, content: 'y' }, agent },
    async () => ({ kind: 'accept' }),
  )
  assert.equal(parentWorktree.kind, 'deny', 'the seat is the named worktree, not the parent cwd')
  // A resolved seat never moves: a later notice naming the parent's worktree
  // does not re-seat the child.
  await preStep(
    { agent, step: 3, messages: [{ role: 'user', content: `working directory changed to ${worktree}` }] },
    async () => ({ kind: 'enter', messages: [] }),
  )
  const stillElsewhere = await tools(
    { callId: 43, name: 'write', arguments: { file_path: `${elsewhere}/src/y.ts`, content: 'y' }, agent },
    async () => ({ kind: 'accept' }),
  )
  assert.equal(stillElsewhere.kind, 'accept')
})

test('ambiguous text seats nothing and a later unambiguous message can still seat (#250)', async () => {
  const other = '/work/wt/ticket-9996'
  const policy = { ...config, worktrees: [worktree, other] }
  const { ctx, listeners } = harness()
  await apply(ctx, policy)
  const agent = { session: { header: { id: 'worker-253', cwd: repo, origin: 'subagent', parentSession: 'root-1' } } }
  const preStep = listeners.get('agent/pre-step')[0]
  await preStep(
    { agent, step: 1, messages: [{ role: 'user', content: `maybe ${worktree}, maybe ${other}` }] },
    async () => ({ kind: 'enter', messages: [] }),
  )
  const denied = await listeners.get('tools/pre-execute')[0](
    { callId: 50, name: 'write', arguments: { file_path: `${worktree}/src/z.ts`, content: 'z' }, agent },
    async () => ({ kind: 'accept' }),
  )
  assert.equal(denied.kind, 'deny', 'two candidate worktrees are not a seat')
  await preStep(
    { agent, step: 2, messages: [{ role: 'user', content: `working directory changed to ${other}` }] },
    async () => ({ kind: 'enter', messages: [] }),
  )
  const allowed = await listeners.get('tools/pre-execute')[0](
    { callId: 51, name: 'write', arguments: { file_path: `${other}/src/z.ts`, content: 'z' }, agent },
    async () => ({ kind: 'accept' }),
  )
  assert.equal(allowed.kind, 'accept')
})

test('an unseated worker is seated by the directory change the host announces (#266)', async () => {
  // The host appends `working-directory/change` when the worker moves itself;
  // that announcement is structured evidence a message-text seat does not need
  // to parse. Before it arrives the worker has no seat and writes nothing.
  const agent = { session: { header: { id: 'worker-266', cwd: repo, origin: 'subagent', parentSession: 'root-1' } } }
  const registry = { get: (id) => (id === 'worker-266' ? agent : undefined), list: () => [] }
  const { ctx, listeners } = harness(registry)
  await apply(ctx, config)
  const tools = listeners.get('tools/pre-execute')[0]
  const write = (path) =>
    tools(
      { callId: 60, name: 'write', arguments: { file_path: path, content: 'x' }, agent },
      async () => ({ kind: 'accept' }),
    )

  assert.equal((await write(`${worktree}/src/x.ts`)).kind, 'deny', 'nothing is recorded yet')

  const change = listeners.get('session/event')[0]
  assert.equal(typeof change, 'function')
  await change({ header: { id: 'worker-266' } }, { type: 'assistant/message', data: { cwd: worktree } })
  assert.equal((await write(`${worktree}/src/x.ts`)).kind, 'deny', 'only a directory change is a seat')
  await change({ header: { id: 'worker-266' } }, { type: 'working-directory/change', data: { cwd: worktree } })

  assert.equal((await write(`${worktree}/src/x.ts`)).kind, 'accept')
  assert.equal((await write(`${repo}/src/x.ts`)).kind, 'deny', 'the checkout stays protected')
  const outside = await write('/work/wt/ticket-9999/src/x.ts')
  assert.equal(outside.kind, 'deny')
  assert.match(outside.reason, /only inside its worktree/u)
})

test('a resumed session is seated by the announcement even though it never fired agent/created (#266)', async () => {
  // A cold resume announces the same session as a NEW Agent object; the seat
  // #250 learned from the spawn prompt lived on the previous object and the
  // resumed log is replayed without re-publishing its notices. No
  // `agent/created` is dispatched in this test, so a seat that depended on the
  // per-agent mount could never exist; the session-scoped announcement is the
  // only evidence, and it must seat the live Agent the seam carries.
  let live = { session: { header: { id: 'worker-resumed', cwd: repo, origin: 'subagent', parentSession: 'root-1' } } }
  const registry = { get: (id) => (id === 'worker-resumed' ? live : undefined), list: () => [] }
  const { ctx, listeners } = harness(registry)
  await apply(ctx, config)
  const tools = listeners.get('tools/pre-execute')[0]
  const write = () =>
    tools(
      { callId: 61, name: 'write', arguments: { file_path: `${worktree}/src/x.ts`, content: 'x' }, agent: live },
      async () => ({ kind: 'accept' }),
    )

  assert.equal((await write()).kind, 'deny')
  live = { session: { header: { id: 'worker-resumed', cwd: repo, origin: 'subagent', parentSession: 'root-1' } } }
  assert.equal((await write()).kind, 'deny', 'the resumed Agent starts unseated')

  await listeners.get('session/event')[0](
    { header: { id: 'worker-resumed' } },
    { type: 'working-directory/change', data: { cwd: worktree } },
  )
  assert.equal((await write()).kind, 'accept')
})

test('a directory change into the primary checkout records no seat (#266)', async () => {
  const agent = { session: { header: { id: 'worker-checkout', cwd: repo, origin: 'subagent', parentSession: 'root-1' } } }
  const registry = { get: () => agent, list: () => [] }
  const { ctx, listeners } = harness(registry)
  await apply(ctx, config)
  const change = listeners.get('session/event')[0]
  const tools = listeners.get('tools/pre-execute')[0]
  const write = () =>
    tools(
      { callId: 62, name: 'write', arguments: { file_path: `${worktree}/src/x.ts`, content: 'x' }, agent },
      async () => ({ kind: 'accept' }),
    )

  await change({ header: { id: 'worker-checkout' } }, { type: 'working-directory/change', data: { cwd: repo } })
  const denied = await write()
  assert.equal(denied.kind, 'deny')
  assert.match(denied.reason, /no worktree is recorded/u)

  // Not a seat is not a failure: the announcement stays retryable, so a later
  // real one can still seat the session.
  await change({ header: { id: 'worker-checkout' } }, { type: 'working-directory/change', data: { cwd: worktree } })
  assert.equal((await write()).kind, 'accept')
})

test('a directory change outside every installed worktree records no seat (#266)', async () => {
  const agent = { session: { header: { id: 'worker-outside', cwd: repo, origin: 'subagent', parentSession: 'root-1' } } }
  const registry = { get: () => agent, list: () => [] }
  const { ctx, listeners } = harness(registry)
  await apply(ctx, config)
  await listeners.get('session/event')[0](
    { header: { id: 'worker-outside' } },
    { type: 'working-directory/change', data: { cwd: '/tmp/anyplugin-wt/not-a-ticket' } },
  )
  const denied = await listeners.get('tools/pre-execute')[0](
    { callId: 63, name: 'write', arguments: { file_path: `${worktree}/src/x.ts`, content: 'x' }, agent },
    async () => ({ kind: 'accept' }),
  )
  assert.equal(denied.kind, 'deny')
  assert.match(denied.reason, /no worktree is recorded/u)
})

test('a recorded seat does not move when a later directory change names another worktree (#266)', async () => {
  const elsewhere = '/work/wt/ticket-9997'
  const policy = { ...config, worktrees: [worktree, elsewhere] }
  const agent = { session: { header: { id: 'worker-moved', cwd: repo, origin: 'subagent', parentSession: 'root-1' } } }
  const registry = { get: () => agent, list: () => [] }
  const { ctx, listeners } = harness(registry)
  await apply(ctx, policy)
  const preStep = listeners.get('agent/pre-step')[0]
  const tools = listeners.get('tools/pre-execute')[0]
  const write = (path) =>
    tools(
      { callId: 64, name: 'write', arguments: { file_path: path, content: 'x' }, agent },
      async () => ({ kind: 'accept' }),
    )

  await preStep(
    { agent, step: 1, messages: [{ role: 'user', content: `spawned to work in ${worktree}` }] },
    async () => ({ kind: 'enter', messages: [] }),
  )
  assert.equal((await write(`${worktree}/src/x.ts`)).kind, 'accept')

  await listeners.get('session/event')[0](
    { header: { id: 'worker-moved' } },
    { type: 'working-directory/change', data: { cwd: elsewhere } },
  )
  assert.equal((await write(`${worktree}/src/x.ts`)).kind, 'accept', 'the recorded seat never moves')
  const moved = await write(`${elsewhere}/src/x.ts`)
  assert.equal(moved.kind, 'deny')
  assert.match(moved.reason, /only inside its worktree/u)
})

test('an ambiguous directory change, like ambiguous text, records no seat (#266)', async () => {
  // The announcement is resolved by the same exactly-one rule as a message:
  // nested entries both cover the announced path, so neither wins.
  const nested = `${worktree}/nested`
  const policy = { ...config, worktrees: [worktree, nested] }
  const agent = { session: { header: { id: 'worker-ambiguous', cwd: repo, origin: 'subagent', parentSession: 'root-1' } } }
  const registry = { get: () => agent, list: () => [] }
  const { ctx, listeners } = harness(registry)
  await apply(ctx, policy)
  await listeners.get('session/event')[0](
    { header: { id: 'worker-ambiguous' } },
    { type: 'working-directory/change', data: { cwd: nested } },
  )
  const denied = await listeners.get('tools/pre-execute')[0](
    { callId: 65, name: 'write', arguments: { file_path: `${nested}/src/x.ts`, content: 'x' }, agent },
    async () => ({ kind: 'accept' }),
  )
  assert.equal(denied.kind, 'deny')
  assert.match(denied.reason, /no worktree is recorded/u)
})

test('a symlink inside the worktree does not become a write into the checkout', () => {
  const data = mkdtempSync(join(tmpdir(), 'guard-symlink-'))
  try {
    const inside = join(data, 'wt')
    const checkoutDir = join(data, 'repo')
    mkdirSync(inside, { recursive: true })
    mkdirSync(checkoutDir, { recursive: true })
    symlinkSync(checkoutDir, join(inside, 'link'), 'dir')
    assert.equal(
      judgeCall(
        { tool: 'write', args: { file_path: join(inside, 'link', 'x.md'), content: 'x' }, agent: { cwd: inside, worker: true }, worktree: inside },
        resolvePolicy({ worktrees: [inside], protectedRoots: [checkoutDir] }),
        { branch: () => 'ticket/80' },
      ).kind,
      'deny',
    )
  } finally {
    rmSync(data, { recursive: true, force: true })
  }
})

test('a worker with no cwd cannot resolve a relative write and is refused', () => {
  const policy = resolvePolicy({ worktrees: [worktree], protectedRoots: [repo] })
  const call = { tool: 'write', args: { file_path: 'x.md', content: 'x' }, agent: { worker: true }, worktree }
  const outcome = judgeCall(call, policy, { branch: () => 'ticket/80' })
  assert.equal(outcome.kind, 'deny')
  assert.match(outcome.reason, /no cwd|absolute/u)
  const relative = judgeCall(
    { tool: 'write', args: { file_path: '../../../etc/x', content: 'x' }, agent: { worker: true, cwd: worktree }, worktree },
    policy,
    { branch: () => 'ticket/80' },
  )
  assert.equal(relative.kind, 'deny')
  assert.equal(relative.rule, 'write-outside-worktree')
})

test('shell bypasses are refused: >|, subshells, git write verbs and launchers', () => {
  assert.equal(shell(`echo x >| ${repo}/x`).kind, 'deny')
  assert.equal(shell(`(cd ${repo} && touch x)`).kind, 'deny')
  assert.equal(shell(`git restore ${repo}/x`).kind, 'allow', 'workspace-local restores are ordinary work')
  assert.equal(shell(`git clean -fd ${repo}`).kind, 'allow', 'workspace-local cleans are ordinary work')
  assert.equal(shell(`env -i git push origin main`).kind, 'deny')
  assert.equal(shell(`timeout 5 git push origin main`).kind, 'deny')
  assert.equal(shell(`nice -n 5 git push origin main`).kind, 'deny')
  assert.equal(shell(`echo $(printf 'git push origin main')`).kind, 'deny')
  assert.equal(shell('if true; then git push origin main; fi').kind, 'deny')
  assert.equal(shell(`tee ${worktree}/x.md < /tmp/in`).kind, 'allow', 'the read source is not a write target')
})

test('the reviewer bypass spellings are refused; ordinary commits are allowed', () => {
  const denied = (command, rule = 'shell-unmodelled') => {
    const outcome = shell(command)
    assert.equal(outcome.kind, 'deny', command)
    assert.equal(outcome.rule, rule, command)
  }
  denied('git push origin main&')
  denied('{ git push origin main; }')
  denied('! git push origin main')
  denied('( git push origin main )')
  denied("git push origin $'main'")
  denied('find . -exec git push origin main +')
  denied("sh -s <<'EOF'\ngit push origin main\nEOF", 'shell-unmodelled')
  denied('echo "git push origin main" | sh')
  denied('stdbuf -o0 git push origin main')
  denied('. /tmp/evil.sh')
  denied('sudo --preserve-env git push origin main', 'sudo-refused')
  assert.equal(shell('git commit -m "fix: a > b"').kind, 'allow', 'quoted commit text is not a redirect')
  assert.equal(shell('git commit -m "fix: a -> b"').kind, 'allow')
  assert.equal(shell('git commit -m "guard: a && b"').kind, 'allow', 'quoted && is text, not a separator')
  assert.equal(shell('git push origin HEAD:refs/heads/ticket/80').kind, 'allow')
  assert.equal(shell('node -e "console.log(1)"').kind, 'allow')
  denied('node -e "require(\'fs\').writeFileSync(\'/tmp/x\', \'y\')"', 'interpreter-write')
  denied('python3 -c "open(\'/tmp/x\', \'w\').write(\'y\')"', 'interpreter-write')
})

test('config keys are an inert allowlist, not a denylist of known drivers', () => {
  const driver = shell('git -c diff.foo.command=\'sh -c "git push --no-verify origin HEAD:main"\' diff --ext-diff')
  assert.equal(driver.kind, 'deny')
  assert.equal(driver.rule, 'git-config-write')

  const env = shell('git --config-env=diff.foo.command=ENV diff --ext-diff')
  assert.equal(env.kind, 'deny')
  assert.equal(env.rule, 'git-config-write')

  assert.equal(shell('git -c color.ui=false status').kind, 'allow', 'color.* is inert')
  assert.equal(shell('git -c user.email=x commit -m x').kind, 'allow', 'user.email is inert')
  assert.equal(shell('git config user.name X').kind, 'deny', 'still no worker config writes')

  assert.equal(shell('git config user.name X', root).kind, 'allow', 'root may write an inert key')
  assert.equal(shell('git config foo.bar x', root).kind, 'deny', 'root uses the same allowlist')
  assert.equal(shell('git -c diff.foo.command=x diff --ext-diff', root).kind, 'deny')
  assert.equal(shell('git -c user.name=X -c user.email=Y commit -m x', root).kind, 'allow')
})

test('a worker cannot plant a driver in .git, and sudo is refused', () => {
  const shellWrite = shell('printf \'[diff "foo"]\\n  command = sh -c "git push origin HEAD:main"\\n\' >> .git/config')
  assert.equal(shellWrite.kind, 'deny')
  assert.equal(shellWrite.rule, 'git-dir-write')

  const structured = verdict('write', { file_path: '/tmp/anyplugin-wt/ticket-80/.git/config', content: 'x' })
  assert.equal(structured.kind, 'deny')
  assert.equal(structured.rule, 'git-dir-write')

  const sudo = shell('sudo git push origin main')
  assert.equal(sudo.kind, 'deny')
  assert.equal(sudo.rule, 'sudo-refused')
  assert.equal(shell('sudo --preserve-env git status').rule, 'sudo-refused')
})

test('interpreter file mutations and tar extraction cannot write .git', () => {
  for (const command of [
    `node -e 'require("fs").renameSync("/tmp/evil", ".git/config")'`,
    `node -e 'require("fs").copyFileSync("/tmp/evil", ".git/config")'`,
    `node -e 'require("fs").cpSync("/tmp/evil", ".git/config")'`,
    `node -e 'require("fs").symlinkSync("/tmp/evil", ".git/config")'`,
    `node -e 'require("fs").truncateSync(".git/config")'`,
  ]) {
    const outcome = shell(command)
    assert.equal(outcome.kind, 'deny', command)
    assert.equal(outcome.rule, 'interpreter-write', command)
  }
  const tar = shell('tar -xf /tmp/evil.tar -C .git')
  assert.equal(tar.kind, 'deny')
  assert.equal(tar.rule, 'git-dir-write')
  const attached = shell('tar -xf /tmp/evil.tar -C.git')
  assert.equal(attached.kind, 'deny', 'GNU tar accepts -C.git attached')
  assert.equal(attached.rule, 'git-dir-write')
  const outside = shell('tar -xf /tmp/evil.tar -C/tmp/tarout7')
  assert.equal(outside.kind, 'deny')
  assert.equal(outside.rule, 'write-outside-worktree')
  assert.equal(shell('tar -xf /tmp/evil.tar').kind, 'allow', 'extracting into the worktree is ordinary')

  // The payload is live, not hypothetical: the same attached form really does
  // replace `.git/config` when the guard is not in the way.
  const staging = mkdtempSync(join(tmpdir(), 'guard-tar-src-'))
  const destination = mkdtempSync(join(tmpdir(), 'guard-tar-dst-'))
  try {
    writeFileSync(join(staging, 'config'), '[diff "foo"]\n  command = sh -c "git push origin HEAD:main"\n')
    mkdirSync(join(destination, '.git'))
    writeFileSync(join(destination, '.git', 'config'), 'original\n')
    execFileSync('tar', ['-cf', join(staging, 'evil.tar'), '-C', staging, 'config'])
    execFileSync('tar', ['-xf', join(staging, 'evil.tar'), '-C.git'], { cwd: destination })
    assert.match(readFileSync(join(destination, '.git', 'config'), 'utf8'), /git push origin HEAD:main/u)
  } finally {
    rmSync(staging, { recursive: true, force: true })
    rmSync(destination, { recursive: true, force: true })
  }
})

test('spawn and write tokens inside string literals are data, not calls', () => {
  assert.equal(shell(`node -e 'console.log("exec(")'`).kind, 'allow')
  assert.equal(shell(`python3 -c 'print("exec(")'`).kind, 'allow')
  assert.equal(shell(`node -e 'console.log("renameSync(")'`).kind, 'allow')
  // The literal call next to the string is still refused.
  assert.equal(shell(`node -e 'console.log("exec("); exec("git push origin main")'`).rule, 'interpreter-exec')
})

test('sudo is matched at command position, not as a word', () => {
  for (const command of ['git commit -m sudo', 'git log --grep sudo', 'grep sudo README.md', 'echo sudo']) {
    assert.equal(shell(command).kind, 'allow', command)
  }
  assert.equal(shell('sudo git status').rule, 'sudo-refused')
  assert.equal(shell('sudo --preserve-env git status').rule, 'sudo-refused')
  assert.equal(shell('env -i -u X sudo git status').rule, 'sudo-refused')
  assert.equal(shell('FOO=1 sudo git status').rule, 'sudo-refused')
  for (const command of ['exec sudo git status', 'nice sudo git status', 'timeout 5 sudo git status', 'xargs sudo true']) {
    assert.equal(shell(command).rule, 'sudo-refused', command)
  }
  assert.equal(shell('nice -n 5 git status').kind, 'allow', 'nice without sudo stays ordinary')
})

test('the installed pre-push hook refuses every spelling git resolves to main', () => {
  const data = mkdtempSync(join(tmpdir(), 'guard-hook-'))
  const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' })
  try {
    const remote = join(data, 'remote.git')
    const local = join(data, 'repo')
    git(['init', '--bare', remote], data)
    git(['init', '-b', 'ticket/80', local], data)
    git(['config', 'user.email', 'guard@example.invalid'], local)
    git(['config', 'user.name', 'guard test'], local)
    writeFileSync(join(local, 'README.md'), 'guard hook test\n')
    git(['add', 'README.md'], local)
    git(['commit', '-m', 'seed'], local)
    git(['branch', 'main'], local)
    git(['remote', 'add', 'origin', remote], local)
    // Seed the remote main before the hook exists, so the delete case has a ref.
    git(['push', 'origin', 'main'], local)
    git(['checkout', 'main'], local)
    writeFileSync(join(local, 'MAIN.md'), 'ahead of the remote\n')
    git(['add', 'MAIN.md'], local)
    git(['commit', '-m', 'main is ahead'], local)
    git(['checkout', 'ticket/80'], local)
    git(['merge', '--ff-only', 'main'], local)
    writeFileSync(join(local, 'TICKET.md'), 'ticket work\n')
    git(['add', 'TICKET.md'], local)
    git(['commit', '-m', 'ticket is ahead'], local)

    const target = join(hooksDirectory(local), 'pre-push')
    assert.equal(prePushStatus(target), 'missing')
    installPrePushHook(target, renderPrePushHook())
    assert.equal(prePushStatus(target), 'current')
    assert.match(readFileSync(target, 'utf8'), /refs\/heads\/main/u)

    const push = (args) => spawnSync('git', ['push', ...args], { cwd: local, encoding: 'utf8' })
    for (const args of [
      ['origin', 'main'],
      ['origin', 'HEAD:main'],
      ['origin', '--all'],
      ['origin', '--mirror'],
      ['origin', ':main'],
    ]) {
      const result = push(args)
      assert.notEqual(result.status, 0, args.join(' '))
      assert.match(result.stderr, /anyplugin-guard/u, args.join(' '))
    }

    // A bare push is the config-dependent spelling: resolve it through the hook.
    git(['config', 'remote.origin.push', 'refs/heads/main'], local)
    assert.notEqual(push(['origin']).status, 0, 'remote.origin.push=refs/heads/main')
    git(['config', '--unset', 'remote.origin.push'], local)
    git(['config', 'push.default', 'upstream'], local)
    git(['config', 'branch.ticket/80.remote', 'origin'], local)
    git(['config', 'branch.ticket/80.merge', 'refs/heads/main'], local)
    assert.notEqual(push(['origin']).status, 0, 'push.default=upstream resolves to main')
    git(['config', '--unset', 'push.default'], local)
    git(['config', '--unset', 'branch.ticket/80.merge'], local)
    git(['config', '--unset', 'branch.ticket/80.remote'], local)

    const allowed = push(['origin', 'HEAD:refs/heads/ticket/80'])
    assert.equal(allowed.status, 0, allowed.stderr)

    removePrePushHook(target)
    assert.equal(prePushStatus(target), 'missing')
  } finally {
    rmSync(data, { recursive: true, force: true })
  }
})

test('the tool layer refuses hook bypasses before a remote can move', () => {
  const data = mkdtempSync(join(tmpdir(), 'guard-bypass-'))
  const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' })
  try {
    const remote = join(data, 'remote.git')
    const plumbing = join(data, 'plumbing.git')
    const local = join(data, 'repo')
    git(['init', '--bare', remote], data)
    git(['init', '--bare', plumbing], data)
    git(['init', '-b', 'main', local], data)
    git(['config', 'user.email', 'guard@example.invalid'], local)
    git(['config', 'user.name', 'guard test'], local)
    writeFileSync(join(local, 'README.md'), 'seed\n')
    git(['add', 'README.md'], local)
    git(['commit', '-m', 'seed'], local)
    git(['remote', 'add', 'origin', remote], local)
    git(['push', 'origin', 'main'], local)
    const seeded = git(['ls-remote', remote, 'refs/heads/main'], local).trim()
    assert.notEqual(seeded, '')

    git(['checkout', '-b', 'ticket/80'], local)
    writeFileSync(join(local, 'TICKET.md'), 'ticket\n')
    git(['add', 'TICKET.md'], local)
    git(['commit', '-m', 'ticket'], local)

    const guarded = (args) => {
      const outcome = shell(['git', ...args].join(' '))
      assert.equal(outcome.kind, 'deny', args.join(' '))
      return outcome
    }
    for (const args of [
      ['-c', 'alias.p=push --no-verify origin main', 'p'],
      ['config', 'alias.p', 'push --no-verify origin main'],
      ['-c', 'core.hooksPath=/tmp/hooks', 'push', 'origin', 'main'],
      ['push', '--no-verify', 'origin', 'main'],
      ['send-pack', plumbing, 'HEAD:refs/heads/main'],
    ]) {
      guarded(args)
    }
    assert.equal(git(['ls-remote', remote, 'refs/heads/main'], local).trim(), seeded, 'remote main did not move')
    assert.equal(git(['ls-remote', plumbing, 'refs/heads/main'], local).trim(), '', 'send-pack did not write')
  } finally {
    rmSync(data, { recursive: true, force: true })
  }
})

test('a failed profile write rolls the pre-push hook back', () => {
  const scratch = scratchCheckout()
  const profile = mkdtempSync(join(tmpdir(), 'guard-rollback-'))
  const hooks = hooksDirectory(scratch)
  const target = join(hooks, 'pre-push')
  assert.equal(readPrePushHook(target), undefined)
  chmodSync(profile, 0o500)
  try {
    const result = spawnSync(process.execPath, ['scripts/guard-install.mjs', '--profile-dir', profile], {
      cwd: scratch,
      encoding: 'utf8',
    })
    assert.equal(result.status, 1, result.stdout + result.stderr)
    assert.match(result.stderr, /EACCES|permission denied|operation not permitted/iu)
    assert.equal(readPrePushHook(target), undefined, 'the hook was rolled back when the patch could not be written')
  } finally {
    chmodSync(profile, 0o700)
    rmSync(profile, { recursive: true, force: true })
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('an install from a linked worktree is refused before it can touch the main hooks', () => {
  const main = mkdtempSync(join(tmpdir(), 'guard-main-'))
  const linked = join(main, 'linked')
  const profile = mkdtempSync(join(tmpdir(), 'guard-linked-'))
  try {
    execFileSync('git', ['init', '-q', main])
    execFileSync('git', ['-C', main, '-c', 'user.email=guard@example.invalid', '-c', 'user.name=guard', 'commit', '-q', '--allow-empty', '-m', 'init'])
    execFileSync('git', ['-C', main, 'worktree', 'add', '-q', '-b', 'ticket/linked', linked])
    const hooks = hooksDirectory(main)
    const before = readPrePushHook(join(hooks, 'pre-push'))
    const result = spawnSync(process.execPath, [join(checkout, 'scripts/guard-install.mjs'), '--profile-dir', profile], {
      cwd: linked,
      encoding: 'utf8',
    })
    assert.equal(result.status, 1, result.stdout + result.stderr)
    assert.match(result.stderr, /linked worktree/u)
    assert.equal(readPrePushHook(join(hooks, 'pre-push')), before, 'the main checkout hook was not touched')
    const uninstall = spawnSync(
      process.execPath,
      [join(checkout, 'scripts/guard-install.mjs'), '--uninstall', '--profile-dir', profile],
      { cwd: linked, encoding: 'utf8' },
    )
    assert.equal(uninstall.status, 1, uninstall.stdout + uninstall.stderr)
    assert.match(uninstall.stderr, new RegExp(`Run from the main checkout \\(${main.replaceAll('/', '\\/')}\\)`, 'u'))
    assert.match(uninstall.stderr, /--dry-run cannot uninstall anything/u)
    assert.ok(!uninstall.stderr.includes('--dry-run (which writes nothing)'), 'an uninstall is not offered a dry run')
  } finally {
    rmSync(profile, { recursive: true, force: true })
    rmSync(main, { recursive: true, force: true })
  }
})

test('guard:status refuses a duplicate id outside the block and a lone end marker', () => {
  const data = mkdtempSync(join(tmpdir(), 'guard-status-'))
  const patch = join(data, 'cordis.patch.yml')
  const status = () =>
    spawnSync(process.execPath, [join(checkout, 'scripts/guard-status.mjs'), '--profile-dir', data], {
      encoding: 'utf8',
    })
  try {
    writeFileSync(patch, '- id: "anyplugin-guard"\n')
    const duplicate = status()
    assert.notEqual(duplicate.status, 0)
    assert.match(duplicate.stdout, /duplicate - id/u)

    writeFileSync(patch, `${BLOCK_END}\n`)
    const marker = status()
    assert.notEqual(marker.status, 0)
    assert.match(marker.stderr, /end marker without a start marker/u)
    assert.doesNotMatch(marker.stderr, /\n\s+at /u, 'a broken profile is a clean refusal, not a stack')
  } finally {
    rmSync(data, { recursive: true, force: true })
  }
})

test('the block reader proves a folded scalar equal and refuses what it cannot read', () => {
  const source = join(repo, 'packages/dsh-anyplugin-guard/src/index.ts')
  const block = renderBlock(source, config)
  const rendered = parseBlock(block)
  assert.equal(rendered.ok, true, rendered.ok ? '' : rendered.reason)
  assert.deepEqual(guardWorktrees(rendered.value), config.worktrees)

  const foldName = (text, separator) => {
    const line = text.split('\n').find((entry) => entry.startsWith('      name: '))
    const name = JSON.parse(line.slice('      name: '.length))
    const cut = name.indexOf('index.ts')
    assert.notEqual(cut, -1, 'the composed block quotes the source path')
    return text.replace(line, '      name: "' + name.slice(0, cut) + separator + name.slice(cut) + '"')
  }

  // A backslash continuation removes the break, so the folded value is the
  // single-line one the tree wrote.
  const escaped = parseBlock(foldName(block, '\\\n        '))
  assert.equal(escaped.ok, true, escaped.ok ? '' : escaped.reason)
  assert.equal(sameValue(escaped.value, rendered.value), true, 'a backslash continuation folds away the break')

  // The same fold, with one character changed in the continuation, is a
  // different path: value comparison must see it.
  const tampered = parseBlock(foldName(block, '\\\n        ').replace('index.ts"', 'index.mjs"'))
  assert.equal(tampered.ok, true, tampered.ok ? '' : tampered.reason)
  assert.equal(sameValue(tampered.value, rendered.value), false, 'a changed continuation is a changed value')

  // A bare line break folds to one space, so it only preserves a scalar that
  // already has that space.
  const foldedSpace = parseBlock('ratchet:\n  - "32 declared / 31\n    matched"\n')
  assert.equal(foldedSpace.ok, true, foldedSpace.ok ? '' : foldedSpace.reason)
  assert.equal(foldedSpace.ok && sameValue(foldedSpace.value, { ratchet: ['32 declared / 31 matched'] }), true)

  const duplicateKey = parseBlock('name: "one"\nname: "two"\n')
  assert.equal(duplicateKey.ok, false)
  assert.match(duplicateKey.ok ? '' : duplicateKey.reason, /duplicate mapping key/u)

  const flow = parseBlock('worktrees: [unterminated\n')
  assert.equal(flow.ok, false)
  assert.match(flow.ok ? '' : flow.reason, /flow sequences are not read/u)

  const anchored = parseBlock('worktrees: &anchor []\n')
  assert.equal(anchored.ok, false)
  assert.match(anchored.ok ? '' : anchored.reason, /anchors, aliases and tags are not read/u)
})

test('the block reader types plain scalars the way the loader does, and folds whitespace the way YAML does', () => {
  // FAIL-OPEN regression (F20 follow-up): a fold that leaves literal spaces
  // before the escaped break changes the value the loader sees. The reader used
  // to trim them and call the block current.
  const spaced = parseBlock('name: "src/ind   \\\n        ex.ts"\n')
  assert.equal(spaced.ok, true, spaced.ok ? '' : spaced.reason)
  assert.deepEqual({ ...spaced.value }, { name: 'src/ind   ex.ts' }, 'spaces before an escaped break are content')

  const tabbed = parseBlock('name: "src/ind\t\\\n        ex.ts"\n')
  assert.equal(tabbed.ok, true, tabbed.ok ? '' : tabbed.reason)
  assert.deepEqual({ ...tabbed.value }, { name: 'src/ind\tex.ts' })

  const escapedSpaceBreak = parseBlock('name: "src/ind\\ \\\n        ex.ts"\n')
  assert.equal(escapedSpaceBreak.ok, true, escapedSpaceBreak.ok ? '' : escapedSpaceBreak.reason)
  assert.deepEqual({ ...escapedSpaceBreak.value }, { name: 'src/ind ex.ts' }, 'an escaped space stays one space')

  const escapedSpaceFold = parseBlock('name: "src/ind\\ \n        ex.ts"\n')
  assert.equal(escapedSpaceFold.ok, true, escapedSpaceFold.ok ? '' : escapedSpaceFold.reason)
  assert.deepEqual({ ...escapedSpaceFold.value }, { name: 'src/ind  ex.ts' }, 'a bare fold adds a space next to an escaped one')

  // A *bare* break drops the raw whitespace that sits before it, and a fold
  // discards the continuation's leading whitespace including a tab. Both are
  // js-yaml's reading (`"x  \n  y"` is `x y`, `"x\` + LF + TAB + `y"` is `xy`),
  // and both are pinned here so a lenient reader cannot pass.
  const bareTrailing = parseBlock('name: "src/ind   \n        ex.ts"\n')
  assert.equal(bareTrailing.ok, true, bareTrailing.ok ? '' : bareTrailing.reason)
  assert.deepEqual({ ...bareTrailing.value }, { name: 'src/ind ex.ts' }, 'a bare break drops raw trailing whitespace')

  const bareTrailingTab = parseBlock('name: "src/ind\t\n        ex.ts"\n')
  assert.equal(bareTrailingTab.ok, true, bareTrailingTab.ok ? '' : bareTrailingTab.reason)
  assert.deepEqual({ ...bareTrailingTab.value }, { name: 'src/ind ex.ts' }, 'a bare break drops a raw trailing tab')

  const tabContinuation = parseBlock('name: "src/index.ts\\\n\tex.mjs"\n')
  assert.equal(tabContinuation.ok, true, tabContinuation.ok ? '' : tabContinuation.reason)
  assert.deepEqual({ ...tabContinuation.value }, { name: 'src/index.tsex.mjs' }, 'a fold skips a leading tab in the continuation')

  // The whole leading run is indentation, spaces and tabs interleaved: skipping
  // only a tab run would keep the spaces that follow the tab as content.
  const tabThenSpaces = parseBlock('name: "x\\\n\t  y"\n')
  assert.equal(tabThenSpaces.ok, true, tabThenSpaces.ok ? '' : tabThenSpaces.reason)
  assert.deepEqual({ ...tabThenSpaces.value }, { name: 'xy' }, 'a fold skips tabs and the spaces after them')

  const bareTabThenSpaces = parseBlock('name: "x \n\t  y"\n')
  assert.equal(bareTabThenSpaces.ok, true, bareTabThenSpaces.ok ? '' : bareTabThenSpaces.reason)
  assert.deepEqual({ ...bareTabThenSpaces.value }, { name: 'x y' }, 'a bare break drops raw whitespace before the indentation')

  const tabSpaceTab = parseBlock('name: "x\\\n\t \ty"\n')
  assert.equal(tabSpaceTab.ok, true, tabSpaceTab.ok ? '' : tabSpaceTab.reason)
  assert.deepEqual({ ...tabSpaceTab.value }, { name: 'xy' }, 'an interleaved tab/space run is all indentation')

  // Plain scalars are typed by the YAML schema, so `TRUE` is a boolean and
  // `0x10` is 16: reading them as strings would make two different loader
  // documents compare equal.
  assert.deepEqual(parseBlock('a: TRUE\n').ok ? { ...parseBlock('a: TRUE\n').value } : undefined, { a: true })
  assert.deepEqual(parseBlock('a: Null\n').ok ? { ...parseBlock('a: Null\n').value } : undefined, { a: null })
  assert.deepEqual(parseBlock('a: 0x10\n').ok ? { ...parseBlock('a: 0x10\n').value } : undefined, { a: 16 })
  assert.deepEqual(parseBlock('a: 012\n').ok ? { ...parseBlock('a: 012\n').value } : undefined, { a: 12 })
  assert.deepEqual(parseBlock('a: .5\n').ok ? { ...parseBlock('a: .5\n').value } : undefined, { a: 0.5 })
  assert.deepEqual(parseBlock('a: +1\n').ok ? { ...parseBlock('a: +1\n').value } : undefined, { a: 1 })
  assert.deepEqual(parseBlock('a: 1_000\n').ok ? { ...parseBlock('a: 1_000\n').value } : undefined, { a: '1_000' })
  assert.deepEqual(parseBlock('a: yes\n').ok ? { ...parseBlock('a: yes\n').value } : undefined, { a: 'yes' })

  // Values the loader would throw on are refused, so the comparison is stale
  // rather than "equal".
  const mappingLike = parseBlock('a: foo: bar\n')
  assert.equal(mappingLike.ok, false)
  assert.match(mappingLike.ok ? '' : mappingLike.reason, /plain value "foo: bar" is not read/u)
  const sequenceLike = parseBlock('a: - b\n')
  assert.equal(sequenceLike.ok, false)
  assert.match(sequenceLike.ok ? '' : sequenceLike.reason, /plain value "- b" is not read/u)

  // The loader's schema types `.inf` / `.NaN` as non-finite numbers; the block
  // cannot mean them, and a JSON report cannot round-trip them, so they are
  // refused (stale, never current).
  const infinite = parseBlock('a: .inf\n')
  assert.equal(infinite.ok, false)
  assert.match(infinite.ok ? '' : infinite.reason, /is not a finite number; quote it/u)
  const notANumber = parseBlock('a: -.NaN\n')
  assert.equal(notANumber.ok, false)
  assert.match(notANumber.ok ? '' : notANumber.reason, /is not a finite number; quote it/u)

  // A numeric form that overflows a double is a string to the loader (its float
  // resolver requires a finite parse) and infinite to `Number`, so the reader
  // must refuse it rather than call it a number.
  for (const text of ['1e999', '-1e999', '1e309', '1.0e999']) {
    const overflow = parseBlock(`a: ${text}\n`)
    assert.equal(overflow.ok, false, `${text} must be refused`)
    assert.match(overflow.ok ? '' : overflow.reason, /is not a finite number; quote it/u)
  }
  const finiteFloat = parseBlock('a: 1e308\n')
  assert.equal(finiteFloat.ok, true)
  assert.deepEqual({ ...finiteFloat.value }, { a: 1e308 })

  // `guardWorktrees` selects the guard's own insert row, not the first one, and
  // a malformed config is "unknown", never a guess (m3-drop-id-check mutation).
  const foreignFirst = parseBlock(
    '- insert:\n    - id: "someone-else"\n      config:\n        worktrees:\n          - "/nope"\n    - id: "anyplugin-guard"\n      config:\n        worktrees:\n          - "/tmp/anyplugin-wt/ticket-*"\n',
  )
  assert.equal(foreignFirst.ok, true, foreignFirst.ok ? '' : foreignFirst.reason)
  assert.deepEqual(guardWorktrees(foreignFirst.value), ['/tmp/anyplugin-wt/ticket-*'])
  const malformedWorktrees = parseBlock('- insert:\n    - id: "anyplugin-guard"\n      config:\n        worktrees: 5\n')
  assert.equal(malformedWorktrees.ok, true, malformedWorktrees.ok ? '' : malformedWorktrees.reason)
  assert.equal(guardWorktrees(malformedWorktrees.value), undefined)
})

test('guard:status reads a folded block as current, and still refuses a changed, a duplicated or an unreadable one', () => {
  const scratch = scratchCheckout()
  const profile = mkdtempSync(join(tmpdir(), 'guard-status-values-'))
  const patch = join(profile, 'cordis.patch.yml')
  const status = (args = []) =>
    spawnSync(
      process.execPath,
      [join(scratch, 'scripts/guard-status.mjs'), '--profile-dir', profile, ...args],
      { cwd: scratch, encoding: 'utf8' },
    )
  const report = () => JSON.parse(status(['--json']).stdout)
  const installed = () => readFileSync(patch, 'utf8')
  const install = () =>
    spawnSync(process.execPath, [join(scratch, 'scripts/guard-install.mjs'), '--profile-dir', profile], {
      cwd: scratch,
      encoding: 'utf8',
    })
  // The F20 shape: the profile writer folds the long double-quoted name scalar
  // with a backslash continuation and reseats the end marker behind a blank
  // line. No value changes.
  const fold = (text) => {
    const line = text.split('\n').find((entry) => entry.startsWith('      name: '))
    const name = JSON.parse(line.slice('      name: '.length))
    const cut = name.indexOf('/src/ind') + '/src/ind'.length
    assert.ok(cut >= '/src/ind'.length, 'the installed block quotes the source path')
    return text
      .replace(line, '      name: "' + name.slice(0, cut) + '\\\n        ' + name.slice(cut) + '"')
      .replace(BLOCK_END, `\n${BLOCK_END}`)
  }
  try {
    const first = install()
    assert.equal(first.status, 0, first.stdout + first.stderr)
    const baseline = status()
    assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr)
    assert.match(baseline.stdout, /guard: status {2}current/u)

    const foldedText = fold(installed())
    writeFileSync(patch, foldedText)
    const folded = status()
    assert.equal(folded.status, 0, folded.stdout + folded.stderr)
    assert.match(folded.stdout, /guard: status {2}current/u)
    assert.doesNotMatch(folded.stdout, /first difference/u)
    assert.match(folded.stdout, /only its serialisation differs/u)
    const foldedReport = report()
    assert.equal(foldedReport.status, 'current')
    assert.equal(foldedReport.difference, undefined)
    assert.equal(foldedReport.reserialised, true)
    assert.deepEqual(foldedReport.installedWorktrees, foldedReport.worktrees)

    // A value changed inside the folded scalar is a real difference.
    writeFileSync(patch, foldedText.replace('ex.ts"', 'index.ts"'))
    const changed = status()
    assert.equal(changed.status, 1)
    assert.match(changed.stdout, /guard: status {2}stale/u)
    assert.match(changed.stdout, /first difference/u)
    const changedReport = report()
    assert.equal(changedReport.status, 'stale')
    assert.equal(typeof changedReport.difference.line, 'number')
    assert.equal(changedReport.blockError, undefined)

    const second = install()
    assert.equal(second.status, 0, second.stdout + second.stderr)
    const canonical = installed()
    assert.match(status().stdout, /guard: status {2}current/u)

    // A plain different value, with no folding involved.
    writeFileSync(patch, canonical.replace('- "apply_patch"', '- "apply_patch2"'))
    const plain = status()
    assert.equal(plain.status, 1)
    assert.match(plain.stdout, /guard: status {2}stale/u)
    assert.equal(typeof report().difference.line, 'number')

    // Two copies of the managed block are a duplicate entry, not a stale one.
    writeFileSync(patch, canonical + canonical)
    const duplicated = status()
    assert.equal(duplicated.status, 1)
    assert.match(duplicated.stdout, /duplicate - id/u)
    assert.equal(report().duplicateId, true)

    // A block that does not parse is not provably equal: stale, with a reason,
    // never current.
    writeFileSync(patch, canonical.replace(/^      name: ".*"$/mu, '      name: "unterminated'))
    const unreadable = status()
    assert.equal(unreadable.status, 1)
    assert.match(unreadable.stdout, /guard: status {2}stale/u)
    assert.match(unreadable.stdout, /cannot be read as YAML/u)
    assert.doesNotMatch(unreadable.stdout, /guard: status {2}current/u)
    const unreadableReport = report()
    assert.equal(unreadableReport.status, 'stale')
    assert.match(unreadableReport.blockError, /cannot be read as YAML/u)
    assert.equal(unreadableReport.difference, undefined)
  } finally {
    rmSync(profile, { recursive: true, force: true })
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('the dry-run table proves every payload against the same judge', () => {
  const cases = guardTable({ worktree, protectedRoot: repo })
  assert.ok(cases.length >= 20)
  const { rows, failures } = runTable(cases, config, { worktree, protectedRoot: repo })
  assert.deepEqual(failures, [], formatTable(rows))
})

test('the install block is marked, idempotent and refused when it would duplicate a plugin id', () => {
  const composition = composeGuard({
    repoRoot: checkout,
    worktrees: [
      { path: checkout, branch: 'main', main: true },
      { path: worktree, branch: 'ticket/80' },
      { path: '/work/wt/verify-x', branch: 'verify/x' },
    ],
  })
  assert.equal(composition.config.protectedRoots[0], checkout)
  assert.deepEqual(
    composition.config.worktrees,
    ['/work/wt/ticket-*'],
    'a ticket worktree collapses to the narrow pattern; a non-ticket worktree is not confinable',
  )
  assert.match(composition.block, new RegExp(`^${BLOCK_START}`, 'u'))
  assert.match(composition.block, /- insert:/u)
  assert.match(composition.block, new RegExp(`id: "anyplugin-guard"`, 'u'))
  assert.match(composition.block, new RegExp(composition.source.replaceAll('/', '\\/'), 'u'))
  assert.match(composition.block, /32 declared \/ 31 matched \/ 0 missing \/ 1 refused/u)

  const fresh = applyBlock('[]\n', composition.block)
  assert.equal(fresh.startsWith(BLOCK_START), true, 'the empty-array marker is replaced, not stacked')
  assert.equal(applyBlock(fresh, composition.block), fresh, 'installing twice is a no-op')
  assert.equal(readBlock(fresh).present, true)

  const removed = applyBlock(fresh, null)
  assert.equal(removed, '', 'the script restores the pre-install state rather than writing an empty patch')

  assert.throws(
    () => applyBlock(`- id: "anyplugin-guard"\n  name: "elsewhere.ts"\n`, composition.block),
    /already appears outside/u,
  )
  assert.throws(
    () => applyBlock(`- id: 'anyplugin-guard'\n  name: "single-quoted.ts"\n`, composition.block),
    /already appears outside/u,
    'YAML accepts both quote styles; the duplicate check must too',
  )
  assert.doesNotThrow(
    () => applyBlock('# - id: "anyplugin-guard" is a comment, not an entry\n', composition.block),
    'a comment naming the id is not a conflicting entry',
  )
})

test('uninstall restores an absent, empty, [] or content file exactly', () => {
  const state = (file, trailing = 0) => ({ file, trailing })
  const render = (installState) => renderBlock('guard.ts', { worktrees: [] }, installState)

  const absent = applyBlock('', render(state('absent')))
  assert.deepEqual(uninstallText(absent), { action: 'delete', content: '' })

  const empty = applyBlock('', render(state('empty', 1)))
  assert.deepEqual(uninstallText(empty), { action: 'write', content: '\n' })

  const array = applyBlock('[]\n', render(state('array', 1)))
  assert.deepEqual(uninstallText(array), { action: 'write', content: '[]\n' })

  const arrayBlank = applyBlock('[]\n', render(state('array', 2)))
  assert.deepEqual(uninstallText(arrayBlank), { action: 'write', content: '[]\n\n' }, 'trailing blank lines are restored byte-for-byte')

  const original = '- id: "other"'
  assert.equal(captureState(original).trailing, 0)
  const installed = applyBlock(original, render(captureState(original)))
  assert.deepEqual(uninstallText(installed), { action: 'write', content: original })
  assert.equal(readState(readBlock(installed).block)?.file, 'content')
})

test('a user row inside the managed block, and an unbalanced marker, are refused', () => {
  const composition = composeGuard({ repoRoot: checkout, worktrees: [{ path: checkout, branch: 'main', main: true }] })
  const tampered = [
    BLOCK_START,
    '- insert:',
    '    - id: "anyplugin-guard"',
    '      name: "ours.ts"',
    '- id: "user-entry"',
    BLOCK_END,
    '',
  ].join('\n')
  assert.throws(() => applyBlock(tampered, composition.block), /did not write/u)

  assert.throws(() => readBlock(`${BLOCK_START}\n- insert: []\n`), /start marker without an end marker/u)
  assert.throws(() => uninstallText(`${BLOCK_START}\n- insert: []\n`), /start marker without an end marker/u)
})

test('renderBrief names the worktree, the ratchet and the rules; message text is flattened', () => {
  const brief = renderBrief({ worktree, cwd: repo, config: config.brief })
  assert.match(brief, /Write only inside that worktree, with absolute paths/u)
  assert.match(brief, /packages\/dsh-anyplugin-conformance\/test\/coverage\.test\.mjs/u)
  assert.match(brief, /mcpServers:a-server-name-that-is-long-enough:refused/u)
  // The brief may not overstate what CI runs: verify.yml boots seven spikes,
  // not every spike in the repository (D78).
  assert.match(brief, /run the suite, the build, the pack check and the perf gate in CI/u)
  assert.match(brief, /let the verify workflow run the spikes it owns/u)
  assert.doesNotMatch(brief, /the spikes in CI/u)
  assert.equal(
    messageText([
      { role: 'user', content: 'plain' },
      { role: 'assistant', content: [{ type: 'text', text: 'block' }] },
    ]),
    'plain\nblock',
  )
})

test('currentBranch reads a worktree .git pointer and refuses a detached HEAD', () => {
  const dir = mkdtempSync(join(tmpdir(), 'anyplugin-guard-git-'))
  try {
    const gitdir = join(dir, 'gitdir')
    mkdirSync(gitdir)
    writeFileSync(join(gitdir, 'HEAD'), 'ref: refs/heads/ticket/80\n')
    writeFileSync(join(dir, '.git'), `gitdir: ${gitdir}\n`)
    assert.equal(currentBranch(dir), 'ticket/80')
    writeFileSync(join(gitdir, 'HEAD'), 'abc123\n')
    assert.equal(currentBranch(dir), undefined)
    assert.equal(isMainRef('refs/heads/main'), true)
    assert.equal(isMainRef('refs/remotes/origin/master'), true)
    assert.equal(isMainRef('refs/heads/ticket/80'), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the agent view reads role and cwd from the session header only', () => {
  assert.equal(isWorker({ session: { header: { parentSession: 'root' } } }), true)
  assert.equal(isWorker({ session: { header: {} } }), false)
  assert.equal(agentCwd({ session: { header: { cwd: '/work' } } }), '/work')
  assert.equal(agentCwd({ session: { header: { cwd: '' } } }), undefined)
})

test('a dry run from a linked worktree composes from the main checkout, not from itself', () => {
  const scratch = scratchCheckout()
  const linkedParent = mkdtempSync(join(tmpdir(), 'guard-linked-wt-'))
  const linked = join(linkedParent, 'linked')
  const profile = mkdtempSync(join(tmpdir(), 'guard-dry-run-'))
  try {
    execFileSync('git', ['-C', scratch, '-c', 'user.email=guard@example.invalid', '-c', 'user.name=guard', 'commit', '-q', '--allow-empty', '-m', 'init'])
    execFileSync('git', ['-C', scratch, 'worktree', 'add', '-q', '-b', 'ticket/linked', linked])
    // The script runs from the linked worktree, but the block must name the
    // checkout that owns .git: removing the worktree must not break the guard.
    const result = spawnSync(
      process.execPath,
      [join(scratch, 'scripts/guard-install.mjs'), '--dry-run', '--profile-dir', profile],
      { cwd: linked, encoding: 'utf8' },
    )
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.ok(result.stdout.includes(`guard: root ${scratch}`), result.stdout.split('\n').slice(0, 3).join('\n'))
    assert.ok(
      result.stdout.includes(`name: "${join(scratch, 'packages/dsh-anyplugin-guard/src/index.ts')}"`),
      'the composition source is the main checkout\'s file',
    )
    assert.ok(!result.stdout.includes(`name: "${join(linked, 'packages')}`), 'the linked worktree\'s copy is never named')
    assert.equal(existsSync(join(profile, 'cordis.patch.yml')), false, 'a dry run writes nothing')
  } finally {
    rmSync(profile, { recursive: true, force: true })
    rmSync(scratch, { recursive: true, force: true })
    rmSync(linkedParent, { recursive: true, force: true })
  }
})

test('a worktree created after install writes without a reinstall, and a sibling outside the pattern is refused', () => {
  const scratch = scratchCheckout()
  const parent = mkdtempSync(join(tmpdir(), 'guard-glob-wt-'))
  const profile = mkdtempSync(join(tmpdir(), 'guard-glob-'))
  try {
    execFileSync('git', ['-C', scratch, '-c', 'user.email=guard@example.invalid', '-c', 'user.name=guard', 'commit', '-q', '--allow-empty', '-m', 'init'])
    for (const n of ['1916', '1917']) {
      execFileSync('git', ['-C', scratch, 'worktree', 'add', '-q', '-b', `ticket/${n}`, join(parent, `ticket-${n}`)])
    }
    const install = spawnSync(
      process.execPath,
      [join(scratch, 'scripts/guard-install.mjs'), '--profile-dir', profile],
      { cwd: scratch, encoding: 'utf8' },
    )
    assert.equal(install.status, 0, install.stdout + install.stderr)
    const pattern = join(parent, 'ticket-*')
    const block = readBlock(readFileSync(join(profile, 'cordis.patch.yml'), 'utf8')).block
    assert.deepEqual(readWorktrees(block), [pattern], 'one narrow pattern, not the discovered snapshot')

    // The worktree did not exist when the install ran; the pattern, not a
    // reinstall, is what admits it.
    const later = join(parent, 'ticket-1999')
    execFileSync('git', ['-C', scratch, 'worktree', 'add', '-q', '-b', 'ticket/1999', later])
    const chosen = chooseWorktree({ text: `work in ${later} (ticket/1999)`, worktrees: readWorktrees(block) })
    assert.equal(chosen, later)
    const policy = resolvePolicy({ worktrees: readWorktrees(block), protectedRoots: [scratch] })
    const call = {
      tool: 'write',
      args: { file_path: join(later, 'src/x.ts'), content: 'x' },
      agent: { id: 'late-worker', cwd: scratch, worker: true },
      worktree: chosen,
    }
    assert.equal(judgeCall(call, policy, { branch: () => 'ticket/1999' }).kind, 'allow')
    const outside = judgeCall(
      { ...call, args: { file_path: join(parent, 'ticket-2000', 'x.ts'), content: 'x' } },
      policy,
      { branch: () => 'ticket/1999' },
    )
    assert.equal(outside.kind, 'deny', 'the pattern admits the matched root, not every sibling')

    const status = spawnSync(
      process.execPath,
      [join(scratch, 'scripts/guard-status.mjs'), '--profile-dir', profile],
      { cwd: scratch, encoding: 'utf8' },
    )
    assert.equal(status.status, 0, status.stdout + status.stderr)
    assert.match(status.stdout, /guard: status {2}current/u)
  } finally {
    rmSync(profile, { recursive: true, force: true })
    rmSync(scratch, { recursive: true, force: true })
    rmSync(parent, { recursive: true, force: true })
  }
})

test('a fresh install with no ticket worktree records the documented namespace, and the first one writes', () => {
  const scratch = scratchCheckout()
  const profile = mkdtempSync(join(tmpdir(), 'guard-fresh-'))
  const parent = mkdtempSync(join(tmpdir(), 'guard-fresh-wt-'))
  try {
    execFileSync('git', ['-C', scratch, '-c', 'user.email=guard@example.invalid', '-c', 'user.name=guard', 'commit', '-q', '--allow-empty', '-m', 'init'])
    // No ticket worktree exists yet. A policy with no pattern would refuse the
    // first one an agent creates until a reinstall (reviewer #230, MUST 1).
    const install = spawnSync(
      process.execPath,
      [join(scratch, 'scripts/guard-install.mjs'), '--profile-dir', profile],
      { cwd: scratch, encoding: 'utf8', env: { ...process.env, ANYPLUGIN_WORKTREE_ROOT: parent } },
    )
    assert.equal(install.status, 0, install.stdout + install.stderr)
    const block = readBlock(readFileSync(join(profile, 'cordis.patch.yml'), 'utf8')).block
    assert.deepEqual(readWorktrees(block), [join(parent, 'ticket-*')], 'the documented namespace, written before any worktree exists')

    const later = join(parent, 'ticket-1999')
    execFileSync('git', ['-C', scratch, 'worktree', 'add', '-q', '-b', 'ticket/1999', later])
    const chosen = chooseWorktree({ text: `work in ${later} (ticket/1999)`, worktrees: readWorktrees(block) })
    assert.equal(chosen, later)
    const policy = resolvePolicy({ worktrees: readWorktrees(block), protectedRoots: [scratch] })
    const call = {
      tool: 'write',
      args: { file_path: join(later, 'src/x.ts'), content: 'x' },
      agent: { id: 'fresh-worker', cwd: scratch, worker: true },
      worktree: chosen,
    }
    assert.equal(
      judgeCall(call, policy, { branch: () => 'ticket/1999' }).kind,
      'allow',
      'the first worktree after a fresh install writes without a reinstall',
    )
  } finally {
    rmSync(profile, { recursive: true, force: true })
    rmSync(scratch, { recursive: true, force: true })
    rmSync(parent, { recursive: true, force: true })
  }
})

test('an install with no override records /tmp/anyplugin-wt, the root the docs name', () => {
  const scratch = scratchCheckout()
  const profile = mkdtempSync(join(tmpdir(), 'guard-default-'))
  try {
    execFileSync('git', ['-C', scratch, '-c', 'user.email=guard@example.invalid', '-c', 'user.name=guard', 'commit', '-q', '--allow-empty', '-m', 'init'])
    const env = { ...process.env }
    delete env.ANYPLUGIN_WORKTREE_ROOT
    const install = spawnSync(
      process.execPath,
      [join(scratch, 'scripts/guard-install.mjs'), '--profile-dir', profile],
      { cwd: scratch, encoding: 'utf8', env },
    )
    assert.equal(install.status, 0, install.stdout + install.stderr)
    const block = readBlock(readFileSync(join(profile, 'cordis.patch.yml'), 'utf8')).block
    // os.tmpdir() is /var/folders/... on macOS, where the docs' /tmp path would
    // be admitted for judging and denied for writes (reviewer #230, MUST 2).
    assert.deepEqual(readWorktrees(block), ['/tmp/anyplugin-wt/ticket-*'])
  } finally {
    rmSync(profile, { recursive: true, force: true })
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('guard:status separates not-installed from a block that lists a worktree which is gone', () => {
  const scratch = scratchCheckout()
  const profile = mkdtempSync(join(tmpdir(), 'guard-stale-'))
  try {
    const status = () =>
      spawnSync(process.execPath, [join(scratch, 'scripts/guard-status.mjs'), '--profile-dir', profile], {
        cwd: scratch,
        encoding: 'utf8',
      })
    const absent = status()
    assert.equal(absent.status, 1)
    assert.match(absent.stdout, /guard: status {2}not-installed/u)
    assert.doesNotMatch(absent.stdout, /stale worktree/u)

    const gone = join(scratch, 'gone', 'ticket-42')
    const block = renderBlock(join(scratch, 'packages/dsh-anyplugin-guard/src/index.ts'), {
      worktrees: [gone],
      protectedRoots: [scratch],
      brief: false,
    })
    writeFileSync(join(profile, 'cordis.patch.yml'), block)
    const stale = status()
    assert.equal(stale.status, 1)
    assert.match(stale.stdout, /guard: status {2}installed-with-stale-paths/u)
    assert.ok(stale.stdout.includes(`guard: stale worktree ${gone} (listed in the block, no longer exists)`))
    const json = spawnSync(
      process.execPath,
      [join(scratch, 'scripts/guard-status.mjs'), '--profile-dir', profile, '--json'],
      { cwd: scratch, encoding: 'utf8' },
    )
    const report = JSON.parse(json.stdout)
    assert.equal(report.status, 'installed-with-stale-paths')
    assert.deepEqual(report.stalePaths, [gone])
  } finally {
    rmSync(profile, { recursive: true, force: true })
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('a literal "*" in a worktree path is refused, not widened into a pattern', () => {
  const scratch = scratchCheckout()
  const parent = mkdtempSync(join(tmpdir(), 'guard-star-wt-'))
  const star = join(parent, 'star*')
  const ticket = join(star, 'ticket-1')
  const starX = join(parent, 'starX', 'ticket-1')
  const profile = mkdtempSync(join(tmpdir(), 'guard-star-'))
  const patch = join(profile, 'cordis.patch.yml')
  const status = () =>
    spawnSync(process.execPath, [join(scratch, 'scripts/guard-status.mjs'), '--profile-dir', profile], {
      cwd: scratch,
      encoding: 'utf8',
    })
  try {
    mkdirSync(star, { recursive: true })
    execFileSync('git', ['-C', scratch, '-c', 'user.email=guard@example.invalid', '-c', 'user.name=guard', 'commit', '-q', '--allow-empty', '-m', 'init'])
    execFileSync('git', ['-C', scratch, 'worktree', 'add', '-q', '-b', 'ticket/1', ticket])

    const install = spawnSync(
      process.execPath,
      [join(scratch, 'scripts/guard-install.mjs'), '--dry-run', '--profile-dir', profile],
      { cwd: scratch, encoding: 'utf8' },
    )
    assert.equal(install.status, 1, install.stdout + install.stderr)
    assert.ok(install.stderr.includes(`the worktree path ${ticket} contains "*"`), install.stderr)
    assert.equal(existsSync(patch), false, 'the refusal writes nothing')

    // The literal path is an exact entry, never a wildcard: `starX` is a
    // sibling the plan never named, and no worktree can be recorded for it.
    assert.equal(matchWorktree(ticket, starX), undefined)
    assert.equal(chooseWorktree({ text: `work in ${starX}`, worktrees: [ticket] }), undefined)
    const denied = judgeCall(
      {
        tool: 'write',
        args: { file_path: join(starX, 'src/x.ts'), content: 'x' },
        agent: { id: 'worker-star', cwd: scratch, worker: true },
      },
      resolvePolicy({ worktrees: [ticket], protectedRoots: [scratch] }),
      { branch: () => 'ticket/1' },
    )
    assert.equal(denied.kind, 'deny')
    assert.match(denied.reason, /no worktree is recorded/u)

    // A block written by the old installer must not read as current: status
    // refuses while the literal worktree is live, and names it once it is gone.
    writeFileSync(
      patch,
      renderBlock(join(scratch, 'packages/dsh-anyplugin-guard/src/index.ts'), {
        worktrees: [ticket],
        protectedRoots: [scratch],
        brief: false,
      }),
    )
    const refused = status()
    assert.equal(refused.status, 1)
    assert.match(refused.stdout, /guard: status {2}refused/u)
    assert.ok(refused.stderr.includes('contains "*"'), refused.stderr)

    execFileSync('git', ['-C', scratch, 'worktree', 'remove', '--force', ticket])
    const gone = status()
    assert.equal(gone.status, 1)
    assert.match(gone.stdout, /guard: status {2}installed-with-stale-paths/u)
    assert.ok(gone.stdout.includes(`guard: stale worktree ${ticket} (listed in the block, no longer exists)`))
  } finally {
    rmSync(profile, { recursive: true, force: true })
    rmSync(scratch, { recursive: true, force: true })
    rmSync(parent, { recursive: true, force: true })
  }
})

test('a legacy exact-list entry ending in "*" stays literal and is reported stale', () => {
  const scratch = scratchCheckout()
  const parent = mkdtempSync(join(tmpdir(), 'guard-legacy-'))
  const legacy = join(parent, 'legacywt', 'ticket*')
  const evil = join(parent, 'legacywt', 'ticket-evil')
  const profile = mkdtempSync(join(tmpdir(), 'guard-legacy-profile-'))
  const patch = join(profile, 'cordis.patch.yml')
  try {
    // A block written before the grammar existed can name a worktree whose
    // real name ends in `*`; it is a path, not the `<stem>-*` operator.
    assert.equal(isWorktreeGlob(legacy), false)
    assert.equal(matchWorktree(legacy, evil), undefined)
    assert.equal(chooseWorktree({ text: `work in ${evil}`, worktrees: [legacy] }), undefined)
    const denied = judgeCall(
      {
        tool: 'write',
        args: { file_path: join(evil, 'src/x.ts'), content: 'x' },
        agent: { id: 'worker-legacy', cwd: scratch, worker: true },
      },
      resolvePolicy({ worktrees: [legacy], protectedRoots: [scratch] }),
      { branch: () => 'ticket/9' },
    )
    assert.equal(denied.kind, 'deny')
    assert.match(denied.reason, /no worktree is recorded/u)

    writeFileSync(
      patch,
      renderBlock(join(scratch, 'packages/dsh-anyplugin-guard/src/index.ts'), {
        worktrees: [legacy],
        protectedRoots: [scratch],
        brief: false,
      }),
    )
    const status = spawnSync(
      process.execPath,
      [join(scratch, 'scripts/guard-status.mjs'), '--profile-dir', profile],
      { cwd: scratch, encoding: 'utf8' },
    )
    assert.equal(status.status, 1, status.stdout + status.stderr)
    assert.match(status.stdout, /guard: status {2}installed-with-stale-paths/u)
    assert.ok(status.stdout.includes(`guard: stale worktree ${legacy} (listed in the block, no longer exists)`))
    const json = spawnSync(
      process.execPath,
      [join(scratch, 'scripts/guard-status.mjs'), '--profile-dir', profile, '--json'],
      { cwd: scratch, encoding: 'utf8' },
    )
    assert.deepEqual(JSON.parse(json.stdout).stalePaths, [legacy])
  } finally {
    rmSync(profile, { recursive: true, force: true })
    rmSync(parent, { recursive: true, force: true })
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('a submodule checkout installs and reports from its own root', () => {
  const scratch = scratchCheckout()
  const superRoot = mkdtempSync(join(tmpdir(), 'guard-super-'))
  const sub = join(superRoot, 'sub')
  const profile = mkdtempSync(join(tmpdir(), 'guard-sub-'))
  try {
    execFileSync('git', ['-C', scratch, 'add', '-A'])
    execFileSync('git', ['-C', scratch, '-c', 'user.email=guard@example.invalid', '-c', 'user.name=guard', 'commit', '-q', '--allow-empty', '-m', 'init'])
    execFileSync('git', ['init', '-q', '-b', 'main', superRoot])
    execFileSync('git', ['-C', superRoot, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', '--', scratch, 'sub'])
    // A ticket worktree makes the glob path run. The submodule's git dir is
    // the superproject's `.git/modules/sub`, which the pattern does not match;
    // the git-dir rule is what protects it.
    const ticket = join(superRoot, 'sub-wt')
    execFileSync('git', ['-C', sub, '-c', 'user.email=guard@example.invalid', '-c', 'user.name=guard', 'worktree', 'add', '-q', '-b', 'ticket/sub', ticket])

    // A submodule's git dir is its common dir, so the old
    // `dirname(--git-common-dir)` resolved to `<super>/.git/modules` and the
    // ratchet read failed before anything was composed.
    const install = spawnSync(
      process.execPath,
      [join(sub, 'scripts/guard-install.mjs'), '--dry-run', '--profile-dir', profile],
      { cwd: sub, encoding: 'utf8' },
    )
    assert.equal(install.status, 0, install.stdout + install.stderr)
    assert.ok(install.stdout.includes(`guard: root ${sub}`), install.stdout.split('\n').slice(0, 3).join('\n'))
    assert.ok(install.stdout.includes(`guard: worktrees 1 ticket worktree(s); policy pattern ${join(superRoot, 'sub-*')}`), install.stdout.split('\n')[3])
    assert.ok(install.stdout.includes(`name: "${join(sub, 'packages/dsh-anyplugin-guard/src/index.ts')}"`))
    const modules = join(superRoot, '.git', 'modules', 'sub')
    assert.ok(install.stdout.includes(`        protectedRoots:\n          - "${sub}"\n          - "${modules}"`), install.stdout)
    assert.ok(install.stdout.includes(`        gitDirectories:\n          - "${modules}"`), install.stdout)

    const composition = composeGuard({ repoRoot: sub, worktrees: readGitWorktrees(sub) })
    const policy = resolvePolicy(composition.config)
    for (const target of [join(modules, 'hooks', 'pre-push'), join(modules, 'config')]) {
      const worker = judgeCall(
        { tool: 'write', args: { file_path: target }, agent: { id: 'worker-sub', cwd: sub, worker: true }, worktree: ticket },
        policy,
        { branch: () => 'ticket/sub' },
      )
      assert.equal(worker.kind, 'deny', target)
      assert.equal(worker.rule, 'git-dir-write', target)
      const root = judgeCall(
        { tool: 'write', args: { file_path: target }, agent: { id: 'root-sub', cwd: sub, worker: false } },
        policy,
        { branch: () => 'main' },
      )
      assert.equal(root.kind, 'allow', `${target} is a root write`)
    }

    const status = spawnSync(
      process.execPath,
      [join(sub, 'scripts/guard-status.mjs'), '--profile-dir', profile],
      { cwd: sub, encoding: 'utf8' },
    )
    assert.equal(status.status, 1, status.stdout + status.stderr)
    assert.match(status.stdout, /guard: status {2}not-installed/u)
    assert.doesNotMatch(status.stderr, /ENOENT/u)

    // A submodule is the main checkout of its own repository: the real install
    // must not be refused as a linked worktree of the superproject.
    const real = spawnSync(
      process.execPath,
      [join(sub, 'scripts/guard-install.mjs'), '--profile-dir', profile],
      { cwd: sub, encoding: 'utf8' },
    )
    assert.equal(real.status, 0, real.stdout + real.stderr)
    assert.doesNotMatch(real.stderr, /linked worktree/u)
    assert.ok(real.stdout.includes(`name: "${join(sub, 'packages/dsh-anyplugin-guard/src/index.ts')}"`))
    const current = spawnSync(
      process.execPath,
      [join(sub, 'scripts/guard-status.mjs'), '--profile-dir', profile],
      { cwd: sub, encoding: 'utf8' },
    )
    assert.equal(current.status, 0, current.stdout + current.stderr)
    assert.match(current.stdout, /guard: status {2}current/u)
  } finally {
    rmSync(profile, { recursive: true, force: true })
    rmSync(superRoot, { recursive: true, force: true })
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('a --separate-git-dir checkout installs a ticket pattern and refuses worker writes to the git dir', () => {
  const scratch = scratchCheckout()
  const base = mkdtempSync(join(tmpdir(), 'guard-separate-'))
  const gitDir = join(base, 'repo.git')
  const work = join(base, 'work')
  const ticket = join(base, 'sep-wt')
  const profile = mkdtempSync(join(tmpdir(), 'guard-separate-profile-'))
  try {
    execFileSync('git', ['-C', scratch, 'add', '-A'])
    execFileSync('git', ['-C', scratch, '-c', 'user.email=guard@example.invalid', '-c', 'user.name=guard', 'commit', '-q', '--allow-empty', '-m', 'init'])
    execFileSync('git', ['clone', '-q', '--separate-git-dir', gitDir, '--', scratch, work])
    execFileSync('git', ['-C', work, '-c', 'user.email=guard@example.invalid', '-c', 'user.name=guard', 'worktree', 'add', '-q', '-b', 'ticket/12', ticket])

    const install = spawnSync(
      process.execPath,
      [join(work, 'scripts/guard-install.mjs'), '--dry-run', '--profile-dir', profile],
      { cwd: work, encoding: 'utf8' },
    )
    assert.equal(install.status, 0, install.stdout + install.stderr)
    assert.ok(install.stdout.includes(`guard: root ${work}`), install.stdout.split('\n').slice(0, 3).join('\n'))
    assert.ok(
      install.stdout.includes(`guard: worktrees 1 ticket worktree(s); policy pattern ${join(base, 'sep-*')}`),
      install.stdout.split('\n')[3],
    )
    assert.ok(install.stdout.includes(`name: "${join(work, 'packages/dsh-anyplugin-guard/src/index.ts')}"`))
    // `sep-*` also matches `sep-gitdir`; the plan never named that directory.
    assert.ok(install.stdout.includes(`        worktrees:\n          - "${join(base, 'sep-*')}"`), install.stdout)
    assert.ok(
      install.stdout.includes(`        protectedRoots:\n          - "${work}"\n          - "${gitDir}"`),
      install.stdout,
    )
    assert.ok(install.stdout.includes(`        gitDirectories:\n          - "${gitDir}"`), install.stdout)

    const composition = composeGuard({ repoRoot: work, worktrees: readGitWorktrees(work) })
    const policy = resolvePolicy(composition.config)
    for (const target of [join(gitDir, 'hooks', 'pre-push'), join(gitDir, 'config')]) {
      const worker = judgeCall(
        { tool: 'write', args: { file_path: target }, agent: { id: 'worker-sep', cwd: work, worker: true }, worktree: ticket },
        policy,
        { branch: () => 'ticket/12' },
      )
      assert.equal(worker.kind, 'deny', target)
      assert.equal(worker.rule, 'git-dir-write', target)
      const root = judgeCall(
        { tool: 'write', args: { file_path: target }, agent: { id: 'root-sep', cwd: work, worker: false } },
        policy,
        { branch: () => 'main' },
      )
      assert.equal(root.kind, 'allow', `${target} is a root write`)
    }
    assert.equal(insideGitDirectory(join(gitDir, 'hooks', 'pre-push'), policy), true)

    const status = spawnSync(
      process.execPath,
      [join(work, 'scripts/guard-status.mjs'), '--profile-dir', profile],
      { cwd: work, encoding: 'utf8' },
    )
    assert.equal(status.status, 1, status.stdout + status.stderr)
    assert.match(status.stdout, /guard: status {2}not-installed/u)
    assert.doesNotMatch(status.stderr, /ENOENT/u)

    // This is still the main worktree, so a real install is allowed here and
    // writes the pattern plus the git-dir protection.
    const real = spawnSync(
      process.execPath,
      [join(work, 'scripts/guard-install.mjs'), '--profile-dir', profile],
      { cwd: work, encoding: 'utf8' },
    )
    assert.equal(real.status, 0, real.stdout + real.stderr)
    assert.doesNotMatch(real.stderr, /linked worktree/u)
    assert.ok(real.stdout.includes(`name: "${join(work, 'packages/dsh-anyplugin-guard/src/index.ts')}"`))
    const current = spawnSync(
      process.execPath,
      [join(work, 'scripts/guard-status.mjs'), '--profile-dir', profile],
      { cwd: work, encoding: 'utf8' },
    )
    assert.equal(current.status, 0, current.stdout + current.stderr)
    assert.match(current.stdout, /guard: status {2}current/u)
  } finally {
    rmSync(profile, { recursive: true, force: true })
    rmSync(base, { recursive: true, force: true })
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('a sibling directory that matches the derived pattern is admitted, and the test names it', () => {
  const scratch = scratchCheckout()
  const parent = mkdtempSync(join(tmpdir(), 'guard-sibling-'))
  const ticket = join(parent, 'ticket-1')
  const sibling = join(parent, 'ticket-notes')
  try {
    execFileSync('git', ['-C', scratch, 'add', '-A'])
    execFileSync('git', ['-C', scratch, '-c', 'user.email=guard@example.invalid', '-c', 'user.name=guard', 'commit', '-q', '--allow-empty', '-m', 'init'])
    execFileSync('git', ['-C', scratch, '-c', 'user.email=guard@example.invalid', '-c', 'user.name=guard', 'worktree', 'add', '-q', '-b', 'ticket/1', ticket])
    mkdirSync(sibling)

    // The pattern is a namespace matcher, not a git-worktree attestation: a
    // sibling directory that happens to share the prefix is confinable. The
    // install cannot distinguish it (the block stores no worktree identity),
    // so D67 names the consequence instead of pretending otherwise.
    const composition = composeGuard({ repoRoot: scratch, worktrees: readGitWorktrees(scratch) })
    assert.deepEqual(composition.config.worktrees, [join(parent, 'ticket-*')])
    const policy = resolvePolicy(composition.config)
    assert.equal(chooseWorktree({ text: `work in ${sibling}`, worktrees: policy.worktrees }), sibling)
    const verdict = judgeCall(
      {
        tool: 'write',
        args: { file_path: join(sibling, 'notes.md') },
        agent: { id: 'worker-sibling', cwd: parent, worker: true },
        worktree: sibling,
      },
      policy,
      { branch: () => 'ticket/1' },
    )
    assert.equal(verdict.kind, 'allow', 'the namespace caveat is the documented behaviour')
  } finally {
    rmSync(parent, { recursive: true, force: true })
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('a linked worktree of a submodule is refused instead of installed as its own checkout', () => {
  const scratch = scratchCheckout()
  const superRoot = mkdtempSync(join(tmpdir(), 'guard-sub-link-super-'))
  const sub = join(superRoot, 'sub')
  const linkedParent = mkdtempSync(join(tmpdir(), 'guard-sub-link-'))
  const linked = join(linkedParent, 'linked')
  const profile = mkdtempSync(join(tmpdir(), 'guard-sub-link-profile-'))
  try {
    execFileSync('git', ['-C', scratch, 'add', '-A'])
    execFileSync('git', ['-C', scratch, '-c', 'user.email=guard@example.invalid', '-c', 'user.name=guard', 'commit', '-q', '--allow-empty', '-m', 'init'])
    execFileSync('git', ['init', '-q', '-b', 'main', superRoot])
    execFileSync('git', ['-C', superRoot, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', '--', scratch, 'sub'])
    execFileSync('git', ['-C', sub, '-c', 'user.email=guard@example.invalid', '-c', 'user.name=guard', 'worktree', 'add', '-q', '-b', 'ticket/sub-linked', linked])

    // mainCheckout() cannot name the submodule's main working tree from the
    // linked git dir; the git-dir/common-dir comparison is what sees this.
    const real = spawnSync(
      process.execPath,
      [join(linked, 'scripts/guard-install.mjs'), '--profile-dir', profile],
      { cwd: linked, encoding: 'utf8' },
    )
    assert.equal(real.status, 1, real.stdout + real.stderr)
    assert.match(real.stderr, /is a linked worktree/u)
    assert.ok(real.stderr.includes('Run from the main checkout'), real.stderr)
    assert.equal(existsSync(join(profile, 'cordis.patch.yml')), false, 'the refusal writes no profile')
    assert.deepEqual(readdirSync(profile), [], 'the refusal writes no profile at all')
    assert.equal(existsSync(join(superRoot, '.git', 'modules', 'sub', 'hooks', 'pre-push')), false, 'the refusal writes no hook')
  } finally {
    rmSync(profile, { recursive: true, force: true })
    rmSync(linkedParent, { recursive: true, force: true })
    rmSync(superRoot, { recursive: true, force: true })
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('a linked worktree of a --separate-git-dir repo is refused before it can write', () => {
  const scratch = scratchCheckout()
  const base = mkdtempSync(join(tmpdir(), 'guard-sep-link-'))
  const gitDir = join(base, 'repo.git')
  const work = join(base, 'work')
  const linked = join(base, 'linked')
  const profile = mkdtempSync(join(tmpdir(), 'guard-sep-link-profile-'))
  try {
    execFileSync('git', ['-C', scratch, 'add', '-A'])
    execFileSync('git', ['-C', scratch, '-c', 'user.email=guard@example.invalid', '-c', 'user.name=guard', 'commit', '-q', '--allow-empty', '-m', 'init'])
    execFileSync('git', ['clone', '-q', '--separate-git-dir', gitDir, '--', scratch, work])
    execFileSync('git', ['-C', work, '-c', 'user.email=guard@example.invalid', '-c', 'user.name=guard', 'worktree', 'add', '-q', '-b', 'ticket/sep-linked', linked])

    // The block this used to write was rooted at the linked path and its
    // pattern also matched the main working tree, which was not protected.
    const real = spawnSync(
      process.execPath,
      [join(linked, 'scripts/guard-install.mjs'), '--profile-dir', profile],
      { cwd: linked, encoding: 'utf8' },
    )
    assert.equal(real.status, 1, real.stdout + real.stderr)
    assert.match(real.stderr, /is a linked worktree/u)
    assert.ok(real.stderr.includes('Run from the main checkout'), real.stderr)
    assert.equal(existsSync(join(profile, 'cordis.patch.yml')), false, 'the refusal writes no profile')
    assert.deepEqual(readdirSync(profile), [], 'the refusal writes no profile at all')
    assert.equal(existsSync(join(gitDir, 'hooks', 'pre-push')), false, 'the refusal writes no hook')
  } finally {
    rmSync(profile, { recursive: true, force: true })
    rmSync(base, { recursive: true, force: true })
    rmSync(scratch, { recursive: true, force: true })
  }
})
