// The mod API's $ is not a global: this read must fail at evaluation (D30).
$.session.usage()

export function register(on: On): void {
  on('never', () => {})
}
