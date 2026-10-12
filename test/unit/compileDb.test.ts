import * as assert from 'assert';
import {
  dirsToMirror,
  intelliSenseMode,
  normalizeStd,
  parseDefines,
  parseFlags,
  parseIncludeSearch,
  rewriteCompileDb,
  splitCommand,
} from '../../src/intellisense/compileDb';

describe('splitCommand', () => {
  it('splits with quotes and escapes', () => {
    assert.deepStrictEqual(splitCommand(`g++ -DNAME=\\"x\\" -I"/a b" 'c d' e\\ f -o x.o`), [
      'g++', '-DNAME="x"', '-I/a b', 'c d', 'e f', '-o', 'x.o',
    ]);
  });
  it('keeps empty quoted args', () => {
    assert.deepStrictEqual(splitCommand(`a "" b`), ['a', '', 'b']);
  });
});

describe('parseFlags', () => {
  it('extracts includes, defines, std and resolves relative dirs', () => {
    const f = parseFlags({
      directory: '/r/build',
      file: '../src/main.cpp',
      command: '/usr/bin/c++ -I../include -isystem /opt/x/include -iquote q -D FOO=1 -DBAR -std=gnu++2a -include ../pch.h -c ../src/main.cpp',
    });
    assert.strictEqual(f.compiler, '/usr/bin/c++');
    assert.strictEqual(f.language, 'c++');
    assert.deepStrictEqual(f.include, ['/r/include']);
    assert.deepStrictEqual(f.system, ['/opt/x/include']);
    assert.deepStrictEqual(f.quote, ['/r/build/q']);
    assert.deepStrictEqual(f.defines, ['FOO=1', 'BAR']);
    assert.deepStrictEqual(f.forced, ['/r/pch.h']);
    assert.strictEqual(normalizeStd(f.std), 'gnu++20');
  });
  it('detects C', () => {
    assert.strictEqual(parseFlags({ directory: '/', file: 'a.c', arguments: ['/usr/bin/gcc', '-c', 'a.c'] }).language, 'c');
  });
});

describe('compiler query parsing', () => {
  it('parses -v include search list', () => {
    const out = [
      'ignoring nonexistent directory "/usr/local/include/x86_64-linux-gnu"',
      '#include "..." search starts here:',
      '#include <...> search starts here:',
      ' /usr/include/c++/12',
      ' /usr/lib/gcc/x86_64-linux-gnu/12/../../../../include/c++/12/backward',
      ' /usr/include',
      'End of search list.',
    ].join('\n');
    assert.deepStrictEqual(parseIncludeSearch(out), {
      quote: [],
      system: ['/usr/include/c++/12', '/usr/include/c++/12/backward', '/usr/include'],
    });
  });
  it('parses -dM defines and drops std-dependent ones', () => {
    assert.deepStrictEqual(parseDefines('#define __GNUC__ 12\n#define __cplusplus 201703L\n#define __linux 1\n#define _GNU_SOURCE'), [
      '__GNUC__=12',
      '__linux=1',
      '_GNU_SOURCE',
    ]);
  });
  it('maps triples to IntelliSense modes', () => {
    assert.strictEqual(intelliSenseMode('x86_64-linux-gnu', false), 'linux-gcc-x64');
    assert.strictEqual(intelliSenseMode('aarch64-linux-gnu', true), 'linux-clang-arm64');
    assert.strictEqual(intelliSenseMode('arm-linux-gnueabihf', false), 'linux-gcc-arm');
  });
});

describe('rewriteCompileDb / dirsToMirror', () => {
  it('rewrites paths', () => {
    const db = rewriteCompileDb(
      [{ directory: '/r/build', file: '/r/src/a.c', arguments: ['cc', '-I/r/inc', '-I/usr/include/x', '-c', '/r/src/a.c'] }],
      [{ remote: '/r', local: '/l' }, { remote: '/usr/include', local: '/c/usr/include' }],
    );
    assert.deepStrictEqual(db[0], {
      directory: '/l/build',
      file: '/l/src/a.c',
      arguments: ['cc', '-I/l/inc', '-I/c/usr/include/x', '-c', '/l/src/a.c'],
    });
  });

  it('selects system dirs and unsynced project dirs', () => {
    const flags = [parseFlags({ directory: '/r/b', file: 'x.c', arguments: ['cc', '-I/r/src', '-I/r/b/gen', '-I/opt/sdk/inc', '-I/usr/include/glib'] })];
    const r = dirsToMirror(flags, ['/usr/include', '/usr/lib/gcc/12/include'], '/r', (rel) => rel === 'src');
    assert.deepStrictEqual(r, {
      system: ['/opt/sdk/inc', '/usr/include', '/usr/lib/gcc/12/include'],
      project: ['/r/b/gen'],
    });
  });
});
