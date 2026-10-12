// Pure helpers for CMake: File API reply parsing and preset resolution.

export interface CMakeTarget {
  name: string;
  type: string;
  /** Absolute remote paths of produced artifacts. */
  artifacts: string[];
}

/**
 * Parse the File API reply directory dumped as `name\0content\0name\0content...`.
 * Returns targets of the first configuration (single-config generators have one).
 */
export function parseFileApiReply(dump: Buffer, buildDir: string, configuration?: string): CMakeTarget[] {
  const parts = dump.toString('utf8').split('\0');
  const files = new Map<string, string>();
  for (let i = 0; i + 1 < parts.length; i += 2) files.set(parts[i], parts[i + 1]);

  const indexName = [...files.keys()].filter((n) => n.startsWith('index-')).sort().pop();
  if (!indexName) return [];
  const index = JSON.parse(files.get(indexName)!);
  const cmRef = (index.objects as { kind: string; jsonFile: string }[]).find((o) => o.kind === 'codemodel');
  if (!cmRef) return [];
  const codemodel = JSON.parse(files.get(cmRef.jsonFile) ?? '{}');
  const configs: { name: string; targets: { name: string; jsonFile: string }[] }[] = codemodel.configurations ?? [];
  const config = configs.find((c) => c.name === configuration) ?? configs[0];
  if (!config) return [];
  const buildPath: string = codemodel.paths?.build ?? buildDir;

  const targets: CMakeTarget[] = [];
  for (const t of config.targets) {
    const raw = files.get(t.jsonFile);
    if (!raw) continue;
    const tj = JSON.parse(raw);
    targets.push({
      name: tj.name,
      type: tj.type,
      artifacts: ((tj.artifacts ?? []) as { path: string }[]).map((a) =>
        a.path.startsWith('/') ? a.path : `${buildPath}/${a.path}`,
      ),
    });
  }
  return targets.sort((a, b) => a.name.localeCompare(b.name));
}

interface RawPreset {
  name: string;
  inherits?: string | string[];
  binaryDir?: string;
  hidden?: boolean;
  generator?: string;
  configurePreset?: string;
  cacheVariables?: Record<string, unknown>;
}

interface PresetsFile {
  configurePresets?: RawPreset[];
  buildPresets?: RawPreset[];
}

export interface PresetInfo {
  configurePresets: string[];
  buildPresets: string[];
  /** Resolve a configure preset's binaryDir and build type, with remote source dir. */
  resolve(name: string, remoteSourceDir: string): { binaryDir?: string; buildType?: string };
  /** The configure preset a build preset refers to. */
  configureOf(buildPreset: string): string | undefined;
}

export function parsePresets(...files: (PresetsFile | undefined)[]): PresetInfo {
  const cfg = new Map<string, RawPreset>();
  const bld = new Map<string, RawPreset>();
  for (const f of files) {
    f?.configurePresets?.forEach((p) => cfg.set(p.name, p));
    f?.buildPresets?.forEach((p) => bld.set(p.name, p));
  }

  const lookup = (map: Map<string, RawPreset>, name: string, key: keyof RawPreset, seen = new Set<string>()): unknown => {
    const p = map.get(name);
    if (!p || seen.has(name)) return undefined;
    seen.add(name);
    if (p[key] !== undefined) return p[key];
    const parents = p.inherits === undefined ? [] : Array.isArray(p.inherits) ? p.inherits : [p.inherits];
    for (const parent of parents) {
      const v = lookup(map, parent, key, seen);
      if (v !== undefined) return v;
    }
    return undefined;
  };

  const cacheVar = (name: string, v: string, seen = new Set<string>()): unknown => {
    const p = cfg.get(name);
    if (!p || seen.has(name)) return undefined;
    seen.add(name);
    const own = p.cacheVariables?.[v];
    if (own !== undefined) return own;
    const parents = p.inherits === undefined ? [] : Array.isArray(p.inherits) ? p.inherits : [p.inherits];
    for (const parent of parents) {
      const r = cacheVar(parent, v, seen);
      if (r !== undefined) return r;
    }
    return undefined;
  };

  return {
    configurePresets: [...cfg.values()].filter((p) => !p.hidden).map((p) => p.name),
    buildPresets: [...bld.values()].filter((p) => !p.hidden).map((p) => p.name),
    resolve(name, src) {
      const raw = lookup(cfg, name, 'binaryDir') as string | undefined;
      const bt = cacheVar(name, 'CMAKE_BUILD_TYPE');
      const buildType = typeof bt === 'string' ? bt : (bt as { value?: string } | undefined)?.value;
      if (!raw) return { buildType };
      const slash = src.lastIndexOf('/');
      const binaryDir = raw
        .replace(/\$\{sourceDir\}/g, src)
        .replace(/\$\{sourceParentDir\}/g, src.slice(0, slash) || '/')
        .replace(/\$\{sourceDirName\}/g, src.slice(slash + 1))
        .replace(/\$\{presetName\}/g, name);
      return { binaryDir: binaryDir.startsWith('/') ? binaryDir : `${src}/${binaryDir}`, buildType };
    },
    configureOf(buildPreset) {
      return lookup(bld, buildPreset, 'configurePreset') as string | undefined;
    },
  };
}
