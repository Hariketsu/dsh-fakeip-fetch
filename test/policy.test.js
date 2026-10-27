import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  compileFakeIpRanges,
  resolveFakeIpAddresses,
  FakeIpPolicyError,
  assertResolverSupport,
} from '../policy.js'

const ranges = compileFakeIpRanges(['198.18.0.0/16', 'fd00::/8'])
const lookupOf = entries => async () => entries
const fakeIp = [{ address: '198.18.0.82', family: 4 }]

test('compiles IPv4 and IPv6 CIDRs', () => {
  assert.equal(ranges.length, 2)
  assert.equal(ranges[0].family, 4)
  assert.equal(ranges[1].family, 6)
})

test('rejects malformed CIDRs', () => {
  for (const bad of ['198.18.0.0', '198.18.0.0/33', 'fd00::/129', 'nope/16', '198.18.0.0/16/2', '']) {
    assert.throws(() => compileFakeIpRanges([bad]), TypeError)
  }
  assert.throws(() => compileFakeIpRanges('198.18.0.0/16'), TypeError)
})

test('accepts answers entirely inside the configured ranges', async () => {
  const resolved = await resolveFakeIpAddresses('en.wikipedia.org', new AbortController().signal, ranges, lookupOf(fakeIp))
  assert.deepEqual(resolved, fakeIp)
})

test('accepts IPv6 fake answers', async () => {
  const resolved = await resolveFakeIpAddresses('example.com', new AbortController().signal, ranges,
    lookupOf([{ address: 'fd00::1', family: 6 }]))
  assert.deepEqual(resolved, [{ address: 'fd00::1', family: 6 }])
})

test('rejects a mixed public and fake answer', async () => {
  await assert.rejects(
    resolveFakeIpAddresses('example.com', new AbortController().signal, ranges,
      lookupOf([...fakeIp, { address: '93.184.216.34', family: 4 }])),
    FakeIpPolicyError,
  )
})

test('rejects IP literals instead of resolving them', async () => {
  for (const literal of ['127.0.0.1', '198.18.0.82', '::1', '[::1]']) {
    await assert.rejects(
      resolveFakeIpAddresses(literal, new AbortController().signal, ranges, lookupOf([])),
      FakeIpPolicyError,
    )
  }
})

test('rejects when no ranges are configured', async () => {
  await assert.rejects(
    resolveFakeIpAddresses('example.com', new AbortController().signal, [], lookupOf(fakeIp)),
    FakeIpPolicyError,
  )
})

test('rejects an empty answer set', async () => {
  await assert.rejects(
    resolveFakeIpAddresses('example.com', new AbortController().signal, ranges, lookupOf([])),
    FakeIpPolicyError,
  )
})

test('propagates lookup failures', async () => {
  await assert.rejects(
    resolveFakeIpAddresses('example.com', new AbortController().signal, ranges, async () => { throw new Error('ENOTFOUND') }),
    /ENOTFOUND/,
  )
})

test('honours cancellation before and during lookup', async () => {
  const aborted = new AbortController()
  aborted.abort()
  await assert.rejects(resolveFakeIpAddresses('example.com', aborted.signal, ranges, lookupOf(fakeIp)), /abort/i)

  const controller = new AbortController()
  const pending = resolveFakeIpAddresses('example.com', controller.signal, ranges, () => new Promise(() => {}))
  controller.abort()
  await assert.rejects(pending, /abort/i)
})

test('detects whether a provider actually kept the injected resolver', () => {
  const resolver = async () => []
  const supported = { resolveAddresses: resolver }
  assert.doesNotThrow(() => assertResolverSupport(supported, resolver))
  assert.throws(() => assertResolverSupport({ resolveAddresses: undefined }, resolver), /Unsupported/)
  assert.throws(() => assertResolverSupport({}, resolver), /Unsupported/)
})
