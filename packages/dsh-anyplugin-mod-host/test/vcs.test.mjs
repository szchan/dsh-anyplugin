// The `$vcs` bridge (#119): `detect` and `diff` are served for git, read-only,
// through `execFile`; the other four pinned members are typed refusals. These
// cases are the ones the execution rule must survive: a real working copy, a
// non-repository directory, a path outside the session working directory
// (where a fake `git` early on PATH proves no process was spawned), and a
// loaded mod observing the answer in a session.start handler.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import test from 'node:test'

import { createModBridge, loadMod } from '../src/index.ts'

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'anyplugin test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'anyplugin test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
}

const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' })
const makeDir = (prefix) => mkdtempSync(join(tmpdir(), prefix))
const remove = (dir) => rmSync(dir, { recursive: true, force: true })

/** A committed repository: one modified file, one deleted, one rename, one untracked text and one binary. */
const makeRepo = () => {
  const root = makeDir('anyplugin-vcs-repo-')
  git(root, 'init', '-b', 'main')
  writeFileSync(join(root, 'tracked.txt'), 'one\ntwo\n')
  writeFileSync(join(root, 'gone.txt'), 'gone\n')
  writeFileSync(join(root, 'old-name.txt'), 'rename me\n')
  git(root, 'add', '--', 'tracked.txt', 'gone.txt', 'old-name.txt')
  git(root, 'commit', '-m', 'init', '--no-gpg-sign')
  return root
}

const mutate = (root) => {
  writeFileSync(join(root, 'tracked.txt'), 'one\nTWO\n')
  rmSync(join(root, 'gone.txt'))
  git(root, 'mv', 'old-name.txt', 'new-name.txt')
  writeFileSync(join(root, 'new-name.txt'), 'rename me\nplus one\n')
  writeFileSync(join(root, 'untracked.txt'), 'hello\n')
  writeFileSync(join(root, 'blob.bin'), Buffer.from([0, 1, 2, 3]))
}

