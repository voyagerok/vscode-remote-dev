import * as assert from 'assert';
import { LocalEntry } from '../../src/sync/fileSet';
import { RemoteEntry, dirsToPrune, parseFindOutput, parseSha1sumZ, planSync, pruneExpressions } from '../../src/sync/planner';

const T = 1_700_000_000_000;
const local = (rel: string, size = 10, mtimeMs = T + 400, mode = 0o644): LocalEntry => ({ rel, kind: 'file', size, mtimeMs, mode });
const remote = (rel: string, size = 10, mtime = T / 1000, mode = 0o100644): RemoteEntry => ({ rel, kind: 'file', size, mtime, mode });
const noIgnore = { deleteOrphans: true, isIgnored: () => false };

describe('planSync', () => {
  it('uploads new files and skips identical ones (whole-second mtime)', () => {
    const p = planSync([local('a.c'), local('b.c')], [remote('a.c')], noIgnore);
    assert.deepStrictEqual(p.upload.map((e) => e.rel), ['b.c']);
    assert.deepStrictEqual(p.delete, []);
  });

  it('uploads on size or mtime change', () => {
    const p = planSync([local('a.c', 11), local('b.c', 10, T + 2000)], [remote('a.c'), remote('b.c')], noIgnore);
    assert.deepStrictEqual(p.upload.map((e) => e.rel), ['a.c', 'b.c']);
  });

  it('chmods when only the mode differs', () => {
    const p = planSync([local('run.sh', 10, T, 0o755)], [remote('run.sh')], noIgnore);
    assert.deepStrictEqual(p.upload, []);
    assert.deepStrictEqual(p.chmod.map((e) => e.rel), ['run.sh']);
  });

  it('deletes orphans but never ignored remote paths', () => {
    const p = planSync([local('a.c')], [remote('a.c'), remote('old.c'), remote('cmake-build-debug/x.o')], {
      deleteOrphans: true,
      isIgnored: (r) => r.startsWith('cmake-build-'),
    });
    assert.deepStrictEqual(p.delete, ['old.c']);
  });

  it('keeps orphans when deletion is disabled', () => {
    const p = planSync([], [remote('old.c')], { deleteOrphans: false, isIgnored: () => false });
    assert.deepStrictEqual(p.delete, []);
  });

  it('compares hashes in force mode', () => {
    const r = [{ ...remote('a.c'), sha1: 'x' }, { ...remote('b.c'), sha1: 'y' }];
    const p = planSync([local('a.c'), local('b.c')], r, { ...noIgnore, byHash: true, localHashes: new Map([['a.c', 'x'], ['b.c', 'z']]) });
    assert.deepStrictEqual(p.upload.map((e) => e.rel), ['b.c']);
  });

  it('replaces symlinks whose target changed and files that became symlinks', () => {
    const l: LocalEntry[] = [
      { rel: 'l1', kind: 'symlink', size: 0, mtimeMs: T, mode: 0o777, linkTarget: 'a' },
      { rel: 'l2', kind: 'symlink', size: 0, mtimeMs: T, mode: 0o777, linkTarget: 'b' },
    ];
    const r: RemoteEntry[] = [
      { rel: 'l1', kind: 'symlink', size: 1, mtime: 0, mode: 0o777, linkTarget: 'a' },
      { rel: 'l2', kind: 'file', size: 1, mtime: 0, mode: 0o644 },
    ];
    assert.deepStrictEqual(planSync(l, r, noIgnore).upload.map((e) => e.rel), ['l2']);
  });
});

describe('remote listing parsers', () => {
  it('parses find -printf output', () => {
    const buf = Buffer.from(
      ['./src/a.c', '12', '1700000000.5', '644', 'f', '', 'scope/link', '0', '1700000001.0', '777', 'l', '../a.c', ''].join('\0'),
    );
    const r = parseFindOutput(buf);
    assert.strictEqual(r.length, 2);
    assert.deepStrictEqual(r[0], { rel: 'src/a.c', size: 12, mtime: 1700000000.5, mode: 0o644, kind: 'file', linkTarget: undefined });
    assert.strictEqual(r[1].rel, 'scope/link');
    assert.strictEqual(r[1].kind, 'symlink');
    assert.strictEqual(r[1].linkTarget, '../a.c');
  });

  it('handles file names with spaces and newlines', () => {
    const r = parseFindOutput(Buffer.from(['./we ird\nname.c', '1', '1', '644', 'f', '', ''].join('\0')));
    assert.strictEqual(r[0].rel, 'we ird\nname.c');
  });

  it('parses sha1sum -z output', () => {
    const h = 'a'.repeat(40);
    const m = parseSha1sumZ(Buffer.from(`${h}  ./x/y.c\0${'b'.repeat(40)}  z\0`));
    assert.strictEqual(m.get('x/y.c'), h);
    assert.strictEqual(m.get('z'), 'b'.repeat(40));
  });
});

describe('pruneExpressions', () => {
  it('converts simple dir patterns only', () => {
    assert.deepStrictEqual(pruneExpressions(['.git/', '/build*/', 'src/gen/', '*.o', '!keep/', '/out/']), [
      ['-name', '.git'],
      ['-path', './build*'],
      ['-path', './out'],
    ]);
  });
});

describe('dirsToPrune', () => {
  it('lists parent dirs missing locally, deepest first', () => {
    const exists = new Set(['src']);
    const r = dirsToPrune(['src/old/deep/a.c', 'src/b.c', 'gone/x.c'], (d) => exists.has(d));
    assert.deepStrictEqual(r, ['src/old/deep', 'src/old', 'gone']);
  });
});
