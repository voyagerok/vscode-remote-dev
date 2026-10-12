import * as fs from 'fs';
import { pack as tarPack } from 'tar-stream';
import { shq } from '../config/profile';
import { SshConnection, RemoteCommandError } from '../ssh/connection';
import { LocalEntry, toAbs } from './fileSet';
import { RemoteEntry, parseFindOutput, parseSha1sumZ } from './planner';

const IN_MEMORY_LIMIT = 8 * 1024 * 1024;

export interface TransferProgress {
  (done: number, total: number): void;
}

/**
 * Stream files to the remote as one tar archive extracted in place. Local mtimes and
 * modes are carried in the headers so the remote quick-check matches afterwards.
 */
export async function uploadTar(
  conn: SshConnection,
  localRoot: string,
  remoteRoot: string,
  entries: LocalEntry[],
  progress?: TransferProgress,
): Promise<void> {
  if (!entries.length) return;
  const cmd = `mkdir -p ${shq(remoteRoot)} && tar -xf - -C ${shq(remoteRoot)} --no-same-owner --delay-directory-restore 2>&1`;
  const ch = await conn.exec(cmd);
  const pack = tarPack();
  const output: Buffer[] = [];
  ch.on('data', (d: Buffer) => output.push(d));
  ch.stderr.on('data', (d: Buffer) => output.push(d));

  const done = new Promise<number>((resolve, reject) => {
    let code = -1;
    ch.on('exit', (c: number | null) => (code = c ?? -1));
    ch.on('close', () => resolve(code));
    ch.on('error', reject);
  });
  pack.pipe(ch);

  let sent = 0;
  const writeAll = async () => {
    for (const e of entries) {
      const header = { name: e.rel, mode: e.mode, mtime: new Date(e.mtimeMs), uname: '', gname: '' };
      if (e.kind === 'symlink') {
        await entry(pack, { ...header, type: 'symlink', linkname: e.linkTarget ?? '', size: 0 });
      } else {
        const abs = toAbs(localRoot, e.rel);
        // Re-stat right before packing: the file may have changed since enumeration.
        const st = await fs.promises.stat(abs).catch(() => undefined);
        if (!st) continue; // deleted meanwhile; the watcher will schedule the remote delete
        const mtime = new Date(st.mtimeMs);
        e.mtimeMs = st.mtimeMs;
        if (st.size <= IN_MEMORY_LIMIT) {
          const data = await fs.promises.readFile(abs);
          e.size = data.length;
          await entry(pack, { ...header, mtime, size: data.length }, data);
        } else {
          e.size = st.size;
          await streamEntry(pack, { ...header, mtime, size: st.size }, abs);
        }
      }
      progress?.(++sent, entries.length);
    }
    pack.finalize();
  };

  await writeAll().catch((err) => {
    pack.destroy(err);
    ch.close();
    throw err;
  });
  const code = await done;
  if (code !== 0) {
    throw new RemoteCommandError(cmd, { code, stdout: Buffer.alloc(0), stderr: Buffer.concat(output).toString('utf8') });
  }
}

type Pack = ReturnType<typeof tarPack>;
type Header = Parameters<Pack['entry']>[0];

function entry(pack: Pack, header: Header, data?: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    pack.entry(header, data ?? Buffer.alloc(0), (err) => (err ? reject(err) : resolve()));
  });
}

function streamEntry(pack: Pack, header: Header, file: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const sink = pack.entry(header, (err) => (err ? reject(err) : resolve()));
    fs.createReadStream(file).on('error', reject).pipe(sink);
  });
}

/** List remote files (and symlinks) under remoteRoot[/scope]. */
export async function listRemote(conn: SshConnection, remoteRoot: string, scope: string, prune: string[][]): Promise<RemoteEntry[]> {
  const start = scope ? `./${scope}` : '.';
  const pruneExpr = prune.length
    ? `\\( ${prune.map(([op, v]) => `${op} ${shq(v)}`).join(' -o ')} \\) -prune -o `
    : '';
  const cmd =
    `cd ${shq(remoteRoot)} 2>/dev/null || exit 0; ` +
    `[ -e ${shq(start)} ] || exit 0; ` +
    `find ${shq(start)} ${pruneExpr}\\( -type f -o -type l \\) -printf '%p\\0%s\\0%T@\\0%m\\0%y\\0%l\\0'`;
  const res = await conn.check(cmd);
  return parseFindOutput(res.stdout);
}

/** sha1 of remote files under remoteRoot[/scope], skipping pruned dirs. */
export async function hashRemote(conn: SshConnection, remoteRoot: string, scope: string, prune: string[][]): Promise<Map<string, string>> {
  const start = scope ? `./${scope}` : '.';
  const pruneExpr = prune.length
    ? `\\( ${prune.map(([op, v]) => `${op} ${shq(v)}`).join(' -o ')} \\) -prune -o `
    : '';
  const cmd =
    `cd ${shq(remoteRoot)} 2>/dev/null || exit 0; ` +
    `[ -e ${shq(start)} ] || exit 0; ` +
    `find ${shq(start)} ${pruneExpr}-type f -print0 | xargs -0 -r sha1sum -z`;
  const res = await conn.check(cmd);
  return parseSha1sumZ(res.stdout);
}

export async function deleteRemote(conn: SshConnection, remoteRoot: string, rels: string[], dirs: string[]): Promise<void> {
  if (rels.length) {
    // Paths are passed NUL-separated on stdin, so no quoting or arg-length issues.
    await conn.check(`cd ${shq(remoteRoot)} && xargs -0 -r rm -f --`, { stdin: Buffer.from(rels.join('\0') + '\0') });
  }
  if (dirs.length) {
    await conn.run(`cd ${shq(remoteRoot)} && xargs -0 -r rmdir --ignore-fail-on-non-empty --`, {
      stdin: Buffer.from(dirs.join('\0') + '\0'),
    });
  }
}

export async function chmodRemote(conn: SshConnection, remoteRoot: string, entries: LocalEntry[]): Promise<void> {
  for (const mode of [0o755, 0o644]) {
    const rels = entries.filter((e) => e.mode === mode).map((e) => e.rel);
    if (rels.length) {
      await conn.check(`cd ${shq(remoteRoot)} && xargs -0 -r chmod ${mode.toString(8)} --`, {
        stdin: Buffer.from(rels.join('\0') + '\0'),
      });
    }
  }
}
