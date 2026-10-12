import * as path from 'path';
import * as vscode from 'vscode';
import { FolderController } from '../controller';
import { rjoin } from '../config/profile';
import { makeTask, runTaskAndWait, TASK_TYPE } from '../build/taskProvider';
import { StdioBridge } from './bridge';

export const DEBUG_TYPE = 'remote-gdb';

interface RemoteGdbConfig extends vscode.DebugConfiguration {
  program?: string;
  args?: string[];
  cwd?: string;
  environment?: { name: string; value: string }[];
  stopAtEntry?: boolean;
  miDebuggerPath?: string;
  buildBeforeLaunch?: boolean;
  setupCommands?: unknown[];
  processId?: string | number;
  /** Set by resolveDebugConfiguration from `${target:<name>}` before variable substitution. */
  remoteDevTarget?: string;
}

export class RemoteGdbProvider implements vscode.DebugConfigurationProvider {
  constructor(
    private readonly controllerFor: (folder: vscode.WorkspaceFolder | undefined) => Promise<FolderController | undefined>,
    private readonly bridge: StdioBridge,
    private readonly extensionPath: string,
    private readonly state: vscode.Memento,
  ) {}

  provideDebugConfigurations(): vscode.DebugConfiguration[] {
    return [{ type: DEBUG_TYPE, request: 'launch', name: 'Remote: launch', program: '', args: [] }];
  }

  /** Runs before VS Code substitutes variables: lift our own `${target:x}` out of the way. */
  resolveDebugConfiguration(_folder: vscode.WorkspaceFolder | undefined, config: RemoteGdbConfig): RemoteGdbConfig {
    const m = /^\$\{target:(.+)\}$/.exec(config.program?.trim() ?? '');
    if (m) {
      config.remoteDevTarget = m[1];
      config.program = '';
    }
    return config;
  }

  async resolveDebugConfigurationWithSubstitutedVariables(
    folder: vscode.WorkspaceFolder | undefined,
    config: RemoteGdbConfig,
  ): Promise<vscode.DebugConfiguration | null | undefined> {
    if (!config.type && !config.request) {
      // F5 with no launch.json.
      config = { type: DEBUG_TYPE, request: 'launch', name: 'Remote: launch', program: '' };
    }
    const ctrl = await this.controllerFor(folder);
    if (!ctrl) {
      void vscode.window.showErrorMessage('Remote Dev: no configured workspace folder for this debug session.');
      return undefined;
    }
    const s = await ctrl.ensureSession();
    const variant = ctrl.variant;
    const buildDir = s.builder.buildDir(variant);

    // Resolve the target before building so only it gets built.
    let program = config.program?.trim() ?? '';
    let target = config.remoteDevTarget;

    const targets = await s.builder.targets(s.conn, variant).catch(() => []);
    const executables = targets.filter((t) => t.type === 'EXECUTABLE' && t.artifacts.length);
    if (!program && !target && config.request === 'launch') {
      if (executables.length === 1) {
        target = executables[0].name;
      } else if (executables.length > 1) {
        const key = `remoteDev.lastDebugTarget.${ctrl.folder.uri}`;
        const last = this.state.get<string>(key);
        const pick = await vscode.window.showQuickPick(
          executables
            .map((t) => ({ label: t.name, description: t.artifacts[0], picked: t.name === last }))
            .sort((a, b) => (a.label === last ? -1 : b.label === last ? 1 : 0)),
          { title: 'Remote Dev: executable to debug' },
        );
        if (!pick) return undefined;
        target = pick.label;
        await this.state.update(key, target);
      } else {
        const input = await vscode.window.showInputBox({
          title: 'Remote Dev: remote program path',
          prompt: `Path of the executable on ${s.conn.label} (relative to ${buildDir})`,
          ignoreFocusOut: true,
        });
        if (!input) return undefined;
        program = input;
      }
    }

    if (config.request === 'launch' && config.buildBeforeLaunch !== false) {
      const task = makeTask(ctrl, { type: TASK_TYPE, action: 'build', target, folder: ctrl.folder.name }, `Build${target ? ` ${target}` : ''}`);
      const code = await runTaskAndWait(task);
      if (code !== 0) {
        void vscode.window.showErrorMessage(`Remote Dev: build failed (exit ${code}); not starting the debugger.`);
        return undefined;
      }
    } else {
      await s.sync.ensureSynced();
    }

    if (target) {
      // Re-read targets: the build may have configured the project for the first time.
      const fresh = await s.builder.targets(s.conn, variant);
      const t = fresh.find((x) => x.name === target);
      if (!t?.artifacts.length) {
        void vscode.window.showErrorMessage(`Remote Dev: CMake target "${target}" has no artifact.`);
        return undefined;
      }
      program = t.artifacts[0];
    } else if (program && !program.startsWith('/')) {
      program = rjoin(buildDir, program);
    }

    await this.bridge.ensureListening();
    const gdb = config.miDebuggerPath || 'gdb';
    const sourceFileMap: Record<string, string> = {};
    for (const mp of ctrl.mappings()) sourceFileMap[mp.remote] = mp.local;

    const cpp: vscode.DebugConfiguration = {
      type: 'cppdbg',
      request: config.request,
      name: config.name,
      program: program || undefined,
      args: config.args ?? [],
      cwd: config.cwd ?? (program ? path.posix.dirname(program) : buildDir),
      environment: config.environment ?? [],
      stopAtEntry: config.stopAtEntry ?? false,
      externalConsole: false,
      MIMode: 'gdb',
      miDebuggerPath: gdb,
      pipeTransport: {
        pipeCwd: ctrl.localRoot,
        pipeProgram: process.execPath,
        pipeArgs: [path.join(this.extensionPath, 'dist', 'pipeProxy.js'), this.bridge.socketPath, ctrl.folder.uri.toString()],
        pipeEnv: { ELECTRON_RUN_AS_NODE: '1', REMOTE_DEV_TOKEN: this.bridge.token },
        debuggerPath: gdb,
        quoteArgs: false,
      },
      sourceFileMap,
      setupCommands: [
        { description: 'Enable pretty-printing', text: '-enable-pretty-printing', ignoreFailures: true },
        ...(config.setupCommands ?? []),
      ],
    };
    if (config.request === 'attach') {
      cpp.processId = String(config.processId ?? '');
      if (!cpp.processId) return undefined;
    }
    return cpp;
  }
}

/** Command: pick a remote process (for attach configurations). */
export async function pickRemoteProcess(ctrl: FolderController): Promise<string | undefined> {
  const s = await ctrl.ensureSession();
  const res = await s.conn.check('ps -eo pid=,user=,args= --sort=-start_time');
  const items = res.stdout
    .toString('utf8')
    .split('\n')
    .map((l) => /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(l))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ label: m[3].split(' ')[0].split('/').pop() || m[3], description: `${m[1]} · ${m[2]}`, detail: m[3], pid: m[1] }));
  const pick = await vscode.window.showQuickPick(items, {
    title: `Remote Dev: attach to process on ${s.conn.label}`,
    matchOnDescription: true,
    matchOnDetail: true,
  });
  return pick?.pid;
}
