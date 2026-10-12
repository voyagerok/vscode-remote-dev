import * as fs from 'fs';
import { EventEmitter } from 'events';
import { shq } from '../config/profile';
import { Logger, errorMessage } from '../log';
import { SshConnection } from '../ssh/connection';
import { LocalEntry, enumerate, gitExecutables, sha1File, statEntry, toAbs } from './fileSet';
import { IgnoreTree } from './ignoreTree';
import { RemoteEntry, SyncPlan, dirsToPrune, planSync, pruneExpressions } from './planner';
import { chmodRemote, deleteRemote, hashRemote, listRemote, uploadTar } from './transfer';

export interface SyncStatus {
  /** Paths queued for incremental sync. */
  pending: number;
  busy: boolean;
  /** Human-readable current activity. */
  activity?: string;
  lastError?: string;
  lastSync?: Date;
  /** True once at least one full sync completed this session. */
  initialized: boolean;
}

export interface SyncOptions {
  /** Relative path (file or directory) to restrict the sync to. */
  scope?: string;
  /** Compare content hashes rather than size+mtime. */
  force?: boolean;
}

export interface SyncResult {
  uploaded: number;
  deleted: number;
  chmodded: number;
}

export interface SyncServiceOptions {
  localRoot: string;
  /** Absolute, already `~`-expanded. */
  remoteRoot: string;
  excludes: string[];
  ignore: IgnoreTree;
  deleteOrphans: boolean;
  debounceMs: number;
  /** Queue size that triggers a planner-based resync instead of per-path processing. */
  burstThreshold?: number;
}

type Change = 'change' | 'delete';

/** What we believe the remote holds, keyed by relative path. */
interface Known {
  size: number;
  mtimeMs: number;
  mode: number;
  kind: LocalEntry['kind'];
  linkTarget?: string;
}

function isSafeRel(rel: string): boolean {
  return !!rel && !rel.startsWith('/') && !rel.split('/').some((p) => p === '..' || p === '.' || p === '');
}

export class SyncService extends EventEmitter {
  private readonly known = new Map<string, Known>();
  private readonly pending = new Map<string, Change>();
  private timer?: NodeJS.Timeout;
  private retryMs = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private status: SyncStatus = { pending: 0, busy: false, initialized: false };
  private executables?: Set<string>;
  private disposed = false;

  constructor(private readonly conn: SshConnection, private readonly opts: SyncServiceOptions, private readonly log: Logger) {
    super();
  }

  get remoteRoot(): string {
    return this.opts.remoteRoot;
  }

  get localRoot(): string {
    return this.opts.localRoot;
  }

  getStatus(): SyncStatus {
    return { ...this.status, pending: this.pending.size };
  }

  private update(patch: Partial<SyncStatus>): void {
    this.status = { ...this.status, ...patch };
    this.emit('status', this.getStatus());
  }

  /** Run operations strictly one after another. */
  private serialize<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const run = async () => {
      this.update({ busy: true, activity: label });
      try {
        const r = await fn();
        this.update({ lastError: undefined, lastSync: new Date() });
        return r;
      } catch (e) {
        this.update({ lastError: errorMessage(e) });
        throw e;
      } finally {
        this.update({ busy: false, activity: undefined });
      }
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }

  private async execBits(): Promise<Set<string> | undefined> {
    if (process.platform !== 'win32') return undefined;
    if (!this.executables) this.executables = await gitExecutables(this.opts.localRoot);
    return this.executables;
  }

  /**
   * Windows has no exec bit: files git doesn't mark executable keep the remote's exec bit
   * instead of being downgraded to 0644 (e.g. untracked scripts, or no git at all).
   */
  private inheritExecBits(entries: LocalEntry[], remoteMode: (rel: string) => number | undefined): void {
    if (process.platform !== 'win32') return;
    for (const e of entries) {
      if (e.kind === 'file' && e.mode === 0o644 && !this.executables?.has(e.rel) && ((remoteMode(e.rel) ?? 0) & 0o111)) {
        e.mode = 0o755;
      }
    }
  }

  private remember(e: LocalEntry): void {
    this.known.set(e.rel, { size: e.size, mtimeMs: e.mtimeMs, mode: e.mode, kind: e.kind, linkTarget: e.linkTarget });
  }

  private forget(rel: string): void {
    this.known.delete(rel);
    const prefix = rel + '/';
    for (const k of this.known.keys()) if (k.startsWith(prefix)) this.known.delete(k);
  }

