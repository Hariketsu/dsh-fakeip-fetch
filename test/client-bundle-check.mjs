import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const captured = []
globalThis.window = { __ModuleLoader__: { load: (row) => { captured.push(row) } } }
const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
new Function(source)()
assert.equal(captured.length, 1)
const [{ id, factory }] = captured
assert.equal(id, 'dsh-fakeip-fetch')

const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useRef: (value) => ({ current: value }),
  Component: class Component { constructor(props) { this.props = props; this.state = {} } },
}
const primitives = {
  Button: 'Button', Input: 'Input', Tag: 'Tag',
  SettingsForm: 'SettingsForm', SettingsValueField: 'SettingsValueField',
}
const mod = factory((spec) => {
  if (spec === 'react') return React
  if (spec === '@deepseek-ai/dsh-client-ui-primitives') return primitives
  throw new Error(`unexpected require: ${spec}`)
})
assert.equal(typeof mod.apply, 'function')
assert.deepEqual(mod.inject, ['slots', 'configForms'])

const sourceText = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
assert.ok(!/style:\s*\[/.test(sourceText), 'React style props must never be arrays')
assert.ok(sourceText.includes('SettingsErrorBoundary'), 'settings page must keep its own error boundary')

const registrations = []
mod.apply({ effect: (fn) => fn(), slots: { register: (options, component) => { registrations.push({ options, component }); return () => {} } } })
assert.equal(registrations.length, 1)
assert.equal(registrations[0].options.name, 'plugins.row.config')
assert.equal(registrations[0].options.key, 'dsh-fakeip-fetch#fakeip-fetch')
assert.equal(registrations[0].options.order, 10)
assert.equal(registrations[0].component.name, 'LocalFetchPageWithBoundary')

const value = {
  enabled: false,
  fakeIpRanges: ['198.18.0.0/16'],
  maxResponseBytes: 5000000, maxBodyChars: 100000, timeoutMs: 30000, maxRedirects: 5,
  userAgent: 'deepseek-harness/0.0.1',
}
const form = { state: { status: 'ready', value, revision: 0, writable: true }, mutate: async () => true }
const Page = mod.LocalFetchPage

function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  if (typeof node.type === 'function') {
    const props = { ...node.props, ...(node.children.length > 0 ? { children: node.children.length === 1 ? node.children[0] : node.children } : {}) }
    return textOf(node.type(props))
  }
  const parts = [
    textOf(node.props?.value), textOf(node.props?.label), textOf(node.props?.placeholder),
    textOf(node.props?.text), textOf(node.props?.hint), textOf(node.props?.desc),
    textOf(node.props?.labels?.unavailable),
    ...node.children.map(textOf),
  ]
  return parts.join(' ')
}

const page = Page({ view: 'page', form })
function formState(overrides) {
  return Page({ view: 'page', form: { ...form, state: { ...form.state, value: { ...value, ...overrides } } } }).props.state
}
for (const fakeIpRanges of [['1:2/64'], ['198.018.0.0/16']]) {
  assert.equal(formState({ fakeIpRanges }).invalid, true)
}
for (const fakeIpRanges of [['fd00::/8'], ['::ffff:192.0.2.1/128']]) {
  assert.equal(formState({ fakeIpRanges }).invalid, false)
}
for (const overrides of [{ timeoutMs: 0 }, { timeoutMs: 2147483648 }, { maxResponseBytes: 0 }, { maxBodyChars: 0 }, { userAgent: 'a\nb' }]) {
  assert.equal(formState(overrides).invalid, true)
}
assert.equal(formState({ maxRedirects: 0, timeoutMs: 2147483647 }).invalid, false)
const pageText = textOf(page)
for (const expected of ['运行状态', 'Fake-IP 网段', '198.18.0.0/16', '探测本机 DNS', '自检', '高级传输设置', '待自检']) {
  assert.ok(pageText.includes(expected), `page must render ${expected}`)
}
assert.ok(!pageText.includes('启用 Fake-IP 放行'), 'the retired enable switch must be gone')
const summary = Page({ view: 'summary', form })
assert.ok(textOf(summary).includes('个网段'), 'summary must report the configured range count')
function assertNoArrayStyle(node) {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (Array.isArray(node)) { node.forEach(assertNoArrayStyle); return }
  if (node.props !== undefined && Array.isArray(node.props.style)) throw new Error('array style prop detected')
  assertNoArrayStyle(node.children)
}

