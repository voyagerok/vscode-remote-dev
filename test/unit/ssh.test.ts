import * as assert from 'assert';
import * as crypto from 'crypto';
import { checkHostKey, fingerprintSha256, keyType, knownHostsLine, knownHostsName } from '../../src/ssh/knownHosts';
import { resolveHost } from '../../src/ssh/sshConfig';

function blob(type: string, body: string): Buffer {
  const t = Buffer.from(type);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(t.length);
  return Buffer.concat([len, t, Buffer.from(body)]);
}

describe('known_hosts', () => {
  const key = blob('ssh-ed25519', 'KEY1');
  const other = blob('ssh-ed25519', 'KEY2');
  const rsa = blob('ssh-rsa', 'RSA');

  it('extracts key type and fingerprint', () => {
    assert.strictEqual(keyType(key), 'ssh-ed25519');
    assert.match(fingerprintSha256(key), /^SHA256:[A-Za-z0-9+/]+$/);
  });

  it('matches plain, port and pattern entries', () => {
    assert.strictEqual(checkHostKey(knownHostsLine('h1', key), ['h1'], key), 'match');
    assert.strictEqual(checkHostKey(`[h1]:2222 ${keyType(key)} ${key.toString('base64')}`, [knownHostsName('h1', 2222)], key), 'match');
    assert.strictEqual(checkHostKey(`*.lan,!bad.lan ssh-ed25519 ${key.toString('base64')}`, ['box.lan'], key), 'match');
    assert.strictEqual(checkHostKey(`*.lan,!bad.lan ssh-ed25519 ${key.toString('base64')}`, ['bad.lan'], key), 'unknown');
  });

  it('matches hashed entries', () => {
    const salt = crypto.randomBytes(20);
    const hash = crypto.createHmac('sha1', salt).update('h1').digest('base64');
    const line = `|1|${salt.toString('base64')}|${hash} ssh-ed25519 ${key.toString('base64')}`;
    assert.strictEqual(checkHostKey(line, ['h1'], key), 'match');
    assert.strictEqual(checkHostKey(line, ['h2'], key), 'unknown');
  });

  it('detects changed keys of the same type only', () => {
    assert.strictEqual(checkHostKey(knownHostsLine('h1', other), ['h1'], key), 'mismatch');
    assert.strictEqual(checkHostKey(knownHostsLine('h1', rsa), ['h1'], key), 'unknown');
  });

  it('honours @revoked', () => {
    assert.strictEqual(checkHostKey(`@revoked h1 ssh-ed25519 ${key.toString('base64')}\n${knownHostsLine('h1', key)}`, ['h1'], key), 'revoked');
  });
});

describe('resolveHost', () => {
  const cfg = `
Host dev
  HostName 10.0.0.5
  User alice
  Port 2200
  IdentityFile ~/.ssh/dev_key
  ProxyJump bastion

Host *
  User fallback
`;
  it('applies ssh config', () => {
    const r = resolveHost('dev', {}, cfg);
    assert.strictEqual(r.hostName, '10.0.0.5');
    assert.strictEqual(r.user, 'alice');
    assert.strictEqual(r.port, 2200);
    assert.strictEqual(r.proxyJump, 'bastion');
    assert.ok(r.identityFiles[0].endsWith('dev_key'));
  });
  it('parses user@host:port and lets overrides win', () => {
    const r = resolveHost('bob@box:2022', {}, cfg);
    assert.deepStrictEqual([r.user, r.hostName, r.port], ['bob', 'box', 2022]);
    assert.strictEqual(resolveHost('dev', { user: 'carol', port: 22 }, cfg).user, 'carol');
    assert.strictEqual(resolveHost('other', {}, cfg).user, 'fallback');
  });
});
