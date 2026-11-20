const g = globalThis as { evaluations?: number }
g.evaluations = (g.evaluations ?? 0) + 1

export function register(on: On): void {
  on('evaluate', ($: Dollar, event: unknown, next: Next) => g.evaluations)
}
