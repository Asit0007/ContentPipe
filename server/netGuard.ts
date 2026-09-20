import dns from 'node:dns/promises';
import net from 'node:net';

/**
 * SSRF guard for user-supplied source URLs.
 *
 * /api/research fetches whatever URL a caller supplies — or any URL found in a
 * pasted message — and follows redirects. Without a guard, a story that links to
 * http://169.254.169.254/ (cloud metadata) or a LAN address makes this server
 * read it and feed the response to the model. Every hop is checked, including
 * redirect targets.
 *
 * Known residual risk: DNS rebinding. The name is resolved here and again by
 * fetch(), so a hostile resolver could answer differently the second time. Closing
 * that needs a pinned-IP dispatcher (undici, not a dependency today); with the
 * server bound to loopback by default the exposure is a local, single-user one.
 */

export class BlockedUrlError extends Error {
  constructor(reason: string) {
    super(`Blocked: ${reason}`);
    this.name = 'BlockedUrlError';
  }
}

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((n, part) => n * 256 + Number(part), 0);
}

// [base, prefixLength] — reserved, private, link-local, loopback, multicast and documentation ranges.
const BLOCKED_V4: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, incl. the 169.254.169.254 metadata endpoint
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
];

function isBlockedV4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  return BLOCKED_V4.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return ((n & mask) >>> 0) === ((ipv4ToInt(base) & mask) >>> 0);
  });
}

/** Expands any IPv6 text form (incl. `::` and an embedded dotted quad) to 8 hextets. */
function expandV6(ip: string): number[] | null {
  let s = ip.toLowerCase().split('%')[0]; // drop zone id
  const dotted = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const p = dotted[2].split('.').map(Number);
    if (p.some((x) => x > 255)) return null;
    s = `${dotted[1]}${((p[0] << 8) | p[1]).toString(16)}:${((p[2] << 8) | p[3]).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  const out = groups.map((g) => parseInt(g || '0', 16));
  return out.length === 8 && out.every((n) => Number.isFinite(n) && n >= 0 && n <= 0xffff) ? out : null;
}

function isBlockedV6(ip: string): boolean {
  const h = expandV6(ip);
  if (!h) return true; // unparseable → refuse rather than guess
  const [a, b, c, d, e, f, g, hh] = h;
  if (h.every((x) => x === 0)) return true; // ::
  if (h.slice(0, 7).every((x) => x === 0) && hh === 1) return true; // ::1
  if ((a & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((a & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((a & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (a === 0x2001 && b === 0x0db8) return true; // documentation
  // IPv4 carried inside IPv6: v4-mapped ::ffff:a.b.c.d and NAT64 64:ff9b::a.b.c.d
  const embeddedV4 = `${g >> 8}.${g & 255}.${hh >> 8}.${hh & 255}`;
  const mapped = a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0xffff;
  const nat64 = a === 0x0064 && b === 0xff9b && c === 0 && d === 0 && e === 0 && f === 0;
  if (mapped || nat64) return isBlockedV4(embeddedV4);
  return false;
}

/** True for any address a public web fetch has no business reaching. Unparseable input counts as blocked. */
export function isBlockedIp(ip: string): boolean {
  if (net.isIPv4(ip)) return isBlockedV4(ip);
  if (net.isIPv6(ip)) return isBlockedV6(ip);
  return true;
}

type Lookup = (host: string, opts: { all: true }) => Promise<Array<{ address: string }>>;

/**
 * Throws BlockedUrlError unless the URL is http(s) on a standard port whose host
 * is — or resolves ONLY to — public addresses. A name with even one private answer
 * is refused: an attacker controls which record wins the race at connect time.
 */
export async function assertPublicUrl(rawUrl: string, lookup: Lookup = dns.lookup as unknown as Lookup): Promise<void> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new BlockedUrlError('malformed URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new BlockedUrlError(`protocol ${u.protocol} is not allowed`);

  // The WHATWG parser has already canonicalised decimal/hex/octal IPv4 forms (http://2130706433/ → 127.0.0.1).
  const host = u.hostname.replace(/^\[|\]$/g, '');
  // Reported before the port check: it is the more informative reason for e.g. localhost:3100.
  if (host === 'localhost' || host.endsWith('.localhost')) throw new BlockedUrlError('localhost is not allowed');
  if (u.port && u.port !== '80' && u.port !== '443') throw new BlockedUrlError(`port ${u.port} is not allowed (only 80/443)`);

  if (net.isIP(host)) {
    if (isBlockedIp(host)) throw new BlockedUrlError(`${host} is a private or reserved address`);
    return;
  }

  let answers: Array<{ address: string }>;
  try {
    answers = await lookup(host, { all: true });
  } catch (err: any) {
    throw new BlockedUrlError(`DNS lookup for ${host} failed (${err?.code || err?.message || 'error'})`);
  }
  if (answers.length === 0) throw new BlockedUrlError(`${host} did not resolve`);
  const bad = answers.find((a) => isBlockedIp(a.address));
  if (bad) throw new BlockedUrlError(`${host} resolves to a private or reserved address (${bad.address})`);
}
