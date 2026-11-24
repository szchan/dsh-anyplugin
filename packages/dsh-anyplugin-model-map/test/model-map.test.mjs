// The model map is this layer's own policy (D91): Claude agent frontmatter names
// aliases (`sonnet`, `opus`, `haiku`) that no DSH provider advertises, so the
// alias is resolved here, through a declared document the user can override.
// These tests pin the three things that make the claim safe: precedence
// (shipped defaults < user document), runtime provider selection by model id,
// and the rule that an id or effort the catalog does not advertise is never
// forwarded (S16: an unknown effort kills the child turn).
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  DEFAULT_MODEL_MAP,
  EFFORT_NAMES,
  formatEffectiveModelMap,
  loadEffectiveModelMap,
  modelMapPath,
  modelMapRefusal,
  resetModelMapDocument,
  resolveModelRoute,
  serializeModelMapDocument,
  setModelMapDocument,
  validateModelMapDocument,
} from '../src/index.ts'

const tempDir = () => mkdtempSync(join(tmpdir(), 'anyplugin-model-map-'))
const envFor = (document) => ({ ANYPLUGIN_MODEL_MAP: document })
const absentDocument = (dir) => join(dir, 'model-map.json')

/** A stub LLM service: providers each advertise a model-id list. */
function catalog({ providers, models, efforts, failModels = new Set(), failInfo = new Set() }) {
  return {
    listProviders: () => providers.map((id) => ({ id, name: id })),
    listModels: async (provider) => {
      if (failModels.has(provider)) throw new Error(`catalog unavailable for ${provider}`)
      return models[provider].map((id) => ({ provider, id, name: id }))
    },
    ...(efforts === undefined
      ? {}
      : {
          resolveModelInfo: async (provider, model) => {
            if (failInfo.has(`${provider}/${model}`)) throw new Error(`no model info for ${model}`)
            return { provider, id: model, name: model, reasoning: { efforts: efforts[model].map((id) => ({ id, name: id })) } }
          },
        }),
  }
}

const SHIPPED = {
  opus: { provider: 'deepseek-account', model: 'deepseek-flash', effort: 'max' },
  sonnet: { provider: 'deepseek-account', model: 'deepseek-flash', effort: 'high' },
  haiku: { provider: 'deepseek-account', model: 'deepseek-flash', effort: 'low' },
}

test('shipped defaults are the map when no user document exists', () => {
  const dir = tempDir()
  const map = loadEffectiveModelMap({ env: envFor(absentDocument(dir)), homedir: dir })
  assert.deepEqual(DEFAULT_MODEL_MAP, SHIPPED)
  assert.equal(map.document, null)
  assert.equal(map.path, absentDocument(dir))
  assert.deepEqual(map.problems, [])
  assert.deepEqual(map.overrides, [])
  assert.deepEqual(
    map.entries.map((entry) => [entry.alias, entry.route, entry.source]),
    [
      ['haiku', SHIPPED.haiku, 'default'],
      ['opus', SHIPPED.opus, 'default'],
      ['sonnet', SHIPPED.sonnet, 'default'],
    ],
  )
})

test('the document path is the user config path unless the environment overrides it', () => {
  assert.equal(
    modelMapPath({ env: {}, homedir: '/home/someone' }),
    '/home/someone/.config/dsh-anyplugin/model-map.json',
  )
  assert.equal(
    modelMapPath({ env: { ANYPLUGIN_MODEL_MAP: '/tmp/custom.json' }, homedir: '/home/someone' }),
    '/tmp/custom.json',
  )
})

test('a user document overrides only the aliases it names, per field', () => {
  const dir = tempDir()
  const document = absentDocument(dir)
  writeFileSync(
    document,
    JSON.stringify({ models: { sonnet: { provider: 'dsh-opencode-go', model: 'deepseek-v4.1-flash', effort: 'max' } } }),
  )
  const map = loadEffectiveModelMap({ env: envFor(document), homedir: dir })
  assert.deepEqual(map.problems, [])
  assert.deepEqual(map.overrides, ['sonnet'])
  assert.deepEqual(
    map.entries.map((entry) => [entry.alias, entry.route, entry.source]),
    [
      ['haiku', SHIPPED.haiku, 'default'],
      ['opus', SHIPPED.opus, 'default'],
      ['sonnet', { provider: 'dsh-opencode-go', model: 'deepseek-v4.1-flash', effort: 'max' }, 'user'],
    ],
  )
  // The document is a document, not ambient state: reading it changed nothing.
  assert.equal(readFileSync(document, 'utf8').includes('dsh-opencode-go'), true)
})

