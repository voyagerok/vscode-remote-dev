import { shq } from '../config/profile';

export interface ShellOptions {
  cwd?: string;
  envSetup?: string;
  env?: Record<string, string>;
}

/**
 * Wrap a command so it runs in a login shell (picks up PATH from ~/.profile etc.), with the
 * profile's env setup applied and inside `cwd`. Falls back to sh when bash is missing.
 */
export function loginShell(command: string, opts: ShellOptions = {}): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) lines.push(`export ${k}=${shq(v)}`);
  }
  if (opts.envSetup) lines.push(opts.envSetup);
  if (opts.cwd) lines.push(`cd ${shq(opts.cwd)} || exit 1`);
  lines.push(command);
  const script = shq(lines.join('\n'));
  return `if command -v bash >/dev/null 2>&1; then exec bash -lc ${script}; else exec sh -lc ${script}; fi`;
}
