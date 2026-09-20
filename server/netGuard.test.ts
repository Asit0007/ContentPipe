import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBlockedIp, assertPublicUrl, BlockedUrlError } from './netGuard';

const resolvesTo = (...addrs: string[]) => async () => addrs.map((address) => ({ address }));

test('IPv4: private, loopback, link-local/metadata, CGNAT, multicast, reserved are blocked', () => {
  for (const ip of ['127.0.0.1', '127.255.255.254', '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '100.127.255.255', '0.0.0.0', '224.0.0.1', '255.255.255.255', '198.18.0.1', '192.0.0.1']) {
    assert.equal(isBlockedIp(ip), true, ip);
  }
});

test('IPv4: ordinary public addresses — including range edges — are allowed', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.255.255', '172.32.0.1', '100.63.255.255', '100.128.0.1', '11.0.0.1', '192.169.0.1']) {
    assert.equal(isBlockedIp(ip), false, ip);
  }
});

test('IPv6: loopback, unspecified, ULA, link-local, multicast, documentation are blocked', () => {
  for (const ip of ['::1', '::', 'fe80::1', 'fd00::1', 'fc00::', 'ff02::1', '2001:db8::1', '0:0:0:0:0:0:0:1']) {
    assert.equal(isBlockedIp(ip), true, ip);
  }
});

test('IPv6: an IPv4 hidden inside (v4-mapped, hex form, NAT64) is judged as that IPv4', () => {
  assert.equal(isBlockedIp('::ffff:127.0.0.1'), true);
  assert.equal(isBlockedIp('::ffff:7f00:1'), true);
  assert.equal(isBlockedIp('::ffff:10.0.0.1'), true);
  assert.equal(isBlockedIp('64:ff9b::7f00:1'), true);
  assert.equal(isBlockedIp('::ffff:8.8.8.8'), false);
  assert.equal(isBlockedIp('64:ff9b::808:808'), false);
});

test('IPv6: ordinary public addresses are allowed; garbage is refused', () => {
  assert.equal(isBlockedIp('2606:4700:4700::1111'), false);
  assert.equal(isBlockedIp('2001:4860:4860::8888'), false);
  assert.equal(isBlockedIp('not-an-ip'), true);
  assert.equal(isBlockedIp(''), true);
});

test('assertPublicUrl: literal private/metadata/loopback hosts are refused without any DNS', async () => {
  const neverCalled = async () => {
    throw new Error('DNS should not be consulted for a literal IP');
  };
  for (const u of ['http://169.254.169.254/latest/meta-data/', 'http://127.0.0.1/', 'http://[::1]/', 'http://10.1.2.3/x', 'http://[::ffff:127.0.0.1]/']) {
    await assert.rejects(assertPublicUrl(u, neverCalled), BlockedUrlError, u);
  }
});

test('assertPublicUrl: numeric IPv4 tricks are canonicalised by the URL parser, then blocked', async () => {
  for (const u of ['http://2130706433/', 'http://0x7f.1/', 'http://0177.0.0.1/', 'http://127.1/']) {
    await assert.rejects(assertPublicUrl(u, resolvesTo('93.184.216.34')), BlockedUrlError, u);
  }
});

test('assertPublicUrl: localhost names and non-standard ports are refused', async () => {
  await assert.rejects(assertPublicUrl('http://localhost:3100/api/health', resolvesTo('93.184.216.34')), /localhost/);
  await assert.rejects(assertPublicUrl('http://app.localhost/', resolvesTo('93.184.216.34')), /localhost/);
  await assert.rejects(assertPublicUrl('https://example.com:8443/', resolvesTo('93.184.216.34')), /port 8443/);
  await assert.rejects(assertPublicUrl('ftp://example.com/', resolvesTo('93.184.216.34')), /protocol/);
});

test('assertPublicUrl: a public name passes; standard ports pass', async () => {
  await assertPublicUrl('https://example.com/article', resolvesTo('93.184.216.34'));
  await assertPublicUrl('http://example.com:80/x', resolvesTo('93.184.216.34'));
  await assertPublicUrl('https://example.com:443/x', resolvesTo('2606:2800:220:1:248:1893:25c8:1946'));
});

test('assertPublicUrl: ONE private answer among public ones is enough to refuse (rebinding-style multi-record)', async () => {
  await assert.rejects(assertPublicUrl('https://evil.example/', resolvesTo('93.184.216.34', '10.0.0.7')), /resolves to a private/);
  await assert.rejects(assertPublicUrl('https://evil.example/', resolvesTo('93.184.216.34', '::1')), /resolves to a private/);
});

test('assertPublicUrl: DNS failure is reported as a block, not thrown raw', async () => {
  const nx = async () => {
    throw Object.assign(new Error('nope'), { code: 'ENOTFOUND' });
  };
  await assert.rejects(assertPublicUrl('https://nx.example/', nx), (e: any) => e instanceof BlockedUrlError && /ENOTFOUND/.test(e.message));
});
