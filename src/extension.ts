import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import SSHConfig from 'ssh-config';
import { FolderController } from './controller';
import { RawProfile } from './config/profile';
import { TASK_TYPE, RemoteTaskProvider, makeTask, RemoteTaskDefinition } from './build/taskProvider';
import { StepsPty } from './build/remotePty';
import { StdioBridge } from './debug/bridge';
import { DEBUG_TYPE, RemoteGdbProvider, pickRemoteProcess } from './debug/provider';
import { RemoteConfigProvider } from './intellisense/cpptoolsProvider';
import { errorMessage, prefixed } from './log';
import { loginShell } from './ssh/remoteShell';
import { toRel } from './sync/fileSet';
import { StatusBar } from './ui/statusBar';

const controllers = new Map<string, FolderController>();

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('Remote Dev', { log: true });
  const statusBar = new StatusBar();
  context.subscriptions.push(output, statusBar);

  const all = () => [...controllers.values()];
  const configured = () => all().filter((c) => !!c.getState().profile);
  const byFolder = (f: vscode.WorkspaceFolder | undefined) => (f ? controllers.get(f.uri.toString()) : undefined);
  const byUri = (uri: vscode.Uri) => byFolder(vscode.workspace.getWorkspaceFolder(uri));

  /** Folder of the active editor if configured, else the only configured folder, else ask. */
  const current = (): FolderController | undefined => {
    const uri = vscode.window.activeTextEditor?.document.uri;
    const fromEditor = uri && byUri(uri);
    if (fromEditor?.getState().profile) return fromEditor;
    const list = configured();
    return list.length >= 1 ? list[0] : all()[0];
  };
  const pick = async (requireProfile = true): Promise<FolderController | undefined> => {
    const list = requireProfile ? configured() : all();
    const cur = current();
    if (list.length <= 1) return list[0] ?? (requireProfile ? undefined : cur);
    if (cur && list.includes(cur) && vscode.window.activeTextEditor) return cur;
    const choice = await vscode.window.showWorkspaceFolderPick({ placeHolder: 'Remote Dev: workspace folder' });
    return choice ? controllers.get(choice.uri.toString()) : undefined;
  };

  const refreshStatus = () => statusBar.update(current());
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(refreshStatus));

  // cpptools integration is optional at runtime (e.g. when using clangd only).
  const configProvider = new RemoteConfigProvider(context.extension.id, byUri, all);
  configProvider
    .register()
    .then((d) => d && context.subscriptions.push(d))
    .catch((e) => output.warn(`cpptools API unavailable: ${errorMessage(e)}`));

  const addFolder = async (folder: vscode.WorkspaceFolder) => {
    const ctrl = new FolderController(folder, context, output);
    controllers.set(folder.uri.toString(), ctrl);
    ctrl.onDidChange(refreshStatus);
    ctrl.onDidChangeIntelliSense(() => {
      configProvider.changed();
      void offerConfigurationProvider(ctrl, context);
    });
    if ((await ctrl.load()) && vscode.workspace.getConfiguration('remoteDev').get<boolean>('autoConnect', true)) {
      void startController(ctrl);
    }
    refreshStatus();
  };

  const startController = async (ctrl: FolderController) => {
    try {
      await ctrl.start();
      // A compile DB from an earlier configure may already exist on the remote.
      await ctrl.refreshIntelliSense().catch((e) => ctrl.logger.debug(`IntelliSense: ${errorMessage(e)}`));
    } catch (e) {
      const msg = errorMessage(e);
      ctrl.logger.error(msg);
      const choice = await vscode.window.showErrorMessage(`Remote Dev (${ctrl.folder.name}): ${msg}`, 'Retry', 'Show Log');
      if (choice === 'Retry') void startController(ctrl);
      if (choice === 'Show Log') output.show();
    }
  };

  for (const f of vscode.workspace.workspaceFolders ?? []) await addFolder(f);
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders((e) => {
      for (const f of e.removed) {
        controllers.get(f.uri.toString())?.dispose();
        controllers.delete(f.uri.toString());
      }
      e.added.forEach((f) => void addFolder(f));
      refreshStatus();
    }),
    { dispose: () => all().forEach((c) => c.dispose()) },
  );

  // Debugging
  const bridge = new StdioBridge(async (folderUri, command) => {
    const ctrl = controllers.get(folderUri);
    if (!ctrl) throw new Error(`Unknown workspace folder ${folderUri}`);
    const s = await ctrl.ensureSession();
    return s.conn.exec(loginShell(command, { cwd: s.remoteRoot, envSetup: s.profile.envSetup }));
  }, prefixed(output, 'debug'));
  context.subscriptions.push({ dispose: () => bridge.dispose() });

  const debugProvider = new RemoteGdbProvider(
    async (folder) => byFolder(folder)?.getState().profile ? byFolder(folder) : await pick(),
    bridge,
    context.extensionPath,
    context.workspaceState,
  );
  context.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider(DEBUG_TYPE, debugProvider),
    vscode.debug.registerDebugConfigurationProvider(DEBUG_TYPE, debugProvider, vscode.DebugConfigurationProviderTriggerKind.Dynamic),
    vscode.tasks.registerTaskProvider(TASK_TYPE, new RemoteTaskProvider((f, name) => byFolder(f) ?? all().find((c) => c.folder.name === name) ?? current(), configured)),
  );

  // Commands
  const withCtrl = (fn: (c: FolderController) => Promise<unknown>) => async () => {
    const c = await pick();
    if (!c) {
      const choice = await vscode.window.showWarningMessage('Remote Dev is not configured for this workspace.', 'Configure');
      if (choice) await vscode.commands.executeCommand('remoteDev.configure');
      return;
    }
    try {
      return await fn(c);
    } catch (e) {
      void vscode.window.showErrorMessage(`Remote Dev: ${errorMessage(e)}`);
    }
  };

  const runTask = (c: FolderController, def: Pick<RemoteTaskDefinition, 'action' | 'target'>, name: string) =>
    vscode.tasks.executeTask(makeTask(c, { type: TASK_TYPE, folder: c.folder.name, ...def }, name));

  const syncUris = async (force: boolean, uri?: vscode.Uri, uris?: vscode.Uri[]) => {
    const targets = uris?.length ? uris : uri ? [uri] : vscode.window.activeTextEditor ? [vscode.window.activeTextEditor.document.uri] : [];
    for (const u of targets) {
      const c = byUri(u);
      if (!c?.getState().profile) continue;
      const rel = toRel(c.localRoot, u.fsPath);
      if (rel === undefined) continue;
      try {
        const s = await c.ensureSession();
        const r = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Remote Dev: ${force ? 'force ' : ''}resync ${rel || c.folder.name}` },
          () => s.sync.fullSync({ scope: rel, force }),
        );
        vscode.window.setStatusBarMessage(`Remote Dev: ${rel || c.folder.name}: uploaded ${r.uploaded}, deleted ${r.deleted}`, 5000);
      } catch (e) {
        void vscode.window.showErrorMessage(`Remote Dev: ${errorMessage(e)}`);
      }
    }
  };

  const fullSync = (force: boolean) =>
    withCtrl(async (c) => {
      const s = await c.ensureSession();
      const r = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Remote Dev: ${force ? 'force ' : ''}resync ${c.folder.name}`, cancellable: false },
        () => s.sync.fullSync({ force }),
      );
      void vscode.window.showInformationMessage(
        `Remote Dev: ${c.folder.name} in sync (uploaded ${r.uploaded}, deleted ${r.deleted}${r.chmodded ? `, chmod ${r.chmodded}` : ''}).`,
      );
    });

  const reg = (id: string, fn: (...args: any[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg('remoteDev.configure', () => configureWizard(pick, all));
  reg('remoteDev.showLog', () => output.show());
  reg('remoteDev.connect', withCtrl((c) => startController(c)));
  reg('remoteDev.disconnect', withCtrl(async (c) => c.stop()));
  reg('remoteDev.fullSync', fullSync(false));
  reg('remoteDev.forceSync', fullSync(true));
  reg('remoteDev.syncPath', (uri?: vscode.Uri, uris?: vscode.Uri[]) => syncUris(false, uri, uris));
  reg('remoteDev.forceSyncPath', (uri?: vscode.Uri, uris?: vscode.Uri[]) => syncUris(true, uri, uris));
  reg('remoteDev.build', withCtrl(async (c) => runTask(c, { action: 'build' }, 'Build')));
  reg('remoteDev.clean', withCtrl(async (c) => runTask(c, { action: 'clean' }, 'Clean')));
  reg('remoteDev.cmakeConfigure', withCtrl(async (c) => runTask(c, { action: 'configure' }, 'Configure')));
  reg('remoteDev.refreshIntellisense', withCtrl((c) => c.refreshIntelliSense(true)));
  reg('remoteDev.pickRemoteProcess', async () => {
    const c = await pick();
    return c ? pickRemoteProcess(c) : undefined;
  });
  reg(
    'remoteDev.openTerminal',
    withCtrl(async (c) => {
      const s = await c.ensureSession();
      const pty = new StepsPty(
        async () => s.conn,
        () => [],
        (io) => io.exec(loginShell('exec "${SHELL:-/bin/sh}" -l', { cwd: s.remoteRoot, envSetup: s.profile.envSetup })),
      );
      vscode.window.createTerminal({ name: `Remote: ${s.conn.label}`, pty, iconPath: new vscode.ThemeIcon('remote') }).show();
    }),
  );
  reg(
    'remoteDev.selectProfile',
    withCtrl(async (c) => {
      const profiles = await c.config.profiles();
      const choice = await vscode.window.showQuickPick(
        profiles.map((p) => ({ label: p.name, description: `${p.host}:${p.remoteRoot}` })),
        { title: 'Remote Dev: active profile' },
      );
      if (choice) await c.config.setActiveProfile(choice.label);
    }),
  );
  reg(
    'remoteDev.selectBuildType',
    withCtrl(async (c) => {
      const s = c.activeSession;
      const builder = s?.builder;
      const variants = builder?.variants() ?? (c.getState().profile?.build.kind === 'cmake' ? ['Debug', 'Release'] : []);
      if (!variants.length) {
        void vscode.window.showInformationMessage('Remote Dev: this build has no build types.');
        return;
      }
      const choice = await vscode.window.showQuickPick(variants, { title: 'Remote Dev: build type / CMake preset', placeHolder: c.variant });
      if (choice) {
        await c.config.setBuildType(choice);
        if (s) void c.refreshIntelliSense().catch(() => undefined);
      }
    }),
  );
  reg('remoteDev.menu', async () => {
    const items: (vscode.QuickPickItem & { cmd: string })[] = [
      { label: '$(sync) Resync Project', cmd: 'remoteDev.fullSync' },
      { label: '$(checklist) Force Resync Project (hash compare)', cmd: 'remoteDev.forceSync' },
      { label: '$(tools) Build', cmd: 'remoteDev.build' },
      { label: '$(settings-gear) CMake Configure', cmd: 'remoteDev.cmakeConfigure' },
      { label: '$(gear) Select Build Type', cmd: 'remoteDev.selectBuildType' },
      { label: '$(terminal) Open Remote Terminal', cmd: 'remoteDev.openTerminal' },
      { label: '$(symbol-class) Refresh IntelliSense', cmd: 'remoteDev.refreshIntellisense' },
      { label: '$(account) Select Profile', cmd: 'remoteDev.selectProfile' },
      { label: '$(plug) Connect', cmd: 'remoteDev.connect' },
      { label: '$(debug-disconnect) Disconnect', cmd: 'remoteDev.disconnect' },
      { label: '$(output) Show Log', cmd: 'remoteDev.showLog' },
    ];
    const choice = await vscode.window.showQuickPick(items, { title: 'Remote Dev' });
    if (choice) await vscode.commands.executeCommand(choice.cmd);
  });

  refreshStatus();
}

/** Point cpptools at our configuration provider for this folder, once, with consent. */
async function offerConfigurationProvider(ctrl: FolderController, context: vscode.ExtensionContext): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('C_Cpp', ctrl.folder.uri);
  const current = cfg.get<string>('default.configurationProvider');
  const id = context.extension.id;
  const askedKey = `remoteDev.askedProvider.${ctrl.folder.uri}`;
  if (current === id || context.workspaceState.get(askedKey)) return;
  await context.workspaceState.update(askedKey, true);
  const yes = 'Use Remote Dev';
  const choice = await vscode.window.showInformationMessage(
    `Remote Dev can provide C/C++ IntelliSense for "${ctrl.folder.name}" using the remote toolchain's headers and flags.`,
    yes,
    'Not Now',
  );
  if (choice === yes) {
    await cfg.update('default.configurationProvider', id, vscode.ConfigurationTarget.WorkspaceFolder);
  }
}

function sshConfigHosts(): string[] {
  try {
    const text = fs.readFileSync(path.join(os.homedir(), '.ssh', 'config'), 'utf8');
    const hosts: string[] = [];
    for (const line of SSHConfig.parse(text)) {
      if ('param' in line && /^host$/i.test(line.param)) {
        const v = Array.isArray(line.value) ? line.value.map((x) => (typeof x === 'string' ? x : x.val)) : [String(line.value)];
        hosts.push(...v.filter((h) => !/[*?!]/.test(h)));
      }
    }
    return hosts;
  } catch {
    return [];
  }
}

async function configureWizard(
  pick: (requireProfile?: boolean) => Promise<FolderController | undefined>,
  all: () => FolderController[],
): Promise<void> {
  const ctrl = (await pick(false)) ?? all()[0];
  if (!ctrl) {
    void vscode.window.showErrorMessage('Remote Dev: open a folder first.');
    return;
  }
  const aliases = sshConfigHosts();
  let host: string | undefined;
  if (aliases.length) {
    const other = '$(edit) Enter user@host[:port]…';
    const choice = await vscode.window.showQuickPick([...aliases, other], { title: 'Remote Dev: remote host (from ~/.ssh/config)' });
    if (!choice) return;
    host = choice === other ? undefined : choice;
  }
  host ??= await vscode.window.showInputBox({
    title: 'Remote Dev: remote host',
    prompt: 'user@host[:port] or an alias from ~/.ssh/config',
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? undefined : 'Required'),
  });
  if (!host) return;
  const remoteRoot = await vscode.window.showInputBox({
    title: 'Remote Dev: remote directory for sources',
    prompt: 'Absolute path or ~/... Leave empty for a per-project directory under ~/.remote-dev/',
    ignoreFocusOut: true,
    validateInput: (v) => (!v || v.startsWith('/') || v.startsWith('~/') ? undefined : 'Must be absolute or start with ~/'),
  });
  if (remoteRoot === undefined) return;
  const hasCMake = fs.existsSync(path.join(ctrl.localRoot, 'CMakeLists.txt'));
  const kind = await vscode.window.showQuickPick(
    [
      { label: 'CMake', description: hasCMake ? 'CMakeLists.txt found' : '', value: 'cmake' },
      { label: 'Custom commands', description: 'make, meson, scripts…', value: 'custom' },
    ],
    { title: 'Remote Dev: build system' },
  );
  if (!kind) return;
  let build: RawProfile['build'] = { kind: 'cmake' };
  if (kind.value === 'custom') {
    const buildCommand = await vscode.window.showInputBox({
      title: 'Remote Dev: build command (run in the remote directory)',
      value: 'make -j$(nproc)',
      ignoreFocusOut: true,
    });
    if (!buildCommand) return;
    build = { kind: 'custom', buildCommand, cleanCommand: 'make clean' };
  }
  const name = host.replace(/[^A-Za-z0-9@._-]/g, '_');
  await ctrl.config.writeProfile({ name, host: host.trim(), ...(remoteRoot ? { remoteRoot } : {}), build });
  await ctrl.config.setActiveProfile(name);
  if (await ctrl.load()) {
    void vscode.commands.executeCommand('remoteDev.connect');
  }
}

export function deactivate(): void {
  controllers.forEach((c) => c.dispose());
  controllers.clear();
}
