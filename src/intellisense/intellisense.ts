import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { shq } from '../config/profile';
import { Logger } from '../log';
import { PathMapping, toLocalPath } from '../build/pathRewriter';
import { SshConnection } from '../ssh/connection';
import { loginShell } from '../ssh/remoteShell';
import {
  CompileCommand,
  ParsedFlags,
  argsOf,
  dirsToMirror,
  intelliSenseMode,
  normalizeStd,
  parseDefines,
  parseFlags,
  parseIncludeSearch,
  remoteFile,
  rewriteCompileDb,
} from './compileDb';
import { cachePath, mirrorDirs } from './headerCache';

/** Same shape as cpptools' SourceFileConfiguration (kept local so this module stays vscode-free). */
export interface FileConfig {
  includePath: string[];
  defines: string[];
  intelliSenseMode: string;
  standard?: string;
  forcedInclude: string[];
  compilerPath: string;
}

interface CompilerInfo {
  quote: string[];
  system: string[];
  defines: string[];
  triple: string;
  clang: boolean;
}

export interface IntelliSenseState {
  /** Normalized local file path → configuration. */
  files: Map<string, FileConfig>;
  /** Local dir → a configuration to use for headers in that dir. */
  dirs: Map<string, FileConfig>;
  fallback?: FileConfig;
  browsePath: string[];
  /** Mappings for remote system/generated header dirs (for debugger + output rewrite). */
  headerMappings: PathMapping[];
  compileDbPath: string;
}

export interface RefreshContext {
  conn: SshConnection;
  envSetup?: string;
  localRoot: string;
  remoteRoot: string;
  /** Remote compile_commands.json path. */
  compileDb: string;
  /** Local cache dir for this host. */
  cacheRoot: string;
  /** Whether a project-relative dir exists in the synced local tree. */
  isSyncedDir: (rel: string) => boolean;
  /** Download system headers even if they were cached before. */
  refetchSystem: boolean;
  log: Logger;
}

/** Key used for file lookups: case-insensitive on Windows/macOS file systems. */
export function fileKey(p: string): string {
  const n = path.normalize(p);
  return process.platform === 'linux' ? n : n.toLowerCase();
}

async function queryCompiler(ctx: RefreshContext, compiler: string, lang: 'c' | 'c++', cwd: string): Promise<CompilerInfo> {
  const cc = shq(compiler);
  const script =
    `${cc} -x ${lang} -E -v - </dev/null 2>&1 >/dev/null; printf '\\0'; ` +
    `${cc} -x ${lang} -dM -E - </dev/null; printf '\\0'; ` +
    `${cc} -dumpmachine; printf '\\0'; ${cc} --version 2>&1 | head -1`;
  const res = await ctx.conn.run(loginShell(script, { cwd, envSetup: ctx.envSetup }));
  const [search = '', defs = '', triple = '', version = ''] = res.stdout.toString('utf8').split('\0');
  const inc = parseIncludeSearch(search);
  return { quote: inc.quote, system: inc.system, defines: parseDefines(defs), triple: triple.trim(), clang: /clang/i.test(version) };
}

interface CacheIndex {
  /** Remote system dirs already mirrored. */
  system: string[];
}

function readIndex(cacheRoot: string): CacheIndex {
  try {
    return JSON.parse(fs.readFileSync(path.join(cacheRoot, 'index.json'), 'utf8')) as CacheIndex;
  } catch {
    return { system: [] };
  }
}

/**
 * Pull compile_commands.json and the headers it needs from the remote, then produce
 * (a) a rewritten local compile DB for clangd and (b) per-file configurations for cpptools.
 */
