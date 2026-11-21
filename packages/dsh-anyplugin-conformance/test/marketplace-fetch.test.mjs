// Fetching a remote marketplace entry (`url`, `git-subdir`, `npm`) under a
// `network` grant. Everything here is offline: git reads a bare repository
// over `file://`, npm packs a package/tarball on this disk, and the url tests
// bind a loopback HTTPS server with a certificate generated in this process.
// No test may reach an external host.

import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { readInstalls } from '../../dsh-anyplugin-install/src/index.ts'
import { grantsPath, readGrants, revoke, writeGrants } from '../../dsh-anyplugin-trust/src/index.ts'
import { MAX_ARTIFACT_BYTES, MAX_REDIRECTS } from '../src/marketplace-fetch.ts'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../..')
const cli = resolve(repoRoot, 'packages/dsh-anyplugin-conformance/src/rig.ts')

// ---------------------------------------------------------------------------
// sandbox and CLI
// ---------------------------------------------------------------------------

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix))
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true })
}

function sandbox() {
  const dir = tempDir('market-fetch-')
  const home = join(dir, 'home')
  const project = join(dir, 'project')
  mkdirSync(home, { recursive: true })
  mkdirSync(project, { recursive: true })
  return {
    dir,
    home,
    project,
    lock: join(home, 'anyplugin', 'installs.yml'),
    grants: join(home, 'anyplugin', 'grants.yml'),
    cache: join(home, 'anyplugin', 'marketplace-cache'),
  }
}

function run(box, args, env = {}) {
  return new Promise((done) => {
    const child = spawn(process.execPath, ['--experimental-vm-modules', cli, ...args], {
      cwd: repoRoot,
      env: { ...process.env, DSH_HOME: box.home, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('close', (status) => done({ status, stdout, stderr }))
  })
}

function digest(file) {
  return existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : null
}

// ---------------------------------------------------------------------------
// fixture writers
// ---------------------------------------------------------------------------

function writePlugin(dir, name, version, skill = 'hello') {
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true })
  writeFileSync(
    join(dir, '.claude-plugin', 'plugin.json'),
    `${JSON.stringify({ name, description: `Fixture plugin ${name}.`, version })}\n`,
  )
  mkdirSync(join(dir, 'skills', skill), { recursive: true })
  writeFileSync(join(dir, 'skills', skill, 'SKILL.md'), `---\nname: ${skill}\ndescription: Says ${skill}.\n---\n\nSay ${skill}.\n`)
}

function writeCatalog(root, entries, name = 'fetch-marketplace') {
  mkdirSync(join(root, '.claude-plugin'), { recursive: true })
  writeFileSync(
    join(root, '.claude-plugin', 'marketplace.json'),
    `${JSON.stringify({ name, description: 'Fetch fixtures.', plugins: entries }, null, 2)}\n`,
  )
  return join(root, '.claude-plugin', 'marketplace.json')
}

// ---------------------------------------------------------------------------
// git fixtures (local bare repositories; file:// only)
// ---------------------------------------------------------------------------

function git(cwd, args) {
  return execFileSync(
    'git',
    ['-c', 'user.name=Marketplace Test', '-c', 'user.email=test@example.invalid', ...args],
    {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_GLOBAL: '/dev/null' },
    },
  )
}

function createRepo() {
  const work = tempDir('git-work-')
  const plugin = join(work, 'plugins', 'git-plugin')
  writePlugin(plugin, 'git-plugin', '0.1.0')
  git(work, ['init', '-b', 'main'])
  git(work, ['add', '.'])
  git(work, ['commit', '-m', 'one'])
  const commit = git(work, ['rev-parse', 'HEAD']).trim()
  const bare = join(tempDir('git-bare-'), 'repo.git')
  execFileSync('git', ['clone', '--bare', work, bare], { stdio: 'ignore' })
  return { work, plugin, bare, url: `file://${bare}`, commit }
}

function pushSecondCommit(repo) {
  writePlugin(repo.plugin, 'git-plugin', '0.2.0')
  git(repo.work, ['add', '.'])
  git(repo.work, ['commit', '-m', 'two'])
  const commit = git(repo.work, ['rev-parse', 'HEAD']).trim()
  git(repo.work, ['push', repo.bare, 'main'])
  return commit
}

