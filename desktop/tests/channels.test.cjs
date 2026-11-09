const test = require('node:test')
const assert = require('node:assert/strict')
const { channelConfig, nightlyVersion } = require('../channels.cjs')

test('stable and nightly apps have distinct OS identities and ports', () => {
  const stable = channelConfig('stable'), nightly = channelConfig('nightly')
  assert.equal(stable.bundleId, 'dev.snip.desktop')
  assert.equal(nightly.name, 'Snip Dev')
  assert.notEqual(stable.bundleId, nightly.bundleId)
  assert.notEqual(stable.port, nightly.port)
  assert.throws(() => channelConfig('preview'), /Unknown/)
  assert.throws(() => channelConfig('__proto__'), /Unknown/)
})

test('nightly build numbers are positive, ordered, numeric versions', () => {
  assert.equal(nightlyVersion('42'), '0.0.42')
  for (const value of ['', '0', '-1', '01', '1.2', '1-beta', '9007199254740992']) assert.throws(() => nightlyVersion(value))
})
