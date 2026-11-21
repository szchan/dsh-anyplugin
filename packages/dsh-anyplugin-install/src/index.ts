/**
 * `dsh-anyplugin-install` — the install and enable layer.
 *
 * The lock (`installs.yml`) is profile-global. Enablement is layered per
 * workspace (`local` > `project` > `user`). This package turns the two into
 * loader entries and reconciles them, without ever writing profile config.
 */
export * from './installs.ts'
export * from './enablements.ts'
export * from './output-styles.ts'
export * from './identity.ts'
export * from './compile.ts'
export * from './reconcile.ts'
export * from './controller.ts'
