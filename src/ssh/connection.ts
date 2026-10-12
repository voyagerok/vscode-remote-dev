import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';
import { Client, ClientChannel, ConnectConfig, AuthenticationType, AnyAuthMethod, SFTPWrapper, PseudoTtyOptions, utils as sshUtils } from 'ssh2';
import { Logger, errorMessage } from '../log';
import { checkHostKey, fingerprintSha256, knownHostsLine, knownHostsName } from './knownHosts';
import { HostOverrides, ResolvedHost, resolveHost } from './sshConfig';

/** UI callbacks used during connect; kept abstract so the SSH layer has no vscode dependency. */
export interface Prompter {
  /** Returns undefined if the user cancelled. */
  password(prompt: string, key: string): Promise<string | undefined>;
  /** Called when a remembered password turned out to be wrong. */
  forgetPassword(key: string): Promise<void>;
  passphrase(keyFile: string): Promise<string | undefined>;
  keyboardInteractive(name: string, instructions: string, prompts: { prompt: string; echo?: boolean }[]): Promise<string[] | undefined>;
  /** Unknown host key: ask whether to trust and add to known_hosts. */
  confirmHostKey(host: string, fingerprint: string): Promise<boolean>;
  /** Changed host key: shown as an error; return true only if the user explicitly overrides. */
  hostKeyChanged(host: string, fingerprint: string): Promise<boolean>;
}

export interface ExecResult {
  code: number;
  signal?: string;
  stdout: Buffer;
  stderr: string;
}

export interface ExecOptions {
  pty?: boolean | PseudoTtyOptions;
  /** Data written to stdin; stdin is closed afterwards. */
  stdin?: Buffer | string;
}

export type ConnectionState = 'disconnected' | 'connecting' | 'connected';

export class RemoteCommandError extends Error {
  constructor(readonly command: string, readonly result: ExecResult) {
    super(`Remote command failed (exit ${result.code}${result.signal ? `, ${result.signal}` : ''}): ${result.stderr.trim() || command}`);
  }
}

const DEFAULT_KNOWN_HOSTS = path.join(os.homedir(), '.ssh', 'known_hosts');

export interface ConnectionOptions {
  /** Override for tests. */
  knownHostsFile?: string;
  /** Override ssh_config text (tests); defaults to ~/.ssh/config. */
  sshConfigText?: string;
}

function agentPath(): string | undefined {
  if (process.env.SSH_AUTH_SOCK) return process.env.SSH_AUTH_SOCK;
  if (process.platform === 'win32') {
    const pipe = '\\\\.\\pipe\\openssh-ssh-agent';
    try {
      fs.statSync(pipe);
      return pipe;
    } catch {
      return 'pageant';
    }
  }
  return undefined;
}

export class SshConnection extends EventEmitter {
  private client?: Client;
  private jumpClient?: SshConnection;
  private connecting?: Promise<Client>;
  private sftpSession?: Promise<SFTPWrapper>;
  private _state: ConnectionState = 'disconnected';
  private _home?: string;
  private disposed = false;
  readonly resolved: ResolvedHost;

  constructor(
    hostSpec: string,
    overrides: HostOverrides,
    private readonly prompter: Prompter,
    private readonly log: Logger,
    private readonly options: ConnectionOptions = {},
  ) {
    super();
    this.resolved = resolveHost(hostSpec, overrides, options.sshConfigText);
  }

  private get knownHosts(): string {
    return this.options.knownHostsFile ?? DEFAULT_KNOWN_HOSTS;
  }

  get state(): ConnectionState {
    return this._state;
  }

  get label(): string {
    const r = this.resolved;
    return `${r.user}@${r.alias}${r.port !== 22 ? `:${r.port}` : ''}`;
  }

  /** Remote $HOME, available after connect. */
  get home(): string {
    if (!this._home) throw new Error('Not connected');
    return this._home;
  }

  private setState(s: ConnectionState): void {
    if (this._state !== s) {
      this._state = s;
      this.emit('state', s);
    }
  }

  async connect(): Promise<Client> {
    if (this.disposed) throw new Error('Connection disposed');
    if (this.client && this._state === 'connected') return this.client;
    if (!this.connecting) {
      this.connecting = this.doConnect().finally(() => (this.connecting = undefined));
    }
    return this.connecting;
  }