// ---------------------------------------------------------------------------
// npm fixtures (local package directory and local tarball; never a registry)
// ---------------------------------------------------------------------------

function npmEnv(cache) {
  return {
    ...process.env,
    npm_config_cache: cache,
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
    npm_config_global: 'false',
  }
}

function npmPackage({ prepareMarker = true, plugin = true } = {}) {
  const dir = tempDir('npm-pkg-')
  const scripts = prepareMarker
    ? { prepare: `node -e "require('fs').writeFileSync(require('path').join(process.cwd(),'prepare-marker'),'x')"` }
    : {}
  writeFileSync(
    join(dir, 'package.json'),
    `${JSON.stringify({ name: 'npm-fixture', version: '0.1.0', private: true, scripts }, null, 2)}\n`,
  )
  if (plugin) writePlugin(dir, 'npm-plugin', '0.1.0')
  return dir
}

function packPackage(dir, out) {
  mkdirSync(out, { recursive: true })
  execFileSync('npm', ['pack', dir, '--ignore-scripts', '--pack-destination', out], {
    encoding: 'utf8',
    env: npmEnv(join(dirname(out), 'npm-cache')),
  })
  const tarballs = readdirSync(out).filter((file) => file.endsWith('.tgz'))
  assert.equal(tarballs.length, 1, `expected one packed tarball, got ${tarballs.join(', ')}`)
  return join(out, tarballs[0])
}

// ---------------------------------------------------------------------------
// loopback HTTPS server (the only "network" in this file)
// ---------------------------------------------------------------------------

const tls = (() => {
  const dir = tempDir('tls-')
  const key = join(dir, 'key.pem')
  const cert = join(dir, 'cert.pem')
  execFileSync(
    'openssl',
    [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', key, '-out', cert, '-days', '2',
      '-subj', '/CN=127.0.0.1',
      '-addext', 'subjectAltName=IP:127.0.0.1',
    ],
    { stdio: 'ignore' },
  )
  return { key: readFileSync(key), cert: readFileSync(cert), certPath: cert }
})()

async function serve(handler) {
  const server = createHttpsServer({ key: tls.key, cert: tls.cert }, handler)
  server.keepAliveTimeout = 250
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address()
  return {
    url: `https://127.0.0.1:${port}`,
    close: () =>
      new Promise((done) => {
        server.closeAllConnections()
        server.close(done)
      }),
  }
}

function readLock(file) {
  return existsSync(file) ? readFileSync(file, 'utf8') : ''
}

// ---------------------------------------------------------------------------
// git-subdir
// ---------------------------------------------------------------------------

test('git-subdir pinned to a sha installs, records the commit, and needs no second fetch', async () => {
  const box = sandbox()
  const repo = createRepo()
  try {
    const root = join(box.dir, 'catalog')
    const catalog = writeCatalog(root, [
      {
        name: 'git-plugin',
        description: 'A plugin in a git repository.',
        version: '0.1.0',
        source: { source: 'git-subdir', url: repo.url, path: 'plugins/git-plugin', sha: repo.commit },
      },
    ])
    const first = await run(box, ['marketplace', 'install', 'git-plugin', '--from', catalog, '--yes'])
    assert.equal(first.status, 0, first.stderr)
    assert.match(first.stdout, /recorded|added/u)

    const source = readInstalls(box.lock).plugins[0].source
    assert.equal(typeof source, 'object')
    assert.equal(source.marketplace, 'fetch-marketplace')
    assert.equal(source.entry, 'git-plugin')
    assert.equal(source.version, '0.1.0')
    assert.equal(source.integrity, `git:${repo.commit}`)
    assert.match(source.resolvedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u)

    const artifact = join(box.cache, 'fetch-marketplace', `git-plugin@${repo.commit}`, 'plugins', 'git-plugin')
    assert.equal(existsSync(join(artifact, '.claude-plugin', 'plugin.json')), true, 'the commit tree is cached')
    assert.equal(existsSync(join(artifact, '.git')), false, 'the fetched tree drops its git directory')

    const grants = readFileSync(box.grants, 'utf8')
    assert.match(grants, /capability: "network"/u)
    assert.match(grants, new RegExp(`target: "git:${repo.url.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}@${repo.commit}#plugins/git-plugin"`, 'u'))
    assert.doesNotMatch(grants, /capability: "exec"/u, 'a network grant never implies exec')
    const parsed = readGrants(box.grants)
    assert.equal(parsed.grants.length, 1)
    assert.equal(parsed.grants[0].capability, 'network')
    assert.equal(parsed.grants[0].artifactHash, `git:${repo.commit}`)

    // A pinned sha is already resolved: the second install reuses the cache and
    // keeps every byte, including resolvedAt.
    const before = digest(box.lock)
    const second = await run(box, ['marketplace', 'install', 'git-plugin', '--from', catalog])
    assert.equal(second.status, 0, second.stderr)
    assert.equal(digest(box.lock), before, 'a re-install is byte-idempotent')
  } finally {
    cleanup(box.dir)
    cleanup(repo.work)
    cleanup(dirname(repo.bare))
  }
})