test('a user route may omit the provider; the provider is then resolved at runtime', () => {
  const dir = tempDir()
  const document = absentDocument(dir)
  writeFileSync(document, JSON.stringify({ models: { haiku: { model: 'deepseek-flash' } } }))
  const map = loadEffectiveModelMap({ env: envFor(document), homedir: dir })
  assert.deepEqual(map.problems, [])
  assert.deepEqual(map.entries.find((entry) => entry.alias === 'haiku').route, { model: 'deepseek-flash' })
})

test('a malformed document is reported and the shipped defaults stay in force', () => {
  const dir = tempDir()
  const document = absentDocument(dir)
  writeFileSync(document, '{ not json')
  const map = loadEffectiveModelMap({ env: envFor(document), homedir: dir })
  assert.equal(map.document, document)
  assert.equal(map.entries.length, 3)
  assert.ok(map.entries.every((entry) => entry.source === 'default'), 'nothing from a broken document applies')
  assert.equal(map.problems.length, 1)
  assert.match(map.problems[0], /model-map\.json/)
  assert.match(map.problems[0], /JSON/)
})

test('strict validation rejects unknown keys, unknown efforts, and bad route shapes', () => {
  const cases = [
    [{ models: {}, route: {} }, /unknown top-level key "route"/],
    [{ models: { opus: { model: 'x', reasoning: 'high' } } }, /unknown key "reasoning"/],
    [{ models: { opus: { model: 'x', effort: 'turbo' } } }, /unknown effort "turbo"/],
    [{ models: { opus: { effort: 'high' } } }, /"model" is required/],
    [{ models: { opus: { model: '' } } }, /"model" must be a non-empty string/],
    [{ models: { opus: { model: 'x', provider: 7 } } }, /"provider" must be a non-empty string/],
    [{ models: { '': { model: 'x' } } }, /alias must be a non-empty string/],
    [{ models: [] }, /"models" must be an object/],
    [{}, /"models" is required/],
  ]
  for (const [document, pattern] of cases) {
    const result = validateModelMapDocument(JSON.stringify(document), 'test-document')
    assert.equal(result.models, undefined, `${JSON.stringify(document)} has no valid routes`)
    assert.equal(result.problems.length, 1, `${JSON.stringify(document)} has one problem`)
    assert.match(result.problems[0], pattern)
  }
})

test('a document with one bad route applies nothing, so a review sees both source and problem', () => {
  const dir = tempDir()
  const document = absentDocument(dir)
  writeFileSync(
    document,
    JSON.stringify({ models: { opus: { model: 'deepseek-flash', effort: 'turbo' }, sonnet: { model: 'glm-5.3' } } }),
  )
  const map = loadEffectiveModelMap({ env: envFor(document), homedir: dir })
  assert.equal(map.problems.length, 1)
  assert.match(map.problems[0], /unknown effort "turbo"/)
  assert.deepEqual(map.entries.map((entry) => [entry.alias, entry.source]), [
    ['haiku', 'default'],
    ['opus', 'default'],
    ['sonnet', 'default'],
  ])
})

test('serialize writes the canonical document validate accepts', () => {
  const text = serializeModelMapDocument({ sonnet: { provider: 'deepseek-account', model: 'deepseek-flash', effort: 'high' } })
  assert.equal(text.endsWith('\n'), true)
  const result = validateModelMapDocument(text, 'roundtrip')
  assert.deepEqual(result.problems, [])
  assert.deepEqual(result.models.sonnet, { provider: 'deepseek-account', model: 'deepseek-flash', effort: 'high' })
})

