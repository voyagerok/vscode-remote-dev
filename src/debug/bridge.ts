import * as crypto from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { ClientChannel } from 'ssh2';
import { Logger, errorMessage } from '../log';
import { FRAME_EXIT, FRAME_STDERR, FRAME_STDOUT, BridgeHello, frame } from './protocol';

/** Opens a remote exec channel for a command on behalf of a folder. */
export type ExecHandler = (folder: string, command: string) => Promise<ClientChannel>;

/**
 * Local IPC server that pipeProxy connects to. Each connection runs one remote command
 * and relays its stdio. Access requires a per-session random token.
 */
export class StdioBridge {
  readonly token = crypto.randomBytes(24).toString('hex');
  readonly socketPath: string;
  private server?: net.Server;
  private listening?: Promise<void>;

  constructor(private readonly exec: ExecHandler, private readonly log: Logger) {
    const id = crypto.randomBytes(8).toString('hex');
    this.socketPath =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\remote-dev-${id}`
        : path.join(os.tmpdir(), `remote-dev-${process.getuid?.() ?? 0}-${id}.sock`);
  }

  /** Start listening (once). */
  ensureListening(): Promise<void> {
    if (!this.listening) {
      this.listening = new Promise((resolve, reject) => {
        const server = net.createServer({ allowHalfOpen: true }, (s) => this.handle(s));
        server.once('error', reject);
        server.listen(this.socketPath, () => {
          if (process.platform !== 'win32') {
            try {
              fs.chmodSync(this.socketPath, 0o600);
            } catch {
              /* best effort; the token still protects it */
            }
          }
          resolve();
        });
        this.server = server;
      });
    }
    return this.listening;
  }

  private handle(sock: net.Socket): void {
    let head: Buffer = Buffer.alloc(0);
    let channel: ClientChannel | undefined;
    const pendingInput: Buffer[] = [];
    let inputEnded = false;

    const fail = (msg: string) => {
      this.log.error(`Debug bridge: ${msg}`);
      sock.write(frame(FRAME_STDERR, Buffer.from(`remote-dev: ${msg}\n`)));
      sock.write(frame(FRAME_EXIT, Buffer.from('255')));
      sock.end();
    };

    let started = false;
    const onData = (d: Buffer) => {
      if (channel) {
        channel.write(d);
      } else if (started) {
        // Remote command still being opened: buffer stdin.
        pendingInput.push(d);
      } else {
        head = Buffer.concat([head, d]);
        const nl = head.indexOf(10);
        if (nl < 0) {
          if (head.length > 64 * 1024) fail('request too large');
          return;
        }
        started = true;
        const rest = head.subarray(nl + 1);
        if (rest.length) pendingInput.push(rest);
        void start(head.subarray(0, nl).toString('utf8'));
      }
    };

    const start = async (line: string) => {
      let hello: BridgeHello;
      try {
        hello = JSON.parse(line) as BridgeHello;
      } catch {
        return fail('malformed request');
      }
      const a = Buffer.from(hello.token ?? '');
      const b = Buffer.from(this.token);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return fail('invalid token');
      try {
        const ch = await this.exec(hello.folder, hello.command);
        this.log.debug(`Debug bridge: started ${hello.command}`);
        ch.on('data', (d: Buffer) => sock.write(frame(FRAME_STDOUT, d)));
        ch.stderr.on('data', (d: Buffer) => sock.write(frame(FRAME_STDERR, d)));
        let code = 0;
        ch.on('exit', (c: number | null) => (code = c ?? 0));
        ch.on('close', () => {
          sock.write(frame(FRAME_EXIT, Buffer.from(String(code))));
          sock.end();
        });
        for (const p of pendingInput.splice(0)) ch.write(p);
        if (inputEnded) ch.end();
        channel = ch;
      } catch (e) {
        fail(errorMessage(e));
      }
    };

    sock.on('data', onData);
    sock.on('end', () => {
      inputEnded = true;
      channel?.end();
    });
    sock.on('error', () => channel?.close());
    sock.on('close', () => channel?.close());
  }

  dispose(): void {
    this.server?.close();
    if (process.platform !== 'win32') fs.rmSync(this.socketPath, { force: true });
  }
}
