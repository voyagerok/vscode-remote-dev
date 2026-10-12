import * as vscode from 'vscode';
import { FolderController } from '../controller';

/** Status bar for the folder of the active editor (or the only configured folder). */
export class StatusBar implements vscode.Disposable {
  private readonly main = vscode.window.createStatusBarItem('remoteDev.status', vscode.StatusBarAlignment.Left, 50);
  private readonly variant = vscode.window.createStatusBarItem('remoteDev.variant', vscode.StatusBarAlignment.Left, 49);

  constructor() {
    this.main.name = 'Remote Dev';
    this.variant.name = 'Remote Dev: build type';
    this.main.command = 'remoteDev.menu';
    this.variant.command = 'remoteDev.selectBuildType';
  }

  update(ctrl: FolderController | undefined): void {
    const st = ctrl?.getState();
    if (!ctrl || !st?.profile) {
      this.main.hide();
      this.variant.hide();
      return;
    }
    const host = st.profile.host;
    const sync = st.sync;
    let icon: string;
    let text: string;
    this.main.backgroundColor = undefined;
    if (st.connection === 'connecting') {
      icon = '$(loading~spin)';
      text = `${host}: connecting`;
    } else if (st.connection === 'disconnected' && !ctrl.activeSession) {
      icon = '$(debug-disconnect)';
      text = host;
    } else if (st.error) {
      icon = '$(error)';
      text = `${host}: sync error`;
      this.main.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    } else if (sync?.busy || sync?.pending) {
      icon = '$(sync~spin)';
      text = `${host}${sync.pending ? ` (${sync.pending})` : ''}`;
    } else if (st.connection === 'disconnected') {
      icon = '$(debug-disconnect)';
      text = `${host}: reconnect pending`;
    } else {
      icon = '$(remote)';
      text = host;
    }
    this.main.text = `${icon} ${text}`;
    const lines = [
      `**Remote Dev** — ${ctrl.folder.name}`,
      `Profile: ${st.profile.name} (${st.connection})`,
      `Remote root: \`${ctrl.activeSession?.remoteRoot ?? st.profile.remoteRoot}\``,
    ];
    if (sync?.activity) lines.push(`Activity: ${sync.activity}`);
    if (sync?.lastSync) lines.push(`Last sync: ${sync.lastSync.toLocaleTimeString()}`);
    if (st.error) lines.push(`Error: ${st.error}`);
    this.main.tooltip = new vscode.MarkdownString(lines.join('\n\n'));
    this.main.show();

    if (st.variant) {
      this.variant.text = `$(gear) ${st.variant}`;
      this.variant.tooltip = 'Remote Dev: select build type / preset';
      this.variant.show();
    } else {
      this.variant.hide();
    }
  }

  dispose(): void {
    this.main.dispose();
    this.variant.dispose();
  }
}
