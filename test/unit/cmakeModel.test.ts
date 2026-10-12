import * as assert from 'assert';
import { parseFileApiReply, parsePresets } from '../../src/build/cmakeModel';

function dump(files: Record<string, unknown>): Buffer {
  return Buffer.from(Object.entries(files).map(([n, c]) => `${n}\0${JSON.stringify(c)}\0`).join(''));
}

describe('parseFileApiReply', () => {
  it('returns targets with absolute artifacts', () => {
    const buf = dump({
      'index-2024.json': { objects: [{ kind: 'codemodel', jsonFile: 'codemodel-v2-1.json' }] },
      'index-2023.json': { objects: [] },
      'codemodel-v2-1.json': {
        paths: { build: '/r/build', source: '/r' },
        configurations: [{ name: 'Debug', targets: [{ name: 'app', jsonFile: 't1.json' }, { name: 'lib', jsonFile: 't2.json' }] }],
      },
      't1.json': { name: 'app', type: 'EXECUTABLE', artifacts: [{ path: 'bin/app' }] },
      't2.json': { name: 'lib', type: 'STATIC_LIBRARY', artifacts: [{ path: '/abs/liblib.a' }] },
    });
    assert.deepStrictEqual(parseFileApiReply(buf, '/r/build', 'Debug'), [
      { name: 'app', type: 'EXECUTABLE', artifacts: ['/r/build/bin/app'] },
      { name: 'lib', type: 'STATIC_LIBRARY', artifacts: ['/abs/liblib.a'] },
    ]);
  });

  it('returns [] without an index', () => {
    assert.deepStrictEqual(parseFileApiReply(Buffer.alloc(0), '/b'), []);
  });
});

describe('parsePresets', () => {
  it('resolves inherited binaryDir and build type with macros', () => {
    const info = parsePresets(
      {
        configurePresets: [
          { name: 'base', hidden: true, binaryDir: '${sourceDir}/out/${presetName}', cacheVariables: { CMAKE_BUILD_TYPE: 'Debug' } },
          { name: 'dev', inherits: 'base' },
          { name: 'rel', inherits: ['base'], cacheVariables: { CMAKE_BUILD_TYPE: { type: 'STRING', value: 'Release' } } },
        ],
      },
      { configurePresets: [{ name: 'mine', binaryDir: 'b' }] },
    );
    assert.deepStrictEqual(info.configurePresets, ['dev', 'rel', 'mine']);
    assert.deepStrictEqual(info.resolve('dev', '/r/p'), { binaryDir: '/r/p/out/dev', buildType: 'Debug' });
    assert.deepStrictEqual(info.resolve('rel', '/r/p'), { binaryDir: '/r/p/out/rel', buildType: 'Release' });
    assert.deepStrictEqual(info.resolve('mine', '/r/p'), { binaryDir: '/r/p/b', buildType: undefined });
  });
});
