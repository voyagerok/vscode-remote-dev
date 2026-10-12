// Pure profile model: no vscode imports so it can be unit-tested.

export interface CMakeBuildConfig {
  kind: 'cmake';
  /** Build types offered in the picker; each gets its own build dir. */
  buildTypes?: string[];
  /** Relative to remoteRoot unless absolute. `${buildType}` is substituted. */
  buildDir?: string;
  generator?: string;
  configureArgs?: string[];
  buildArgs?: string[];
  /** Use a CMake preset instead of buildTypes (`cmake --preset`). */
  configurePreset?: string;
  buildPreset?: string;
  cmakePath?: string;
}

export interface CustomBuildConfig {
  kind: 'custom';
  buildCommand: string;
  cleanCommand?: string;
  configureCommand?: string;
  /** Remote dir containing build outputs (for debug/run defaults), relative to remoteRoot. */
  buildDir?: string;
  /** Remote path to a compile_commands.json, relative to remoteRoot, for IntelliSense. */
  compileCommands?: string;
}

export type BuildConfig = CMakeBuildConfig | CustomBuildConfig;

export interface RawProfile {
  name: string;
  host: string;
  port?: number;
  user?: string;
  identityFile?: string;
  remoteRoot?: string;
  envSetup?: string;
  exclude?: string[];
  useGitignore?: boolean;
  deleteRemoteOrphans?: boolean;
  build?: Partial<BuildConfig> & { kind?: string };
}

export interface Profile {
  name: string;
  host: string;
  port?: number;
  user?: string;
  identityFile?: string;
  /** May start with `~/`; resolved against the remote $HOME after connecting. */
  remoteRoot: string;
  envSetup?: string;
  exclude: string[];
  useGitignore: boolean;
  deleteRemoteOrphans: boolean;
  build: BuildConfig;
}

export const DEFAULT_EXCLUDES = [
  '.git/',
  '.hg/',
  '.svn/',
  '.vscode/',
  '.idea/',
  '.cache/',
  'node_modules/',
  '/build*/',
  '/cmake-build-*/',
  '/out/',
  '.DS_Store',
  'Thumbs.db',
  '*.swp',
  '*~',
];

/** Stable, path-safe id for a local folder so different projects never share a remote dir. */
export function folderSlug(folderName: string, folderPath: string): string {
  let h = 2166136261;
  for (let i = 0; i < folderPath.length; i++) {
    h ^= folderPath.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const safe = folderName.replace(/[^A-Za-z0-9._-]/g, '_') || 'project';
  return `${safe}-${(h >>> 0).toString(16).padStart(8, '0')}`;
}

export function normalizeProfile(raw: RawProfile, folderName: string, folderPath: string): Profile {
  if (!raw || typeof raw.name !== 'string' || !raw.name) {
    throw new Error('Remote Dev profile is missing "name"');
  }
  if (typeof raw.host !== 'string' || !raw.host) {
    throw new Error(`Remote Dev profile "${raw.name}" is missing "host"`);
  }
  const remoteRoot = (raw.remoteRoot || `~/.remote-dev/${folderSlug(folderName, folderPath)}`).replace(/\/+$/, '');
  if (remoteRoot === '' || remoteRoot === '~' || remoteRoot === '/') {
    // Orphan deletion operates inside remoteRoot; never allow it to be a home or root dir.
    throw new Error(`Remote Dev profile "${raw.name}": remoteRoot "${raw.remoteRoot}" is not allowed`);
  }
  if (!remoteRoot.startsWith('/') && !remoteRoot.startsWith('~/')) {
    throw new Error(`Remote Dev profile "${raw.name}": remoteRoot must be absolute or start with ~/`);
  }

  const b = raw.build ?? {};
  let build: BuildConfig;
  if (b.kind === 'custom') {
    const c = b as Partial<CustomBuildConfig>;
    if (!c.buildCommand) {
      throw new Error(`Remote Dev profile "${raw.name}": custom build requires "buildCommand"`);
    }
    build = { ...c, kind: 'custom', buildCommand: c.buildCommand };
  } else {
    const c = b as Partial<CMakeBuildConfig>;
    build = {
      ...c,
      kind: 'cmake',
      buildTypes: c.buildTypes?.length ? c.buildTypes : ['Debug', 'Release'],
      buildDir: c.buildDir || 'cmake-build-${buildType}',
    };
  }

  return {
    name: raw.name,
    host: raw.host,
    port: raw.port,
    user: raw.user,
    identityFile: raw.identityFile,
    remoteRoot,
    envSetup: raw.envSetup,
    exclude: [...DEFAULT_EXCLUDES, ...(raw.exclude ?? [])],
    useGitignore: raw.useGitignore ?? true,
    deleteRemoteOrphans: raw.deleteRemoteOrphans ?? true,
    build,
  };
}

/** POSIX-join for remote paths. */
export function rjoin(...parts: string[]): string {
  const joined = parts.filter((p) => p !== '').join('/');
  return joined.replace(/\/{2,}/g, '/');
}

export function resolveBuildDir(profile: Profile, remoteRoot: string, buildType: string | undefined): string {
  const dir = (profile.build.buildDir ?? 'build').replace(/\$\{buildType\}/g, (buildType ?? 'Debug').toLowerCase());
  return dir.startsWith('/') ? dir : rjoin(remoteRoot, dir);
}

/** Single-quote for POSIX sh. */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
