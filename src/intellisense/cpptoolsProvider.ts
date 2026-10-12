import * as vscode from 'vscode';
import {
  CppToolsApi,
  CustomConfigurationProvider,
  SourceFileConfiguration,
  SourceFileConfigurationItem,
  Version,
  WorkspaceBrowseConfiguration,
  getCppToolsApi,
} from 'vscode-cpptools';
import { FolderController } from '../controller';
import { FileConfig, configFor } from './intellisense';

type Lookup = (uri: vscode.Uri) => FolderController | undefined;

/** Supplies per-file include paths/defines derived from the remote toolchain to cpptools. */
export class RemoteConfigProvider implements CustomConfigurationProvider {
  readonly name = 'Remote Dev';
  readonly extensionId: string;
  private api?: CppToolsApi;

  constructor(extensionId: string, private readonly lookup: Lookup, private readonly controllers: () => FolderController[]) {
    this.extensionId = extensionId;
  }

  async register(): Promise<vscode.Disposable | undefined> {
    this.api = await getCppToolsApi(Version.v6);
    if (!this.api) return undefined;
    this.api.registerCustomConfigurationProvider(this);
    this.api.notifyReady(this);
    return this.api;
  }

  /** Call after IntelliSense state of any folder changed. */
  changed(): void {
    if (!this.api) return;
    this.api.didChangeCustomConfiguration(this);
    this.api.didChangeCustomBrowseConfiguration(this);
  }

  private configOf(uri: vscode.Uri): FileConfig | undefined {
    const st = this.lookup(uri)?.intelliSenseState;
    return st ? configFor(st, uri.fsPath) : undefined;
  }

  async canProvideConfiguration(uri: vscode.Uri): Promise<boolean> {
    return !!this.configOf(uri);
  }

  async provideConfigurations(uris: vscode.Uri[]): Promise<SourceFileConfigurationItem[]> {
    const items: SourceFileConfigurationItem[] = [];
    for (const uri of uris) {
      const c = this.configOf(uri);
      if (c) items.push({ uri, configuration: c as SourceFileConfiguration });
    }
    return items;
  }

  async canProvideBrowseConfiguration(): Promise<boolean> {
    return this.controllers().some((c) => !!c.intelliSenseState);
  }

  async provideBrowseConfiguration(): Promise<WorkspaceBrowseConfiguration | null> {
    const states = this.controllers().map((c) => c.intelliSenseState).filter((s) => !!s);
    if (!states.length) return null;
    return {
      browsePath: [...new Set(states.flatMap((s) => s!.browsePath))],
      standard: states[0]!.fallback?.standard as WorkspaceBrowseConfiguration['standard'],
      compilerPath: '',
    };
  }

  async canProvideBrowseConfigurationsPerFolder(): Promise<boolean> {
    return true;
  }

  async provideFolderBrowseConfiguration(uri: vscode.Uri): Promise<WorkspaceBrowseConfiguration | null> {
    const st = this.lookup(uri)?.intelliSenseState;
    if (!st) return null;
    return {
      browsePath: st.browsePath,
      standard: st.fallback?.standard as WorkspaceBrowseConfiguration['standard'],
      compilerPath: '',
    };
  }

  dispose(): void {
    /* cpptools API object is disposed by the caller */
  }
}