export async function refreshIntelliSense(ctx: RefreshContext): Promise<IntelliSenseState | undefined> {
  const { conn, localRoot, remoteRoot, cacheRoot, log } = ctx;
  const res = await conn.run(`cat ${shq(ctx.compileDb)}`);
  if (res.code !== 0) {
    log.warn(`No compile database at ${ctx.compileDb} (configure the project first)`);
    return undefined;
  }
  const db = JSON.parse(res.stdout.toString('utf8')) as CompileCommand[];
  const flags = db.map(parseFlags);

  // One query per distinct compiler/language pair.
  const compilers = new Map<string, CompilerInfo>();
  for (const f of flags) {
    const key = `${f.compiler}\0${f.language}`;
    if (!compilers.has(key)) {
      try {
        compilers.set(key, await queryCompiler(ctx, f.compiler, f.language, remoteRoot));
      } catch (e) {
        log.warn(`Compiler query failed for ${f.compiler}: ${(e as Error).message}`);
      }
    }
  }
  const compilerDirs = [...compilers.values()].flatMap((c) => [...c.quote, ...c.system]);
  const mirror = dirsToMirror(flags, compilerDirs, remoteRoot, ctx.isSyncedDir);

  await fs.promises.mkdir(cacheRoot, { recursive: true });
  const index = readIndex(cacheRoot);
  const missing = ctx.refetchSystem
    ? mirror.system
    : mirror.system.filter((d) => !index.system.some((c) => d === c || d.startsWith(c + '/')));
  if (missing.length) {
    log.info(`Downloading remote headers: ${missing.join(', ')}`);
    const n = await mirrorDirs(conn, cacheRoot, missing, false, log);
    log.info(`Header cache: ${n} files`);
    index.system = [...new Set([...index.system, ...missing])];
    await fs.promises.writeFile(path.join(cacheRoot, 'index.json'), JSON.stringify(index, null, 2));
  }
  if (mirror.project.length) {
    // Generated headers in build dirs change with every configure: always refresh.
    await mirrorDirs(conn, cacheRoot, mirror.project, true, log);
  }

  const headerMappings: PathMapping[] = [...mirror.system, ...mirror.project].map((d) => ({
    remote: d,
    local: cachePath(cacheRoot, d),
  }));
  const mappings: PathMapping[] = [{ remote: remoteRoot, local: localRoot }, ...headerMappings];
  const toLocal = (p: string) => toLocalPath(p, mappings) ?? p;

  // (a) compile DB for clangd: remote paths rewritten, compiler search dirs made explicit.
  const rewritten = rewriteCompileDb(db, mappings).map((cc, i) => {
    const info = compilers.get(`${flags[i].compiler}\0${flags[i].language}`);
    const args = argsOf(cc);
    if (!info) return { directory: cc.directory, file: cc.file, arguments: args, output: cc.output };
    const extra = ['-nostdinc', ...(info.triple ? [`--target=${info.triple}`] : [])];
    for (const d of info.quote) extra.push('-iquote', toLocal(d));
    for (const d of info.system) extra.push('-isystem', toLocal(d));
    return { directory: cc.directory, file: cc.file, arguments: [args[0], ...extra, ...args.slice(1)], output: cc.output };
  });
  const outDir = path.join(localRoot, '.vscode', 'remote-dev');
  await fs.promises.mkdir(outDir, { recursive: true });
  await fs.promises.writeFile(path.join(outDir, '.gitignore'), '*\n');
  const compileDbPath = path.join(outDir, 'compile_commands.json');
  await fs.promises.writeFile(compileDbPath, JSON.stringify(rewritten, null, 2));

  // (b) cpptools configurations.
  const files = new Map<string, FileConfig>();
  const dirs = new Map<string, FileConfig>();
  const browse = new Set<string>([localRoot]);
  let fallback: FileConfig | undefined;
  let fallbackIsCxx = false;
  db.forEach((cc, i) => {
    const f: ParsedFlags = flags[i];
    const info = compilers.get(`${f.compiler}\0${f.language}`);
    const includePath = [
      ...f.quote,
      ...f.include,
      ...f.system,
      ...(info?.quote ?? []),
      ...(info?.system ?? []),
      ...f.after,
    ].map(toLocal);
    includePath.forEach((p) => browse.add(p));
    const std = normalizeStd(f.std);
    const cfg: FileConfig = {
      includePath: [...new Set(includePath)],
      defines: [...(info?.defines ?? []), ...f.defines],
      intelliSenseMode: intelliSenseMode(info?.triple ?? 'x86_64', info?.clang ?? false),
      standard: std,
      forcedInclude: f.forced.map(toLocal),
      // Empty compilerPath: never query a local compiler, the remote one is authoritative.
      compilerPath: '',
    };
    const local = fileKey(toLocal(remoteFile(cc)));
    files.set(local, cfg);
    const dir = path.dirname(local);
    if (!dirs.has(dir) || f.language === 'c++') dirs.set(dir, cfg);
    if (!fallback || (f.language === 'c++' && !fallbackIsCxx)) {
      fallback = cfg;
      fallbackIsCxx = f.language === 'c++';
    }
  });

  log.info(`IntelliSense: ${db.length} compile entries, ${compilers.size} compiler(s), ${headerMappings.length} mirrored include root(s)`);
  return { files, dirs, fallback, browsePath: [...browse], headerMappings, compileDbPath };
}

/** Per-host cache dir name. */
export function hostCacheName(user: string, host: string, port: number): string {
  return crypto.createHash('sha1').update(`${user}@${host}:${port}`).digest('hex').slice(0, 16);
}

/** Config for a header or other file not in the DB: nearest dir with a config, else fallback. */
export function configFor(state: IntelliSenseState, file: string): FileConfig | undefined {
  const key = fileKey(file);
  const direct = state.files.get(key);
  if (direct) return direct;
  for (let dir = path.dirname(key); ; dir = path.dirname(dir)) {
    const c = state.dirs.get(dir);
    if (c) return c;
    if (path.dirname(dir) === dir) break;
  }
  return state.fallback;
}
