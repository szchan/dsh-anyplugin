/**
 * Command materializer — the human-facing half of a Claude command.
 *
 * ## What is missing in the harness today (0.2.2-rc.2)
 *
 * Two seams, both additive (T2), are required before a Claude command can be
 * typed byte for byte:
 *
 * 1. **Colon in command names.** `dsh-commands` validates with
 *    `/^[a-z][a-z0-9_-]*$/u` and parses with the same class
 *    (`src/index.ts:32` and `:126`). `/skills-only:migrate` is therefore not
 *    even a *candidate* command — the line is never resolved against the
 *    registry.
 * 2. **A result kind that submits a prompt.** A DSH command handler "executes
 *    against the receiving agent without sending the command to the model"
 *    (`dsh-commands/src/index.ts:76`), and the client states that "a command
 *    line is never silently downgraded to a plain prompt"
 *    (`dsh-client-ui-commands`). A Claude command, by contrast, *is* a prompt
 *    template: the expanded body must become the next user message.
 *
 * Both are union additions: no existing name or result kind changes meaning.
 *
 * ## What this plugin does until then
 *
 * It probes. On a harness with the seams it registers every command with its
 * exact name and a handler that returns the expanded template under the
 * proposed `submit` result kind. On a harness without them it registers
 * nothing, logs one line per command, and reports the rejection — a
 * half-working command that only pretends to be `/plugin:name` would be worse
 * than a missing one, because it would be discovered only at invocation time.
 */
import { expandCommandTemplate, type CommandExpansion } from '../../dsh-anyplugin-command-template/src/index.ts'

export const name = 'anyplugin-materialize-command'
export const inject = ['commands']

/**
 * The result kind this materializer needs: "take this text and submit it as the
 * next user message". Not a thing in 0.2.2-rc.2; proposed as the second seam.
 */
export const SUBMIT_KIND = 'submit'

export interface MaterialCommand {
  /** Exact upstream name, `plugin:command` (colon included). */
  name: string
  description: string
  /** Template body, frontmatter removed. */
  content: string
  /** Frontmatter `argument-hint`, surfaced as the command's input hint. */
  argumentHint?: string
  sourcePath?: string
}

export interface Config {
  commands?: MaterialCommand[]
}

export interface CommandDefinitionLike {
  name: string
  description: string
  input?: { hint?: string }
  handler: (invocation: { rawInput: string }) => { kind: string; text: string }
}

export interface CommandRegistryLike {
  register: (definition: CommandDefinitionLike) => () => void
}

export interface RegistrationOutcome {
  registered: string[]
  rejected: Array<{ name: string; error: string }>
}

/** Build the definition this materializer would register for one command. */
export function commandDefinition(command: MaterialCommand): CommandDefinitionLike {
  const definition: CommandDefinitionLike = {
    name: command.name,
    description: command.description,
    handler: ({ rawInput }) => ({
      kind: SUBMIT_KIND,
      text: expandCommandTemplate(command.content, rawInput).text,
    }),
  }
  if (command.argumentHint) definition.input = { hint: command.argumentHint }
  return definition
}

/**
 * Register every command, collecting rejections instead of throwing. A
 * rejection is the seam being absent, not a bug, so it must not turn into an
 * unhandled apply failure that takes the whole group entry down with it.
 */
export function registerCommands(
  registry: CommandRegistryLike,
  commands: readonly MaterialCommand[],
): RegistrationOutcome {
  const outcome: RegistrationOutcome = { registered: [], rejected: [] }
  for (const command of commands) {
    try {
      registry.register(commandDefinition(command))
      outcome.registered.push(command.name)
    } catch (error) {
      outcome.rejected.push({
        name: command.name,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return outcome
}

/**
 * Ask the registry whether a colon name is accepted, without leaving a probe
 * registration behind. Returns the exact rejection so the report can quote the
 * harness instead of guessing at it.
 */
export function probeColonSeam(registry: CommandRegistryLike, sample = 'anyplugin:probe'): { supported: boolean; error?: string } {
  try {
    const dispose = registry.register({ name: sample, description: 'seam probe', handler: () => ({ kind: SUBMIT_KIND, text: '' }) })
    try {
      dispose()
    } catch {
      // A registry that cannot dispose a probe is not our problem here.
    }
    return { supported: true }
  } catch (error) {
    return { supported: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** Expand without registering — the shape the submit seam will consume. */
export function previewExpansion(command: MaterialCommand, rawInput: string): CommandExpansion {
  return expandCommandTemplate(command.content, rawInput)
}

export function apply(ctx: any, config: Config = {}): void {
  const commands = config.commands ?? []
  if (commands.length === 0) return
  const outcome = registerCommands(ctx.commands, commands)
  for (const rejected of outcome.rejected) {
    ctx.logger?.warn?.(
      `anyplugin: command "${rejected.name}" not registered — the harness refused it (${rejected.error}). Needs the colon-name seam; see DECISIONS D10.`,
    )
  }
}
