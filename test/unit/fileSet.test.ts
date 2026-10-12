import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DEFAULT_EXCLUDES } from '../../src/config/profile';
import { enumerate, toRel } from '../../src/sync/fileSet';
import { IgnoreTree } from '../../src/sync/ignoreTree';

describe('enumerate + IgnoreTree', () => {
  let root: string;
  const write = (rel: string, content = 'x') => {
    const abs = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  };

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-fs-'));
    write('CMakeLists.txt');
    write('src/main.cpp');
    write('src/gen/out.h');
    write('src/keep.log');
    write('src/drop.log');
    write('src/.gitignore', 'gen/\n');
    write('.gitignore', '*.log\n!keep.log\n');
    write('.git/HEAD');
    write('cmake-build-debug/x.o');
    write('build/y.o');
    write('docs/build/page.md');
    write('tools/run.sh', '#!/bin/sh');
    fs.chmodSync(path.join(root, 'tools/run.sh'), 0o755);
    if (process.platform !== 'win32') fs.symlinkSync('main.cpp', path.join(root, 'src/link.cpp'));
  });
  after(() => fs.rmSync(root, { recursive: true, force: true }));

  it('applies default excludes and nested .gitignore files', async () => {
    const ig = new IgnoreTree(root, DEFAULT_EXCLUDES, true);
    const rels = (await enumerate({ root, ignore: ig })).map((e) => e.rel);
    const expected = ['.gitignore', 'CMakeLists.txt', 'docs/build/page.md', 'src/.gitignore', 'src/keep.log', 'src/main.cpp', 'tools/run.sh'];
    if (process.platform !== 'win32') expected.push('src/link.cpp');
    assert.deepStrictEqual(rels, expected.sort());
  });

  it('can ignore .gitignore files entirely', async () => {
    const ig = new IgnoreTree(root, DEFAULT_EXCLUDES, false);
    const rels = (await enumerate({ root, ignore: ig })).map((e) => e.rel);
    assert.ok(rels.includes('src/drop.log'));
    assert.ok(rels.includes('src/gen/out.h'));
  });

  it('records exec bits and symlinks', async () => {
    const ig = new IgnoreTree(root, DEFAULT_EXCLUDES, true);
    const all = await enumerate({ root, ignore: ig });
    assert.strictEqual(all.find((e) => e.rel === 'tools/run.sh')?.mode, 0o755);
    assert.strictEqual(all.find((e) => e.rel === 'src/main.cpp')?.mode, 0o644);
    if (process.platform !== 'win32') {
      const l = all.find((e) => e.rel === 'src/link.cpp');
      assert.strictEqual(l?.kind, 'symlink');
      assert.strictEqual(l?.linkTarget, 'main.cpp');
    }
  });

  it('supports scopes', async () => {
    const ig = new IgnoreTree(root, DEFAULT_EXCLUDES, true);
    assert.deepStrictEqual((await enumerate({ root, ignore: ig, scope: 'tools' })).map((e) => e.rel), ['tools/run.sh']);
    assert.deepStrictEqual((await enumerate({ root, ignore: ig, scope: 'src/main.cpp' })).map((e) => e.rel), ['src/main.cpp']);
    assert.deepStrictEqual(await enumerate({ root, ignore: ig, scope: 'build' }), []);
  });

  it('answers ignore queries for watcher events', () => {
    const ig = new IgnoreTree(root, DEFAULT_EXCLUDES, true);
    assert.strictEqual(ig.isIgnored('cmake-build-debug/CMakeFiles/a.o'), true);
    assert.strictEqual(ig.isIgnored('src/gen/new.h'), true);
    assert.strictEqual(ig.isIgnored('src/new.cpp'), false);
    assert.strictEqual(ig.isIgnored('.git/index'), true);
  });

  it('converts paths', () => {
    assert.strictEqual(toRel(root, path.join(root, 'a', 'b.c')), 'a/b.c');
    assert.strictEqual(toRel(root, root), '');
    assert.strictEqual(toRel(root, path.dirname(root)), undefined);
  });
});
