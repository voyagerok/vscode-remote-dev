import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFile } from 'child_process';
import { IgnoreTree } from './ignoreTree';

export interface LocalEntry {
  rel: string;
  kind: 'file' | 'symlink';
  size: number;
  mtimeMs: number;
  /** POSIX permission bits to apply remotely (0o644 / 0o755). */
  mode: number;
  linkTarget?: string;
}

/** Convert an absolute local path to a POSIX path relative to root, or undefined if outside. */
export function toRel(root: string, abs: string): string | undefined {
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return rel === '' ? '' : undefined;
  return rel.split(path.sep).join('/');
}

export function toAbs(root: string, rel: string): string {
  return rel ? path.join(root, ...rel.split('/')) : root;
}

export async function sha1File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha1');
    fs.createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });
}

/**
 * Executable bits for platforms without POSIX modes (Windows): taken from the git index,
 * where mode 100755 marks executables.
 */
export function gitExecutables(root: string): Promise<Set<string>> {
  return new Promise((resolve) => {
    execFile('git', ['ls-files', '-s', '-z'], { cwd: root, maxBuffer: 256 * 1024 * 1024 }, (err, stdout) => {
      const set = new Set<string>();
      if (!err) {
        for (const rec of stdout.split('\0')) {
          if (rec.startsWith('100755 ')) set.add(rec.slice(rec.indexOf('\t') + 1));
        }
      }
      resolve(set);
    });
  });
}

export interface FileSetOptions {
  root: string;
  ignore: IgnoreTree;
  /** Restrict to this relative file or directory (scoped resync). */
  scope?: string;
  /** Only used where the OS has no exec bit. */
  executables?: Set<string>;
}

const hasPosixModes = process.platform !== 'win32';

function modeOf(st: fs.Stats, rel: string, executables?: Set<string>): number {
  if (hasPosixModes) return st.mode & 0o111 ? 0o755 : 0o644;
  return executables?.has(rel) ? 0o755 : 0o644;
}

export async function statEntry(root: string, rel: string, executables?: Set<string>): Promise<LocalEntry | undefined> {
  const abs = toAbs(root, rel);
  let st: fs.Stats;
  try {
    st = await fs.promises.lstat(abs);
  } catch {
    return undefined;
  }
  if (st.isSymbolicLink()) {
    const linkTarget = (await fs.promises.readlink(abs)).split(path.sep).join('/');
    return { rel, kind: 'symlink', size: 0, mtimeMs: st.mtimeMs, mode: 0o777, linkTarget };
  }
  if (!st.isFile()) return undefined;
  return { rel, kind: 'file', size: st.size, mtimeMs: st.mtimeMs, mode: modeOf(st, rel, executables) };
}

/** Enumerate all non-excluded files (and symlinks) under root or a scope within it. */
export async function enumerate(opts: FileSetOptions): Promise<LocalEntry[]> {
  const { root, ignore, executables } = opts;
  const out: LocalEntry[] = [];
  const scope = opts.scope ?? '';

  if (scope) {
    if (ignore.isIgnored(scope, false) && ignore.isIgnored(scope, true)) return out;
    const st = await fs.promises.lstat(toAbs(root, scope)).catch(() => undefined);
    if (!st) return out;
    if (!st.isDirectory()) {
      const e = await statEntry(root, scope, executables);
      return e && !ignore.isIgnored(scope) ? [e] : out;
    }
  }

  const queue: string[] = [scope];
  const limit = 64;
  while (queue.length) {
    const batch = queue.splice(0, limit);
    await Promise.all(
      batch.map(async (dir) => {
        let entries: fs.Dirent[];
        try {
          entries = await fs.promises.readdir(toAbs(root, dir), { withFileTypes: true });
        } catch {
          return;
        }
        await Promise.all(
          entries.map(async (d) => {
            const rel = dir ? `${dir}/${d.name}` : d.name;
            if (d.isDirectory()) {
              if (!ignore.isIgnored(rel, true)) queue.push(rel);
              return;
            }
            if (ignore.isIgnored(rel, false)) return;
            const e = await statEntry(root, rel, executables);
            if (e) out.push(e);
          }),
        );
      }),
    );
  }
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return out;
}
