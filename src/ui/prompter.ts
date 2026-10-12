import * as vscode from 'vscode';
import { Prompter } from '../ssh/connection';

export class VsCodePrompter implements Prompter {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  private secretKey(key: string): string {
    return `remoteDev.password.${key}`;
  }

  async password(prompt: string, key: string): Promise<string | undefined> {
    const remember = vscode.workspace.getConfiguration('remoteDev').get<boolean>('rememberPasswords', true);
    if (remember) {
      const stored = await this.secrets.get(this.secretKey(key));
      if (stored !== undefined) return stored;
    }
    const value = await vscode.window.showInputBox({
      title: 'Remote Dev: SSH password',
      prompt: remember ? `${prompt} (stored in VS Code secret storage)` : prompt,
      password: true,
      ignoreFocusOut: true,
    });
    if (value !== undefined && remember) await this.secrets.store(this.secretKey(key), value);
    return value;
  }

  async forgetPassword(key: string): Promise<void> {
    await this.secrets.delete(this.secretKey(key));
  }

  passphrase(keyFile: string): Promise<string | undefined> {
    return Promise.resolve(
      vscode.window.showInputBox({
        title: 'Remote Dev: key passphrase',
        prompt: `Passphrase for ${keyFile}`,
        password: true,
        ignoreFocusOut: true,
      }),
    );
  }

  async keyboardInteractive(name: string, instructions: string, prompts: { prompt: string; echo?: boolean }[]): Promise<string[] | undefined> {
    const answers: string[] = [];
    for (const p of prompts) {
      const v = await vscode.window.showInputBox({
        title: `Remote Dev: ${name || 'SSH authentication'}`,
        prompt: [instructions, p.prompt].filter(Boolean).join(' — '),
        password: !p.echo,
        ignoreFocusOut: true,
      });
      if (v === undefined) return undefined;
      answers.push(v);
    }
    return answers;
  }

  async confirmHostKey(host: string, fingerprint: string): Promise<boolean> {
    const trust = 'Trust and Connect';
    const choice = await vscode.window.showWarningMessage(
      `The authenticity of host "${host}" can't be established.`,
      { modal: true, detail: `Key fingerprint is ${fingerprint}.\nIt will be added to ~/.ssh/known_hosts.` },
      trust,
    );
    return choice === trust;
  }

  async hostKeyChanged(host: string, fingerprint: string): Promise<boolean> {
    const choice = await vscode.window.showErrorMessage(
      `WARNING: the host key for "${host}" has CHANGED.`,
      {
        modal: true,
        detail:
          `Someone could be eavesdropping on you (man-in-the-middle attack), or the host key was just changed.\n` +
          `New fingerprint: ${fingerprint}\n\nFix ~/.ssh/known_hosts if the change is expected. Connecting once anyway does not update known_hosts.`,
      },
      'Connect Once Anyway',
    );
    return choice === 'Connect Once Anyway';
  }
}