const probe = mod.renderProbeResult(
  {
    host: 'en.wikipedia.org',
    answers: [
      { address: '198.18.0.82', family: 4, inRange: true },
      { address: '203.0.113.9', family: 4, inRange: false },
    ],
    suggestion: '198.18.0.0/16',
  },
  [],
  () => {},
)
assertNoArrayStyle(probe)
const probeText = textOf(probe)
for (const expected of ['198.18.0.82', '在网段内', '203.0.113.9', '不在网段内', '建议网段', '198.18.0.0/16']) {
  assert.ok(probeText.includes(expected), `probe view must show ${expected}`)
}
assertNoArrayStyle(mod.renderProbeResult({ host: 'x', answers: [] }, [], () => {}))
assert.ok(textOf(mod.renderProbeResult({ host: 'x', answers: [] }, [], () => {})).includes('DNS 没有返回地址'))
assert.ok(textOf(mod.renderProbeResult({ host: 'x', answers: 'oops' }, [], () => {})).includes('DNS 没有返回地址'))

const selfOk = mod.renderSelfCheck({
  fingerprint: 'f1',
  pluginVersion: '0.5.0',
  providerVersion: '0.2.1-rc.3',
  state: {
    checkedAt: '2026-10-26T07:00:00.000Z', fingerprint: 'f1', pluginVersion: '0.5.0', providerVersion: '0.2.1-rc.3',
    ranges: ['198.18.0.0/16'],
    dns: { host: 'en.wikipedia.org', answers: [{ address: '198.18.0.82', family: 4, inRange: true }] },
    fetch: { ok: true, status: 200, path: 'fallback', ms: 320 },
    versionCheck: { checkedAt: '2026-10-26T07:00:00.000Z', pluginVersion: '0.5.0', providerVersion: '0.2.1-rc.3', supported: true },
  },
}, '')
assertNoArrayStyle(selfOk)
const selfOkText = textOf(selfOk)
for (const expected of ['通过', 'Fake-IP 备选路径', '320 ms', '198.18.0.82', '在网段内', '版本检查', '0.5.0']) {
  assert.ok(selfOkText.includes(expected), `self check view must show ${expected}`)
}
const selfNoRanges = mod.renderSelfCheck({ fingerprint: 'f1', state: { checkedAt: 'x', fingerprint: 'f1', pluginVersion: '0.5.0', providerVersion: 'v', dns: { answers: [] }, fetch: { skipped: 'no-ranges' } } }, '')
assert.ok(textOf(selfNoRanges).includes('已跳过网络自检'))
const selfUnsupported = mod.renderSelfCheck({ fingerprint: 'f1', state: { checkedAt: 'x', fingerprint: 'f1', pluginVersion: '0.5.0', providerVersion: 'v', dns: { answers: [] }, fetch: { skipped: 'no-ranges' }, versionCheck: { supported: false } } }, '')
assert.ok(textOf(selfUnsupported).includes('不支持'))
const selfStale = mod.renderSelfCheck({ fingerprint: 'f2', state: { checkedAt: 'x', pluginVersion: '0.5.0', providerVersion: 'v', fingerprint: 'f1', dns: { answers: [] }, fetch: {} } }, '')
assert.ok(textOf(selfStale).includes('正在重跑'))
assert.ok(textOf(mod.renderSelfCheck(null, '')).includes('尚未运行'))
assert.ok(textOf(mod.renderSelfCheck(null, 'boom')).includes('读取失败'))

const conflictSummary = mod.renderSelfCheck ? null : null
const conflicted = Page({ view: 'page', form })
assert.ok(textOf(conflicted).length > 0)

const noForm = Page({ view: 'page' })
assert.ok(textOf(noForm).includes('配置尚未就绪'), 'missing form must render a placeholder')

console.log('CLIENT_BUNDLE_OK', JSON.stringify({
  id, inject: mod.inject, rowKey: registrations[0].options.key,
  pageNodes: JSON.stringify(page).length, summary: textOf(summary),
}))
