import * as assert from 'assert';
import { parseJsonc } from '../../src/config/jsonc';
import { normalizeProfile, resolveBuildDir, shq } from '../../src/config/profile';
import { loginShell } from '../../src/ssh/remoteShell';

describe('profile', () => {
  it('fills defaults', () => {
    const p = normalizeProfile({ name: 'a', host: 'h' }, 'My Proj', '/x/My Proj');
    assert.match(p.remoteRoot, /^~\/\.remote-dev\/My_Proj-[0-9a-f]{8}$/);
    assert.strictEqual(p.build.kind, 'cmake');
    assert.strictEqual(resolveBuildDir(p, '/r', 'Debug'), '/r/cmake-build-debug');
    assert.ok(p.exclude.includes('.git/'));
  });
  it('rejects dangerous remote roots', () => {
    for (const remoteRoot of ['/', '~', '~/', 'relative/dir']) {
      assert.throws(() => normalizeProfile({ name: 'a', host: 'h', remoteRoot }, 'p', '/p'), remoteRoot);
    }
  });
  it('requires a build command for custom builds', () => {
    assert.throws(() => normalizeProfile({ name: 'a', host: 'h', build: { kind: 'custom' } }, 'p', '/p'));
  });
});

describe('shell quoting', () => {
  it('quotes single quotes', () => {
    assert.strictEqual(shq(`it's`), `'it'\\''s'`);
  });
  it('builds a login shell command', () => {
    const c = loginShell('make', { cwd: '/r', envSetup: 'source /e.sh', env: { A: 'b c', 'bad-name': 'x' } });
    assert.ok(c.includes('bash -lc'));
    assert.ok(c.includes(`export A='\\''b c'\\''`));
    assert.ok(!c.includes('bad-name'));
  });
});

describe('parseJsonc', () => {
  it('accepts comments and trailing commas', () => {
    assert.deepStrictEqual(parseJsonc('{ // c\n "a": "x//y", /* b */ "b": [1,2,], }'), { a: 'x//y', b: [1, 2] });
  });
});
