// Pure diff logic between the local tree and the remote mirror. No I/O.
//
// Uploads preserve the local mtime (tar header), so a remote file is up to date when
// size, whole-second mtime and mode match — the same quick check rsync uses. A
// "force" sync additionally compares content hashes.

import { LocalEntry } from './fileSet';

export interface RemoteEntry {
  rel: string;
  kind: 'file' | 'symlink' | 'other';
  size: number;
  /** Seconds since epoch (may be fractional). */
  mtime: number;
  mode: number;
  linkTarget?: string;
  sha1?: string;
}

export interface SyncPlan {
  upload: LocalEntry[];
  /** Content identical, only permission bits differ. */
  chmod: LocalEntry[];
  delete: string[];
}

export interface PlanOptions {
  /** Delete remote files absent locally. */
  deleteOrphans: boolean;
  /** Remote path filter: excluded remote paths (e.g. build dirs) are never deleted. */
  isIgnored: (rel: string) => boolean;
  /** Compare hashes instead of size/mtime. Requires sha1 on both sides. */
  byHash?: boolean;
  localHashes?: Map<string, string>;
}

export function sameSecond(localMs: number, remoteSec: number): boolean {
  return Math.floor(localMs / 1000) === Math.floor(remoteSec);
}

export function planSync(local: LocalEntry[], remote: RemoteEntry[], opts: PlanOptions): SyncPlan {
  const remoteByRel = new Map(remote.map((r) => [r.rel, r]));
  const plan: SyncPlan = { upload: [], chmod: [], delete: [] };

  for (const l of local) {
    const r = remoteByRel.get(l.rel);
    if (!r) {
      plan.upload.push(l);
      continue;
    }
    if (l.kind === 'symlink') {
      if (r.kind !== 'symlink' || r.linkTarget !== l.linkTarget) plan.upload.push(l);
      continue;
    }
    if (r.kind !== 'file') {
      plan.upload.push(l);
      continue;
    }
    let same: boolean;
    if (opts.byHash) {
      const lh = opts.localHashes?.get(l.rel);
      same = !!lh && lh === r.sha1;
    } else {
      same = l.size === r.size && sameSecond(l.mtimeMs, r.mtime);
    }
    if (!same) plan.upload.push(l);
    else if ((r.mode & 0o777) !== l.mode) plan.chmod.push(l);
  }

  if (opts.deleteOrphans) {
    const localSet = new Set(local.map((l) => l.rel));
    for (const r of remote) {
      if (!localSet.has(r.rel) && !opts.isIgnored(r.rel)) plan.delete.push(r.rel);
    }
  }
  return plan;
}

/**
 * Parse `find -printf '%p\0%s\0%T@\0%m\0%y\0%l\0'` output run from the remote root.
 * Paths come out as `./a/b` or `scope/a/b`; normalized to `a/b`.
 */
export function parseFindOutput(buf: Buffer): RemoteEntry[] {
  const fields = buf.toString('utf8').split('\0');
  const out: RemoteEntry[] = [];
  for (let i = 0; i + 5 < fields.length; i += 6) {
    let rel = fields[i];
    if (rel.startsWith('./')) rel = rel.slice(2);
    if (!rel || rel === '.') continue;
    const y = fields[i + 4];
    out.push({
      rel,
      size: Number(fields[i + 1]),
      mtime: Number(fields[i + 2]),
      mode: parseInt(fields[i + 3], 8),
      kind: y === 'f' ? 'file' : y === 'l' ? 'symlink' : 'other',
      linkTarget: y === 'l' ? fields[i + 5] : undefined,
    });
  }
  return out;
}

/** Parse `sha1sum -z` output: `<hash>  <path>\0`. */
export function parseSha1sumZ(buf: Buffer): Map<string, string> {
  const map = new Map<string, string>();
  for (const rec of buf.toString('utf8').split('\0')) {
    if (rec.length < 42) continue;
    let rel = rec.slice(42);
    if (rel.startsWith('./')) rel = rel.slice(2);
    map.set(rel, rec.slice(0, 40));
  }
  return map;
}

/**
 * Turn simple directory exclude patterns into `find` prune expressions so huge excluded
 * remote trees (build dirs) are not listed. Complex patterns are left to the client filter.
 */
export function pruneExpressions(excludes: string[]): string[][] {
  const out: string[][] = [];
  for (const raw of excludes) {
    const p = raw.trim();
    if (!p || p.startsWith('!') || p.startsWith('#') || !p.endsWith('/')) continue;
    const body = p.replace(/^\//, '').replace(/\/$/, '');
    if (!body || body.includes('/') || /[\[\]\\]/.test(body)) continue;
    out.push(p.startsWith('/') ? ['-path', `./${body}`] : ['-name', body]);
  }
  return out;
}

/** Remote dirs that may become empty after deletes and don't exist locally, deepest first. */
export function dirsToPrune(deleted: string[], localDirExists: (rel: string) => boolean): string[] {
  const dirs = new Set<string>();
  for (const rel of deleted) {
    let d = rel;
    for (let i = d.lastIndexOf('/'); i > 0; i = d.lastIndexOf('/')) {
      d = d.slice(0, i);
      if (localDirExists(d)) break;
      dirs.add(d);
    }
  }
  return [...dirs].sort((a, b) => b.split('/').length - a.split('/').length || (a < b ? 1 : -1));
}
