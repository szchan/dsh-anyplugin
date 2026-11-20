// The upstream mod table (#55): every mod that ships under `mods/` at the
// pinned Claude Code commit is fetched, scanned, and loaded through the real
// host, and the observed outcome is compared with `fixtures/mods/upstream.json`
// in both directions.
//
// The table is hand-authored, not generated: a change in what a mod does must
// change this file, and a change in this file must fail unless the fetched
// bytes and the host agree. A mod that loads must have exactly the recorded
// registrations; a refusal must name the error class, the exact authored
// message, and the file:line:column frame, not merely "it threw".
//
// Sources are fetched at test time and never vendored. CI fetches the tree and
// sets ANYPLUGIN_MODS_TREE; a local run that has not fetched skips with a
// reason naming the script (AGENTS §6: tests never touch the network).
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { loadMod, ModHostError } from '../../dsh-anyplugin-mod-host/src/index.ts'
import { DIFF_MOD_PIN, UPSTREAM_MODS_PIN } from '../../dsh-anyplugin-mod-host/src/pin.ts'
import { scanModSource } from '../../dsh-anyplugin-mod-scan/src/index.ts'
import { treeSha256 } from '../../../scripts/fetch-mod.mjs'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const isCI = process.env.CI === 'true' || process.env.CI === '1'
const tablePath = join(repoRoot, 'fixtures', 'mods', 'upstream.json')
const diffFixturePath = join(repoRoot, 'fixtures', 'mods', 'diff', 'fixture.json')
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
const posix = (path) => path.split(sep).join('/')

