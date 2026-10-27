import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const require = createRequire('/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/package.json')

export const name = 'fakeip-fetch-driver'
export const inject = ['tools', 'settings', 'web']

async function fetchViaTool(ctx, url) {
  const { ToolCallId } = require('@deepseek-ai/dsh-llm')
  const result = await ctx.tools.execute({
    callId: ToolCallId('fakeip-fetch-check'),
    name: 'web_fetch',
    arguments: { url },
    signal: AbortSignal.timeout(40000),
  })
  return {
    isError: result.isError === true,
    status: result.value?.statusCode,
    chars: result.value?.body?.content?.length,
    hasWikipedia: typeof result.value?.body?.content === 'string' && result.value.body.content.includes('Wikipedia'),
    text: JSON.stringify(result.content).slice(0, 240),
  }
}

async function webFetch(ctx, url) {
  try {
    const value = await ctx.web.fetch({ url }, AbortSignal.timeout(20000))
    return { ok: true, status: value.statusCode, chars: value.body?.content?.length }
  } catch (error) {
    return { ok: false, code: error?.code, message: String(error?.message).slice(0, 200) }
  }
}

export function apply(ctx) {
  const ready = ctx.get('appReady')
  const exit = ctx.get('appExit')
  if (!ready || !exit) throw new Error('missing lifecycle services')
  ctx.effect(() => ready.onReady(() => {
    void (async () => {
      const summary = { steps: [] }
      try {
        const descriptor = ctx.settings.describe().find(row => row.ns === 'fakeip-fetch')
        summary.namespace = descriptor === undefined ? null : {
          ns: descriptor.ns,
          applies: descriptor.applies,
          revision: descriptor.revision,
          value: descriptor.value,
        }
        assert.ok(descriptor, 'fakeip-fetch settings namespace must be served')

        assert.deepEqual(descriptor.value.fakeIpRanges, ['198.18.0.0/16'], 'default ranges are present')
        await ctx.settings.mutate('fakeip-fetch', [{ op: 'set', path: ['fakeIpRanges'], value: [] }])
        summary.steps.push({ step: 'no ranges wikipedia', ...(await webFetch(ctx, 'https://en.wikipedia.org/wiki/Main_Page')) })
        summary.steps.push({ step: 'no ranges example.com', ...(await webFetch(ctx, 'https://example.com')) })

        await ctx.settings.mutate('fakeip-fetch', [{ op: 'set', path: ['fakeIpRanges'], value: ['198.18.0.0/16'] }])
        summary.steps.push({ step: 'enabled example.com (live)', ...(await webFetch(ctx, 'https://example.com')) })
        const wiki = await fetchViaTool(ctx, 'https://en.wikipedia.org/wiki/Main_Page')
        summary.steps.push({ step: 'enabled wikipedia via web_fetch', ...wiki })

        await ctx.settings.mutate('fakeip-fetch', [{ op: 'set', path: ['fakeIpRanges'], value: ['10.0.0.0/8'] }])
        summary.steps.push({ step: 'wrong ranges example.com', ...(await webFetch(ctx, 'https://example.com')) })

        await ctx.settings.mutate('fakeip-fetch', [{ op: 'set', path: ['fakeIpRanges'], value: ['198.18.0.0/16'] }])
        summary.steps.push({ step: 'fixed ranges wikipedia', ...(await webFetch(ctx, 'https://en.wikipedia.org/wiki/Main_Page')) })

        for (const url of ['http://127.0.0.1/', 'http://169.254.169.254/', 'http://10.0.0.1/', 'http://198.18.0.82/', 'http://[::1]/', 'http://user:pass@example.com/']) {
          summary.steps.push({ step: `reject ${url}`, ...(await webFetch(ctx, url)) })
        }

        const statePath = join(process.env.DSH_HOME ?? '.', 'storages', 'fakeip-fetch', 'selfcheck.json')
        let stored
        const deadlineAt = Date.now() + 15000
        while (Date.now() < deadlineAt) {
          try { stored = JSON.parse(await readFile(statePath, 'utf8')); break } catch { await new Promise(r => setTimeout(r, 250)) }
        }
        assert.ok(stored, 'startup self check must persist its state under the harness home')
        assert.equal(stored.pluginVersion, '0.5.2')
        assert.equal(stored.supported, true, 'installed build must expose the resolver parameter')
        assert.deepEqual(stored.ranges, ['198.18.0.0/16'], 'the self check records the configured ranges')
        assert.equal(stored.fetch.ok, true, 'the default self check must serve the fetch')
        assert.ok(stored.versionCheck, 'every boot must record a version check')
        assert.equal(stored.versionCheck.pluginVersion, '0.5.2')
        assert.equal(stored.versionCheck.supported, true)
        assert.equal(stored.dns.host, 'en.wikipedia.org')
        assert.ok(Array.isArray(stored.dns.answers) && stored.dns.answers.length > 0)
        summary.selfCheck = stored

        summary.ok = true
      } catch (error) {
        summary.ok = false
        summary.error = String(error?.stack ?? error)
      }
      if (process.env.DEMO_REPORT) await writeFile(process.env.DEMO_REPORT, `${JSON.stringify(summary, null, 2)}\n`)
      process.stdout.write(`LOCAL_FETCH_RESULT ${JSON.stringify(summary)}\n`)
      exit(summary.ok === true ? 0 : 1)
    })()
  }), 'local fetch driver')
}
