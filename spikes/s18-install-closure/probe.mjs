// S18 child probe: one Node binary, one scratch profile.
//
// This file is copied *into* `<home>/profiles/s18/probe.mjs` by run.mjs and is
// never run from the spike directory. The placement is load-bearing: the
// launcher's `ResolutionRouter.hasInterceptionLayerForUrl` only routes
// importers that live in the profiles tree (or the active profile / a linked
// root), so a probe outside the tree would observe `ERR_MODULE_NOT_FOUND`
// both before and after interception and prove nothing.
//
// Reports one JSON object on stdout; run.mjs interprets it. It never asserts:
// the assertions live in run.mjs, where the per-node matrix can compare the
// gate Node with the Desktop Node.
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const harnessDir = process.env.S18_HARNESS_DIR
const installAnchor = process.env.S18_INSTALL_ANCHOR
const profileDir = dirname(fileURLToPath(import.meta.url))
const home = dirname(dirname(profileDir))
const result = {
  node: process.version,
  execPath: process.execPath,
  harnessDir,
  profileDir,
}

const describe = (error) => ({
  code: error?.code ?? null,
  message: String(error?.message ?? error).slice(0, 600),
})

const attemptImport = async (specifier) => {
  try {
    const ns = await import(specifier)
    let resolved = null
    try {
      resolved = import.meta.resolve(specifier)
    } catch (error) {
      resolved = `resolve-failed: ${String(error.message).slice(0, 200)}`
    }
    return { ok: true, keys: Object.keys(ns).slice(0, 8), resolved }
  } catch (error) {
    return { ok: false, ...describe(error) }
  }
}

try {
  const require = createRequire(installAnchor)

  // The addon is what `installRuntimeInterception` requires; probe it before
  // constructing the service so a binding failure is attributed to the Node
  // build, not to a resolver path set up by this profile.
  const addon = require('node-addon-require-builtin')
  result.addon = {
    version: require('node-addon-require-builtin/package.json').version,
    binding: typeof addon.getBindingInfo === 'function' ? addon.getBindingInfo() : null,
  }
  result.builtins = [
    'internal/modules/esm/loader',
    'internal/modules/cjs/loader',
    'internal/modules/helpers',
    'internal/modules/esm/utils',
    'internal/modules/esm/resolve',
  ].map((id) => {
    try {
      const builtin = addon.requireBuiltin(id)
      return { id, ok: true, type: typeof builtin }
    } catch (error) {
      return { id, ok: false, ...describe(error) }
    }
  })

  const appBoot = await import(pathToFileURL(join(harnessDir, 'dsh-app-boot', 'lib', 'index.js')).href)
  const { Context } = await import(pathToFileURL(join(harnessDir, 'cordis', 'lib', 'index.js')).href)
  const profile = appBoot.loadProfile('dsh', 's18', installAnchor, home)
  const resolution = await appBoot.createRuntimeResolution({ installAnchor, profile, home })
  result.resolutionEntries = Object.keys(resolution ?? {}).length

  // A bare @deepseek-ai/* import with no scope link in the profile. If the
  // PluginPackages interception is absent this cannot resolve; there is no
  // node_modules fallback anywhere up from the scratch home.
  const specifier = '@deepseek-ai/cordis-plugin-group'
  result.specifier = specifier
  // The launcher has no separate plugin-packages package at this pin; probing
  // it makes the "import shape" claim falsifiable if a pin adds one.
  result.separatePackage = await attemptImport('@deepseek-ai/dsh-plugin-packages')
  result.before = await attemptImport(specifier)

  try {
    const context = new Context()
    new appBoot.PluginPackages(context, { resolution })
    result.pluginPackages = { ok: true }
  } catch (error) {
    result.pluginPackages = { ok: false, ...describe(error) }
  }

  result.after = await attemptImport(specifier)
  result.resolvedFromInstallation =
    result.after.ok === true && typeof result.after.resolved === 'string'
      ? result.after.resolved.startsWith(pathToFileURL(harnessDir).href + '/')
      : false
} catch (error) {
  result.fatal = describe(error)
}

console.log(JSON.stringify(result))
