// Pure compile_commands.json handling: argument parsing, path rewriting, and extraction of
// the per-file IntelliSense configuration. No vscode or I/O.

import { PathMapping, rewriteText, toLocalPath } from '../build/pathRewriter';

export interface CompileCommand {
  directory: string;
  file: string;
  command?: string;
  arguments?: string[];
  output?: string;
}

/** POSIX-shell-like splitting of a `command` string. */
export function splitCommand(cmd: string): string[] {
  const out: string[] = [];
  let cur = '';
  let has = false;
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote === "'") {
      if (c === "'") quote = undefined;
      else cur += c;
    } else if (quote === '"') {
      if (c === '"') quote = undefined;
      else if (c === '\\' && i + 1 < cmd.length && '"\\$`'.includes(cmd[i + 1])) cur += cmd[++i];
      else cur += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      has = true;
    } else if (c === '\\' && i + 1 < cmd.length) {
      cur += cmd[++i];
      has = true;
    } else if (/\s/.test(c)) {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += c;
    }
  }
  if (has || cur) out.push(cur);
  return out;
}

export function argsOf(cc: CompileCommand): string[] {
  return cc.arguments ?? splitCommand(cc.command ?? '');
}

/** Resolve `p` against `dir` and normalize `.`/`..` segments (POSIX). */
function absPosix(dir: string, p: string): string {
  const parts = (p.startsWith('/') ? p : `${dir}/${p}`).split('/');
  const out: string[] = [];
  for (const s of parts) {
    if (s === '..') out.pop();
    else if (s && s !== '.') out.push(s);
  }
  return '/' + out.join('/');
}

export interface ParsedFlags {
  compiler: string;
  language: 'c' | 'c++';
  quote: string[];
  include: string[];
  system: string[];
  after: string[];
  defines: string[];
  forced: string[];
  std?: string;
}

const CXX_EXT = /\.(cc|cpp|cxx|c\+\+|C|ii|cppm|ixx|mm)$/;

/** Extract include dirs (absolute remote), defines and standard from a compile command. */
export function parseFlags(cc: CompileCommand): ParsedFlags {
  const args = argsOf(cc);
  const compiler = args[0] ?? 'cc';
  let language: 'c' | 'c++' = CXX_EXT.test(cc.file) || /\+\+|xx$/.test(compiler) ? 'c++' : 'c';
  const r: ParsedFlags = { compiler, language, quote: [], include: [], system: [], after: [], defines: [], forced: [] };
  const dir = cc.directory;
  const take = (flag: string, i: number): [string | undefined, number] => {
    const a = args[i];
    if (a === flag) return [args[i + 1], i + 1];
    return [a.slice(flag.length), i];
  };
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    let v: string | undefined;
    if (a.startsWith('-I')) {
      [v, i] = take('-I', i);
      if (v) r.include.push(absPosix(dir, v));
    } else if (a.startsWith('-isystem')) {
      [v, i] = take('-isystem', i);
      if (v) r.system.push(absPosix(dir, v));
    } else if (a.startsWith('-iquote')) {
      [v, i] = take('-iquote', i);
      if (v) r.quote.push(absPosix(dir, v));
    } else if (a.startsWith('-idirafter')) {
      [v, i] = take('-idirafter', i);
      if (v) r.after.push(absPosix(dir, v));
    } else if (a.startsWith('-D')) {
      [v, i] = take('-D', i);
      if (v) r.defines.push(v);
    } else if (a === '-include') {
      v = args[++i];
      if (v) r.forced.push(absPosix(dir, v));
    } else if (a.startsWith('-std=')) {
      r.std = a.slice(5);
    } else if (a === '-x') {
      const lang = args[++i];
      if (lang === 'c++' || lang === 'c') language = lang;
    }
  }
  r.language = language;
  return r;
}

const STANDARDS = new Set([
  'c89', 'c99', 'c11', 'c17', 'c23', 'gnu89', 'gnu99', 'gnu11', 'gnu17', 'gnu23',
  'c++98', 'c++03', 'c++11', 'c++14', 'c++17', 'c++20', 'c++23', 'c++26',
  'gnu++98', 'gnu++03', 'gnu++11', 'gnu++14', 'gnu++17', 'gnu++20', 'gnu++23', 'gnu++26',
]);

