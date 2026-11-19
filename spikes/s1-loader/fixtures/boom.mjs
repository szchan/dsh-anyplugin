// S1 fixture: a plugin that fails during apply. Used to find out whether a
// group entry rolls back when one of its children cannot be applied.
export default function s1boom() {
  throw new Error('s1: apply failed on purpose')
}
