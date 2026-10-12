// Integration tests against a real Linux host (see test/docker/Dockerfile).
// Skipped unless RD_TEST_HOST is set, e.g.
//   RD_TEST_HOST=dev@127.0.0.1:2222 RD_TEST_PASSWORD=dev npm run test:remote

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createBuilder } from '../../src/build/builder';
import { normalizeProfile, shq } from '../../src/config/profile';
import { refreshIntelliSense } from '../../src/intellisense/intellisense';
import { Logger } from '../../src/log';
import { Prompter, SshConnection } from '../../src/ssh/connection';
import { loginShell } from '../../src/ssh/remoteShell';
import { IgnoreTree } from '../../src/sync/ignoreTree';
import { SyncService } from '../../src/sync/syncService';

const HOST = process.env.RD_TEST_HOST;
const log: Logger = process.env.RD_TEST_VERBOSE
  ? { info: console.log, warn: console.warn, error: console.error, debug: console.log }
  : { info() {}, warn() {}, error() {}, debug() {} };

const prompter: Prompter = {
  password: async () => process.env.RD_TEST_PASSWORD,
  forgetPassword: async () => undefined,
  passphrase: async () => undefined,
  keyboardInteractive: async (_n, _i, prompts) => prompts.map(() => process.env.RD_TEST_PASSWORD ?? ''),
  confirmHostKey: async () => true,
  hostKeyChanged: async () => false,
};