  /** Full or scoped resync against an actual remote listing. */
  fullSync(options: SyncOptions = {}): Promise<SyncResult> {
    const scope = options.scope ?? '';
    const label = `${options.force ? 'Force resync' : 'Resync'} ${scope || 'project'}`;
    return this.serialize(label, async () => {
      if (scope) {
        // Explicit scoped request: drop queued events inside it, the full pass covers them.
        for (const k of [...this.pending.keys()]) if (k === scope || k.startsWith(scope + '/')) this.pending.delete(k);
      } else {
        this.pending.clear();
        this.ignore.invalidate();
      }
      const t0 = Date.now();
      const { localRoot, remoteRoot } = this.opts;
      const prune = pruneExpressions(this.opts.excludes);
      const [local, remote] = await Promise.all([
        enumerate({ root: localRoot, ignore: this.ignore, scope, executables: await this.execBits() }),
        listRemote(this.conn, remoteRoot, scope, prune),
      ]);

      let localHashes: Map<string, string> | undefined;
      if (options.force) {
        this.update({ activity: `${label}: hashing` });
        const [lh, rh] = await Promise.all([this.hashLocal(local), hashRemote(this.conn, remoteRoot, scope, prune)]);
        localHashes = lh;
        for (const r of remote) r.sha1 = rh.get(r.rel);
      }

      const remoteModes = new Map(remote.map((r) => [r.rel, r.mode]));
      this.inheritExecBits(local, (rel) => remoteModes.get(rel));
      const plan = planSync(local, remote, {
        deleteOrphans: this.opts.deleteOrphans,
        isIgnored: (rel) => this.ignore.isIgnored(rel),
        byHash: options.force,
        localHashes,
      });
      const result = await this.apply(plan, label);
      if (!scope) this.known.clear();
      for (const e of local) this.remember(e);
      if (!scope) this.update({ initialized: true });
      this.log.info(
        `${label}: ${local.length} local / ${remote.length} remote files, uploaded ${result.uploaded}, ` +
          `deleted ${result.deleted}, chmod ${result.chmodded} in ${Date.now() - t0} ms`,
      );
      return result;
    });
  }