test('vcs.detect answers the pinned working copy for a git repository', async () => {
  const root = makeRepo()
  const bridge = createModBridge({ plugin: 'unit/vcs.ts', cwd: root })
  try {
    const $ = bridge.dollar()
    const copy = await $.vcs.detect({ path: '.' })
    assert.equal(copy.vcs, 'git')
    assert.equal(copy.root, realpathSync(root))
    assert.equal(copy.mainRoot, copy.root)
    assert.match(copy.revision, /^[0-9a-f]{40}$/)
    assert.equal(copy.branch, 'main')
    assert.equal(copy.defaultBranch, null)
    assert.equal(copy.remote, null)

    // The pin's remote is the engine's own words with credentials stripped.
    git(root, 'remote', 'add', 'origin', 'https://user:secret@example.com/o/r.git')
    assert.equal((await $.vcs.detect({ path: root })).remote, 'https://example.com/o/r.git')
    // A token in the query string is a credential too, and the pin says the
    // remote has credentials stripped; the harmless parameter survives, and a
    // presigned signature or a credential-bearing fragment cannot ride along.
    git(
      root,
      'remote',
      'set-url',
      'origin',
      'https://example.com/o/r.git?ref=main&access_token=SECRET&X-Amz-Signature=SIG#access_token=FRAG',
    )
    assert.equal((await $.vcs.detect({ path: root })).remote, 'https://example.com/o/r.git?ref=main')

    // `default` needs refs/remotes/origin/HEAD; until it exists, null is the
    // honest answer rather than guessing `main`.
    git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
    git(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
    assert.equal((await $.vcs.detect({ path: '.' })).defaultBranch, 'main')
  } finally {
    bridge.dispose()
    remove(root)
  }
})

test('vcs.detect reports no main root for a submodule checkout', async () => {
  const inner = makeRepo()
  const superRoot = makeDir('anyplugin-vcs-super-')
  const sub = join(superRoot, 'sub')
  try {
    git(superRoot, 'init', '-b', 'main')
    git(superRoot, '-c', 'protocol.file.allow=always', 'submodule', 'add', '--', inner, 'sub')
    const bridge = createModBridge({ plugin: 'unit/vcs.ts', cwd: sub })
    try {
      const copy = await bridge.dollar().vcs.detect({ path: '.' })
      assert.equal(copy.root, realpathSync(sub))
      assert.equal(copy.mainRoot, null)
    } finally {
      bridge.dispose()
    }
  } finally {
    remove(superRoot)
    remove(inner)
  }
})

test('vcs.detect discovers the root from a subdirectory and answers null outside a repository', async () => {
  const root = makeRepo()
  const sub = join(root, 'sub')
  mkdirSync(sub)
  writeFileSync(join(sub, 'inside.txt'), 'inside\n')
  const bridge = createModBridge({ plugin: 'unit/vcs.ts', cwd: sub })
  try {
    const copy = await bridge.dollar().vcs.detect({ path: '.' })
    assert.equal(copy.root, realpathSync(root))
    assert.equal(copy.mainRoot, realpathSync(root))
  } finally {
    bridge.dispose()
    remove(root)
  }

  const plain = makeDir('anyplugin-vcs-plain-')
  const plainBridge = createModBridge({ plugin: 'unit/vcs.ts', cwd: plain })
  try {
    assert.equal(await plainBridge.dollar().vcs.detect({ path: '.' }), null)
    // The pinned result has an `unknown` arm for exactly this: detect answers
    // null, so there is no working copy to diff. It is an answer, not a throw.
    const outside = await plainBridge.dollar().vcs.diff({ path: '.', vcs: 'git', base: 'head' })
    assert.equal(typeof outside.unknown, 'string')
    assert.match(outside.unknown, /not in a working copy/)
    assert.equal(outside.base, undefined)
    assert.equal(outside.files, undefined)
  } finally {
    plainBridge.dispose()
    remove(plain)
  }

  // An unborn branch has no revision; `head` still means "the empty tree".
  const unborn = makeDir('anyplugin-vcs-unborn-')
  git(unborn, 'init', '-b', 'main')
  writeFileSync(join(unborn, 'first.txt'), 'first\n')
  const unbornBridge = createModBridge({ plugin: 'unit/vcs.ts', cwd: unborn })
  try {
    const copy = await unbornBridge.dollar().vcs.detect({ path: '.' })
    assert.equal(copy.revision, null)
    assert.equal(copy.branch, 'main')
    const answer = await unbornBridge.dollar().vcs.diff({ path: '.', vcs: 'git', base: 'head' })
    assert.equal(answer.base, 'HEAD')
    assert.deepEqual(answer.files.map((file) => file.path), ['first.txt'])
    assert.equal(answer.files[0].isUntracked, true)
  } finally {
    unbornBridge.dispose()
    remove(unborn)
  }
})

test('a vcs path outside the session working directory is refused before a process starts', async () => {
  const root = makeRepo()
  const outside = makeDir('anyplugin-vcs-outside-')
  const marker = join(outside, 'git-was-spawned')
  const bin = join(outside, 'bin')
  mkdirSync(bin)
  // If the bridge ever spawned for this path, the fake git would leave the
  // marker. The refusal must happen in path resolution, before `execFile`.
  writeFileSync(join(bin, 'git'), '#!/bin/sh\nprintf spawned > "$ANYPLUGIN_VCS_MARKER"\nexit 0\n', { mode: 0o755 })
  const savedPath = process.env.PATH
  const savedMarker = process.env.ANYPLUGIN_VCS_MARKER
  process.env.PATH = `${bin}${delimiter}${savedPath ?? ''}`
  process.env.ANYPLUGIN_VCS_MARKER = marker
  const bridge = createModBridge({ plugin: 'unit/vcs.ts', cwd: root })
  try {
    const $ = bridge.dollar()
    await assert.rejects($.vcs.detect({ path: outside }), (error) => error.code === 'ERR_MOD_HOST_PATH_OUTSIDE')
    await assert.rejects($.vcs.detect({ path: `../${outside.split('/').pop()}` }), (error) => error.code === 'ERR_MOD_HOST_PATH_OUTSIDE')
    await assert.rejects(
      $.vcs.diff({ path: outside, vcs: 'git', base: 'head' }),
      (error) => error.code === 'ERR_MOD_HOST_PATH_OUTSIDE',
    )
    assert.equal(existsSync(marker), false, 'a refused path must not spawn git')
  } finally {
    bridge.dispose()
    process.env.PATH = savedPath
    if (savedMarker === undefined) delete process.env.ANYPLUGIN_VCS_MARKER
    else process.env.ANYPLUGIN_VCS_MARKER = savedMarker
    remove(root)
    remove(outside)
  }
})

test('vcs.diff answers head, paths, isStatOnly and unknown with the pinned shapes', async () => {
  const root = makeRepo()
  mutate(root)
  const bridge = createModBridge({ plugin: 'unit/vcs.ts', cwd: root })
  try {
    const $ = bridge.dollar()
    const answer = await $.vcs.diff({ path: '.', vcs: 'git', base: 'head' })
    assert.equal(answer.base, 'HEAD')
    const rows = new Map(answer.files.map((file) => [file.path, file]))
    assert.deepEqual([...rows.keys()], ['blob.bin', 'gone.txt', 'new-name.txt', 'tracked.txt', 'untracked.txt'])

    assert.equal(rows.get('blob.bin').isBinary, true)
    assert.equal(rows.get('blob.bin').isUntracked, true)
    assert.equal(rows.get('blob.bin').added, 0)
    assert.equal(Object.hasOwn(rows.get('blob.bin'), 'patch'), false)

    assert.equal(rows.get('untracked.txt').isUntracked, true)
    assert.equal(rows.get('untracked.txt').added, 1)
    assert.ok(rows.get('untracked.txt').patch.startsWith('@@'))
    assert.match(rows.get('untracked.txt').patch, /\+hello/)

    assert.deepEqual(
      { added: rows.get('gone.txt').added, removed: rows.get('gone.txt').removed, renamedFrom: rows.get('gone.txt').renamedFrom },
      { added: 0, removed: 1, renamedFrom: null },
    )
    assert.match(rows.get('gone.txt').patch, /-gone/)

    assert.equal(rows.get('new-name.txt').renamedFrom, 'old-name.txt')
    assert.equal(rows.get('new-name.txt').added, 1)
    assert.equal(rows.get('new-name.txt').removed, 0)
    assert.match(rows.get('new-name.txt').patch, /\+plus one/)

    assert.equal(rows.get('tracked.txt').added, 1)
    assert.equal(rows.get('tracked.txt').removed, 1)
    assert.match(rows.get('tracked.txt').patch, /\+TWO/)
    assert.match(rows.get('tracked.txt').patch, /-two/)

    // `paths` narrows the answer and either side of a rename keeps it.
    const narrow = await $.vcs.diff({ path: '.', vcs: 'git', base: 'head', paths: ['untracked.txt'] })
    assert.deepEqual(narrow.files.map((file) => file.path), ['untracked.txt'])
    const renamed = await $.vcs.diff({ path: '.', vcs: 'git', base: 'head', paths: ['old-name.txt'] })
    assert.deepEqual(renamed.files.map((file) => file.path), ['new-name.txt'])
    assert.equal(renamed.files[0].renamedFrom, 'old-name.txt')
    assert.deepEqual((await $.vcs.diff({ path: '.', vcs: 'git', base: 'head', paths: [] })).files, [])
    assert.deepEqual((await $.vcs.diff({ path: '.', vcs: 'git', base: 'head', paths: ['no-such-file'] })).files, [])
    // `.` is the copy root, so it means the whole copy, not a literal name.
    assert.deepEqual(
      (await $.vcs.diff({ path: '.', vcs: 'git', base: 'head', paths: ['.'] })).files.map((file) => file.path),
      [...rows.keys()],
    )

    // Stat-only keeps every patch out, including the untracked ones.
    const stat = await $.vcs.diff({ path: '.', vcs: 'git', base: 'head', isStatOnly: true })
    assert.ok(stat.files.length > 0)
    for (const file of stat.files) assert.equal(Object.hasOwn(file, 'patch'), false)
    assert.equal(stat.files.find((file) => file.path === 'tracked.txt').added, 1)
    assert.equal(stat.files.find((file) => file.path === 'untracked.txt').added, 1)
    assert.equal(stat.files.find((file) => file.path === 'untracked.txt').isUntracked, true)

    // `default` still needs origin/HEAD; without it the answer is `unknown`,
    // not a throw and not a guessed branch.
    const unknown = await $.vcs.diff({ path: '.', vcs: 'git', base: 'default' })
    assert.equal(typeof unknown.unknown, 'string')
    assert.equal(Object.hasOwn(unknown, 'files'), false)

    git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
    git(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
    const branch = await $.vcs.diff({ path: '.', vcs: 'git', base: 'default', paths: [] })
    assert.deepEqual(branch, { base: 'main', files: [] })
    const againstMain = await $.vcs.diff({ path: '.', vcs: 'git', base: 'default' })
    assert.equal(againstMain.base, 'main')
    assert.deepEqual(againstMain.files.map((file) => file.path), ['blob.bin', 'gone.txt', 'new-name.txt', 'tracked.txt', 'untracked.txt'])

    // A non-git slug is an `unknown` answer, not a fabricated empty diff.
    const other = await $.vcs.diff({ path: '.', vcs: 'svn', base: 'head' })
    assert.equal(typeof other.unknown, 'string')

    // The pinned inputs are checked, not coerced.
    await assert.rejects($.vcs.detect({}), (error) => error.code === 'ERR_MOD_HOST_VCS_INVALID')
    await assert.rejects($.vcs.detect({ path: join(root, 'missing') }), (error) => error.code === 'ERR_MOD_HOST_PATH_MISSING')
    await assert.rejects($.vcs.detect({ path: join(root, 'tracked.txt') }), (error) => error.code === 'ERR_MOD_HOST_VCS_INVALID')
    await assert.rejects($.vcs.diff({ path: '.', vcs: 'git', base: 'sideways' }), (error) => error.code === 'ERR_MOD_HOST_VCS_INVALID')
    await assert.rejects($.vcs.diff({ path: '.', vcs: 'git', base: 'head', paths: ['../x'] }), (error) => error.code === 'ERR_MOD_HOST_VCS_INVALID')
    await assert.rejects($.vcs.diff({ path: '.', vcs: 'git', base: 'head', isStatOnly: 'yes' }), (error) => error.code === 'ERR_MOD_HOST_VCS_INVALID')
    await assert.rejects(
      $.vcs.diff({ path: '.', vcs: 'git', base: 'head', paths: ['x'.repeat(4097)] }),
      (error) => error.code === 'ERR_MOD_HOST_VCS_INVALID',
    )
  } finally {
    bridge.dispose()
    remove(root)
  }
})

test('vcs.diff from a subdirectory reports root-relative paths after detect recorded the root', async () => {
  const root = makeRepo()
  mutate(root)
  const sub = join(root, 'sub')
  mkdirSync(sub)
  writeFileSync(join(sub, 'inside.txt'), 'inside\n')
  const bridge = createModBridge({ plugin: 'unit/vcs.ts', cwd: sub })
  try {
    const $ = bridge.dollar()
    // `detect` from the subdirectory reports the repository root, which is
    // outside the session cwd; that exact root is then a served path.
    const copy = await $.vcs.detect({ path: '.' })
    assert.equal(copy.root, realpathSync(root))
    const answer = await $.vcs.diff({ path: copy.root, vcs: copy.vcs, base: 'head' })
    assert.equal(answer.base, 'HEAD')
    const paths = answer.files.map((file) => file.path)
    assert.ok(paths.includes('tracked.txt'), 'tracked changes are root-relative')
    assert.ok(paths.includes('sub/inside.txt'), 'untracked files are repo-wide and root-relative')
    assert.equal(answer.files.find((file) => file.path === 'sub/inside.txt').isUntracked, true)
    // A path that was never reported by detect and is outside the session is
    // still refused, even though it is a working-copy path.
    const elsewhere = makeRepo()
    try {
      await assert.rejects($.vcs.diff({ path: elsewhere, vcs: 'git', base: 'head' }), (error) => error.code === 'ERR_MOD_HOST_PATH_OUTSIDE')
    } finally {
      remove(elsewhere)
    }
  } finally {
    bridge.dispose()
    remove(root)
  }
})

test('a repository filter driver cannot execute on the stat, patch or untracked paths', async () => {
  const root = makeRepo()
  writeFileSync(join(root, 'tracked.txt'), 'one\nTWO\n')
  writeFileSync(join(root, 'untracked.txt'), 'hello\n')
  const marker = join(root, 'filter-ran')
  const script = join(root, 'evil-filter.sh')
  writeFileSync(script, '#!/bin/sh\n: > "$ANYPLUGIN_FILTER_MARKER"\ncat\n', { mode: 0o755 })
  writeFileSync(join(root, '.gitattributes'), '*.txt filter=evil\n')
  git(root, 'config', 'filter.evil.clean', script)
  git(root, 'config', 'filter.evil.required', 'true')

  const previous = process.env.ANYPLUGIN_FILTER_MARKER
  process.env.ANYPLUGIN_FILTER_MARKER = marker
  const bridge = createModBridge({ plugin: 'unit/vcs.ts', cwd: root })
  try {
    // Control: the same raw invocation without the bridge's overrides runs the
    // driver. If this ever stops writing the marker, the fixture is stale and
    // the assertions below prove nothing.
    execFileSync('git', ['diff', '--no-ext-diff', '--no-textconv', 'HEAD'], {
      cwd: root,
      env: { ...GIT_ENV, ANYPLUGIN_FILTER_MARKER: marker },
      encoding: 'utf8',
    })
    assert.equal(existsSync(marker), true, 'the raw-git control must run the driver')
    rmSync(marker)

    const $ = bridge.dollar()
    const patched = await $.vcs.diff({ path: '.', vcs: 'git', base: 'head' })
    assert.equal(existsSync(marker), false, 'the patch path must not run the driver')
    assert.ok(patched.files.some((file) => file.path === 'tracked.txt' && typeof file.patch === 'string'))

    const stat = await $.vcs.diff({ path: '.', vcs: 'git', base: 'head', isStatOnly: true })
    assert.equal(existsSync(marker), false, 'the stat path must not run the driver')
    assert.ok(stat.files.some((file) => file.path === 'tracked.txt'))

    const untracked = await $.vcs.diff({ path: '.', vcs: 'git', base: 'head', paths: ['untracked.txt'] })
    assert.equal(existsSync(marker), false, 'the --no-index untracked path must not run the driver')
    assert.equal(untracked.files[0].isUntracked, true)
  } finally {
    if (previous === undefined) delete process.env.ANYPLUGIN_FILTER_MARKER
    else process.env.ANYPLUGIN_FILTER_MARKER = previous
    bridge.dispose()
    remove(root)
  }
})

test('a filter key containing = cannot escape the override', async () => {
  const root = makeRepo()
  writeFileSync(join(root, 'tracked.txt'), 'one\nTWO\n')
  writeFileSync(join(root, 'untracked.txt'), 'hello\n')
  const marker = join(root, 'filter-ran')
  const script = join(root, 'evil-filter.sh')
  writeFileSync(script, '#!/bin/sh\n: > "$ANYPLUGIN_FILTER_MARKER"\ncat\n', { mode: 0o755 })
  writeFileSync(join(root, '.gitattributes'), '*.txt filter=a=b\n')
  // `-c filter.a=b.clean=` would set key `filter.a` and leave this driver
  // live; the environment form must carry the whole key.
  git(root, 'config', 'filter.a=b.clean', script)
  git(root, 'config', 'filter.a=b.required', 'true')

  const previous = process.env.ANYPLUGIN_FILTER_MARKER
  process.env.ANYPLUGIN_FILTER_MARKER = marker
  const bridge = createModBridge({ plugin: 'unit/vcs.ts', cwd: root })
  try {
    execFileSync('git', ['diff', '--no-ext-diff', '--no-textconv', 'HEAD'], {
      cwd: root,
      env: { ...GIT_ENV, ANYPLUGIN_FILTER_MARKER: marker },
      encoding: 'utf8',
    })
    assert.equal(existsSync(marker), true, 'the raw-git control must run the driver')
    rmSync(marker)

    const $ = bridge.dollar()
    const patched = await $.vcs.diff({ path: '.', vcs: 'git', base: 'head' })
    assert.equal(existsSync(marker), false, 'the patch path must not run the driver')
    assert.ok(patched.files.some((file) => file.path === 'tracked.txt' && typeof file.patch === 'string'))

    const stat = await $.vcs.diff({ path: '.', vcs: 'git', base: 'head', isStatOnly: true })
    assert.equal(existsSync(marker), false, 'the stat path must not run the driver')

    const untracked = await $.vcs.diff({ path: '.', vcs: 'git', base: 'head', paths: ['untracked.txt'] })
    assert.equal(existsSync(marker), false, 'the --no-index untracked path must not run the driver')
    assert.equal(untracked.files[0].isUntracked, true)
  } finally {
    if (previous === undefined) delete process.env.ANYPLUGIN_FILTER_MARKER
    else process.env.ANYPLUGIN_FILTER_MARKER = previous
    bridge.dispose()
    remove(root)
  }
})

test('the four unbridged vcs members refuse with a named reason, never undefined', async () => {
  const root = makeRepo()
  const bridge = createModBridge({ plugin: 'unit/vcs.ts', cwd: root })
  try {
    const $ = bridge.dollar()
    for (const name of ['isolate', 'list', 'status', 'release']) {
      await assert.rejects(
        $.vcs[name]({}),
        (error) => error.code === 'ERR_MOD_HOST_VCS_UNSUPPORTED' && error.message.includes(`$.vcs.${name}`),
        `${name} must be a typed refusal`,
      )
    }
  } finally {
    bridge.dispose()
    remove(root)
  }
})

test('a loaded mod observes detect then diff through the bridge in a session.start turn', async () => {
  const root = makeRepo()
  mutate(root)
  const modRoot = makeDir('anyplugin-vcs-mod-')
  writeFileSync(
    join(modRoot, 'register.ts'),
    [
      'export function register(on, options) {',
      "  on('session.start', async ($, event) => {",
      '    const copy = await $.vcs.detect({ path: event.cwd })',
      "    const answer = copy === null ? null : await $.vcs.diff({ path: copy.root, vcs: copy.vcs, base: 'head' })",
      "    $.telemetry.mark({ hook: 'session.start', copy, answer })",
      "    return { kind: 'continued' }",
      '  })',
      '}',
      '',
    ].join('\n'),
  )
  const marks = []
  const bridge = createModBridge({
    plugin: 'synthetic-vcs/register.ts',
    cwd: root,
    telemetry: (record) => {
      if (record.kind === 'mark') marks.push(record.entry)
    },
  })
  try {
    const mod = await loadMod({ root: modRoot, entry: 'register.ts', host: { dollar: () => bridge.dollar() } })
    assert.equal(mod.registrations.length, 1)
    const registration = mod.registrations[0]
    assert.equal(registration.event, 'session.start')
    await registration.handler({ hook_event_name: 'SessionStart', cwd: root }, () => ({ kind: 'continued' }))

    assert.equal(marks.length, 1)
    const observed = marks[0]
    assert.equal(observed.copy.vcs, 'git')
    assert.equal(observed.copy.root, realpathSync(root))
    assert.equal(observed.answer.base, 'HEAD')
    const rows = new Map(observed.answer.files.map((file) => [file.path, file]))
    assert.equal(rows.get('tracked.txt').added, 1)
    assert.equal(rows.get('tracked.txt').removed, 1)
    assert.equal(rows.get('untracked.txt').isUntracked, true)
    assert.ok(rows.get('new-name.txt').patch.startsWith('@@'))
    assert.equal(rows.get('new-name.txt').renamedFrom, 'old-name.txt')
  } finally {
    bridge.dispose()
    remove(root)
    remove(modRoot)
  }
})
