import * as vscode from 'vscode';
import { parseJsonc } from './jsonc';
import { normalizeProfile, Profile, RawProfile } from './profile';

export const CONFIG_FILE = '.vscode/remote-dev.json';

interface ConfigFile {
  activeProfile?: string;
  profiles?: RawProfile[];
}

export class ConfigStore implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(readonly folder: vscode.WorkspaceFolder, private readonly state: vscode.Memento) {
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, CONFIG_FILE));
    this.disposables.push(
      watcher,
      watcher.onDidChange(() => this.emitter.fire()),
      watcher.onDidCreate(() => this.emitter.fire()),
      watcher.onDidDelete(() => this.emitter.fire()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('remoteDev', folder.uri)) this.emitter.fire();
      }),
      this.emitter,
    );
  }

  private get fileUri(): vscode.Uri {
    return vscode.Uri.joinPath(this.folder.uri, CONFIG_FILE);
  }

  private async readFile(): Promise<ConfigFile | undefined> {
    try {
      const bytes = await vscode.workspace.fs.readFile(this.fileUri);
      return parseJsonc(Buffer.from(bytes).toString('utf8')) as ConfigFile;
    } catch (e) {
      if (e instanceof vscode.FileSystemError && e.code === 'FileNotFound') return undefined;
      throw new Error(`Cannot parse ${CONFIG_FILE}: ${(e as Error).message}`);
    }
  }

  async rawProfiles(): Promise<{ profiles: RawProfile[]; active?: string }> {
    const file = await this.readFile();
    if (file?.profiles?.length) {
      return { profiles: file.profiles, active: file.activeProfile };
    }
    const cfg = vscode.workspace.getConfiguration('remoteDev', this.folder.uri);
    return { profiles: cfg.get<RawProfile[]>('profiles') ?? [], active: cfg.get<string>('activeProfile') };
  }

  async profiles(): Promise<Profile[]> {
    const { profiles } = await this.rawProfiles();
    return profiles.map((p) => normalizeProfile(p, this.folder.name, this.folder.uri.fsPath));
  }

  /** Active profile: per-machine override (workspaceState) > config file/settings > first. */
  async activeProfile(): Promise<Profile | undefined> {
    const { profiles, active } = await this.rawProfiles();
    if (!profiles.length) return undefined;
    const chosen = this.state.get<string>(this.key('activeProfile')) ?? active;
    const raw = profiles.find((p) => p.name === chosen) ?? profiles[0];
    return normalizeProfile(raw, this.folder.name, this.folder.uri.fsPath);
  }

  async setActiveProfile(name: string): Promise<void> {
    await this.state.update(this.key('activeProfile'), name);
    this.emitter.fire();
  }

  get buildType(): string | undefined {
    return this.state.get<string>(this.key('buildType'));
  }

  async setBuildType(bt: string): Promise<void> {
    await this.state.update(this.key('buildType'), bt);
    this.emitter.fire();
  }

  async writeProfile(profile: RawProfile): Promise<void> {
    const file = (await this.readFile()) ?? {};
    const profiles = (file.profiles ?? []).filter((p) => p.name !== profile.name);
    profiles.push(profile);
    const next: ConfigFile = { ...file, activeProfile: profile.name, profiles };
    await vscode.workspace.fs.writeFile(this.fileUri, Buffer.from(JSON.stringify(next, null, 2) + '\n', 'utf8'));
  }

  private key(k: string): string {
    return `remoteDev.${this.folder.uri.toString()}.${k}`;
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}
