export function register(on) {
  on('session.end', (dollar, event, next) => next(event))
}
