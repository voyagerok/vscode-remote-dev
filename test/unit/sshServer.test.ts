// End-to-end tests of SshConnection and the debug stdio bridge against an in-process
// ssh2 server that executes commands with the local /bin/sh.

import * as assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { Server, utils as sshUtils } from 'ssh2';
import { nullLogger } from '../../src/log';
import { Prompter, SshConnection } from '../../src/ssh/connection';
import { StdioBridge } from '../../src/debug/bridge';

const PASSWORD = 's3cret';

function startServer(): Promise<{ server: Server; port: number }> {
  const hostKey = sshUtils.generateKeyPairSync('ed25519').private;
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    client
      .on('authentication', (ctx) => {
        if (ctx.method === 'password' && ctx.password === PASSWORD) ctx.accept();
        else ctx.reject(['password']);
      })
      .on('ready', () => {
        client.on('session', (accept) => {
          const session = accept();
          session.on('exec', (acc, _rej, info) => {
            const stream = acc();
            const child = cp.spawn('/bin/sh', ['-c', info.command]);
            stream.pipe(child.stdin);
            child.stdout.pipe(stream, { end: false });
            child.stderr.pipe(stream.stderr, { end: false });
            child.on('close', (code) => {
              stream.exit(code ?? 0);
              stream.end();
            });
          });
        });
      })
      .on('error', () => undefined);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as net.AddressInfo).port })));
}

/** Async spawn: the bridge lives in this process, so a sync spawn would deadlock. */
function run(cmd: string, args: string[], env: NodeJS.ProcessEnv, input = ''): Promise<{ stdout: string; stderr: string; status: number | null }> {
  return new Promise((resolve) => {
    const child = cp.spawn(cmd, args, { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (status) => resolve({ stdout, stderr, status }));
    child.stdin.end(input);
  });
}

class TestPrompter implements Prompter {
  hostPrompts = 0;
  passwordPrompts = 0;
  forgotten = 0;
  constructor(private pw = PASSWORD, private trust = true) {}
  async password() {
    this.passwordPrompts++;
    return this.pw;
  }
  async forgetPassword() {
    this.forgotten++;
    this.pw = PASSWORD;
  }
  async passphrase() {
    return undefined;
  }
  async keyboardInteractive() {
    return undefined;
  }
  async confirmHostKey() {
    this.hostPrompts++;
    return this.trust;
  }
  async hostKeyChanged() {
    return false;
  }
}

describe('SshConnection against an in-process server', function () {
  if (process.platform === 'win32') return;
  let server: Server;
  let port: number;
  let dir: string;
  const conns: SshConnection[] = [];
  const connect = (prompter: Prompter) => {
    const c = new SshConnection(`tester@127.0.0.1:${port}`, { identityFile: path.join(dir, 'missing') }, prompter, nullLogger, {
      knownHostsFile: path.join(dir, 'known_hosts'),
      sshConfigText: '',
    });
    conns.push(c);
    return c;
  };

  before(async () => {
    ({ server, port } = await startServer());
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-ssh-'));
    delete process.env.SSH_AUTH_SOCK;
  });
  after(() => {
    conns.forEach((c) => c.dispose());
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('asks to trust an unknown host key, records it, and authenticates by password', async () => {
    const p = new TestPrompter();
    const c = connect(p);
    await c.connect();
    assert.strictEqual(c.state, 'connected');
    assert.strictEqual(p.hostPrompts, 1);
    assert.ok(fs.readFileSync(path.join(dir, 'known_hosts'), 'utf8').startsWith(`[127.0.0.1]:${port} ssh-ed25519 `));
    assert.strictEqual(c.home, os.homedir());
  });

  it('does not ask again for a known host', async () => {
    const p = new TestPrompter();
    await connect(p).connect();
    assert.strictEqual(p.hostPrompts, 0);
  });

  it('forgets a wrong stored password and retries', async () => {
    const p = new TestPrompter('wrong');
    await connect(p).connect();
    assert.strictEqual(p.forgotten, 1);
    assert.strictEqual(p.passwordPrompts, 2);
  });

  it('refuses when the user rejects the host key', async () => {
    fs.rmSync(path.join(dir, 'known_hosts'));
    await assert.rejects(connect(new TestPrompter(PASSWORD, false)).connect());
  });

  it('runs commands with stdin and exit codes', async () => {
    const c = connect(new TestPrompter());
    const r = await c.run('tr a-z A-Z; echo err >&2; exit 3', { stdin: 'hello' });
    assert.strictEqual(r.stdout.toString(), 'HELLO');
    assert.strictEqual(r.stderr, 'err\n');
    assert.strictEqual(r.code, 3);
    await assert.rejects(c.check('exit 1'), /exit 1/);
  });

  it('relays stdio through the debug bridge and pipe proxy', async () => {
    const c = connect(new TestPrompter());
    await c.connect();
    const bridge = new StdioBridge(async (_folder, command) => c.exec(command), nullLogger);
    await bridge.ensureListening();
    try {
      const proxy = path.join(__dirname, '..', '..', 'src', 'debug', 'pipeProxy.js');
      const out = await run(
        process.execPath,
        [proxy, bridge.socketPath, 'file:///x', 'cat;', 'echo', 'done', '>&2;', 'exit', '7'],
        { ...process.env, REMOTE_DEV_TOKEN: bridge.token },
        'line1\nline2\n',
      );
      assert.strictEqual(out.stdout, 'line1\nline2\n');
      assert.strictEqual(out.stderr, 'done\n');
      assert.strictEqual(out.status, 7);

      const bad = await run(process.execPath, [proxy, bridge.socketPath, 'file:///x', 'true'], { ...process.env, REMOTE_DEV_TOKEN: 'nope' });
      assert.strictEqual(bad.status, 255);
      assert.match(bad.stderr, /invalid token/);
    } finally {
      bridge.dispose();
    }
  });
});