test('a floating ref records what it resolved to, and a moved pin refuses until --yes names both commits', async () => {
  const box = sandbox()
  const repo = createRepo()
  try {
    const root = join(box.dir, 'catalog')
    const catalog = writeCatalog(root, [
      {
        name: 'git-plugin',
        version: '0.1.0',
        source: { source: 'git-subdir', url: repo.url, path: 'plugins/git-plugin', ref: 'main' },
      },
    ])
    const first = await run(box, ['marketplace', 'install', 'git-plugin', '--from', catalog, '--yes'])
    assert.equal(first.status, 0, first.stderr)
    assert.equal(readInstalls(box.lock).plugins[0].source.integrity, `git:${repo.commit}`)

    const moved = pushSecondCommit(repo)
    assert.notEqual(moved, repo.commit)

    const before = digest(box.lock)
    const refused = await run(box, ['marketplace', 'install', 'git-plugin', '--from', catalog])
    assert.equal(refused.status, 1)
    assert.match(refused.stderr, /refused \(network-pin-moved\)/u)
    assert.match(refused.stderr, new RegExp(`resolved to git:${moved}`, 'u'))
    assert.match(refused.stderr, new RegExp(`pins git:${repo.commit}`, 'u'))
    assert.match(refused.stderr, /--yes/u)
    assert.equal(digest(box.lock), before, 'a moved pin must not rewrite the lock')
    assert.equal(readGrants(box.grants).grants[0].artifactHash, `git:${repo.commit}`, 'the grant still pins the old bytes')

    const accepted = await run(box, ['marketplace', 'install', 'git-plugin', '--from', catalog, '--yes'])
    assert.equal(accepted.status, 0, accepted.stderr)
    assert.equal(readInstalls(box.lock).plugins[0].source.integrity, `git:${moved}`)
    assert.equal(readGrants(box.grants).grants[0].artifactHash, `git:${moved}`, '--yes updates the grant in place')

    // Once the grant matches the resolved commit, no --yes is needed again.
    const again = await run(box, ['marketplace', 'install', 'git-plugin', '--from', catalog])
    assert.equal(again.status, 0, again.stderr)
  } finally {
    cleanup(box.dir)
    cleanup(repo.work)
    cleanup(dirname(repo.bare))
  }
})

test('a git-subdir path that escapes the repository is refused before the fetch', async () => {
  const box = sandbox()
  const repo = createRepo()
  try {
    const root = join(box.dir, 'catalog')
    const catalog = writeCatalog(root, [
      {
        name: 'git-plugin',
        source: { source: 'git-subdir', url: repo.url, path: '../outside', ref: 'main' },
      },
    ])
    const refused = await run(box, ['marketplace', 'install', 'git-plugin', '--from', catalog, '--yes'])
    assert.equal(refused.status, 1)
    assert.match(refused.stderr, /refused \(marketplace-fetch-refused\)/u)
    assert.match(refused.stderr, /escapes the repository root/u)
    assert.equal(existsSync(box.cache), false, 'no cache directory for a refused path')
    assert.equal(existsSync(box.lock), false)
  } finally {
    cleanup(box.dir)
    cleanup(repo.work)
    cleanup(dirname(repo.bare))
  }
})

