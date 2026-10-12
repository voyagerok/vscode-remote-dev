import * as crypto from 'crypto';

export type HostKeyStatus = 'match' | 'mismatch' | 'revoked' | 'unknown';

/** Name used in known_hosts: `host` for port 22, `[host]:port` otherwise. */
export function knownHostsName(host: string, port: number): string {
  return port === 22 ? host : `[${host}]:${port}`;
}

/** Key algorithm name embedded at the start of an SSH public key blob. */
export function keyType(blob: Buffer): string {
  if (blob.length < 4) return '';
  const len = blob.readUInt32BE(0);
  return blob.subarray(4, 4 + len).toString('ascii');
}

export function fingerprintSha256(blob: Buffer): string {
  return 'SHA256:' + crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, '');
}

function globToRegExp(pattern: string): RegExp {
  const re = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${re}$`, 'i');
}

function hostFieldMatches(field: string, name: string): boolean {
  if (field.startsWith('|1|')) {
    const [, , salt, hash] = field.split('|');
    if (!salt || !hash) return false;
    const h = crypto.createHmac('sha1', Buffer.from(salt, 'base64')).update(name).digest('base64');
    return h === hash;
  }
  let matched = false;
  for (const pat of field.split(',')) {
    if (pat.startsWith('!')) {
      if (globToRegExp(pat.slice(1)).test(name)) return false;
    } else if (globToRegExp(pat).test(name)) {
      matched = true;
    }
  }
  return matched;
}

/**
 * Check a server key against known_hosts content. `names` are the candidate host names
 * (e.g. the alias's HostName and its IP form), each already in `knownHostsName` format.
 */
export function checkHostKey(content: string, names: string[], blob: Buffer): HostKeyStatus {
  const type = keyType(blob);
  const b64 = blob.toString('base64');
  let sawSameTypeDifferentKey = false;
  let matched = false;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const fields = line.split(/\s+/);
    let marker: string | undefined;
    if (fields[0].startsWith('@')) marker = fields.shift();
    if (fields.length < 3) continue;
    const [hosts, ktype, key] = fields;
    if (marker === '@cert-authority') continue;
    if (!names.some((n) => hostFieldMatches(hosts, n))) continue;

    if (marker === '@revoked') {
      if (key === b64) return 'revoked';
      continue;
    }
    if (ktype !== type) continue;
    if (key === b64) matched = true;
    else sawSameTypeDifferentKey = true;
  }
  if (matched) return 'match';
  return sawSameTypeDifferentKey ? 'mismatch' : 'unknown';
}

export function knownHostsLine(name: string, blob: Buffer): string {
  return `${name} ${keyType(blob)} ${blob.toString('base64')}`;
}
