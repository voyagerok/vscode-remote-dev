export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  debug(msg: string): void;
}

export const nullLogger: Logger = { info() {}, warn() {}, error() {}, debug() {} };

/** Minimal structural type of vscode.LogOutputChannel, so non-vscode code can depend on it. */
interface LogSink {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  debug(msg: string): void;
}

export function prefixed(sink: LogSink, prefix: string): Logger {
  return {
    info: (m) => sink.info(`[${prefix}] ${m}`),
    warn: (m) => sink.warn(`[${prefix}] ${m}`),
    error: (m) => sink.error(`[${prefix}] ${m}`),
    debug: (m) => sink.debug(`[${prefix}] ${m}`),
  };
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