  private async hashLocal(entries: LocalEntry[]): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    const files = entries.filter((e) => e.kind === 'file');
    for (let i = 0; i < files.length; i += 32) {
      await Promise.all(
        files.slice(i, i + 32).map(async (e) => map.set(e.rel, await sha1File(toAbs(this.opts.localRoot, e.rel)))),
      );
    }
    return map;
  }

  private async apply(plan: SyncPlan, label: string): Promise<SyncResult> {
    const { localRoot, remoteRoot } = this.opts;
    if (plan.delete.length) {
      const dirs = dirsToPrune(plan.delete, (d) => fs.existsSync(toAbs(localRoot, d)));
      await deleteRemote(this.conn, remoteRoot, plan.delete, dirs);
      plan.delete.forEach((r) => this.forget(r));
    }
    if (plan.upload.length) {
      await uploadTar(this.conn, localRoot, remoteRoot, plan.upload, (done, total) => {
        if (total > 50 && done % 50 === 0) this.update({ activity: `${label}: ${done}/${total}` });
      });
      plan.upload.forEach((e) => this.remember(e));
    }
    if (plan.chmod.length) {
      await chmodRemote(this.conn, remoteRoot, plan.chmod);
      plan.chmod.forEach((e) => this.remember(e));
    }
    return { uploaded: plan.upload.length, deleted: plan.delete.length, chmodded: plan.chmod.length };
  }

  private get ignore(): IgnoreTree {
    return this.opts.ignore;
  }

  /** Feed a local file-system event (relative POSIX path). */
  notify(rel: string, change: Change): void {
    if (this.disposed || !isSafeRel(rel)) return;
    if (rel === '.gitignore' || rel.endsWith('/.gitignore')) {
      this.ignore.invalidate();
    } else if (change !== 'delete' && this.ignore.isIgnored(rel)) {
      // Cheap early filter for noisy excluded trees (.git, build dirs). Deletes always
      // go through: the path may have been a directory that is not excluded as a file.
      return;
    }
    this.pending.set(rel, change);
    this.update({});
    this.schedule(this.opts.debounceMs);
  }

  private schedule(delayMs: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.flush().then(
        () => (this.retryMs = 0),
        (e) => {
          // Typically a dropped connection: retry with backoff; flush() reconnects on demand.
          this.retryMs = Math.min(this.retryMs ? this.retryMs * 2 : 2000, 60000);
          this.log.error(`Sync failed (retrying in ${this.retryMs / 1000}s): ${errorMessage(e)}`);
          if (!this.disposed && this.pending.size) this.schedule(this.retryMs);
        },
      );
    }, delayMs);
  }

  /** Push all queued changes now. Resolves once they are on the remote. */
  flush(): Promise<SyncResult> {
    clearTimeout(this.timer);
    return this.serialize('Uploading changes', async () => {
      const batch = new Map(this.pending);
      this.pending.clear();
      if (!batch.size) return { uploaded: 0, deleted: 0, chmodded: 0 };
      try {
        return await this.flushBatch(batch);
      } catch (e) {
        // Keep the changes so the next flush (or a reconnect) retries them; newer events win.
        for (const [rel, change] of batch) if (!this.pending.has(rel)) this.pending.set(rel, change);
        throw e;
      }
    });
  }

  private async flushBatch(batch: Map<string, Change>): Promise<SyncResult> {
    if (batch.size > (this.opts.burstThreshold ?? 1000) || !this.status.initialized) {
      // Branch switches and similar bursts: a planner pass is cheaper and more robust.
      return this.verifyLocked('Resync after bulk change');
    }

    const executables = await this.execBits();
    const plan: SyncPlan = { upload: [], chmod: [], delete: [] };
    const deletes: string[] = [];
    // The event kind is only a hint: what is on disk now decides (atomic saves emit delete+create).
    for (const rel of batch.keys()) {
      const st = await fs.promises.lstat(toAbs(this.opts.localRoot, rel)).catch(() => undefined);
      if (!st) {
        if (!this.ignore.isIgnored(rel)) deletes.push(rel);
        continue;
      }
      if (st.isDirectory()) {
        if (this.ignore.isIgnored(rel, true)) continue;
        // A directory appeared (move/copy/checkout): enumerate it.
        const entries = await enumerate({ root: this.opts.localRoot, ignore: this.ignore, scope: rel, executables });
        this.inheritExecBits(entries, (r) => this.known.get(r)?.mode);
        plan.upload.push(...entries.filter((e) => this.changed(e)));
        continue;
      }
      if (this.ignore.isIgnored(rel)) continue;
      const e = await statEntry(this.opts.localRoot, rel, executables);
      if (e) {
        this.inheritExecBits([e], (r) => this.known.get(r)?.mode);
        if (this.changed(e)) plan.upload.push(e);
      }
    }

    if (deletes.length && this.opts.deleteOrphans) {
      // The path may have been a directory, so delete recursively. Paths are validated
      // relative paths inside remoteRoot.
      await this.conn.check(`cd ${shq(this.opts.remoteRoot)} && xargs -0 -r rm -rf --`, {
        stdin: Buffer.from(deletes.join('\0') + '\0'),
      });
      deletes.forEach((r) => this.forget(r));
    }
    const res = await this.apply(plan, 'Uploading changes');
    if (plan.upload.length || deletes.length) {
      this.log.info(`Synced ${plan.upload.length} changed, ${deletes.length} deleted: ${[...batch.keys()].slice(0, 5).join(', ')}${batch.size > 5 ? ', …' : ''}`);
    }
    return { ...res, deleted: deletes.length };
  }

  private changed(e: LocalEntry): boolean {
    const k = this.known.get(e.rel);
    return (
      !k ||
      k.kind !== e.kind ||
      k.size !== e.size ||
      k.mode !== e.mode ||
      k.linkTarget !== e.linkTarget ||
      Math.floor(k.mtimeMs / 1000) !== Math.floor(e.mtimeMs / 1000)
    );
  }

  /**
   * Pre-build gate: flush queued events, then compare the local tree against what we
   * believe the remote holds (local stat only, no remote listing) to catch missed events.
   */
  async ensureSynced(): Promise<SyncResult> {
    if (!this.status.initialized) return this.fullSync();
    await this.flush();
    return this.serialize('Verifying sync', () => this.verifyLocked('Verify'));
  }

  private async verifyLocked(label: string): Promise<SyncResult> {
    if (!this.status.initialized) {
      // Without a baseline we must look at the remote.
      const remote = await listRemote(this.conn, this.opts.remoteRoot, '', pruneExpressions(this.opts.excludes));
      return this.applyAgainst(remote, label, true);
    }
    const remote: RemoteEntry[] = [...this.known].map(([rel, k]) => ({
      rel,
      kind: k.kind,
      size: k.size,
      mtime: k.mtimeMs / 1000,
      mode: k.mode,
      linkTarget: k.linkTarget,
    }));
    return this.applyAgainst(remote, label, false);
  }

  private async applyAgainst(remote: RemoteEntry[], label: string, resetKnown: boolean): Promise<SyncResult> {
    const local = await enumerate({ root: this.opts.localRoot, ignore: this.ignore, executables: await this.execBits() });
    const remoteModes = new Map(remote.map((r) => [r.rel, r.mode]));
    this.inheritExecBits(local, (rel) => remoteModes.get(rel));
    const plan = planSync(local, remote, {
      deleteOrphans: this.opts.deleteOrphans,
      isIgnored: (rel) => this.ignore.isIgnored(rel),
    });
    const res = await this.apply(plan, label);
    if (resetKnown) {
      this.known.clear();
      local.forEach((e) => this.remember(e));
      this.update({ initialized: true });
    }
    if (res.uploaded || res.deleted || res.chmodded) {
      this.log.info(`${label}: uploaded ${res.uploaded}, deleted ${res.deleted}, chmod ${res.chmodded}`);
    }
    return res;
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    this.removeAllListeners();
  }
}
