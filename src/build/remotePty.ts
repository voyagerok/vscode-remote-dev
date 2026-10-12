import * as vscode from 'vscode';
import { StringDecoder } from 'string_decoder';
import { ClientChannel } from 'ssh2';
import { errorMessage } from '../log';
import { SshConnection } from '../ssh/connection';
import { PathMapping, StreamRewriter } from './pathRewriter';

export interface PtyIO {
  /** Print a local status line (CRLF added). */
  line(text: string): void;
  /** Run a remote command attached to the terminal; resolves with its exit code. */
  exec(command: string): Promise<number>;
  readonly cancelled: boolean;
}

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

/**
 * Pseudoterminal that runs a script of local steps and remote commands. Remote output is
 * rewritten (remote paths → local) so problem matchers and links resolve to local files.
 */
export class StepsPty implements vscode.Pseudoterminal {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  private readonly closeEmitter = new vscode.EventEmitter<number>();
  readonly onDidWrite = this.writeEmitter.event;
  readonly onDidClose = this.closeEmitter.event;
  private dims: vscode.TerminalDimensions = { columns: 120, rows: 30 };
  private channel?: ClientChannel;
  private cancelled = false;
  private finished = false;
  private closed = false;

  constructor(
    private readonly conn: () => Promise<SshConnection>,
    private readonly mappings: () => PathMapping[],
    private readonly script: (io: PtyIO) => Promise<number>,
    private readonly options: { keepOpen?: boolean } = {},
  ) {}

  open(dims: vscode.TerminalDimensions | undefined): void {
    if (dims) this.dims = dims;
    const pty = this;
    const io: PtyIO = {
      line: (t) => this.writeEmitter.fire(t.replace(/\r?\n/g, '\r\n') + '\r\n'),
      exec: (c) => this.exec(c),
      get cancelled() {
        return pty.cancelled;
      },
    };
    this.script(io).then(
      (code) => this.finish(code),
      (e) => {
        io.line(`${RED}${errorMessage(e)}${RESET}`);
        this.finish(1);
      },
    );
  }

  private finish(code: number): void {
    this.finished = true;
    if (this.options.keepOpen) {
      this.writeEmitter.fire(`\r\n${DIM}[process exited with code ${code}]${RESET}\r\n`);
      return;
    }
    if (!this.closed) {
      this.closed = true;
      this.closeEmitter.fire(code);
    }
  }

  private async exec(command: string): Promise<number> {
    if (this.cancelled) return 130;
    const conn = await this.conn();
    const ch = await conn.exec(command, {
      pty: { term: 'xterm-256color', cols: this.dims.columns, rows: this.dims.rows },
    });
    this.channel = ch;
    const rewriter = new StreamRewriter(this.mappings());
    const decoder = new StringDecoder('utf8');
    return new Promise<number>((resolve) => {
      let code = -1;
      ch.on('data', (d: Buffer) => this.writeEmitter.fire(rewriter.push(decoder.write(d))));
      ch.stderr.on('data', (d: Buffer) => this.writeEmitter.fire(rewriter.push(decoder.write(d))));
      ch.on('exit', (c: number | null, signal?: string) => (code = c ?? (signal ? 128 : -1)));
      ch.on('close', () => {
        this.writeEmitter.fire(rewriter.push(decoder.end()) + rewriter.end());
        this.channel = undefined;
        resolve(code);
      });
    });
  }

  handleInput(data: string): void {
    if (this.channel) {
      this.channel.write(data);
    } else if (this.finished && !this.closed) {
      // Any key closes a finished run terminal.
      this.closed = true;
      this.closeEmitter.fire(0);
    }
  }

  setDimensions(dims: vscode.TerminalDimensions): void {
    this.dims = dims;
    this.channel?.setWindow(dims.rows, dims.columns, 0, 0);
  }

  close(): void {
    this.cancelled = true;
    if (this.channel) {
      try {
        this.channel.signal('INT');
        this.channel.write('\x03');
      } catch {
        /* channel already gone */
      }
      this.channel.close();
    }
  }
}

export function header(text: string): string {
  return `${BOLD}> ${text}${RESET}`;
}

export function dim(text: string): string {
  return `${DIM}${text}${RESET}`;
}