test('the human form shows the document, provenance, and problems', () => {
  const dir = tempDir()
  const document = absentDocument(dir)
  writeFileSync(document, '{ not json')
  const map = loadEffectiveModelMap({ env: envFor(document), homedir: dir })
  const text = formatEffectiveModelMap(map)
  assert.match(text, /model-map:/)
  assert.match(text, new RegExp(document.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(text, /opus -> deepseek-account\/deepseek-flash @ max \(default\)/)
  assert.match(text, /problem:/)
})

test('the session provider wins when it advertises the model id', async () => {
  const llm = catalog({
    providers: ['dsh-opencode-go', 'deepseek-account'],
    models: { 'dsh-opencode-go': ['deepseek-flash'], 'deepseek-account': ['deepseek-flash'] },
  })
  const resolution = await resolveModelRoute(llm, { provider: 'deepseek-account', model: 'deepseek-flash' }, {
    sessionProvider: 'dsh-opencode-go',
  })
  assert.equal(resolution.forward, true)
  assert.equal(resolution.provider, 'dsh-opencode-go')
  assert.equal(resolution.model, 'deepseek-flash')
  assert.deepEqual(resolution.gaps, [])
})

test('the declared provider is used when the session provider does not advertise the id', async () => {
  const llm = catalog({
    providers: ['dsh-opencode-go', 'deepseek-account'],
    models: { 'dsh-opencode-go': ['glm-5.3'], 'deepseek-account': ['deepseek-flash'] },
  })
  const resolution = await resolveModelRoute(llm, { provider: 'deepseek-account', model: 'deepseek-flash' }, {
    sessionProvider: 'dsh-opencode-go',
  })
  assert.equal(resolution.forward, true)
  assert.equal(resolution.provider, 'deepseek-account')
})

test('an absent declared provider substitutes another provider that advertises the id, and says so', async () => {
  const llm = catalog({
    providers: ['dsh-opencode-go'],
    models: { 'dsh-opencode-go': ['deepseek-flash'] },
  })
  const resolution = await resolveModelRoute(llm, { provider: 'deepseek-account', model: 'deepseek-flash' }, {
    sessionProvider: 'dsh-opencode-go',
  })
  assert.equal(resolution.forward, true)
  assert.equal(resolution.provider, 'dsh-opencode-go')
  assert.equal(resolution.model, 'deepseek-flash')
  assert.equal(resolution.gaps.length, 1)
  assert.match(resolution.gaps[0], /deepseek-account/)
  assert.match(resolution.gaps[0], /dsh-opencode-go/)
})

test('an unadvertised model id is never forwarded; the gap names the id and the providers', async () => {
  const llm = catalog({ providers: ['dsh-opencode-go'], models: { 'dsh-opencode-go': ['glm-5.3'] } })
  const resolution = await resolveModelRoute(llm, { provider: 'deepseek-account', model: 'deepseek-flash' }, {
    sessionProvider: 'dsh-opencode-go',
  })
  assert.equal(resolution.forward, false)
  assert.equal(resolution.provider, undefined)
  assert.equal(resolution.model, undefined)
  assert.ok(resolution.gaps.some((gap) => /deepseek-flash/.test(gap)), 'the gap names the model id')
  assert.ok(resolution.gaps.some((gap) => /dsh-opencode-go/.test(gap)), 'the gap names a provider tried')
})

test('a provider whose catalog cannot be read does not advertise; the next provider is tried', async () => {
  const llm = catalog({
    providers: ['deepseek-account', 'dsh-opencode-go'],
    models: { 'deepseek-account': ['deepseek-flash'], 'dsh-opencode-go': ['deepseek-flash'] },
    failModels: new Set(['deepseek-account']),
  })
  const resolution = await resolveModelRoute(llm, { provider: 'deepseek-account', model: 'deepseek-flash' }, {})
  assert.equal(resolution.forward, true)
  assert.equal(resolution.provider, 'dsh-opencode-go')
  assert.ok(resolution.gaps.some((gap) => /catalog/.test(gap)), 'the unreadable catalog is recorded')
})

test('an effort the provider advertises is forwarded', async () => {
  const llm = catalog({
    providers: ['deepseek-account'],
    models: { 'deepseek-account': ['deepseek-flash'] },
    efforts: { 'deepseek-flash': ['low', 'high', 'max'] },
  })
  const resolution = await resolveModelRoute(llm, { provider: 'deepseek-account', model: 'deepseek-flash', effort: 'high' }, {})
  assert.equal(resolution.forward, true)
  assert.equal(resolution.effort, 'high')
  assert.deepEqual(resolution.gaps, [])
})

test('an effort the provider does not advertise is dropped, with a visible gap; the model still runs', async () => {
  const llm = catalog({
    providers: ['deepseek-account'],
    models: { 'deepseek-account': ['deepseek-flash'] },
    efforts: { 'deepseek-flash': ['low'] },
  })
  const resolution = await resolveModelRoute(llm, { provider: 'deepseek-account', model: 'deepseek-flash', effort: 'max' }, {})
  assert.equal(resolution.forward, true)
  assert.equal(resolution.model, 'deepseek-flash')
  assert.equal(resolution.effort, undefined)
  assert.equal(resolution.gaps.length, 1)
  assert.match(resolution.gaps[0], /max/)
  assert.match(resolution.gaps[0], /low/)
})

test('an effort that cannot be confirmed is dropped rather than guessed', async () => {
  const noInfo = catalog({ providers: ['deepseek-account'], models: { 'deepseek-account': ['deepseek-flash'] } })
  const unresolved = await resolveModelRoute(noInfo, { provider: 'deepseek-account', model: 'deepseek-flash', effort: 'high' }, {})
  assert.equal(unresolved.forward, true)
  assert.equal(unresolved.effort, undefined)
  assert.ok(unresolved.gaps.some((gap) => /effort/.test(gap)))

  const throwing = catalog({
    providers: ['deepseek-account'],
    models: { 'deepseek-account': ['deepseek-flash'] },
    efforts: { 'deepseek-flash': ['high'] },
    failInfo: new Set(['deepseek-account/deepseek-flash']),
  })
  const failed = await resolveModelRoute(throwing, { provider: 'deepseek-account', model: 'deepseek-flash', effort: 'high' }, {})
  assert.equal(failed.forward, true)
  assert.equal(failed.effort, undefined)
  assert.ok(failed.gaps.some((gap) => /effort/.test(gap)))
})

test('a provider that reports no reasoning efforts drops the effort visibly even after another provider fails', async () => {
  // Regression: the gap used to require `gaps.length === 0`, so an unrelated
  // catalog failure earlier in the provider walk made the dropped effort
  // silent — the returned route lost its effort with nothing logged.
  const llm = {
    listProviders: () => [
      { id: 'broken-provider', name: 'broken-provider' },
      { id: 'deepseek-account', name: 'deepseek-account' },
    ],
    listModels: async (provider) => {
      if (provider === 'broken-provider') throw new Error('catalog unavailable for broken-provider')
      return [{ provider, id: 'deepseek-flash', name: 'deepseek-flash' }]
    },
    resolveModelInfo: async (provider, model) => ({ provider, id: model, name: model }),
  }
  const resolution = await resolveModelRoute(
    llm,
    { provider: 'deepseek-account', model: 'deepseek-flash', effort: 'high' },
    { sessionProvider: 'broken-provider' },
  )
  assert.equal(resolution.forward, true)
  assert.equal(resolution.effort, undefined)
  assert.equal(resolution.gaps.length, 2)
  assert.match(resolution.gaps[0], /did not expose a model catalog/)
  assert.match(resolution.gaps[1], /reports no reasoning efforts/)
  assert.match(resolution.gaps[1], /dropped effort "high"/)
})

test('an unknown effort name is never sent to the catalog and never forwarded', async () => {
  const llm = catalog({
    providers: ['deepseek-account'],
    models: { 'deepseek-account': ['deepseek-flash'] },
    efforts: { 'deepseek-flash': ['low', 'high', 'max'] },
  })
  const resolution = await resolveModelRoute(llm, { provider: 'deepseek-account', model: 'deepseek-flash', effort: 'turbo' }, {})
  assert.equal(resolution.forward, true)
  assert.equal(resolution.effort, undefined)
  assert.ok(resolution.gaps.some((gap) => /turbo/.test(gap)))
})

test('the effort name set is exactly the provider vocabulary this layer accepts', () => {
  assert.deepEqual([...EFFORT_NAMES], ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
})

test('an empty provider list is a gap, not a crash', async () => {
  const resolution = await resolveModelRoute({ listProviders: () => [], listModels: async () => [] }, { model: 'deepseek-flash' }, {})
  assert.equal(resolution.forward, false)
  assert.ok(resolution.gaps.some((gap) => /deepseek-flash/.test(gap)))
})

test('set writes the canonical user document, and a fresh load reports it as user-sourced', () => {
  const path = absentDocument(tempDir())
  const result = setModelMapDocument('{"models":{"opus":{"model":"my-model","effort":"low"}}}', { env: envFor(path) })
  assert.equal(result.written, true)
  assert.deepEqual(result.problems, [])
  assert.equal(readFileSync(path, 'utf8'), serializeModelMapDocument({ opus: { model: 'my-model', effort: 'low' } }))
  const map = loadEffectiveModelMap({ env: envFor(path) })
  assert.equal(map.document, path)
  assert.deepEqual(map.overrides, ['opus'])
  const opus = map.entries.find((entry) => entry.alias === 'opus')
  assert.equal(opus.source, 'user')
  assert.equal(opus.route.model, 'my-model')
  assert.equal(opus.route.effort, 'low')
  // An alias the document does not name keeps its shipped route.
  assert.equal(map.entries.find((entry) => entry.alias === 'sonnet').source, 'default')
})

test('set reads a path as well as inline JSON, and writes nothing on any problem', () => {
  const dir = tempDir()
  const path = absentDocument(dir)
  const input = join(dir, 'input.json')
  writeFileSync(input, '{"models":{"sonnet":{"provider":"acme","model":"acme-flash","effort":"high"}}}')
  const ok = setModelMapDocument(input, { env: envFor(path) })
  assert.equal(ok.written, true)
  assert.equal(loadEffectiveModelMap({ env: envFor(path) }).overrides[0], 'sonnet')

  const bad = join(dir, 'bad.json')
  writeFileSync(bad, '{"models":{"opus":{"model":"m"}},"route":{}}')
  const rejected = setModelMapDocument(bad, { env: envFor(path) })
  assert.equal(rejected.written, false)
  assert.ok(rejected.problems.some((problem) => /unknown top-level key/.test(problem)))
  // The earlier valid document is untouched: a rejected set never half-writes.
  assert.equal(loadEffectiveModelMap({ env: envFor(path) }).overrides[0], 'sonnet')

  const missing = setModelMapDocument(join(dir, 'absent.json'), { env: envFor(path) })
  assert.equal(missing.written, false)
  assert.match(missing.problems.join('\n'), /could not read/)
})

test('reset removes the user document and succeeds when there is nothing to remove', () => {
  const path = absentDocument(tempDir())
  setModelMapDocument('{"models":{"haiku":{"model":"m"}}}', { env: envFor(path) })
  assert.equal(existsSync(path), true)
  const removed = resetModelMapDocument({ env: envFor(path) })
  assert.equal(removed.removed, true)
  assert.deepEqual(removed.problems, [])
  assert.equal(existsSync(path), false)
  assert.deepEqual(loadEffectiveModelMap({ env: envFor(path) }).overrides, [])
  assert.equal(resetModelMapDocument({ env: envFor(path) }).removed, true)
})

test('modelMapRefusal names a malformed document and is undefined for defaults and a valid document', () => {
  const clean = loadEffectiveModelMap({ env: envFor(absentDocument(tempDir())) })
  assert.equal(modelMapRefusal(clean), undefined)
  const path = absentDocument(tempDir())
  writeFileSync(path, '{"models":{"opus":{"model":"m","effort":"turbo"}}}')
  const malformed = loadEffectiveModelMap({ env: envFor(path) })
  assert.match(modelMapRefusal(malformed), /malformed/)
  assert.match(modelMapRefusal(malformed), /unknown effort/)
  const valid = loadEffectiveModelMap({ env: envFor(absentDocument(tempDir())) })
  assert.equal(modelMapRefusal(valid), undefined)
})
