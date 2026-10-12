import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import SSHConfig from 'ssh-config';

export interface ResolvedHost {
  /** Alias as written by the user (used for display and known_hosts aliasing). */
  alias: string;
  hostName: string;
  port: number;
  user: string;
  identityFiles: string[];
  /** IdentitiesOnly=yes: do not offer ssh-agent keys. */
  identitiesOnly: boolean;
  proxyJump?: string;
}

export interface HostOverrides {
  port?: number;
  user?: string;
  identityFile?: string;
}

export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

const DEFAULT_KEYS = ['id_ed25519', 'id_ecdsa', 'id_rsa'];

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function all(v: string | string[] | undefined): string[] {
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
}

/**
 * Parse `user@host:port` shorthand and merge it with ~/.ssh/config, the way `ssh` would.
 * Explicit profile overrides win over ssh config values.
 */
export function resolveHost(spec: string, overrides: HostOverrides = {}, configText?: string): ResolvedHost {
  let alias = spec;
  let specUser: string | undefined;
  let specPort: number | undefined;
  const at = alias.lastIndexOf('@');
  if (at >= 0) {
    specUser = alias.slice(0, at);
    alias = alias.slice(at + 1);
  }
  const portMatch = /^(.*):(\d+)$/.exec(alias);
  if (portMatch && !alias.includes(']')) {
    alias = portMatch[1];
    specPort = Number(portMatch[2]);
  }

  let computed: Record<string, string | string[]> = {};
  const text = configText ?? readSshConfig();
  if (text) {
    try {
      computed = SSHConfig.parse(text).compute(alias);
    } catch {
      computed = {};
    }
  }

  const cfgIdentity = all(computed.IdentityFile).map((f) => expandHome(f.replace(/%d/g, os.homedir())));
  const explicit = overrides.identityFile ? [expandHome(overrides.identityFile)] : cfgIdentity;
  const identitiesOnly = /^yes$/i.test(first(computed.IdentitiesOnly) ?? '');
  const identityFiles = explicit.length
    ? explicit
    : DEFAULT_KEYS.map((k) => path.join(os.homedir(), '.ssh', k)).filter((f) => fs.existsSync(f));

  const proxyJump = first(computed.ProxyJump);
  return {
    alias,
    hostName: first(computed.HostName) ?? alias,
    port: overrides.port ?? specPort ?? Number(first(computed.Port) ?? 22),
    user: overrides.user ?? specUser ?? first(computed.User) ?? os.userInfo().username,
    identityFiles,
    identitiesOnly,
    proxyJump: proxyJump && !/^none$/i.test(proxyJump) ? proxyJump : undefined,
  };
}

function readSshConfig(): string | undefined {
  try {
    return fs.readFileSync(path.join(os.homedir(), '.ssh', 'config'), 'utf8');
  } catch {
    return undefined;
  }
}
