import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { extract as tarExtract } from 'tar-stream';
import { shq } from '../config/profile';
import { Logger } from '../log';
import { SshConnection } from '../ssh/connection';

const HEADER_NAMES = ['*.h', '*.hh', '*.hpp', '*.hxx', '*.h++', '*.inc', '*.inl', '*.ipp', '*.tcc', '*.def'];

/** Local mirror location of an absolute remote path. */
export function cachePath(cacheRoot: string, remoteAbs: string): string {
  return path.join(cacheRoot, ...remoteAbs.split('/').filter(Boolean));
}

/**
 * Download remote directories into cacheRoot, mirroring their absolute paths.
 * `headersOnly` restricts to header-like files (used for build dirs with object files).
 * Symlinks are dereferenced on the remote so the local copy works on Windows.
 */
export async function mirrorDirs(
  conn: SshConnection,
  cacheRoot: string,
  dirs: string[],
  headersOnly: boolean,
  log: Logger,
): Promise<number> {
  if (!dirs.length) return 0;
  const rels = dirs.map((d) => d.replace(/^\/+/, ''));
  const existing = rels.map(shq).join(' ');
  const nameExpr = HEADER_NAMES.map((n) => `-name ${shq(n)}`).join(' -o ');
  const select = headersOnly ? `-type f \\( ${nameExpr} \\)` : `\\( -type f -o -type l \\)`;
  // `find` limits the archive to existing files (and headers when requested); tar -h dereferences links.
  const cmd =
    `cd / && find ${existing} ${select} -print0 2>/dev/null | ` +
    `tar -czhf - --null --no-recursion -T - 2>/dev/null`;

  const ch = await conn.exec(cmd);
  const extract = tarExtract();
  let count = 0;
  let failures = 0;

  const done = new Promise<void>((resolve, reject) => {
    extract.on('entry', (header, stream, next) => {
      const segments = header.name.replace(/^\/+/, '').split('/');
      const skip = header.type !== 'file' || segments.some((s) => s === '..' || s === '');
      const chunks: Buffer[] = [];
      stream.on('data', (d) => {
        if (!skip) chunks.push(d as Buffer);
      });
      stream.on('end', () => {
        if (skip) return next();
        const dest = path.join(cacheRoot, ...segments);
        fs.promises
          .mkdir(path.dirname(dest), { recursive: true })
          .then(() => fs.promises.writeFile(dest, Buffer.concat(chunks)))
          .then(
            () => count++,
            // Names invalid on this OS (e.g. `aux.h` on Windows) or case collisions.
            () => failures++,
          )
          .finally(() => next());
      });
    });
    extract.on('finish', resolve);
    extract.on('error', reject);
    ch.on('error', reject);
  });

  ch.pipe(zlib.createGunzip()).on('error', (e) => extract.destroy(e)).pipe(extract);
  await done;
  if (failures) log.warn(`Header cache: ${failures} file(s) could not be written locally`);
  return count;
}
