export function register(on) {
  on('session.end', async (dollar, event, next) => {
    await dollar.session.flush()
    return next(event)
  })
}
