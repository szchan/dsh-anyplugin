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
  symlinkSync,
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

function writeCodexCatalog(root, entries, name = 'codex-fetch') {
  mkdirSync(join(root, '.agents', 'plugins'), { recursive: true })
  writeFileSync(
    join(root, '.agents', 'plugins', 'marketplace.json'),
    `${JSON.stringify({ name, plugins: entries }, null, 2)}\n`,
  )
  return join(root, '.agents', 'plugins', 'marketplace.json')
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

function npmPackage({ prepareMarker = true, plugin = true, pluginName = 'npm-plugin' } = {}) {
  const dir = tempDir('npm-pkg-')
  const scripts = prepareMarker
    ? { prepare: `node -e "require('fs').writeFileSync(require('path').join(process.cwd(),'prepare-marker'),'x')"` }
    : {}
  writeFileSync(
    join(dir, 'package.json'),
    `${JSON.stringify({ name: 'npm-fixture', version: '0.1.0', private: true, scripts }, null, 2)}\n`,
  )
  if (plugin) writePlugin(dir, pluginName, '0.1.0')
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
    port,
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
    const cache = join(box.cache, 'fetch-marketplace')
    assert.deepEqual(existsSync(cache) ? readdirSync(cache) : [], [])
  } finally {
    cleanup(box.dir)
  }
})

// ---------------------------------------------------------------------------
// url over https (loopback only)
// ---------------------------------------------------------------------------