  private async doConnect(): Promise<Client> {
    this.setState('connecting');
    const r = this.resolved;
    this.log.info(`Connecting to ${this.label} (${r.hostName}:${r.port})${r.proxyJump ? ` via ${r.proxyJump}` : ''}`);
    try {
      let sock: ConnectConfig['sock'];
      if (r.proxyJump) {
        // Chains like "a,b" are handled by resolving the last hop through the earlier ones.
        const hops = r.proxyJump.split(',');
        const last = hops.pop()!;
        this.jumpClient = new SshConnection(last, {}, this.prompter, this.log, this.options);
        if (hops.length) {
          this.jumpClient.resolved.proxyJump = hops.join(',');
        }
        const jc = await this.jumpClient.connect();
        sock = await new Promise((resolve, reject) =>
          jc.forwardOut('127.0.0.1', 0, r.hostName, r.port, (err, ch) => (err ? reject(err) : resolve(ch))),
        );
      }

      const client = new Client();
      const hostKeyNames = [knownHostsName(r.hostName, r.port)];
      if (r.alias !== r.hostName) hostKeyNames.push(knownHostsName(r.alias, r.port));

      await new Promise<void>((resolve, reject) => {
        client
          .once('ready', () => resolve())
          .once('error', (err) => reject(err))
          .connect({
            host: r.hostName,
            port: r.port,
            username: r.user,
            sock,
            readyTimeout: 30000,
            keepaliveInterval: 15000,
            keepaliveCountMax: 4,
            tryKeyboard: true,
            hostVerifier: (key: Buffer, verify: (ok: boolean) => void) => {
              this.verifyHostKey(hostKeyNames, key).then(verify, (e) => {
                this.log.error(`Host key verification failed: ${errorMessage(e)}`);
                verify(false);
              });
            },
            authHandler: this.authHandler(),
          } as ConnectConfig);
      });

      client.on('error', (err) => this.log.error(`SSH error: ${err.message}`));
      client.on('close', () => {
        if (this.client === client) {
          this.log.warn(`Connection to ${this.label} closed`);
          this.client = undefined;
          this.sftpSession = undefined;
          this.setState('disconnected');
        }
      });
      this.client = client;

      const home = await this.runOn(client, 'printf %s "$HOME"');
      this._home = home.stdout.toString('utf8') || `/home/${r.user}`;
      this.setState('connected');
      this.log.info(`Connected to ${this.label}, remote home ${this._home}`);
      return client;
    } catch (e) {
      this.setState('disconnected');
      this.jumpClient?.dispose();
      this.jumpClient = undefined;
      throw e;
    }
  }

  private async verifyHostKey(names: string[], key: Buffer): Promise<boolean> {
    let content = '';
    try {
      content = await fs.promises.readFile(this.knownHosts, 'utf8');
    } catch {
      /* no known_hosts yet */
    }
    const fp = fingerprintSha256(key);
    const status = checkHostKey(content, names, key);
    this.log.debug(`Host key ${fp}: ${status}`);
    if (status === 'match') return true;
    if (status === 'revoked') {
      this.log.error(`Host key for ${names[0]} is marked @revoked in known_hosts`);
      return false;
    }
    const ok = status === 'mismatch'
      ? await this.prompter.hostKeyChanged(names[0], fp)
      : await this.prompter.confirmHostKey(names[0], fp);
    if (ok && status === 'unknown') {
      await fs.promises.mkdir(path.dirname(this.knownHosts), { recursive: true });
      const sep = content && !content.endsWith('\n') ? '\n' : '';
      await fs.promises.appendFile(this.knownHosts, sep + knownHostsLine(names[0], key) + '\n', { mode: 0o600 });
    }
    return ok;
  }