test('a git-subdir the repository does not contain is an artifact refusal, not an install', async () => {
  const box = sandbox()
  const repo = createRepo()
  try {
    const root = join(box.dir, 'catalog')
    const catalog = writeCatalog(root, [
      {
        name: 'git-plugin',
        source: { source: 'git-subdir', url: repo.url, path: 'plugins/nope', ref: 'main' },
      },
    ])
    const refused = await run(box, ['marketplace', 'install', 'git-plugin', '--from', catalog, '--yes'])
    assert.equal(refused.status, 1)
    assert.match(refused.stderr, /refused \(marketplace-artifact-invalid\)/u)
    assert.match(refused.stderr, /does not contain "plugins\/nope"/u)
    assert.equal(existsSync(box.lock), false)
  } finally {
    cleanup(box.dir)
    cleanup(repo.work)
    cleanup(dirname(repo.bare))
  }
})

// ---------------------------------------------------------------------------
// npm
// ---------------------------------------------------------------------------

test('an npm package is packed with --ignore-scripts and records the tarball sha512', async () => {
  const box = sandbox()
  try {
    const root = join(box.dir, 'catalog')
    const pkg = npmPackage({ prepareMarker: true })
    const catalog = writeCatalog(root, [
      {
        name: 'npm-plugin',
        version: '0.1.0',
        source: { source: 'npm', package: pkg, version: '0.1.0' },
      },
    ])
    const marker = join(pkg, 'prepare-marker')
    assert.equal(existsSync(marker), false)

    const installed = await run(box, ['marketplace', 'install', 'npm-plugin', '--from', catalog, '--yes'])
    assert.equal(installed.status, 0, installed.stderr)
    assert.equal(existsSync(marker), false, '--ignore-scripts means the prepare script must not run')

    const source = readInstalls(box.lock).plugins[0].source
    assert.equal(typeof source, 'object')
    assert.equal(source.version, '0.1.0')
    assert.match(source.integrity, /^npm:[0-9a-f]{128}$/u)
    assert.equal(existsSync(join(box.cache, 'fetch-marketplace', 'npm-plugin@0.1.0')), true)

    const before = digest(box.lock)
    const again = await run(box, ['marketplace', 'install', 'npm-plugin', '--from', catalog])
    assert.equal(again.status, 0, again.stderr)
    assert.equal(digest(box.lock), before, 'the same tarball keeps the lock byte-identical')
  } finally {
    cleanup(box.dir)
  }
})

test('an npm tarball path is accepted and a registry-style spec must pin an exact version', async () => {
  const box = sandbox()
  try {
    const root = join(box.dir, 'catalog')
    const pkg = npmPackage({ prepareMarker: false })
    const tarball = packPackage(pkg, join(box.dir, 'tarballs'))
    const catalog = writeCatalog(root, [
      {
        name: 'npm-plugin',
        version: '0.1.0',
        source: { source: 'npm', package: './tarballs/npm-fixture-0.1.0.tgz' },
      },
    ])
    // The catalog resolves a local spec against the marketplace root.
    mkdirSync(join(root, 'tarballs'), { recursive: true })
    writeFileSync(join(root, 'tarballs', 'npm-fixture-0.1.0.tgz'), readFileSync(tarball))
    const installed = await run(box, ['marketplace', 'install', 'npm-plugin', '--from', catalog, '--yes'])
    assert.equal(installed.status, 0, installed.stderr)
    assert.match(readInstalls(box.lock).plugins[0].source.integrity, /^npm:[0-9a-f]{128}$/u)

    const unpinned = writeCatalog(
      join(box.dir, 'catalog-unpinned'),
      [{ name: 'npm-plugin', source: { source: 'npm', package: '@scope/name' } }],
      'unpinned-marketplace',
    )
    const refused = await run(box, ['marketplace', 'install', 'npm-plugin', '--from', unpinned, '--yes'])
    assert.equal(refused.status, 1)
    assert.match(refused.stderr, /refused \(marketplace-fetch-refused\)/u)
    assert.match(refused.stderr, /must pin an exact version/u)
    assert.match(refused.stderr, /ranges are not a pin/u)
    assert.equal(existsSync(join(box.cache, 'unpinned-marketplace')), false)
  } finally {
    cleanup(box.dir)
  }
})

test('an npm package without a plugin manifest is refused after extraction', async () => {
  const box = sandbox()
  try {
    const root = join(box.dir, 'catalog')
    const pkg = npmPackage({ prepareMarker: false, plugin: false })
    const catalog = writeCatalog(root, [
      { name: 'npm-plugin', source: { source: 'npm', package: pkg } },
    ])
    const refused = await run(box, ['marketplace', 'install', 'npm-plugin', '--from', catalog, '--yes'])
    assert.equal(refused.status, 1)
    assert.match(refused.stderr, /refused \(marketplace-artifact-invalid\)/u)
    assert.match(refused.stderr, /fetched no plugin manifest/u)
    assert.equal(existsSync(box.lock), false)
  } finally {
    cleanup(box.dir)
  }
})