test('the pinned upstream mods match fixtures/mods/upstream.json', async (t) => {
  const tree = process.env.ANYPLUGIN_MODS_TREE
    ? resolve(process.env.ANYPLUGIN_MODS_TREE)
    : join(repoRoot, '.mods', UPSTREAM_MODS_PIN.commit)
  const modsDir = join(tree, UPSTREAM_MODS_PIN.directory)

  if (!existsSync(modsDir)) {
    const reason =
      `ANYPLUGIN_MODS_TREE is unset or ${tree} has no ${UPSTREAM_MODS_PIN.directory}/; ` +
      'run `node scripts/fetch-mod.mjs` and set ANYPLUGIN_MODS_TREE to the printed root'
    if (isCI) {
      assert.fail(`CI must fetch the pinned upstream mods before npm test: ${reason}`)
    }
    return t.skip(reason)
  }

  const table = JSON.parse(readFileSync(tablePath, 'utf8'))
  const diffFixture = JSON.parse(readFileSync(diffFixturePath, 'utf8'))

  // ---- the pin itself ------------------------------------------------------
  assert.equal(table.pin.version, UPSTREAM_MODS_PIN.version)
  assert.equal(table.pin.commit, UPSTREAM_MODS_PIN.commit)
  assert.equal(table.pin.commit, DIFF_MOD_PIN.commit)
  assert.equal(table.pin.treeSha256, UPSTREAM_MODS_PIN.treeSha256)
  assert.equal(treeSha256(modsDir), table.pin.treeSha256, 'the fetched tree is the table tree')

  // ---- the table and the tree enumerate the same mods ----------------------
  // `types/` carries the generated `claude-code.d.ts`, the spec the pin is
  // measured against; it is not a mod. Every other directory must have a row.
  const present = readdirSync(modsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'types')
    .map((entry) => entry.name)
    .sort()
  const names = table.mods.map((row) => row.name).sort()
  assert.deepEqual(present, names, 'the fetched mod set and the table rows must be identical')
  assert.deepEqual(
    UPSTREAM_MODS_PIN.mods.map((mod) => mod.name).sort(),
    names,
    'the pin and the table must enumerate the same mods',
  )
  assert.equal(new Set(names).size, names.length, 'the table has a duplicate row')

  for (const row of table.mods) {
    const pinned = UPSTREAM_MODS_PIN.mods.find((mod) => mod.name === row.name)
    assert.ok(pinned !== undefined, `${row.name} has no entry in UPSTREAM_MODS_PIN`)

    // ---- one artifact per row ---------------------------------------------
    const entry = join(tree, row.entry)
    assert.ok(existsSync(entry), `${row.entry} is missing from ${tree}`)
    assert.equal(row.pin, table.pin.commit, `${row.name} names a different pin`)
    assert.equal(row.pin, DIFF_MOD_PIN.commit)
    assert.equal(
      row.entry,
      `${UPSTREAM_MODS_PIN.directory}/${row.name}/${pinned.entry}`,
      `${row.name} entry is not the pinned path`,
    )
    assert.equal(row.entrySha256, pinned.entrySha256, `${row.name} entry hash disagrees with the pin`)
    assert.equal(sha256(entry), row.entrySha256, `${row.name} fetched bytes are not the pinned artifact`)
    if (row.name === 'diff') {
      assert.equal(row.entrySha256, DIFF_MOD_PIN.entrySha256, 'diff evidence must stay the pinned artifact')
    }

    // ---- scan ---------------------------------------------------------------
    const scan = scanModSource(readFileSync(entry, 'utf8'), { file: row.entry })
    assert.deepEqual(
      {
        sites: scan.events.length,
        events: new Set(scan.events.map((event) => event.name)).size,
        calls: scan.calls.length,
        dynamic: scan.dynamic.length,
      },
      row.scan,
      `${row.name} scan counts differ from the table`,
    )

    // ---- load -------------------------------------------------------------
    const host = {
      dollar: () => {
        throw new Error('host.dollar() was called during register; this table observes load only')
      },
    }
    const load = { root: dirname(entry), entry: basename(entry), host }

    if (row.outcome === 'loaded') {
      assert.ok(Array.isArray(row.registrations), `${row.name} is loaded but has no registration list`)
      assert.ok(!('code' in row) && !('path' in row) && !('message' in row), `${row.name} is loaded and refused`)
      if (row.name === 'diff') {
        // The existing diff fixture and this table are the same claim.
        assert.equal(diffFixture.pin.version, table.pin.version)
        assert.equal(diffFixture.pin.commit, table.pin.commit)
        assert.equal(diffFixture.entry, 'register.ts')
        assert.equal(row.scan.sites, diffFixture.scan.events)
        assert.equal(row.scan.events, diffFixture.scan.uniqueEvents)
        assert.equal(row.scan.calls, diffFixture.scan.calls)
        assert.equal(row.scan.dynamic, diffFixture.scan.dynamic)
        assert.deepEqual(
          row.registrations.map((registration) => registration.event),
          diffFixture.registrations,
        )
      }

      let loaded
      try {
        loaded = await loadMod(load)
      } catch (error) {
        assert.fail(`${row.name} is recorded loaded but refused: ${error.name}: ${error.message}`)
      }
      // Registrations cross the vm boundary, so their objects carry the mod
      // realm's prototypes; compare plain data, not identity.
      const observed = JSON.parse(
        JSON.stringify(
          loaded.registrations.map((registration) =>
            registration.matcher === undefined
              ? { event: registration.event }
              : { event: registration.event, matcher: registration.matcher },
          ),
        ),
      )
      assert.deepEqual(observed, row.registrations, `${row.name} registered something else`)
      continue
    }

    assert.equal(row.outcome, 'refused', `${row.name} has an unknown outcome`)
    assert.ok(!('registrations' in row), `${row.name} is refused but carries registrations`)
    assert.equal(typeof row.code, 'string', `${row.name} refusal has no code`)
    assert.equal(typeof row.path, 'string', `${row.name} refusal has no path`)
    assert.equal(typeof row.message, 'string', `${row.name} refusal has no exact message`)

    let error
    try {
      await loadMod(load)
    } catch (caught) {
      error = caught
    }
    assert.ok(error !== undefined, `${row.name} is recorded refused but loaded`)

    if (row.code.startsWith('ERR_MOD_HOST_')) {
      // A typed host refusal names the host's code and file, not a stack frame.
      assert.ok(error instanceof ModHostError, `${row.name} refusal is not a ModHostError`)
      assert.equal(error.code, row.code, `${row.name} refusal has the wrong host code`)
      const path = join(tree, row.path.split(/:\d+:\d+$/)[0])
      assert.ok(
        error.file === path || String(error.message).includes(path),
        `${row.name} refusal does not name ${path}`,
      )
      continue
    }

    // An authored error is not wrapped (D30): assert its class, its exact
    // message, and the authored frame. A TypeError here is a host gap, not a
    // vague refusal; the table records the line that fails.
    assert.ok(!(error instanceof ModHostError), `${row.name} refusal was wrapped by the host`)
    assert.equal(error.name, row.code, `${row.name} refused with a different error class`)
    assert.equal(error.message, row.message, `${row.name} refused with a different message`)
    const frame = /^(.*):(\d+):(\d+)$/.exec(row.path)
    assert.ok(frame !== null, `${row.name} refusal path must end in :line:column`)
    assert.equal(posix(frame[1]), row.entry, `${row.name} refusal is not in the entry file`)
    const url = pathToFileURL(join(tree, frame[1])).href
    assert.ok(
      String(error.stack).includes(`${url}:${frame[2]}:${frame[3]}`),
      `${row.name} stack does not name ${url}:${frame[2]}:${frame[3]}`,
    )
  }
})