function copyDir(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

(HOST ? describe : describe.skip)('remote integration', function () {
  this.timeout(180000);
  let tmp: string;
  let local: string;
  let conn: SshConnection;
  let sync: SyncService;
  let remoteRoot: string;
  const profile = () => normalizeProfile({ name: 't', host: HOST!, remoteRoot: '~/rd-it' }, 'hello', local);
  const remoteLs = async () =>
    (await conn.check(`cd ${shq(remoteRoot)} && find . -path ./cmake-build-debug -prune -o -type f -print | sort`)).stdout
      .toString()
      .trim()
      .split('\n')
      .map((l) => l.slice(2));
  const write = (rel: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(local, rel)), { recursive: true });
    fs.writeFileSync(path.join(local, rel), content);
  };

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-it-'));
    local = path.join(tmp, 'hello');
    copyDir(path.join(__dirname, '..', '..', '..', 'test', 'fixtures', 'hello-cmake'), local);
    conn = new SshConnection(HOST!, {}, prompter, log, { knownHostsFile: path.join(tmp, 'known_hosts'), sshConfigText: '' });
    await conn.connect();
    const p = profile();
    remoteRoot = conn.expand(p.remoteRoot);
    await conn.check(`rm -rf ${shq(remoteRoot)}`);
    sync = new SyncService(
      conn,
      { localRoot: local, remoteRoot, excludes: p.exclude, ignore: new IgnoreTree(local, p.exclude, true), deleteOrphans: true, debounceMs: 50 },
      log,
    );
  });

  after(async () => {
    await conn?.run(`rm -rf ${shq(remoteRoot)}`).catch(() => undefined);
    sync?.dispose();
    conn?.dispose();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('full sync uploads the project, honouring .gitignore', async () => {
    write('scratch.tmp', 'ignored');
    const r = await sync.fullSync();
    assert.strictEqual(r.uploaded, 6);
    assert.deepStrictEqual(await remoteLs(), [
      '.gitignore', 'CMakeLists.txt', 'config.h.in', 'include/greet.h', 'src/greet.cpp', 'src/main.cpp',
    ]);
    const again = await sync.fullSync();
    assert.deepStrictEqual(again, { uploaded: 0, deleted: 0, chmodded: 0 });
  });

  it('incremental sync handles change, create, delete, rename and dir moves', async () => {
    write('src/main.cpp', fs.readFileSync(path.join(local, 'src/main.cpp'), 'utf8') + '// edit\n');
    write('src/extra.cpp', 'int extra() { return 1; }\n');
    fs.rmSync(path.join(local, 'config.h.in'));
    fs.renameSync(path.join(local, 'include'), path.join(local, 'headers'));
    for (const [rel, kind] of [
      ['src/main.cpp', 'change'], ['src/extra.cpp', 'change'], ['config.h.in', 'delete'], ['include', 'delete'], ['headers', 'change'],
    ] as const) sync.notify(rel, kind);
    await sync.flush();
    assert.deepStrictEqual(await remoteLs(), ['.gitignore', 'CMakeLists.txt', 'headers/greet.h', 'src/extra.cpp', 'src/greet.cpp', 'src/main.cpp']);
    const main = (await conn.check(`cat ${shq(remoteRoot + '/src/main.cpp')}`)).stdout.toString();
    assert.ok(main.endsWith('// edit\n'));

    // restore fixture layout for the build tests
    fs.renameSync(path.join(local, 'headers'), path.join(local, 'include'));
    write('config.h.in', '#pragma once\n#define HELLO_GREETING "Hello from @PROJECT_NAME@"\n');
    fs.rmSync(path.join(local, 'src/extra.cpp'));
  });

  it('ensureSynced catches changes the watcher missed', async () => {
    const r = await sync.ensureSynced();
    assert.ok(r.uploaded >= 2 && r.deleted >= 1, JSON.stringify(r));
    assert.deepStrictEqual((await sync.fullSync()).uploaded, 0);
  });

  it('force resync repairs remote tampering with identical size and mtime', async () => {
    await conn.check(`cd ${shq(remoteRoot)} && t=$(stat -c %y src/greet.cpp) && sed -i 's/who/WHO/' src/greet.cpp && touch -d "$t" src/greet.cpp`);
    assert.strictEqual((await sync.fullSync({ scope: 'src' })).uploaded, 0);
    assert.strictEqual((await sync.fullSync({ scope: 'src', force: true })).uploaded, 1);
  });

  it('preserves the executable bit', async () => {
    write('tools/run.sh', '#!/bin/sh\necho hi\n');
    fs.chmodSync(path.join(local, 'tools/run.sh'), 0o755);
    await sync.fullSync({ scope: 'tools' });
    assert.strictEqual((await conn.check(`${shq(remoteRoot + '/tools/run.sh')}`)).stdout.toString(), 'hi\n');
  });

  it('configures, builds, lists targets and runs via CMake', async () => {
    const p = profile();
    const b = createBuilder(p, local, remoteRoot);
    const sh = (c: string) => conn.check(loginShell(c, { cwd: remoteRoot }));
    assert.strictEqual(await b.needsConfigure(conn, 'Debug'), true);
    await sh(b.configureCommand('Debug')!);
    await sh(b.buildCommand('Debug'));
    const targets = await b.targets(conn, 'Debug');
    const hello = targets.find((t) => t.name === 'hello');
    assert.strictEqual(hello?.type, 'EXECUTABLE');
    assert.strictEqual(hello?.artifacts[0], `${remoteRoot}/cmake-build-debug/hello`);
    assert.strictEqual((await sh(`${shq(hello!.artifacts[0])} tester`)).stdout.toString(), 'Hello from hello, tester\n');

    // A full resync must not delete the remote build dir.
    await sync.fullSync();
    assert.strictEqual((await conn.run(`test -x ${shq(hello!.artifacts[0])}`)).code, 0);
  });

  it('mirrors headers and rewrites the compile DB for IntelliSense', async () => {
    const cacheRoot = path.join(tmp, 'cache');
    const b = createBuilder(profile(), local, remoteRoot);
    const state = await refreshIntelliSense({
      conn,
      localRoot: local,
      remoteRoot,
      compileDb: b.compileCommandsPath('Debug')!,
      cacheRoot,
      isSyncedDir: (rel) => fs.existsSync(path.join(local, rel)),
      refetchSystem: false,
      log,
    });
    assert.ok(state);
    // Generated header from the remote build dir is mirrored.
    assert.ok(fs.existsSync(path.join(cacheRoot, ...`${remoteRoot}/cmake-build-debug/generated/config.h`.split('/').filter(Boolean))));
    // System C++ headers are mirrored.
    assert.ok(state!.headerMappings.some((m) => fs.existsSync(path.join(m.local, 'iostream'))), 'iostream mirrored');
    const db = JSON.parse(fs.readFileSync(state!.compileDbPath, 'utf8'));
    assert.ok(db.every((e: { file: string }) => e.file.startsWith(local)));
    const cfg = [...state!.files.values()][0];
    assert.strictEqual(cfg.standard, 'gnu++17');
    assert.ok(cfg.includePath.some((p) => p === path.join(local, 'include')));
    assert.ok(cfg.defines.some((d) => d.startsWith('__GNUC__=')));
  });

  it('debug info refers to remote source paths (mapped by sourceFileMap)', async () => {
    const out = (await conn.check(loginShell(`gdb -batch -ex 'info line main' cmake-build-debug/hello`, { cwd: remoteRoot }))).stdout.toString();
    assert.ok(out.includes(`${remoteRoot}/src/main.cpp`) || out.includes('src/main.cpp'), out);
  });
});
