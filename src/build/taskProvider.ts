import * as vscode from 'vscode';
import { FolderController } from '../controller';
import { shq } from '../config/profile';
import { errorMessage } from '../log';
import { loginShell } from '../ssh/remoteShell';
import { PtyIO, StepsPty, dim, header } from './remotePty';

export const TASK_TYPE = 'remote-dev';

export interface RemoteTaskDefinition extends vscode.TaskDefinition {
  type: typeof TASK_TYPE;
  action: 'sync' | 'configure' | 'build' | 'clean' | 'run' | 'command';
  target?: string;
  buildType?: string;
  command?: string;
  folder?: string;
  args?: string[];
}

/** Resolve the controller a task belongs to. */
export type ControllerLookup = (folder: vscode.WorkspaceFolder | undefined, name?: string) => FolderController | undefined;

/** The sequence of steps behind each task action, run inside a pseudoterminal. */
export async function runAction(io: PtyIO, ctrl: FolderController, def: RemoteTaskDefinition): Promise<number> {
  const s = await ctrl.ensureSession();
  const variant = def.buildType ?? ctrl.variant;
  const shell = (cmd: string, cwd = s.remoteRoot) => loginShell(cmd, { cwd, envSetup: s.profile.envSetup });

  io.line(header(`Syncing ${ctrl.localRoot} → ${s.conn.label}:${s.remoteRoot}`));
  const t0 = Date.now();
  const r = await s.sync.ensureSynced();
  io.line(dim(`  uploaded ${r.uploaded}, deleted ${r.deleted} (${Date.now() - t0} ms)`));
  if (def.action === 'sync' || io.cancelled) return 0;

  const configure = async (): Promise<number> => {
    const cmd = s.builder.configureCommand(variant);
    if (!cmd) return 0;
    io.line(header(`Configure${variant ? ` [${variant}]` : ''}`));
    io.line(dim(cmd));
    const code = await io.exec(shell(cmd));
    if (code === 0) {
      // Compile DB changed: refresh IntelliSense in the background.
      ctrl.refreshIntelliSense().catch((e) => ctrl.logger.warn(`IntelliSense refresh failed: ${errorMessage(e)}`));
    }
    return code;
  };

  switch (def.action) {
    case 'configure':
      return configure();

    case 'clean': {
      const cmd = s.builder.cleanCommand(variant);
      if (!cmd) {
        io.line('No clean command configured.');
        return 0;
      }
      io.line(header('Clean'));
      return io.exec(shell(cmd));
    }

    case 'build':
    case 'run': {
      if (await s.builder.needsConfigure(s.conn, variant)) {
        const c = await configure();
        if (c !== 0 || io.cancelled) return c;
      }
      const cmd = s.builder.buildCommand(variant, def.target);
      io.line(header(`Build${def.target ? ` ${def.target}` : ''}${variant ? ` [${variant}]` : ''}`));
      io.line(dim(cmd));
      const code = await io.exec(shell(cmd));
      if (code !== 0 || def.action === 'build' || io.cancelled) return code;

      const targets = await s.builder.targets(s.conn, variant);
      const t = targets.find((x) => x.name === def.target && x.type === 'EXECUTABLE');
      const program = t?.artifacts[0] ?? def.target;
      if (!program) throw new Error('No target to run');
      const argv = [program, ...(def.args ?? [])].map(shq).join(' ');
      io.line(header(`Run ${program}`));
      return io.exec(shell(argv, s.builder.buildDir(variant)));
    }

    case 'command': {
      if (!def.command) throw new Error('"command" is required for action "command"');
      io.line(header(def.command));
      return io.exec(shell(def.command));
    }
  }
  return 0;
}

export function makeTask(ctrl: FolderController, def: RemoteTaskDefinition, name: string): vscode.Task {
  const task = new vscode.Task(
    def,
    ctrl.folder,
    name,
    'Remote Dev',
    new vscode.CustomExecution(async () => {
      return new StepsPty(
        async () => (await ctrl.ensureSession()).conn,
        () => ctrl.mappings(),
        (io) => runAction(io, ctrl, def),
      );
    }),
    ['$gcc'],
  );
  if (def.action === 'build') task.group = vscode.TaskGroup.Build;
  if (def.action === 'clean') task.group = vscode.TaskGroup.Clean;
  task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, clear: true, showReuseMessage: false };
  return task;
}

export class RemoteTaskProvider implements vscode.TaskProvider {
  constructor(private readonly lookup: ControllerLookup, private readonly controllers: () => FolderController[]) {}

  provideTasks(): vscode.Task[] {
    const tasks: vscode.Task[] = [];
    for (const ctrl of this.controllers()) {
      if (!ctrl.getState().profile) continue;
      const folder = ctrl.folder.name;
      const mk = (action: RemoteTaskDefinition['action'], name: string) =>
        tasks.push(makeTask(ctrl, { type: TASK_TYPE, action, folder }, name));
      mk('build', 'Build');
      mk('sync', 'Sync');
      mk('clean', 'Clean');
      if (ctrl.getState().profile?.build.kind === 'cmake') mk('configure', 'Configure');
    }
    return tasks;
  }

  resolveTask(task: vscode.Task): vscode.Task | undefined {
    const def = task.definition as RemoteTaskDefinition;
    const folder = typeof task.scope === 'object' ? task.scope : undefined;
    const ctrl = this.lookup(folder, def.folder);
    if (!ctrl) return undefined;
    const resolved = makeTask(ctrl, def, task.name);
    // Keep user-specified matchers/presentation from tasks.json.
    resolved.problemMatchers = task.problemMatchers.length ? task.problemMatchers : resolved.problemMatchers;
    return resolved;
  }
}

/** Execute a task and resolve with its exit code (used before debugging). */
export async function runTaskAndWait(task: vscode.Task): Promise<number | undefined> {
  const execution = await vscode.tasks.executeTask(task);
  return new Promise((resolve) => {
    const d = vscode.tasks.onDidEndTaskProcess((e) => {
      if (e.execution === execution) {
        d.dispose();
        resolve(e.exitCode);
      }
    });
  });
}