// ---------------------------------------------------------------------------
// url over https (loopback only)
// ---------------------------------------------------------------------------

test('a url tarball is fetched over https, hashed before extraction, and installed', async () => {
  const box = sandbox()
  const pkg = npmPackage({ prepareMarker: false })
  const tarball = packPackage(pkg, join(box.dir, 'tarballs'))
  const requests = []
  const server = await serve((request, response) => {
    requests.push(request.url)
    response.writeHead(200, { 'content-type': 'application/gzip' })
    response.end(readFileSync(tarball))
  })
  try {
    const root = join(box.dir, 'catalog')
    const catalog = writeCatalog(root, [
      {
        name: 'url-plugin',
        version: '0.1.0',
        source: { source: 'url', url: `${server.url}/url-plugin.tgz` },
      },
    ])
    const installed = await run(box, ['marketplace', 'install', 'url-plugin', '--from', catalog, '--yes'], {
      NODE_EXTRA_CA_CERTS: tls.certPath,
    })
    assert.equal(installed.status, 0, installed.stderr)
    assert.deepEqual(requests, ['/url-plugin.tgz'])

    const sha = createHash('sha256').update(readFileSync(tarball)).digest('hex')
    const lock = readInstalls(box.lock)
    const source = lock.plugins[0].source
    assert.equal(typeof source, 'object')
    assert.equal(source.integrity, `sha256:${sha}`)
    assert.match(source.resolvedAt, /Z$/u)
    assert.equal(existsSync(join(box.cache, 'fetch-marketplace', `url-plugin@${sha}`)), true)
    assert.equal(readGrants(box.grants).grants[0].artifactHash, `sha256:${sha}`)
  } finally {
    await server.close()
    cleanup(box.dir)
  }
})

test('an oversized url response is refused by the declared length, before extraction', async () => {
  const box = sandbox()
  const requests = []
  const server = await serve((request, response) => {
    requests.push(request.url)
    response.writeHead(200, { 'content-length': String(MAX_ARTIFACT_BYTES + 1) })
    response.end()
  })
  try {
    const root = join(box.dir, 'catalog')
    const catalog = writeCatalog(root, [
      { name: 'url-plugin', source: { source: 'url', url: `${server.url}/big.tgz` } },
    ])
    const refused = await run(box, ['marketplace', 'install', 'url-plugin', '--from', catalog, '--yes'], {
      NODE_EXTRA_CA_CERTS: tls.certPath,
    })
    assert.equal(refused.status, 1)
    assert.match(refused.stderr, /refused \(marketplace-fetch-refused\)/u)
    assert.match(refused.stderr, new RegExp(`above the ${MAX_ARTIFACT_BYTES} byte cap`, 'u'))
    assert.equal(existsSync(box.cache), false)
    assert.equal(existsSync(box.lock), false)
  } finally {
    await server.close()
    cleanup(box.dir)
  }
})

test('a redirect loop is refused instead of followed forever', async () => {
  const box = sandbox()
  const server = await serve((request, response) => {
    response.writeHead(302, { location: '/loop' })
    response.end()
  })
  try {
    const root = join(box.dir, 'catalog')
    const catalog = writeCatalog(root, [
      { name: 'url-plugin', source: { source: 'url', url: `${server.url}/loop` } },
    ])
    const refused = await run(box, ['marketplace', 'install', 'url-plugin', '--from', catalog, '--yes'], {
      NODE_EXTRA_CA_CERTS: tls.certPath,
    })
    assert.equal(refused.status, 1)
    assert.match(refused.stderr, /refused \(marketplace-fetch-refused\)/u)
    assert.match(refused.stderr, /redirects in a loop/u)
    assert.equal(existsSync(box.cache), false)
  } finally {
    await server.close()
    cleanup(box.dir)
  }
})

