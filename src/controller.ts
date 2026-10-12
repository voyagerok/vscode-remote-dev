import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ConfigStore } from './config/configStore';
import { Profile, rjoin } from './config/profile';
import { Builder, createBuilder } from './build/builder';
import { PathMapping } from './build/pathRewriter';
import { IntelliSenseState, hostCacheName, refreshIntelliSense } from './intellisense/intellisense';
import { Logger, errorMessage, prefixed } from './log';
import { SshConnection } from './ssh/connection';
import { VsCodePrompter } from './ui/prompter';
import { toRel } from './sync/fileSet';
import { IgnoreTree } from './sync/ignoreTree';
import { SyncService, SyncStatus } from './sync/syncService';

export interface Session {
  profile: Profile;
  conn: SshConnection;
  sync: SyncService;
  builder: Builder;
  remoteRoot: string;
  ignore: IgnoreTree;
}

export interface ControllerState {
  profile?: Profile;
  connection: SshConnection['state'];
  sync?: SyncStatus;
  variant?: string;
  error?: string;
}

/** Everything Remote Dev does for one workspace folder. */
export class FolderController implements vscode.Disposable {
  readonly config: ConfigStore;
  private session?: Session;
  private starting?: Promise<Session>;
  private profile?: Profile;
  private intellisense?: IntelliSenseState;
  private lastError?: string;
  private readonly log: Logger;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly emitter = new vscode.EventEmitter<void>();
  /** Fires on any state change relevant to the UI. */
  readonly onDidChange = this.emitter.event;
  private readonly intellisenseEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeIntelliSense = this.intellisenseEmitter.event;

