import * as assert from 'assert';
import { StreamRewriter, rewriteText, toLocalPath } from '../../src/build/pathRewriter';

const maps = [
  { remote: '/home/u/proj', local: 'C:\\work\\proj' },
  { remote: '/usr/include', local: '/cache/usr/include' },
];

describe('rewriteText', () => {
  it('rewrites gcc diagnostics', () => {
    assert.strictEqual(
      rewriteText('/home/u/proj/src/a.cpp:10:5: error: x\n', maps),
      'C:\\work\\proj/src/a.cpp:10:5: error: x\n',
    );
  });

  it('respects path boundaries', () => {
    assert.strictEqual(rewriteText('/home/u/project2/a.c', maps), '/home/u/project2/a.c');
    assert.strictEqual(rewriteText('"/home/u/proj"', maps), '"C:\\work\\proj"');
  });

  it('prefers the longest mapping', () => {
    const m = [...maps, { remote: '/home/u/proj/build', local: '/gen' }];
    assert.strictEqual(rewriteText('/home/u/proj/build/x.h /home/u/proj/y.h', m), '/gen/x.h C:\\work\\proj/y.h');
  });

  it('maps single paths', () => {
    assert.strictEqual(toLocalPath('/usr/include/stdio.h', maps), '/cache/usr/include/stdio.h');
    assert.strictEqual(toLocalPath('/usr/include2/x', maps), undefined);
  });
});

describe('StreamRewriter', () => {
  it('handles matches split across chunks', () => {
    const text = 'In file included from /home/u/proj/src/a.cpp:1:\n/usr/include/stdio.h:3: note\n';
    for (let split = 1; split < text.length; split++) {
      const rw = new StreamRewriter(maps);
      const out = rw.push(text.slice(0, split)) + rw.push(text.slice(split)) + rw.end();
      assert.strictEqual(out, rewriteText(text, maps), `split at ${split}`);
    }
  });

  it('emits partial lines that cannot contain a match', () => {
    const rw = new StreamRewriter(maps);
    assert.strictEqual(rw.push('[ 50%] Building'), '[ 50%] Building');
  });
});
