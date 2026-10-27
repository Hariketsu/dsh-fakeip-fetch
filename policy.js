import { lookup as systemLookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'

export class FakeIpPolicyError extends Error {
  code = 'WEB_BLOCKED_URL'
}

export function compileFakeIpRanges(cidrs) {
  if (!Array.isArray(cidrs)) throw new TypeError('fakeIpRanges must be an array of CIDR strings')
  return cidrs.map(cidr => {
    if (typeof cidr !== 'string') throw new TypeError('fakeIpRanges entries must be CIDR strings')
    const parts = cidr.split('/')
    const family = isIP(parts[0])
    const maximum = family === 4 ? 32 : 128
    if (parts.length !== 2 || family === 0 || parts[0].includes('%')
      || !/^(0|[1-9]\d*)$/.test(parts[1]) || Number(parts[1]) > maximum) {
      throw new TypeError(`Invalid fakeIpRanges CIDR: ${cidr}`)
    }
    const block = new BlockList()
    block.addSubnet(parts[0], Number(parts[1]), family === 4 ? 'ipv4' : 'ipv6')
    return { family, block }
  })
}

export function assertResolverSupport(provider, resolver) {
  if (Reflect.get(provider, 'resolveAddresses') !== resolver) {
    throw new Error('Unsupported HTTP fetch implementation: custom address resolver is unavailable; this demo only supports the inspected Desktop build')
  }
}

function abortReason(signal) {
  return signal.reason ?? new DOMException('The operation was aborted', 'AbortError')
}

export async function resolveFakeIpAddresses(hostname, signal, ranges, lookup = systemLookup) {
  if (signal.aborted) throw abortReason(signal)
  const unbracketed = hostname.replace(/^\[|\]$/g, '')
  if (isIP(unbracketed) !== 0) throw new FakeIpPolicyError('Fake-IP compatibility only permits DNS answers, not IP literals')
  if (ranges.length === 0) throw new FakeIpPolicyError('No Fake-IP DNS ranges are enabled')
  const addresses = await new Promise((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal))
    signal.addEventListener('abort', onAbort, { once: true })
    Promise.resolve().then(() => lookup(hostname, { all: true, order: 'verbatim' }))
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', onAbort))
  })
  if (signal.aborted) throw abortReason(signal)
  if (addresses.length === 0) throw new FakeIpPolicyError(`Hostname "${hostname}" resolved to no Fake-IP answers`)
  for (const entry of addresses) {
    if ((entry.family !== 4 && entry.family !== 6) || isIP(entry.address) !== entry.family
      || !ranges.some(range => range.family === entry.family
        && range.block.check(entry.address, entry.family === 4 ? 'ipv4' : 'ipv6'))) {
      throw new FakeIpPolicyError(`Hostname "${hostname}" has an answer outside the configured Fake-IP ranges`)
    }
  }
  return addresses.map(({ address, family }) => ({ address, family }))
}
