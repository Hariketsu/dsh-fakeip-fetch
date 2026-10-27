/** Boot-time check: the legacy `local-fetch` row is adopted before any user edit. */
export const name = 'migration-check'
export const inject = ['settings']

export function apply(ctx) {
  const ready = ctx.get('appReady')
  const exit = ctx.get('appExit')
  if (!ready || !exit) throw new Error('missing lifecycle services')
  ctx.effect(() => ready.onReady(() => {
    void (async () => {
      await new Promise(resolve => setTimeout(resolve, 1500))
      const row = ctx.settings.describe().find(item => item.ns === 'fakeip-fetch')
      process.stdout.write(`MIGRATION_CHECK ${JSON.stringify({ ns: row?.ns, value: row?.value, user: row?.user })}\n`)
      exit(0)
    })()
  }), 'migration check')
}