  constructor(
    readonly folder: vscode.WorkspaceFolder,
    private readonly context: vscode.ExtensionContext,
    output: vscode.LogOutputChannel,
  ) {
    this.log = prefixed(output, folder.name);
    this.config = new ConfigStore(folder, context.workspaceState);
    this.disposables.push(this.config, this.emitter, this.intellisenseEmitter);
    this.disposables.push(this.config.onDidChange(() => void this.reload()));

    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '**/*'));
    const onFs = (uri: vscode.Uri, kind: 'change' | 'delete') => {
      const s = this.session;
      if (!s || !vscode.workspace.getConfiguration('remoteDev', folder.uri).get<boolean>('autoSync', true)) return;
      const rel = toRel(folder.uri.fsPath, uri.fsPath);
      if (rel) s.sync.notify(rel, kind);
    };
    this.disposables.push(
      watcher,
      watcher.onDidCreate((u) => onFs(u, 'change')),
      watcher.onDidChange((u) => onFs(u, 'change')),
      watcher.onDidDelete((u) => onFs(u, 'delete')),
    );
  }

  get localRoot(): string {
    return this.folder.uri.fsPath;
  }

  get activeSession(): Session | undefined {
    return this.session;
  }

  get intelliSenseState(): IntelliSenseState | undefined {
    return this.intellisense;
  }

  /** Load the active profile; returns false if the folder isn't configured. */
  async load(): Promise<boolean> {
    try {
      this.profile = await this.config.activeProfile();
      this.lastError = undefined;
    } catch (e) {
      this.profile = undefined;
      this.lastError = errorMessage(e);
      this.log.error(this.lastError);
    }
    this.emitter.fire();
    return !!this.profile;
  }

  private sameProfile(a: Profile | undefined, b: Profile | undefined): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  private async reload(): Promise<void> {
    const before = this.profile;
    await this.load();
    if (this.session && !this.sameProfile(before, this.profile)) {
      this.log.info('Configuration changed, reconnecting');
      this.stop();
      if (this.profile) await this.start().catch((e) => this.fail(e));
    } else if (this.session) {
      // Presets or variant may have changed.
      this.session.builder = createBuilder(this.session.profile, this.localRoot, this.session.remoteRoot);
    }
    this.emitter.fire();
  }

  private fail(e: unknown): void {
    this.lastError = errorMessage(e);
    this.log.error(this.lastError);
    this.emitter.fire();
  }

  getState(): ControllerState {
    return {
      profile: this.profile,
      connection: this.session?.conn.state ?? (this.starting ? 'connecting' : 'disconnected'),
      sync: this.session?.sync.getStatus(),
      variant: this.variant,
      error: this.lastError ?? this.session?.sync.getStatus().lastError,
    };
  }

  get variant(): string | undefined {
    const chosen = this.config.buildType;
    const b = this.session?.builder ?? (this.profile ? createBuilder(this.profile, this.localRoot, this.profile.remoteRoot) : undefined);
    if (!b) return undefined;
    const variants = b.variants();
    return chosen && variants.includes(chosen) ? chosen : b.defaultVariant();
  }

  /** Connect and run the initial sync. Idempotent. */
  start(): Promise<Session> {
    if (this.session) return Promise.resolve(this.session);
    if (!this.starting) {
      this.starting = this.doStart().finally(() => {
        this.starting = undefined;
        this.emitter.fire();
      });
      this.emitter.fire();
    }
    return this.starting;
  }

  private async doStart(): Promise<Session> {
    if (!this.profile && !(await this.load())) {
      throw new Error(`No Remote Dev profile configured for "${this.folder.name}". Run "Remote Dev: Configure Remote Host".`);
    }
    const profile = this.profile!;
    const conn = new SshConnection(
      profile.host,
      { port: profile.port, user: profile.user, identityFile: profile.identityFile },
      new VsCodePrompter(this.context.secrets),
      this.log,
    );
    try {
      await conn.connect();
    } catch (e) {
      conn.dispose();
      throw e;
    }
    const remoteRoot = conn.expand(profile.remoteRoot);
    const builder = createBuilder(profile, this.localRoot, remoteRoot);
    const excludes = [...profile.exclude, ...this.buildDirExcludes(builder, remoteRoot)];
    const ignore = new IgnoreTree(this.localRoot, excludes, profile.useGitignore);
    const sync = new SyncService(
      conn,
      {
        localRoot: this.localRoot,
        remoteRoot,
        excludes,
        ignore,
        deleteOrphans: profile.deleteRemoteOrphans,
        debounceMs: vscode.workspace.getConfiguration('remoteDev').get<number>('syncDebounceMs', 300),
      },
      this.log,
    );
    sync.on('status', () => this.emitter.fire());
    conn.on('state', () => this.emitter.fire());
    this.session = { profile, conn, sync, builder, remoteRoot, ignore };
    this.lastError = undefined;
    this.emitter.fire();

    await vscode.commands.executeCommand('setContext', 'remoteDev.active', true);
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: 'Remote Dev: initial sync' },
        () => sync.fullSync(),
      );
    } catch (e) {
      this.fail(e);
    }
    return this.session;
  }

  /** Build dirs inside remoteRoot must never be treated as orphans and deleted. */
  private buildDirExcludes(builder: Builder, remoteRoot: string): string[] {
    const dirs = new Set<string>();
    const variants = builder.variants().length ? builder.variants() : [undefined];
    for (const v of variants) dirs.add(builder.buildDir(v));
    const out: string[] = [];
    for (const d of dirs) {
      if (d.startsWith(remoteRoot + '/')) out.push('/' + d.slice(remoteRoot.length + 1) + '/');
    }
    return out;
  }

  /** Session, connecting first if necessary. */
  async ensureSession(): Promise<Session> {
    return this.session ?? this.start();
  }

  stop(): void {
    const s = this.session;
    this.session = undefined;
    if (s) {
      s.sync.dispose();
      s.conn.dispose();
      this.log.info('Disconnected');
    }
    this.emitter.fire();
  }

  /** Remote → local mappings: project root plus mirrored header dirs. */
  mappings(): PathMapping[] {
    const s = this.session;
    if (!s) return [];
    return [{ remote: s.remoteRoot, local: this.localRoot }, ...(this.intellisense?.headerMappings ?? [])];
  }

  async refreshIntelliSense(refetchSystem = false): Promise<void> {
    const s = await this.ensureSession();
    const compileDb = s.builder.compileCommandsPath(this.variant);
    if (!compileDb) {
      this.log.info('No compile_commands.json configured for this build; skipping IntelliSense refresh');
      return;
    }
    const r = s.conn.resolved;
    const cacheRoot = path.join(this.context.globalStorageUri.fsPath, 'headers', hostCacheName(r.user, r.hostName, r.port));
    const state = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'Remote Dev: updating IntelliSense' },
      () =>
        refreshIntelliSense({
          conn: s.conn,
          envSetup: s.profile.envSetup,
          localRoot: this.localRoot,
          remoteRoot: s.remoteRoot,
          compileDb,
          cacheRoot,
          isSyncedDir: (rel) => !s.ignore.isIgnored(rel, true) && fs.existsSync(path.join(this.localRoot, rel)),
          refetchSystem,
          log: this.log,
        }),
    );
    if (state) {
      this.intellisense = state;
      this.intellisenseEmitter.fire();
    }
  }

  /** Remote directory relative helper for UI. */
  remotePathOf(localPath: string): string | undefined {
    const s = this.session;
    const rel = toRel(this.localRoot, localPath);
    if (!s || rel === undefined) return undefined;
    return rel ? rjoin(s.remoteRoot, rel) : s.remoteRoot;
  }

  get logger(): Logger {
    return this.log;
  }

  dispose(): void {
    this.stop();
    this.disposables.forEach((d) => d.dispose());
  }
}