test('a url tarball is fetched over https, hashed before extraction, and installed', async () => {
  const box = sandbox()
  const pkg = npmPackage({ prepareMarker: false, pluginName: 'url-plugin' })
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

test('a fetched plugin name mismatch is refused before the cache commit', async () => {
  const box = sandbox()
  const pkg = npmPackage({ prepareMarker: false, pluginName: 'actual' })
  const tarball = packPackage(pkg, join(box.dir, 'tarballs'))
  const server = await serve((request, response) => {
    response.writeHead(200, { 'content-type': 'application/gzip' })
    response.end(readFileSync(tarball))
  })
  try {
    const root = join(box.dir, 'catalog')
    const catalog = writeCatalog(root, [
      {
        name: 'expected',
        version: '0.1.0',
        source: { source: 'url', url: `${server.url}/expected.tgz` },
      },
    ])
    const refused = await run(box, ['marketplace', 'install', 'expected', '--from', catalog, '--yes'], {
      NODE_EXTRA_CA_CERTS: tls.certPath,
    })
    assert.equal(refused.status, 1)
    assert.match(refused.stderr, /refused \(name-mismatch\)/u)
    assert.match(refused.stderr, /fetched a plugin that calls itself "actual"/u)
    assert.equal(existsSync(box.lock), false)
    // The name is checked before `commitArtifact`: no cache entry may exist.
    const cache = join(box.cache, 'fetch-marketplace')
    const entries = existsSync(cache) ? readdirSync(cache) : []
    assert.deepEqual(entries, [])
  } finally {
    await server.close()
    cleanup(box.dir)
  }
})

test('a Codex url entry installs through the same grant and records dialect codex', async () => {
  const box = sandbox()
  const pkg = npmPackage({ prepareMarker: false, pluginName: 'url-plugin' })
  // The same tarball carries the portable manifest Codex reads; the fetch
  // machinery must not care which format named it.
  writeFileSync(
    join(pkg, 'plugin.json'),
    `${JSON.stringify({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
      name: 'url-plugin',
      version: '0.1.0',
      description: 'A Codex plugin fetched from a url source.',
    })}\n`,
  )
  const tarball = packPackage(pkg, join(box.dir, 'tarballs'))
  const server = await serve((request, response) => {
    response.writeHead(200, { 'content-type': 'application/gzip' })
    response.end(readFileSync(tarball))
  })
  try {
    const root = join(box.dir, 'catalog')
    mkdirSync(join(root, '.agents', 'plugins'), { recursive: true })
    const catalog = join(root, '.agents', 'plugins', 'marketplace.json')
    writeFileSync(
      catalog,
      `${JSON.stringify({
        name: 'codex-fetch',
        plugins: [
          {
            name: 'url-plugin',
            category: 'testing',
            policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
            source: { source: 'url', url: `${server.url}/url-plugin.tgz` },
          },
        ],
      })}\n`,
    )
    const installed = await run(box, ['marketplace', 'install', 'url-plugin', '--from', catalog, '--yes'], {
      NODE_EXTRA_CA_CERTS: tls.certPath,
    })
    assert.equal(installed.status, 0, installed.stderr)
    const sha = createHash('sha256').update(readFileSync(tarball)).digest('hex')
    const record = readInstalls(box.lock).plugins[0]
    assert.equal(record.dialect, 'codex')
    assert.equal(record.pin, 'agent-plugins@1.0.0')
    assert.equal(record.source.integrity, `sha256:${sha}`)
    assert.equal(existsSync(join(box.cache, 'codex-fetch', `url-plugin@${sha}`)), true)
    const network = readGrants(box.grants).grants.filter((row) => row.capability === 'network')
    assert.equal(network.length, 1)
    assert.equal(network[0].artifactHash, `sha256:${sha}`)
  } finally {
    await server.close()
    cleanup(box.dir)
  }
})

test('a Codex entry reads the Codex manifest, not a Claude manifest beside it', async () => {
  const box = sandbox()
  // Both manifests coexist. The catalog entry matches the Claude one, so a
  // dialect-blind check would accept it; Codex reads the root manifest.
  const pkg = npmPackage({ prepareMarker: false, pluginName: 'expected' })
  writeFileSync(
    join(pkg, 'plugin.json'),
    `${JSON.stringify({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
      name: 'actual',
      version: '0.1.0',
      description: 'The manifest Codex reads.',
    })}\n`,
  )
  const tarball = packPackage(pkg, join(box.dir, 'tarballs'))
  const server = await serve((request, response) => {
    response.writeHead(200, { 'content-type': 'application/gzip' })
    response.end(readFileSync(tarball))
  })
  try {
    const root = join(box.dir, 'catalog')
    const catalog = writeCodexCatalog(
      root,
      [
        {
          name: 'expected',
          category: 'testing',
          policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
          source: { source: 'url', url: `${server.url}/expected.tgz` },
        },
      ],
      'dual-market',
    )
    const refused = await run(box, ['marketplace', 'install', 'expected', '--from', catalog, '--yes'], {
      NODE_EXTRA_CA_CERTS: tls.certPath,
    })
    assert.equal(refused.status, 1)
    assert.match(refused.stderr, /refused \(name-mismatch\)/u)
    assert.match(refused.stderr, /fetched a plugin that calls itself "actual"/u)
    // The mismatch is detected before `commitArtifact`: the cache is empty.
    const cache = join(box.cache, 'dual-market')
    assert.deepEqual(existsSync(cache) ? readdirSync(cache) : [], [])
    assert.equal(existsSync(box.lock), false)
  } finally {
    await server.close()
    cleanup(box.dir)
  }
})

test('a malformed manifest the dialect does not read cannot skip the name check', async () => {
  const box = sandbox()
  const pkg = npmPackage({ prepareMarker: false, pluginName: 'actual' })
  // Codex reads the root manifest; the malformed Claude manifest is foreign.
  writeFileSync(join(pkg, '.claude-plugin', 'plugin.json'), '{ this is not json\n')
  writeFileSync(
    join(pkg, 'plugin.json'),
    `${JSON.stringify({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
      name: 'actual',
      version: '0.1.0',
      description: 'The manifest Codex reads.',
    })}\n`,
  )
  const tarball = packPackage(pkg, join(box.dir, 'tarballs'))
  const server = await serve((request, response) => {
    response.writeHead(200, { 'content-type': 'application/gzip' })
    response.end(readFileSync(tarball))
  })
  try {
    const root = join(box.dir, 'catalog')
    const catalog = writeCodexCatalog(
      root,
      [
        {
          name: 'expected',
          category: 'testing',
          policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
          source: { source: 'url', url: `${server.url}/expected.tgz` },
        },
      ],
      'malformed-foreign',
    )
    const refused = await run(box, ['marketplace', 'install', 'expected', '--from', catalog, '--yes'], {
      NODE_EXTRA_CA_CERTS: tls.certPath,
    })
    assert.equal(refused.status, 1)
    assert.match(refused.stderr, /refused \(name-mismatch\)/u)
    const cache = join(box.cache, 'malformed-foreign')
    assert.deepEqual(existsSync(cache) ? readdirSync(cache) : [], [])
  } finally {
    await server.close()
    cleanup(box.dir)
  }
})

test('a Codex entry installs when its Claude sibling manifest disagrees', async () => {
  const box = sandbox()
  const pkg = npmPackage({ prepareMarker: false, pluginName: 'other' })
  writeFileSync(
    join(pkg, 'plugin.json'),
    `${JSON.stringify({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
      name: 'expected',
      version: '0.1.0',
      description: 'The manifest Codex reads.',
    })}\n`,
  )
  const tarball = packPackage(pkg, join(box.dir, 'tarballs'))
  const server = await serve((request, response) => {
    response.writeHead(200, { 'content-type': 'application/gzip' })
    response.end(readFileSync(tarball))
  })
  try {
    const root = join(box.dir, 'catalog')
    const catalog = writeCodexCatalog(
      root,
      [
        {
          name: 'expected',
          category: 'testing',
          policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
          source: { source: 'url', url: `${server.url}/expected.tgz` },
        },
      ],
      'sibling-disagrees',
    )
    const installed = await run(box, ['marketplace', 'install', 'expected', '--from', catalog, '--yes'], {
      NODE_EXTRA_CA_CERTS: tls.certPath,
    })
    assert.equal(installed.status, 0, installed.stderr)
    assert.equal(readInstalls(box.lock).plugins[0].dialect, 'codex')
  } finally {
    await server.close()
    cleanup(box.dir)
  }
})

test('a Codex pre-check uses the selected root manifest and falls back to the directory name', async () => {
  const box = sandbox()
  const pkg = npmPackage({ prepareMarker: false, plugin: false })
  mkdirSync(join(pkg, '.codex-plugin'), { recursive: true })
  // The root exists but has no name, so the reader uses the directory name and
  // never reads the shadowed `.codex-plugin` manifest that names the entry.
  writeFileSync(join(pkg, 'plugin.json'), `${JSON.stringify({ version: '0.1.0' })}\n`)
  writeFileSync(
    join(pkg, '.codex-plugin', 'plugin.json'),
    `${JSON.stringify({ name: 'expected', version: '0.1.0' })}\n`,
  )
  const tarball = packPackage(pkg, join(box.dir, 'tarballs'))
  const server = await serve((request, response) => {
    response.writeHead(200, { 'content-type': 'application/gzip' })
    response.end(readFileSync(tarball))
  })
  try {
    const root = join(box.dir, 'catalog')
    const catalog = writeCodexCatalog(
      root,
      [
        {
          name: 'expected',
          category: 'testing',
          policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
          source: { source: 'url', url: `${server.url}/expected.tgz` },
        },
      ],
      'nameless-root',
    )
    const refused = await run(box, ['marketplace', 'install', 'expected', '--from', catalog, '--yes'], {
      NODE_EXTRA_CA_CERTS: tls.certPath,
    })
    assert.equal(refused.status, 1)
    assert.match(refused.stderr, /refused \(name-mismatch\)/u)
    assert.match(refused.stderr, /fetched a plugin that calls itself "package"/u)
    const cache = join(box.cache, 'nameless-root')
    assert.deepEqual(existsSync(cache) ? readdirSync(cache) : [], [])
  } finally {
    await server.close()
    cleanup(box.dir)
  }
})

test('a malformed selected Codex manifest falls back to the directory name before the cache commit', async () => {
  const box = sandbox()
  const pkg = npmPackage({ prepareMarker: false, plugin: false })
  mkdirSync(join(pkg, '.codex-plugin'), { recursive: true })
  writeFileSync(join(pkg, 'plugin.json'), '{ this is not json\n')
  writeFileSync(
    join(pkg, '.codex-plugin', 'plugin.json'),
    `${JSON.stringify({ name: 'expected', version: '0.1.0' })}\n`,
  )
  const tarball = packPackage(pkg, join(box.dir, 'tarballs'))
  const server = await serve((request, response) => {
    response.writeHead(200, { 'content-type': 'application/gzip' })
    response.end(readFileSync(tarball))
  })
  try {
    const root = join(box.dir, 'catalog')
    const catalog = writeCodexCatalog(
      root,
      [
        {
          name: 'expected',
          category: 'testing',
          policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
          source: { source: 'url', url: `${server.url}/expected.tgz` },
        },
      ],
      'malformed-root',
    )
    const refused = await run(box, ['marketplace', 'install', 'expected', '--from', catalog, '--yes'], {
      NODE_EXTRA_CA_CERTS: tls.certPath,
    })
    assert.equal(refused.status, 1)
    assert.match(refused.stderr, /refused \(name-mismatch\)/u)
    assert.match(refused.stderr, /fetched a plugin that calls itself "package"/u)
    const cache = join(box.cache, 'malformed-root')
    assert.deepEqual(existsSync(cache) ? readdirSync(cache) : [], [])
  } finally {
    await server.close()
    cleanup(box.dir)
  }
})

test('a Codex plugin with only the .codex-plugin fallback installs', async () => {
  const box = sandbox()
  const pkg = npmPackage({ prepareMarker: false, plugin: false })
  mkdirSync(join(pkg, '.codex-plugin'), { recursive: true })
  mkdirSync(join(pkg, 'skills', 'hello'), { recursive: true })
  writeFileSync(
    join(pkg, '.codex-plugin', 'plugin.json'),
    `${JSON.stringify({ name: 'expected', version: '0.1.0', description: 'Fallback-only manifest.' })}\n`,
  )
  writeFileSync(join(pkg, 'skills', 'hello', 'SKILL.md'), '---\nname: hello\n---\n\nSay hello.\n')
  const tarball = packPackage(pkg, join(box.dir, 'tarballs'))
  const server = await serve((request, response) => {
    response.writeHead(200, { 'content-type': 'application/gzip' })
    response.end(readFileSync(tarball))
  })
  try {
    const root = join(box.dir, 'catalog')
    const catalog = writeCodexCatalog(
      root,
      [
        {
          name: 'expected',
          category: 'testing',
          policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
          source: { source: 'url', url: `${server.url}/expected.tgz` },
        },
      ],
      'fallback-only',
    )
    const installed = await run(box, ['marketplace', 'install', 'expected', '--from', catalog, '--yes'], {
      NODE_EXTRA_CA_CERTS: tls.certPath,
    })
    assert.equal(installed.status, 0, installed.stderr)
    const record = readInstalls(box.lock).plugins[0]
    assert.equal(record.dialect, 'codex')
    assert.equal(record.name, 'expected')
    assert.equal(record.version, '0.1.0')
  } finally {
    await server.close()
    cleanup(box.dir)
  }
})

test('a shadowed Codex manifest cannot supply the recorded version', async () => {
  const box = sandbox()
  const pkg = npmPackage({ prepareMarker: false, plugin: false })
  mkdirSync(join(pkg, '.codex-plugin'), { recursive: true })
  // The selected root has no version; the reader refuses for that reason. The
  // fetched metadata must not borrow the shadowed fallback's version either.
  writeFileSync(join(pkg, 'plugin.json'), `${JSON.stringify({ name: 'expected' })}\n`)
  writeFileSync(
    join(pkg, '.codex-plugin', 'plugin.json'),
    `${JSON.stringify({ name: 'expected', version: '9.9.9' })}\n`,
  )
  const tarball = packPackage(pkg, join(box.dir, 'tarballs'))
  const sha = createHash('sha256').update(readFileSync(tarball)).digest('hex')
  const server = await serve((request, response) => {
    response.writeHead(200, { 'content-type': 'application/gzip' })
    response.end(readFileSync(tarball))
  })
  try {
    const root = join(box.dir, 'catalog')
    const catalog = writeCodexCatalog(
      root,
      [
        {
          name: 'expected',
          category: 'testing',
          policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
          source: { source: 'url', url: `${server.url}/expected.tgz` },
        },
      ],
      'version-shadow',
    )
    const refused = await run(box, ['marketplace', 'install', 'expected', '--from', catalog, '--yes'], {
      NODE_EXTRA_CA_CERTS: tls.certPath,
    })
    assert.equal(refused.status, 1)
    assert.match(refused.stderr, /refused \(missing-version\)/u)
    const metadata = JSON.parse(
      readFileSync(join(box.cache, 'version-shadow', `expected@${sha}`, '.dsh-anyplugin-artifact.json'), 'utf8'),
    )
    assert.equal(metadata.version, undefined)
  } finally {
    await server.close()
    cleanup(box.dir)
  }
})

test('a remote --dialect mismatch names the layout before the reader runs', async () => {
  const box = sandbox()
  const pkg = npmPackage({ prepareMarker: false, plugin: false })
  writeFileSync(
    join(pkg, 'plugin.json'),
    `${JSON.stringify({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
      name: 'expected',
      version: '0.1.0',
      description: 'A Codex-only plugin.',
    })}\n`,
  )
  mkdirSync(join(pkg, 'skills', 'hello'), { recursive: true })
  writeFileSync(join(pkg, 'skills', 'hello', 'SKILL.md'), '---\nname: hello\n---\n\nSay hello.\n')
  const tarball = packPackage(pkg, join(box.dir, 'tarballs'))
  const sha = createHash('sha256').update(readFileSync(tarball)).digest('hex')
  const server = await serve((request, response) => {
    response.writeHead(200, { 'content-type': 'application/gzip' })
    response.end(readFileSync(tarball))
  })
  try {
    const root = join(box.dir, 'catalog')
    const catalog = writeCodexCatalog(
      root,
      [
        {
          // The fetched directory is named "package", so this entry name keeps
          // the dialect-blind identity check neutral and the test reaches the
          // remote assertDialect call it is meant to pin.
          name: 'package',
          category: 'testing',
          policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
          source: { source: 'url', url: `${server.url}/expected.tgz` },
        },
      ],
      'remote-dialect',
    )
    const refused = await run(
      box,
      ['marketplace', 'install', 'package', '--from', catalog, '--yes', '--dialect', 'claude-code'],
      { NODE_EXTRA_CA_CERTS: tls.certPath },
    )
    assert.equal(refused.status, 1)
    assert.match(refused.stderr, /refused \(dialect-mismatch\)/u)
    assert.match(refused.stderr, /declares a codex plugin/u)
    assert.equal(existsSync(box.lock), false)
    // D65 clause 4: a dialect refusal is install-time, after the fetch. The
    // cache keeps the artifact and its metadata; only the lock stays absent.
    const cached = join(box.cache, 'remote-dialect', `package@${sha}`)
    assert.equal(existsSync(join(cached, '.dsh-anyplugin-artifact.json')), true)
    assert.equal(existsSync(join(cached, 'package', 'plugin.json')), true)
    assert.equal(existsSync(join(cached, 'package', 'skills', 'hello', 'SKILL.md')), true)
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
  const pkg = npmPackage({ prepareMarker: false, pluginName: 'url-plugin' })
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
    assert.equal(network[0].target.startsWith('url:' + server.url + '/url-plugin.tgz#q='), true)
    assert.match(network[0].target, /#q=[0-9a-f]{16}$/u)
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
    assert.match(preview.stdout, /integrity: unknown — a dry run fetches nothing/u)
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

test('a redirect carrying credentials is refused before the hop', async () => {
  const box = sandbox()
  const requests = []
  const server = await serve((request, response) => {
    requests.push({ url: request.url, authorization: request.headers.authorization ?? null })
    if (request.url === '/cred') {
      response.writeHead(302, { location: `https://user:pw@127.0.0.1:${server.port}/same.tgz` })
      response.end()
      return
    }
    response.writeHead(200, { 'content-type': 'application/gzip' })
    response.end()
  })
  try {
    const catalog = writeCatalog(join(box.dir, 'catalog'), [
      { name: 'url-plugin', source: { source: 'url', url: server.url + '/cred' } },
    ])
    const refused = await run(box, ['marketplace', 'install', 'url-plugin', '--from', catalog, '--yes'], {
      NODE_EXTRA_CA_CERTS: tls.certPath,
    })
    assert.equal(refused.status, 1)
    assert.match(refused.stderr, /marketplace-fetch-refused/u)
    assert.match(refused.stderr, /redirected to a URL carrying credentials/u)
    assert.doesNotMatch(refused.stderr, /user:pw/u, 'the refusal must not echo the credentials')
    assert.deepEqual(
      requests.map((request) => request.url),
      ['/cred'],
      'the hop carrying credentials must never be requested',
    )
    assert.equal(requests[0].authorization, null)
    assert.equal(existsSync(box.cache), false, 'a refused hop writes no artifact')
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
    mkdirSync(join(root, '.claude-plugin'), { recursive: true })
    writeFileSync(join(root, '.claude-plugin', 'marketplace.json'), '{"name":"x","plugins":[]')
    const refused = await run(box, ['marketplace', 'list', '--from', join(root, '.claude-plugin', 'marketplace.json')])
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


// ---------------------------------------------------------------------------
// review round: option-shaped refs, query identity, origin pinning, redaction,
// symlinks, cache re-hashing, grant-after-install, network revoke
// ---------------------------------------------------------------------------

test('a git ref that looks like an option is refused before git runs', async () => {
  const box = sandbox()
  const repo = createRepo()
  const marker = join(box.dir, 'RIG-RCE')
  const tick = String.fromCharCode(96)
  const payload = '--upload-pack=' + tick + 'touch$' + '{IFS}' + marker + tick + 'sh'
  try {
    const root = join(box.dir, 'catalog')
    const catalog = writeCatalog(root, [
      {
        name: 'git-plugin',
        source: { source: 'git-subdir', url: repo.url, path: 'plugins/git-plugin', ref: payload },
      },
    ])
    const refused = await run(box, ['marketplace', 'install', 'git-plugin', '--from', catalog, '--yes'])
    assert.equal(refused.status, 1)
    assert.match(refused.stderr, /source\.ref .* is not a plain git ref/u)
    assert.equal(existsSync(marker), false, 'the ref payload must never reach a shell')
    assert.equal(existsSync(box.cache), false)
    // A bare option-shaped ref passes the character grammar, so the leading
    // "-" rule is the only thing that refuses it before git sees the ref.
    const optionCatalog = writeCatalog(join(box.dir, 'catalog-option'), [
      { name: 'git-plugin', source: { source: 'git-subdir', url: repo.url, path: 'plugins/git-plugin', ref: '--upload-pack' } },
    ])
    const option = await run(box, ['marketplace', 'install', 'git-plugin', '--from', optionCatalog, '--yes'])
    assert.equal(option.status, 1)
    assert.match(option.stderr, /source\.ref .* is not a plain git ref/u)
  } finally {
    cleanup(box.dir)
  }
})

test('a query string is part of the grant identity, not display-only', async () => {
  const box = sandbox()
  const pkg = npmPackage({ prepareMarker: false, pluginName: 'url-plugin' })
  const tarball = packPackage(pkg, join(box.dir, 'tarballs'))
  const requests = []
  const server = await serve((request, response) => {
    requests.push(request.url)
    response.writeHead(200, { 'content-type': 'application/gzip' })
    response.end(readFileSync(tarball))
  })
  try {
    const first = writeCatalog(join(box.dir, 'one'), [
      { name: 'url-plugin', source: { source: 'url', url: server.url + '/url-plugin.tgz?token=one' } },
    ])
    const installed = await run(box, ['marketplace', 'install', 'url-plugin', '--from', first, '--yes'], {
      NODE_EXTRA_CA_CERTS: tls.certPath,
    })
    assert.equal(installed.status, 0, installed.stderr)
    const network = readGrants(box.grants).grants.filter((record) => record.capability === 'network')
    assert.equal(network.length, 1)
    assert.match(network[0].target, /#q=[0-9a-f]{16}$/u)
    const second = writeCatalog(join(box.dir, 'two'), [
      { name: 'url-plugin', source: { source: 'url', url: server.url + '/url-plugin.tgz?token=two' } },
    ])
    const refused = await run(box, ['marketplace', 'install', 'url-plugin', '--from', second], {
      NODE_EXTRA_CA_CERTS: tls.certPath,
    })
    assert.equal(refused.status, 1)
    assert.match(refused.stderr, /network-consent-required/u)
    assert.equal(requests.length, 1, 'consent for ?token=one must not fetch ?token=two')
    assert.equal(readGrants(box.grants).grants.length, 1)
    const preview = await run(box, ['marketplace', 'install', 'url-plugin', '--from', first, '--dry-run', '--json'], {
      NODE_EXTRA_CA_CERTS: tls.certPath,
    })
    assert.equal(preview.status, 0, preview.stderr)
    const plan = JSON.parse(preview.stdout).fetch
    assert.equal(plan.consent, 'granted')
    assert.equal(plan.integrity, 'unknown', 'a dry run cannot verify the current bytes')
    assert.equal(plan.pinnedIntegrity, network[0].artifactHash)
    assert.equal(requests.length, 1, 'the dry run after a grant still fetches nothing')
  } finally {
    await server.close()
    cleanup(box.dir)
  }
})

test('a cross-origin redirect is refused before the second origin is contacted', async () => {
  const box = sandbox()
  const pkg = npmPackage({ prepareMarker: false, pluginName: 'url-plugin' })
  const tarball = packPackage(pkg, join(box.dir, 'tarballs'))
  const secondRequests = []
  const second = await serve((request, response) => {
    secondRequests.push(request.url)
    response.writeHead(200)
    response.end()
  })
  const first = await serve((request, response) => {
    response.writeHead(302, { location: second.url + '/url-plugin.tgz' })
    response.end()
  })
  try {
    const catalog = writeCatalog(join(box.dir, 'catalog'), [
      { name: 'url-plugin', source: { source: 'url', url: first.url + '/url-plugin.tgz' } },
    ])
    const refused = await run(box, ['marketplace', 'install', 'url-plugin', '--from', catalog, '--yes'], {
      NODE_EXTRA_CA_CERTS: tls.certPath,
    })
    assert.equal(refused.status, 1)
    assert.match(refused.stderr, /redirected to a different origin/u)
    assert.deepEqual(secondRequests, [])
    assert.equal(existsSync(box.cache), false)
  } finally {
    await first.close()
    await second.close()
    cleanup(box.dir)
  }
})

test('--json and list output never print a query token', async () => {
  const box = sandbox()
  const pkg = npmPackage({ prepareMarker: false, pluginName: 'url-plugin' })
  const tarball = packPackage(pkg, join(box.dir, 'tarballs'))
  const server = await serve((request, response) => {
    response.writeHead(200, { 'content-type': 'application/gzip' })
    response.end(readFileSync(tarball))
  })
  try {
    const catalog = writeCatalog(join(box.dir, 'catalog'), [
      { name: 'url-plugin', source: { source: 'url', url: server.url + '/url-plugin.tgz?token=S3CRET&sig=ABC' } },
      // Catalog rows with userinfo must be redacted before either output mode
      // prints them; this entry is never installed.
      { name: 'credential-plugin', source: { source: 'url', url: 'https://user:s3cr3t@example.invalid/x.tgz' } },
    ])
    const listJson = await run(box, ['marketplace', 'list', '--from', catalog, '--json'])
    assert.equal(listJson.status, 0, listJson.stderr)
    assert.doesNotMatch(listJson.stdout, /S3CRET|ABC|s3cr3t/u)
    const listed = JSON.parse(listJson.stdout)
    const credential = listed.entries.find((entry) => entry.name === 'credential-plugin')
    assert.equal(credential.source.url, 'https://example.invalid/x.tgz')
    const listText = await run(box, ['marketplace', 'list', '--from', catalog])
    assert.doesNotMatch(listText.stdout + listText.stderr, /S3CRET|ABC|s3cr3t/u)
    const preview = await run(box, ['marketplace', 'install', 'url-plugin', '--from', catalog, '--dry-run', '--json'])
    assert.equal(preview.status, 0, preview.stderr)
    assert.doesNotMatch(preview.stdout, /S3CRET|ABC/u)
    const previewText = await run(box, ['marketplace', 'install', 'url-plugin', '--from', catalog, '--dry-run'])
    assert.equal(previewText.status, 0, previewText.stderr)
    assert.doesNotMatch(previewText.stdout + previewText.stderr, /S3CRET|ABC|s3cr3t/u)
    const installed = await run(box, ['marketplace', 'install', 'url-plugin', '--from', catalog, '--yes', '--json'], {
      NODE_EXTRA_CA_CERTS: tls.certPath,
    })
    assert.equal(installed.status, 0, installed.stderr)
    assert.doesNotMatch(installed.stdout, /S3CRET|ABC/u)
    assert.doesNotMatch(readFileSync(box.grants, 'utf8'), /S3CRET|ABC/u)
    assert.doesNotMatch(readFileSync(box.lock, 'utf8'), /S3CRET|ABC/u)
  } finally {
    await server.close()
    cleanup(box.dir)
  }
})

test('a git artifact with a symbolic link is refused like a tar link', async () => {
  const box = sandbox()
  const repo = createRepo()
  try {
    symlinkSync('skills/hello/SKILL.md', join(repo.plugin, 'linked.md'))
    git(repo.work, ['add', '.'])
    git(repo.work, ['commit', '-m', 'link'])
    git(repo.work, ['push', repo.bare, 'main'])
    const catalog = writeCatalog(join(box.dir, 'catalog'), [
      { name: 'git-plugin', source: { source: 'git-subdir', url: repo.url, path: 'plugins/git-plugin', ref: 'main' } },
    ])
    const refused = await run(box, ['marketplace', 'install', 'git-plugin', '--from', catalog, '--yes'])
    assert.equal(refused.status, 1)
    assert.match(refused.stderr, /symbolic link/u)
    // The marketplace cache parent exists because the fetch workspace is made
    // inside it; no artifact may be committed for a refused git checkout.
    assert.deepEqual(readdirSync(join(box.cache, 'fetch-marketplace')), [])
  } finally {
    cleanup(box.dir)
  }
})

test('a tampered cache entry is re-fetched instead of trusted by metadata', async () => {
  const box = sandbox()
  const repo = createRepo()
  try {
    const catalog = writeCatalog(join(box.dir, 'catalog'), [
      {
        name: 'git-plugin',
        source: { source: 'git-subdir', url: repo.url, path: 'plugins/git-plugin', sha: repo.commit },
      },
    ])
    const first = await run(box, ['marketplace', 'install', 'git-plugin', '--from', catalog, '--yes'])
    assert.equal(first.status, 0, first.stderr)
    const artifact = join(box.cache, 'fetch-marketplace', 'git-plugin@' + repo.commit)
    const skill = join(artifact, 'plugins', 'git-plugin', 'skills', 'hello', 'SKILL.md')
    writeFileSync(skill, readFileSync(skill, 'utf8') + '\ntampered\n')
    const again = await run(box, ['marketplace', 'install', 'git-plugin', '--from', catalog])
    assert.equal(again.status, 0, again.stderr)
    assert.doesNotMatch(readFileSync(skill, 'utf8'), /tampered/u)
  } finally {
    cleanup(box.dir)
  }
})

test('a fetch followed by a refused install writes no network grant', async () => {
  const box = sandbox()
  const pkg = tempDir('empty-pkg-')
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'empty-fixture', version: '0.1.0' }))
  mkdirSync(join(pkg, '.claude-plugin'), { recursive: true })
  writeFileSync(
    join(pkg, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'empty-plugin', version: '0.1.0' }),
  )
  const tarball = packPackage(pkg, join(box.dir, 'tarballs'))
  const server = await serve((request, response) => {
    response.writeHead(200, { 'content-type': 'application/gzip' })
    response.end(readFileSync(tarball))
  })
  try {
    const catalog = writeCatalog(join(box.dir, 'catalog'), [
      { name: 'empty-plugin', source: { source: 'url', url: server.url + '/empty.tgz' } },
    ])
    const refused = await run(box, ['marketplace', 'install', 'empty-plugin', '--from', catalog, '--yes'], {
      NODE_EXTRA_CA_CERTS: tls.certPath,
    })
    assert.equal(refused.status, 1)
    assert.match(refused.stderr, /nothing-declared/u)
    assert.equal(existsSync(box.cache), true, 'the fetch happened before the install refusal')
    assert.equal(existsSync(box.grants), false, 'a refused install leaves no standing consent')
  } finally {
    await server.close()
    cleanup(box.dir)
  }
})

test('a network grant is revoked by target and a later install refuses', async () => {
  const box = sandbox()
  const pkg = npmPackage({ prepareMarker: false, pluginName: 'url-plugin' })
  const tarball = packPackage(pkg, join(box.dir, 'tarballs'))
  const server = await serve((request, response) => {
    response.writeHead(200, { 'content-type': 'application/gzip' })
    response.end(readFileSync(tarball))
  })
  try {
    const catalog = writeCatalog(join(box.dir, 'catalog'), [
      { name: 'url-plugin', source: { source: 'url', url: server.url + '/url-plugin.tgz' } },
    ])
    const installed = await run(box, ['marketplace', 'install', 'url-plugin', '--from', catalog, '--yes'], {
      NODE_EXTRA_CA_CERTS: tls.certPath,
    })
    assert.equal(installed.status, 0, installed.stderr)
    const target = readGrants(box.grants).grants.find((record) => record.capability === 'network').target
    const revoked = await run(box, [
      'revoke', '--grants', box.grants,
      '--plugin-id', 'fetch-marketplace:url-plugin',
      '--target', target,
      '--capability', 'network',
    ])
    assert.equal(revoked.status, 0, revoked.stderr)
    assert.match(revoked.stdout, /revoked network grant/u)
    assert.equal(readGrants(box.grants).revokes.filter((record) => record.capability === 'network').length, 1)
    const refused = await run(box, ['marketplace', 'install', 'url-plugin', '--from', catalog], {
      NODE_EXTRA_CA_CERTS: tls.certPath,
    })
    assert.equal(refused.status, 1)
    assert.match(refused.stderr, /network-consent-revoked/u)
  } finally {
    await server.close()
    cleanup(box.dir)
  }
})
