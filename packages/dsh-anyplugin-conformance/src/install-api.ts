/**
 * The published install surface: `dsh-anyplugin/install`.
 *
 * The panel's server half calls exactly the functions the CLI calls, so the
 * panel cannot grow a second writer over `installs.yml` (D49). The functions
 * themselves live in the conformance package because the rig owns the
 * differential pipeline; this file is only the re-export the panel's server
 * half reaches through the package's own name (D77), and it keeps `packages/`
 * private.
 */
export { InstallCliError, installPlugin, listPlugins } from './install-cli.ts'
export type {
  InstallCliCode,
  InstallOptions,
  InstallResult,
  ListOptions,
  ListResult,
  ListedPlugin,
  PathOptions,
} from './install-cli.ts'