  private authHandler(): (left: AuthenticationType[] | null, partial: boolean | null, next: (m: AnyAuthMethod | false) => void) => void {
    const r = this.resolved;
    const username = r.user;
    const pwKey = `${username}@${r.hostName}:${r.port}`;
    type Step = () => Promise<AnyAuthMethod | undefined>;
    const steps: { type: AuthenticationType; run: Step }[] = [];
    let lastType: AuthenticationType | undefined;
    let passwordAttempts = 0;

    steps.push({ type: 'none', run: async () => ({ type: 'none', username }) });
    const agent = agentPath();
    if (agent && !r.identitiesOnly) {
      steps.push({ type: 'publickey', run: async () => ({ type: 'agent', username, agent }) });
    }
    for (const file of r.identityFiles) {
      steps.push({
        type: 'publickey',
        run: async () => {
          let key: Buffer;
          try {
            key = await fs.promises.readFile(file);
          } catch {
            this.log.debug(`Identity file ${file} not readable, skipping`);
            return undefined;
          }
          const parsed = sshUtils.parseKey(key);
          if (!(parsed instanceof Error)) return { type: 'publickey', username, key };
          if (!/passphrase|encrypted/i.test(parsed.message)) {
            this.log.warn(`Cannot parse key ${file}: ${parsed.message}`);
            return undefined;
          }
          const passphrase = await this.prompter.passphrase(file);
          return passphrase === undefined ? undefined : { type: 'publickey', username, key, passphrase };
        },
      });
    }
    const kbd: Step = async () => ({
      type: 'keyboard-interactive',
      username,
      prompt: (name, instructions, _lang, prompts, finish) => {
        if (!prompts.length) return finish([]);
        this.prompter.keyboardInteractive(name, instructions, prompts).then((answers) => finish(answers ?? []));
      },
    });
    const pw: Step = async () => {
      const p = await this.prompter.password(`Password for ${pwKey}`, pwKey);
      return p === undefined ? undefined : { type: 'password', username, password: p };
    };
    // Up to three interactive attempts, like OpenSSH.
    for (let i = 0; i < 3; i++) {
      steps.push({ type: 'keyboard-interactive', run: kbd });
      steps.push({ type: 'password', run: pw });
    }

    return (left, _partial, next) => {
      void (async () => {
        if (lastType === 'password') {
          passwordAttempts++;
          await this.prompter.forgetPassword(pwKey);
        }
        while (steps.length) {
          const step = steps.shift()!;
          if (left && step.type !== 'none' && !left.includes(step.type)) continue;
          if (step.type === 'none' && left) continue;
          if (step.type === 'password' && passwordAttempts >= 3) continue;
          let method: AnyAuthMethod | undefined;
          try {
            method = await step.run();
          } catch (e) {
            this.log.warn(`Auth step failed: ${errorMessage(e)}`);
          }
          if (!method) {
            // A cancelled password prompt means the user gave up; anything else just skips.
            if (step.type === 'password') break;
            continue;
          }
          lastType = step.type;
          this.log.debug(`Trying auth method ${method.type}`);
          return next(method);
        }
        next(false);
      })();
    };
  }

  /** Open an exec channel. Reconnects transparently if the connection dropped. */
  async exec(command: string, opts: ExecOptions = {}): Promise<ClientChannel> {
    const client = await this.connect();
    return new Promise((resolve, reject) => {
      client.exec(command, { pty: opts.pty }, (err, ch) => {
        if (err) return reject(err);
        if (opts.stdin !== undefined) ch.end(opts.stdin);
        resolve(ch);
      });
    });
  }

  /** Run a command, capturing output. Does not throw on non-zero exit. */
  async run(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    return this.runOn(await this.connect(), command, opts);
  }

  /** Run a command and throw RemoteCommandError on non-zero exit. */
  async check(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const res = await this.run(command, opts);
    if (res.code !== 0) throw new RemoteCommandError(command, res);
    return res;
  }

  private runOn(client: Client, command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      client.exec(command, { pty: opts.pty }, (err, ch) => {
        if (err) return reject(err);
        const out: Buffer[] = [];
        const errChunks: Buffer[] = [];
        let code = -1;
        let signal: string | undefined;
        ch.on('data', (d: Buffer) => out.push(d));
        ch.stderr.on('data', (d: Buffer) => errChunks.push(d));
        ch.on('exit', (c: number | null, sig?: string) => {
          code = c ?? -1;
          signal = sig;
        });
        ch.on('close', () =>
          resolve({ code, signal, stdout: Buffer.concat(out), stderr: Buffer.concat(errChunks).toString('utf8') }),
        );
        ch.on('error', reject);
        if (opts.stdin !== undefined) ch.end(opts.stdin);
        else ch.end();
      });
    });
  }

  async sftp(): Promise<SFTPWrapper> {
    const client = await this.connect();
    if (!this.sftpSession) {
      this.sftpSession = new Promise<SFTPWrapper>((resolve, reject) =>
        client.sftp((err, s) => (err ? reject(err) : resolve(s))),
      );
      this.sftpSession
        .then((s) => s.on('close', () => (this.sftpSession = undefined)))
        .catch(() => (this.sftpSession = undefined));
    }
    return this.sftpSession;
  }

  /** Expand a leading `~/` using the remote home. */
  expand(p: string): string {
    return p.startsWith('~/') ? `${this.home}/${p.slice(2)}` : p === '~' ? this.home : p;
  }

  disconnect(): void {
    const c = this.client;
    this.client = undefined;
    this.sftpSession = undefined;
    c?.end();
    this.jumpClient?.dispose();
    this.jumpClient = undefined;
    this.setState('disconnected');
  }

  dispose(): void {
    this.disposed = true;
    this.disconnect();
    this.removeAllListeners();
  }
}