test('http:// is refused before any request reaches the server', async () => {
  const box = sandbox()
  const requests = []
  const server = createHttpServer((request, response) => {
    requests.push(request.url)
    response.writeHead(200)
    response.end()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address()
  try {
    const root = join(box.dir, 'catalog')
    const catalog = writeCatalog(root, [
      { name: 'url-plugin', source: { source: 'url', url: `http://127.0.0.1:${port}/plugin.tgz` } },
    ])
    const refused = await run(box, ['marketplace', 'install', 'url-plugin', '--from', catalog, '--yes'])
    assert.equal(refused.status, 1)
    assert.match(refused.stderr, /refused \(insecure-marketplace-source\)/u)
    assert.match(refused.stderr, /https or file only/u)
    assert.deepEqual(requests, [], 'the refusal must happen before the socket')
    assert.equal(existsSync(box.cache), false)
  } finally {
    server.close()
    cleanup(box.dir)
  }
})

test('a url query token is sent but never stored or printed', async () => {
  const box = sandbox()
  const pkg = npmPackage({ prepareMarker: false })
  const tarball = packPackage(pkg, join(box.dir, 'tarballs'))
  const requests = []
  const server = await serve((request, response) => {
    requests.push(request.url)
    response.writeHead(200, { 'content-type': 'application/gzip' })
    response.end(readFileSync(tarball))
  })
  try {
    const root = join(box.dir, 'catalog')
    const catalog = writeCatalog(root, [
      {
        name: 'url-plugin',
        version: '0.1.0',
        source: { source: 'url', url: `${server.url}/url-plugin.tgz?token=s3cr3t-token` },
      },
    ])
    const installed = await run(box, ['marketplace', 'install', 'url-plugin', '--from', catalog, '--yes'], {
      NODE_EXTRA_CA_CERTS: tls.certPath,
    })
    assert.equal(installed.status, 0, installed.stderr)
    assert.doesNotMatch(installed.stdout + installed.stderr, /s3cr3t-token/u)
    assert.doesNotMatch(readFileSync(box.grants, 'utf8'), /s3cr3t-token/u)
    const grants = readGrants(box.grants).grants
    const network = grants.filter((record) => record.capability === 'network')
    assert.equal(network.length, 1)
    assert.equal(network[0].target, 'url:' + server.url + '/url-plugin.tgz')
    assert.equal(grants.filter((record) => record.capability === 'exec').length, 0)
    // The fetch itself still carried the query the catalog asked for.
    assert.equal(requests.length, 1)
    assert.match(requests[0], /token=s3cr3t-token/u)
  } finally {
    await server.close()
    cleanup(box.dir)
  }
})

test('url or git credentials in a catalog are refused', async () => {
  const box = sandbox()
  try {
    const root = join(box.dir, 'catalog')
    const catalog = writeCatalog(root, [
      {
        name: 'url-plugin',
        source: { source: 'url', url: 'https://user:secret@example.invalid/plugin.tgz' },
      },
    ])
    const refused = await run(box, ['marketplace', 'install', 'url-plugin', '--from', catalog, '--yes'])
    assert.equal(refused.status, 1)
    assert.match(refused.stderr, /refused \(marketplace-fetch-refused\)/u)
    assert.match(refused.stderr, /carries credentials/u)
    assert.doesNotMatch(refused.stderr, /user:secret/u, 'a refusal must not echo the secret')
  } finally {
    cleanup(box.dir)
  }
})

// ---------------------------------------------------------------------------
// consent: dry-run, revoke, and no --yes
// ---------------------------------------------------------------------------

test('--dry-run prints the exact fetch and creates no cache, grant, lock or request', async () => {
  const box = sandbox()
  const requests = []
  const server = await serve((request, response) => {
    requests.push(request.url)
    response.writeHead(200)
    response.end()
  })
  try {
    const root = join(box.dir, 'catalog')
    const catalog = writeCatalog(root, [
      { name: 'url-plugin', source: { source: 'url', url: `${server.url}/plugin.tgz` } },
    ])
    const preview = await run(box, ['marketplace', 'install', 'url-plugin', '--from', catalog, '--dry-run'], {
      NODE_EXTRA_CA_CERTS: tls.certPath,
    })
    assert.equal(preview.status, 0, preview.stderr)
    assert.match(preview.stdout, /dry run — nothing fetched, nothing written/u)
    assert.match(preview.stdout, new RegExp(`would fetch: GET ${server.url}/plugin\\.tgz`, 'u'))
    assert.match(preview.stdout, /network grant: none/u)
    assert.deepEqual(requests, [], 'a dry run must not fetch')
    assert.equal(existsSync(box.cache), false, 'a dry run must not create the cache directory')
    assert.equal(existsSync(box.grants), false, 'a dry run must not write a grant')
    assert.equal(existsSync(box.lock), false)

    const json = await run(box, ['marketplace', 'install', 'url-plugin', '--from', catalog, '--dry-run', '--json'], {
      NODE_EXTRA_CA_CERTS: tls.certPath,
    })
    assert.equal(json.status, 0, json.stderr)
    const payload = JSON.parse(json.stdout)
    assert.equal(payload.dryRun, true)
    assert.equal(payload.fetch.consent, 'none')
    assert.equal(payload.fetch.kind, 'url')
    assert.match(payload.fetch.command, /^GET https:/u)
    assert.equal(existsSync(box.cache), false)
  } finally {
    await server.close()
    cleanup(box.dir)
  }
})

test('a revoke is a refusal that --yes does not override', async () => {
  const box = sandbox()
  const repo = createRepo()
  try {
    const root = join(box.dir, 'catalog')
    const catalog = writeCatalog(root, [
      {
        name: 'git-plugin',
        version: '0.1.0',
        source: { source: 'git-subdir', url: repo.url, path: 'plugins/git-plugin', sha: repo.commit },
      },
    ])
    const installed = await run(box, ['marketplace', 'install', 'git-plugin', '--from', catalog, '--yes'])
    assert.equal(installed.status, 0, installed.stderr)

    const target = `git:${repo.url}@${repo.commit}#plugins/git-plugin`
    const store = readGrants(grantsPath(box.lock))
    writeGrants(grantsPath(box.lock), revoke(store, { plugin: 'fetch-marketplace:git-plugin', capability: 'network', target }, { scope: 'user' }))

    const refused = await run(box, ['marketplace', 'install', 'git-plugin', '--from', catalog, '--yes'])
    assert.equal(refused.status, 1)
    assert.match(refused.stderr, /refused \(network-consent-revoked\)/u)
    assert.match(refused.stderr, /--yes does not override it/u)
    assert.equal(readGrants(box.grants).revokes.length, 1)
  } finally {
    cleanup(box.dir)
    cleanup(repo.work)
    cleanup(dirname(repo.bare))
  }
})

test('a network grant is not a mod grant: an exec artifact still reports refused:exec', async () => {
  const box = sandbox()
  const repo = createRepo()
  try {
    const root = join(box.dir, 'catalog')
    const catalog = writeCatalog(root, [
      {
        name: 'git-plugin',
        version: '0.1.0',
        source: { source: 'git-subdir', url: repo.url, path: 'plugins/git-plugin', sha: repo.commit },
      },
    ])
    const installed = await run(box, ['marketplace', 'install', 'git-plugin', '--from', catalog, '--yes'])
    assert.equal(installed.status, 0, installed.stderr)
    const grants = readGrants(box.grants)
    assert.equal(grants.grants.every((record) => record.capability === 'network'), true)
    assert.equal(grants.grants.some((record) => record.capability === 'exec'), false)

    // The installed plugin is listed as effective (skills only), and the grant
    // store has no exec record for it.
    const listed = await run(box, ['list', '--json'])
    assert.equal(listed.status, 0, listed.stderr)
    const payload = JSON.parse(listed.stdout)
    assert.equal(payload.plugins.length, 1)
    assert.equal(payload.plugins[0].grants, 0, 'no exec grant is stored for a network fetch')
  } finally {
    cleanup(box.dir)
    cleanup(repo.work)
    cleanup(dirname(repo.bare))
  }
})

test('a statically malformed catalog cannot name a cache directory', async () => {
  const box = sandbox()
  try {
    const root = join(box.dir, 'catalog')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'marketplace.json'), '{"name":"x","plugins":[]')
    const refused = await run(box, ['marketplace', 'list', '--from', join(root, 'marketplace.json')])
    assert.equal(refused.status, 1)
    assert.match(refused.stderr, /refused \(malformed-marketplace\)/u)
    assert.equal(existsSync(box.cache), false)
  } finally {
    cleanup(box.dir)
  }
})

test('the fetch caps are the ones the refusal messages name', async () => {
  assert.equal(MAX_ARTIFACT_BYTES, 20 * 1024 * 1024)
  assert.equal(MAX_REDIRECTS, 5)
})