const STD_ALIASES: Record<string, string> = {
  'c90': 'c89', 'iso9899:1990': 'c89', 'c9x': 'c99', 'c1x': 'c11', 'c18': 'c17', 'c2x': 'c23',
  'gnu90': 'gnu89', 'gnu9x': 'gnu99', 'gnu1x': 'gnu11', 'gnu18': 'gnu17', 'gnu2x': 'gnu23',
  'c++0x': 'c++11', 'c++1y': 'c++14', 'c++1z': 'c++17', 'c++2a': 'c++20', 'c++2b': 'c++23', 'c++2c': 'c++26',
  'gnu++0x': 'gnu++11', 'gnu++1y': 'gnu++14', 'gnu++1z': 'gnu++17', 'gnu++2a': 'gnu++20', 'gnu++2b': 'gnu++23', 'gnu++2c': 'gnu++26',
};

export function normalizeStd(std: string | undefined): string | undefined {
  if (!std) return undefined;
  const s = STD_ALIASES[std] ?? std;
  return STANDARDS.has(s) ? s : undefined;
}

/** Parse `cc -E -v` stderr: the `#include <...>` search list. */
export function parseIncludeSearch(output: string): { quote: string[]; system: string[] } {
  const lines = output.split(/\r?\n/);
  const quote: string[] = [];
  const system: string[] = [];
  let target: string[] | undefined;
  for (const line of lines) {
    if (line.startsWith('#include "..." search starts here')) target = quote;
    else if (line.startsWith('#include <...> search starts here')) target = system;
    else if (line.startsWith('End of search list')) target = undefined;
    else if (target && line.startsWith(' ')) {
      // macOS-style " (framework directory)" suffix never appears on Linux but strip anyway.
      target.push(normalizePosix(line.trim().replace(/ \(framework directory\)$/, '')));
    }
  }
  return { quote, system };
}

function normalizePosix(p: string): string {
  return absPosix('/', p);
}

/** Parse `cc -dM -E` output into NAME=VALUE defines (language-version macros removed). */
export function parseDefines(output: string): string[] {
  const out: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const m = /^#define\s+(\S+)(?:\s+(.*))?$/.exec(line);
    if (!m) continue;
    // These depend on -std and are set by IntelliSense from `standard`.
    if (m[1] === '__cplusplus' || m[1] === '__STDC_VERSION__') continue;
    out.push(m[2] === undefined ? m[1] : `${m[1]}=${m[2]}`);
  }
  return out;
}

export function intelliSenseMode(triple: string, isClang: boolean): string {
  const arch = /^(x86_64|amd64)/.test(triple)
    ? 'x64'
    : /^(aarch64|arm64)/.test(triple)
      ? 'arm64'
      : /^arm/.test(triple)
        ? 'arm'
        : /^i[3-6]86/.test(triple)
          ? 'x86'
          : 'x64';
  return `linux-${isClang ? 'clang' : 'gcc'}-${arch}`;
}

/** Rewrite every path-like string in a compile DB from remote to local. */
export function rewriteCompileDb(db: CompileCommand[], mappings: PathMapping[]): CompileCommand[] {
  const rw = (s: string) => rewriteText(s, mappings);
  return db.map((cc) => ({
    directory: toLocalPath(cc.directory, mappings) ?? cc.directory,
    file: toLocalPath(absPosix(cc.directory, cc.file), mappings) ?? cc.file,
    ...(cc.arguments ? { arguments: cc.arguments.map(rw) } : {}),
    ...(cc.command !== undefined ? { command: rw(cc.command) } : {}),
    ...(cc.output !== undefined ? { output: rw(cc.output) } : {}),
  }));
}

/** Absolute remote path of the source file of an entry. */
export function remoteFile(cc: CompileCommand): string {
  return absPosix(cc.directory, cc.file);
}

/**
 * Remote include dirs that must be mirrored locally: everything outside the remote
 * project root, plus dirs inside it that are not part of the synced tree (build dirs
 * with generated headers).
 */
export function dirsToMirror(
  flags: ParsedFlags[],
  compilerDirs: string[],
  remoteRoot: string,
  isSyncedRel: (rel: string) => boolean,
): { system: string[]; project: string[] } {
  const system = new Set<string>(compilerDirs);
  const project = new Set<string>();
  for (const f of flags) {
    for (const d of [...f.quote, ...f.include, ...f.system, ...f.after]) {
      if (d === remoteRoot || d.startsWith(remoteRoot + '/')) {
        const rel = d.slice(remoteRoot.length + 1);
        if (rel && !isSyncedRel(rel)) project.add(d);
      } else {
        system.add(d);
      }
    }
  }
  return { system: collapse([...system]), project: collapse([...project]) };
}

/** Drop dirs nested inside another listed dir. */
function collapse(dirs: string[]): string[] {
  const sorted = [...new Set(dirs)].sort();
  const out: string[] = [];
  for (const d of sorted) {
    if (!out.some((p) => d === p || d.startsWith(p + '/'))) out.push(d);
  }
  return out;
}
