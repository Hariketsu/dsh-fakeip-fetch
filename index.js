import { readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { lookup } from 'node:dns/promises'
import z from '@deepseek-ai/schemastery'
import { WebError } from '@deepseek-ai/dsh-web'
import { HttpFetchProvider, DEFAULT_USER_AGENT } from '@deepseek-ai/dsh-web-fetch-http'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { compileFakeIpRanges, resolveFakeIpAddresses, FakeIpPolicyError } from './policy.js'

export const name = 'fakeip-fetch'

/** The web seam this plugin provides the fetch half for. */
export const inject = ['web']

/** Settings namespace of this plugin equals its Loader row id. */
export const SETTINGS_NS = 'fakeip-fetch'

/** Route the settings page calls to read the machine's own DNS answers. */
export const PROBE_PATH = '/fakeip-fetch/probe'

/** Route the settings page calls to read the last startup self check. */
export const SELFCHECK_PATH = '/fakeip-fetch/selfcheck'

/** Bumped whenever the persisted self-check shape changes, forcing a re-run. */
const STATE_VERSION = 2

/** Target whose DNS answers reveal whether the machine resolves into Fake-IP. */
const PROBE_HOST = 'en.wikipedia.org'

/** Small page fetched by the startup self check so one request measures the whole path. */
const CHECK_URL = 'https://example.com'

/** Self-check fetch deadline; the ordinary provider budget still applies underneath. */
const CHECK_TIMEOUT_MS = 15_000

const requireFromHere = createRequire(import.meta.url)

/** Read one dependency's version, walking up from its entry until its own manifest is found. */
function packageVersionOf(specifier) {
  try {
    let directory = dirname(requireFromHere.resolve(specifier))
    for (let depth = 0; depth < 6; depth += 1) {
      try {
        const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
        if (manifest.name === specifier) return String(manifest.version ?? 'unknown')
      } catch (_noManifestHere) {
        // keep walking up
      }
      const parent = dirname(directory)
      if (parent === directory) break
      directory = parent
    }
  } catch (_unresolvable) {
    // fall through to unknown
  }
  return 'unknown'
}

/** This package's own version, read once at load. */
const PLUGIN_VERSION = (() => {
  try {
    return String(JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version ?? 'unknown')
  } catch (_unreadableManifest) {
    return 'unknown'
  }
})()

/** The installed transport package's version: changes when the Host is upgraded. */
const PROVIDER_VERSION = packageVersionOf('@deepseek-ai/dsh-web-fetch-http')

const DEFAULT_LIMITS = Object.freeze({
  maxResponseBytes: 5_000_000,
  maxBodyChars: 100_000,
  timeoutMs: 30_000,
  maxRedirects: 5,
  userAgent: DEFAULT_USER_AGENT,
})

export const Config = z.object({
  fakeIpRanges: z.array(z.string()).default(['198.18.0.0/16']).volatile(),
  maxResponseBytes: z.number().default(5_000_000).volatile(),
  maxBodyChars: z.number().default(100_000).volatile(),
  timeoutMs: z.number().default(30_000).volatile(),
  maxRedirects: z.number().default(5).volatile(),
  userAgent: z.string().default(DEFAULT_USER_AGENT).volatile(),
})

function limitsOf(config) {
  return {
    maxResponseBytes: config.maxResponseBytes.get(),
    maxBodyChars: config.maxBodyChars.get(),
    timeoutMs: config.timeoutMs.get(),
    maxRedirects: config.maxRedirects.get(),
    userAgent: config.userAgent.get(),
  }
}

function validateLimits(limits) {
  for (const field of ['maxResponseBytes', 'maxBodyChars', 'timeoutMs']) {
    if (!Number.isSafeInteger(limits[field]) || limits[field] <= 0) {
      throw new TypeError(`${field} must be a positive safe integer`)
    }
  }
  if (limits.timeoutMs > 2_147_483_647) throw new TypeError('timeoutMs exceeds the Node timer range')
  if (!Number.isSafeInteger(limits.maxRedirects) || limits.maxRedirects < 0) {
    throw new TypeError('maxRedirects must be a non-negative safe integer')
  }
  if (typeof limits.userAgent !== 'string' || limits.userAgent.trim() === '' || /[\r\n]/.test(limits.userAgent)) {
    throw new TypeError('userAgent must be a non-empty single-line string')
  }
}

/** Whether one resolved address belongs to the configured Fake-IP ranges. */
function addressInRanges(ranges, address, family) {
  try {
    return ranges.some(range => range.family === family && range.block.check(address, family === 4 ? 'ipv4' : 'ipv6'))
  } catch (_unparsableAddress) {
    return false
  }
}

/** Suggest the /16 that contains an IPv4 answer, so the page can prefill a range. */
function suggestRange(address) {
  const parts = address.split('.')
  if (parts.length !== 4) return undefined
  if (parts.some(part => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return undefined
  return `${parts[0]}.${parts[1]}.0.0/16`
}

/**
 * Fetch provider that keeps the installed HTTP transport unchanged and only
 * adds one opt-in exception: when the ordinary public-address guard refuses a
 * host because the machine's DNS answered from the TUN Fake-IP range, the same
 * transport retries with a resolver limited to that range.
 */
export class FakeIpFetchProvider {
  id = 'http'

  constructor(config) {
    this.config = config
    this.cache = undefined
    this.rangeCache = undefined
    this.fallback = undefined
    /** Which path served the most recent request: `direct` or `fallback`. */
    this.lastPath = 'direct'
  }

  available() {
    return true
  }

  /** Compile the configured CIDRs, reusing the last compilation until the list changes. */
  ranges() {
    const raw = this.config.fakeIpRanges.get()
    const signature = JSON.stringify(raw)
    if (this.rangeCache === undefined || this.rangeCache.signature !== signature) {
      this.rangeCache = { signature, ranges: compileFakeIpRanges(raw) }
    }
    return this.rangeCache.ranges
  }

  /** Compile the CIDRs, degrading to an empty list instead of throwing. */
  rangesSafe() {
    try {
      return this.ranges()
    } catch (_invalidRanges) {
      return []
    }
  }

  /** Whether this Host build exposes the address-resolver constructor parameter. */
  supportsFakeIp() {
    try {
      return this.transports().fakeIp !== undefined
    } catch (_unbuildableLimits) {
      return false
    }
  }

  /**
   * Rebuild the transports when a volatile transport field changed. The
   * Fake-IP transport is skipped when this build's HttpFetchProvider has no
   * address-resolver parameter: the plugin then behaves exactly like the
   * built-in provider instead of failing the whole web tool.
   */
  transports() {
    const limits = limitsOf(this.config)
    const signature = JSON.stringify(limits)
    if (this.cache !== undefined && this.cache.signature === signature) return this.cache
    validateLimits(limits)
    const original = new HttpFetchProvider(limits)
    let fakeIp
    const resolver = async (hostname, signal) => {
      try {
        return await resolveFakeIpAddresses(hostname, signal, this.ranges())
      } catch (error) {
        if (error instanceof FakeIpPolicyError) {
          throw new WebError(
            `${error.message}. Check the Fake-IP Fetch settings: the configured Fake-IP ranges must match the TUN DNS answer.`,
            'WEB_BLOCKED_URL',
            { cause: error },
          )
        }
        throw error
      }
    }
    try {
      const candidate = new HttpFetchProvider(limits, resolver)
      if (Reflect.get(candidate, 'resolveAddresses') !== resolver) throw new Error('address resolver unavailable')
      fakeIp = candidate
    } catch (_unsupported) {
      fakeIp = undefined
    }
    this.cache = { signature, original, fakeIp }
    return this.cache
  }

  /** Last-resort transport with built-in defaults, so a bad volatile value cannot break `web_fetch`. */
  plain() {
    if (this.fallback === undefined) this.fallback = new HttpFetchProvider(DEFAULT_LIMITS)
    return this.fallback
  }

  async fetch(request, signal) {
    if (signal?.aborted === true) throw new WebError('web fetch aborted', 'WEB_ABORTED')
    let original
    let fakeIp
    let ranges
    let timeoutMs
    try {
      ({ original, fakeIp } = this.transports())
      ranges = this.ranges()
      timeoutMs = this.config.timeoutMs.get()
    } catch (_invalidConfiguration) {
      this.lastPath = 'direct'
      return this.plain().fetch(request, signal)
    }
    if (fakeIp === undefined || ranges.length === 0) {
      this.lastPath = 'direct'
      return original.fetch(request, signal)
    }
    const budget = deadline(signal, timeoutMs, 'WEB_FETCH_TIMEOUT')
    try {
      try {
        this.lastPath = 'direct'
        return await original.fetch(request, budget.signal)
      } catch (error) {
        if (!(error instanceof WebError) || error.code !== 'WEB_BLOCKED_URL') throw error
        if (budget.signal.aborted) throw new WebError('web fetch aborted', 'WEB_ABORTED', { cause: budget.signal.reason })
        this.lastPath = 'fallback'
        return await fakeIp.fetch(request, budget.signal)
      }
    } catch (error) {
      const timeout = timeoutOf(budget.signal, 'WEB_FETCH_TIMEOUT')
      if (timeout !== undefined) throw new WebError('web fetch timed out', 'WEB_FETCH_TIMEOUT', { cause: timeout })
      throw error
    } finally {
      budget[Symbol.dispose]()
    }
  }
}

/** Persisted self-check state: one JSON file under the harness home. */
async function stateFile(ctx) {
  const homePath = ctx.get('dshHomePath')
  const base = typeof homePath === 'function'
    ? homePath('storages', 'fakeip-fetch')
    : join(process.env.DSH_HOME ?? join(process.env.HOME ?? '.', '.dsh'), 'storages', 'fakeip-fetch')
  return join(base, 'selfcheck.json')
}

async function loadState(ctx) {
  try {
    const parsed = JSON.parse(await readFile(await stateFile(ctx), 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined
  } catch (_noStateYet) {
    return undefined
  }
}

async function saveState(ctx, state) {
  try {
    const file = await stateFile(ctx)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, `${JSON.stringify(state, null, 2)}\n`)
  } catch (_stateNotWritable) {
    // A self check is diagnostic only; an unwritable home never affects fetching.
  }
}

/** Identity that decides whether the startup self check must run again. */
function fingerprintOf(provider) {
  return [PLUGIN_VERSION, PROVIDER_VERSION, provider.supportsFakeIp() ? 'resolver' : 'plain', String(STATE_VERSION)].join('|')
}

/** Run the three self-check stages against the live provider and this machine's DNS. */
async function runSelfCheck(ctx, config, provider) {
  const result = {
    checkedAt: new Date().toISOString(),
    fingerprint: fingerprintOf(provider),
    pluginVersion: PLUGIN_VERSION,
    providerVersion: PROVIDER_VERSION,
    supported: provider.supportsFakeIp(),
    ranges: config.fakeIpRanges.get(),
    dns: undefined,
    fetch: undefined,
  }
  const ranges = provider.rangesSafe()
  try {
    const answers = await lookup(PROBE_HOST, { all: true, order: 'verbatim' })
    result.dns = {
      host: PROBE_HOST,
      answers: answers.map(entry => ({
        address: entry.address,
        family: entry.family,
        inRange: addressInRanges(ranges, entry.address, entry.family),
      })),
    }
  } catch (error) {
    result.dns = { host: PROBE_HOST, error: String(error?.message ?? error) }
  }
  if (!Array.isArray(result.ranges) || result.ranges.length === 0) {
    result.fetch = { skipped: 'no-ranges' }
  } else if (result.supported !== true) {
    result.fetch = { skipped: 'unsupported-host' }
  } else {
    const started = Date.now()
    try {
      const value = await provider.fetch({ url: CHECK_URL }, AbortSignal.timeout(CHECK_TIMEOUT_MS))
      result.fetch = {
        ok: true,
        status: value.statusCode,
        path: provider.lastPath,
        ms: Date.now() - started,
        characters: value.body?.content?.length,
      }
    } catch (error) {
      result.fetch = {
        ok: false,
        path: provider.lastPath,
        ms: Date.now() - started,
        code: error?.code,
        message: String(error?.message ?? error).slice(0, 300),
      }
    }
  }
  return result
}

/** Legacy row id written by the previous package name; adopted once into this namespace. */
const LEGACY_ROW_ID = 'local-fetch'

/** Field names the legacy row and the current schema share. */
const LEGACY_NUMERIC_FIELDS = ['maxResponseBytes', 'maxBodyChars', 'timeoutMs', 'maxRedirects']

/**
 * Read the legacy row's config from the active profile patch. The previous
 * package name wrote `- id: local-fetch` there; the file format is the small
 * settings-written YAML subset, so a line parser is enough and no YAML
 * dependency enters the plugin.
 */
async function readLegacyConfig(ctx) {
  const settings = ctx.get('settings')
  const documentPath = settings?.documentPath
  if (typeof documentPath !== 'string') return undefined
  let text
  try {
    text = await readFile(documentPath, 'utf8')
  } catch (_patchUnreadable) {
    return undefined
  }
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex(line => /^-\s+id:\s*local-fetch\s*$/.test(line))
  if (start < 0) return undefined
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^-\s+\S/.test(lines[index])) { end = index; break }
  }
  const legacy = {}
  let inRanges = false
  for (const line of lines.slice(start, end)) {
    const trimmed = line.trim()
    if (/^fakeIpRanges:\s*(\[\s*\])?$/.test(trimmed)) {
      inRanges = !/\[\s*\]/.test(trimmed)
      legacy.fakeIpRanges = []
      continue
    }
    if (inRanges) {
      const item = /^-\s+(.+)$/.exec(trimmed)
      if (item !== null) {
        legacy.fakeIpRanges.push(item[1].replace(/^['"]|['"]$/g, ''))
        continue
      }
      inRanges = false
    }
    const pair = /^([A-Za-z][A-Za-z0-9_]*):\s*(.*)$/.exec(trimmed)
    if (pair === null) continue
    const [, key, raw] = pair
    if (key === 'userAgent') legacy.userAgent = raw.replace(/^['"]|['"]$/g, '')
    else if (LEGACY_NUMERIC_FIELDS.includes(key)) {
      const value = Number(raw)
      if (Number.isFinite(value)) legacy[key] = value
    }
  }
  return Object.keys(legacy).length > 0 ? legacy : undefined
}

/**
 * Adopt the previous package's settings once, when this namespace still has no
 * user override. Writes through the settings service so the values persist in
 * the profile patch and the settings page shows them.
 */
async function migrateLegacyConfig(ctx) {
  const settings = ctx.get('settings')
  if (settings === undefined) return
  let descriptor
  try {
    descriptor = settings.describe().find(row => row.ns === SETTINGS_NS)
  } catch (_settingsUnavailable) {
    return
  }
  if (descriptor === undefined) return
  const user = descriptor.user
  if (user !== null && typeof user === 'object' && Object.keys(user).length > 0) return
  const legacy = await readLegacyConfig(ctx)
  if (legacy === undefined) return
  try {
    await settings.update(SETTINGS_NS, legacy)
    ctx.logger?.info?.('fakeip-fetch: adopted legacy %s settings %o', LEGACY_ROW_ID, Object.keys(legacy))
  } catch (error) {
    ctx.logger?.warn?.('fakeip-fetch: legacy settings adoption failed: %s', String(error?.message ?? error))
  }
}

/** The startup self check: only on a fingerprint change, never blocking, never touching config. */
function scheduleSelfCheck(ctx, config, provider) {
  let lastState
  const bootstrap = async () => {
    // A legacy-adoption write reloads the volatile config; give that reload a
    // moment so the first network attempt below reads settled values.
    await new Promise(resolve => setTimeout(resolve, 300))
    const stored = await loadState(ctx)
    const fingerprint = fingerprintOf(provider)
    // Every startup states the build identity and its compatibility, even when
    // the heavier network self check is reused from the previous boot.
    const versionCheck = {
      checkedAt: new Date().toISOString(),
      pluginVersion: PLUGIN_VERSION,
      providerVersion: PROVIDER_VERSION,
      supported: provider.supportsFakeIp(),
      fingerprint,
    }
    ctx.logger?.info?.(
      'fakeip-fetch version check: plugin=%s transport=%s resolver=%s fingerprint=%s',
      PLUGIN_VERSION, PROVIDER_VERSION, versionCheck.supported ? 'supported' : 'unsupported', fingerprint,
    )
    if (stored !== undefined && stored.fingerprint === fingerprint) {
      lastState = { ...stored, versionCheck }
      await saveState(ctx, lastState)
      ctx.logger?.info?.('fakeip-fetch self check: unchanged fingerprint, reusing %s', String(stored.checkedAt))
      return
    }
    let checked = await runSelfCheck(ctx, config, provider)
    if (checked.fetch !== undefined && checked.fetch !== null && checked.fetch.ok === false) {
      // One retry: the first boot after a config reload can race a transient
      // failure that has nothing to do with the user's ranges.
      await new Promise(resolve => setTimeout(resolve, 1500))
      const retried = await runSelfCheck(ctx, config, provider)
      if (retried.fetch !== undefined && retried.fetch !== null && retried.fetch.ok === true) checked = retried
    }
    lastState = { ...checked, versionCheck }
    await saveState(ctx, lastState)
    ctx.logger?.info?.('fakeip-fetch self check: %o', {
      fingerprint: lastState.fingerprint,
      ranges: lastState.ranges,
      supported: lastState.supported,
      fetch: lastState.fetch,
    })
  }
  const refresh = async () => {
    lastState = await runSelfCheck(ctx, config, provider)
    await saveState(ctx, lastState)
    return lastState
  }
  return { get: () => lastState, refresh, bootstrap }
}

export function apply(ctx, config) {
  const provider = new FakeIpFetchProvider(config)
  let providerConflict
  const selfCheck = scheduleSelfCheck(ctx, config, provider)
  const boot = async () => {
    await migrateLegacyConfig(ctx)
    await selfCheck.bootstrap()
  }
  const ready = ctx.get('appReady')
  if (ready !== undefined && typeof ready.onReady === 'function') {
    ctx.effect(() => ready.onReady(() => { void boot() }), 'fakeip-fetch: startup migration and self check')
  } else {
    void boot()
  }
  ctx.effect(() => {
    try {
      return ctx.web.registerFetchProvider(provider)
    } catch (error) {
      providerConflict = String(error?.message ?? error)
      ctx.logger?.error?.(
        'fakeip-fetch: cannot register the "http" fetch provider: %s. Another package still registers that id (most likely the legacy dsh-local-fetch). Uninstall it, restart, and retry.',
        providerConflict,
      )
      return () => {}
    }
  }, 'fakeip-fetch: fetch provider')
  ctx.inject(['webServer', 'connection'], (child) => {
    const rejectionOf = (req, res) => {
      const rejection = child.connection.requestRejection(req)
      if (rejection === undefined) return false
      res.statusCode = rejection
      res.end()
      return true
    }
    child.effect(() => child.webServer.register({
      kind: 'exact',
      path: SELFCHECK_PATH,
      handler: async (req, res) => {
        if (rejectionOf(req, res)) return
        if (req.method !== 'GET' && req.method !== 'POST') {
          res.statusCode = 405
          res.end()
          return
        }
        let state
        if (req.method === 'POST') {
          try {
            state = await selfCheck.refresh()
          } catch (error) {
            state = { checkedAt: new Date().toISOString(), error: String(error?.message ?? error) }
          }
        } else {
          state = selfCheck.get()
          if (state === undefined) state = await loadState(ctx)
        }
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.setHeader('cache-control', 'no-store')
        res.end(JSON.stringify({
          state: state ?? null,
          fingerprint: fingerprintOf(provider),
          providerVersion: PROVIDER_VERSION,
          pluginVersion: PLUGIN_VERSION,
          conflict: providerConflict,
        }))
      },
    }), 'fakeip-fetch: self check route')
    child.effect(() => child.webServer.register({
      kind: 'exact',
      path: PROBE_PATH,
      handler: async (req, res) => {
        if (rejectionOf(req, res)) return
        if (req.method !== 'GET') {
          res.statusCode = 405
          res.end()
          return
        }
        const url = new URL(String(req.url), 'http://localhost')
        const requested = url.searchParams.get('host')
        const host = (requested === null || requested.trim() === '' ? PROBE_HOST : requested).slice(0, 253)
        const ranges = provider.rangesSafe()
        let answers
        try {
          answers = await lookup(host, { all: true, order: 'verbatim' })
        } catch (_lookupFailed) {
          answers = []
        }
        const entries = answers.map(entry => ({
          address: entry.address,
          family: entry.family,
          inRange: addressInRanges(ranges, entry.address, entry.family),
        }))
        const first = entries.find(entry => entry.family === 4)
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.setHeader('cache-control', 'no-store')
        res.end(JSON.stringify({
          host,
          answers: entries,
          ranges: config.fakeIpRanges.get(),
          suggestion: first === undefined ? undefined : suggestRange(first.address),
        }))
      },
    }), 'fakeip-fetch: probe route')
  })
}
