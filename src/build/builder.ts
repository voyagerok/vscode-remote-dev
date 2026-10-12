import * as fs from 'fs';
import * as path from 'path';
import { parseJsonc } from '../config/jsonc';
import { CMakeBuildConfig, Profile, resolveBuildDir, rjoin, shq } from '../config/profile';
import { SshConnection } from '../ssh/connection';
import { CMakeTarget, PresetInfo, parseFileApiReply, parsePresets } from './cmakeModel';

/** Everything the task provider, debugger and IntelliSense need from a build system. */
export interface Builder {
  readonly kind: 'cmake' | 'custom';
  /** Selectable variants: CMake build types or configure presets. */
  variants(): string[];
  /** Variant used when none is selected. */
  defaultVariant(): string | undefined;
  buildDir(variant: string | undefined): string;
  configureCommand(variant: string | undefined): string | undefined;
  buildCommand(variant: string | undefined, target?: string): string;
  cleanCommand(variant: string | undefined): string | undefined;
  /** Whether `configure` must run before the first build of this variant. */
  needsConfigure(conn: SshConnection, variant: string | undefined): Promise<boolean>;
  targets(conn: SshConnection, variant: string | undefined): Promise<CMakeTarget[]>;
  compileCommandsPath(variant: string | undefined): string | undefined;
}

export function createBuilder(profile: Profile, localRoot: string, remoteRoot: string): Builder {
  return profile.build.kind === 'cmake'
    ? new CMakeBuilder(profile, profile.build, localRoot, remoteRoot)
    : new CustomBuilder(profile, remoteRoot);
}

function readPresetFile(file: string): object | undefined {
  try {
    return parseJsonc(fs.readFileSync(file, 'utf8')) as object;
  } catch {
    return undefined;
  }
}

class CMakeBuilder implements Builder {
  readonly kind = 'cmake';
  private readonly presets?: PresetInfo;
  private readonly cmake: string;

  constructor(
    private readonly profile: Profile,
    private readonly cfg: CMakeBuildConfig,
    localRoot: string,
    private readonly remoteRoot: string,
  ) {
    // Presets are read from the local copy: it is the source of truth and identical to the remote.
    const info = parsePresets(
      readPresetFile(path.join(localRoot, 'CMakePresets.json')) as never,
      readPresetFile(path.join(localRoot, 'CMakeUserPresets.json')) as never,
    );
    if (info.configurePresets.length) this.presets = info;
    this.cmake = cfg.cmakePath ?? 'cmake';
  }

  private usesPreset(variant: string | undefined): variant is string {
    return !!variant && !!this.presets?.configurePresets.includes(variant);
  }

  variants(): string[] {
    return this.presets?.configurePresets ?? this.cfg.buildTypes ?? ['Debug'];
  }

  defaultVariant(): string | undefined {
    if (this.cfg.configurePreset) return this.cfg.configurePreset;
    return this.variants()[0];
  }

  buildDir(variant: string | undefined): string {
    if (this.usesPreset(variant)) {
      const dir = this.presets!.resolve(variant, this.remoteRoot).binaryDir;
      if (dir) return dir;
    }
    return resolveBuildDir(this.profile, this.remoteRoot, this.usesPreset(variant) ? variant : variant ?? 'Debug');
  }

  private fileApiQuery(dir: string): string {
    const q = rjoin(dir, '.cmake/api/v1/query');
    return `mkdir -p ${shq(q)} && touch ${shq(q + '/codemodel-v2')}`;
  }

  configureCommand(variant: string | undefined): string {
    const dir = this.buildDir(variant);
    const args = [...(this.cfg.configureArgs ?? [])].map(shq).join(' ');
    if (this.usesPreset(variant)) {
      return `${this.fileApiQuery(dir)} && ${shq(this.cmake)} --preset ${shq(variant)} -S ${shq(this.remoteRoot)} -B ${shq(dir)} -DCMAKE_EXPORT_COMPILE_COMMANDS=ON ${args}`;
    }
    const gen = this.cfg.generator ? `-G ${shq(this.cfg.generator)}` : '';
    return (
      `${this.fileApiQuery(dir)} && ${shq(this.cmake)} -S ${shq(this.remoteRoot)} -B ${shq(dir)} ${gen} ` +
      `-DCMAKE_BUILD_TYPE=${shq(variant ?? 'Debug')} -DCMAKE_EXPORT_COMPILE_COMMANDS=ON ${args}`
    );
  }

  buildCommand(variant: string | undefined, target?: string): string {
    const extra = this.cfg.buildArgs?.length ? ` -- ${this.cfg.buildArgs.map(shq).join(' ')}` : '';
    const t = target ? ` --target ${shq(target)}` : '';
    if (this.cfg.buildPreset) {
      return `${shq(this.cmake)} --build --preset ${shq(this.cfg.buildPreset)}${t}${extra}`;
    }
    // --config matters only for multi-config generators; harmless otherwise.
    const config = this.usesPreset(variant) ? this.presets!.resolve(variant, this.remoteRoot).buildType : variant;
    const cfgArg = config ? ` --config ${shq(config)}` : '';
    return `${shq(this.cmake)} --build ${shq(this.buildDir(variant))}${cfgArg} --parallel${t}${extra}`;
  }

  cleanCommand(variant: string | undefined): string {
    return `${shq(this.cmake)} --build ${shq(this.buildDir(variant))} --target clean`;
  }

  async needsConfigure(conn: SshConnection, variant: string | undefined): Promise<boolean> {
    const res = await conn.run(`test -f ${shq(rjoin(this.buildDir(variant), 'CMakeCache.txt'))}`);
    return res.code !== 0;
  }

  async targets(conn: SshConnection, variant: string | undefined): Promise<CMakeTarget[]> {
    const dir = this.buildDir(variant);
    const reply = rjoin(dir, '.cmake/api/v1/reply');
    const res = await conn.run(
      `cd ${shq(reply)} 2>/dev/null || exit 0; for f in *.json; do printf '%s\\0' "$f"; cat "$f"; printf '\\0'; done`,
    );
    if (res.code !== 0 || !res.stdout.length) return [];
    const config = this.usesPreset(variant) ? this.presets!.resolve(variant, this.remoteRoot).buildType : variant;
    return parseFileApiReply(res.stdout, dir, config);
  }

  compileCommandsPath(variant: string | undefined): string {
    return rjoin(this.buildDir(variant), 'compile_commands.json');
  }
}

class CustomBuilder implements Builder {
  readonly kind = 'custom';
  private readonly cfg: Extract<Profile['build'], { kind: 'custom' }>;

  constructor(private readonly profile: Profile, private readonly remoteRoot: string) {
    this.cfg = profile.build as typeof this.cfg;
  }

  variants(): string[] {
    return [];
  }

  defaultVariant(): undefined {
    return undefined;
  }

  buildDir(): string {
    return resolveBuildDir(this.profile, this.remoteRoot, undefined);
  }

  configureCommand(): string | undefined {
    return this.cfg.configureCommand;
  }

  buildCommand(_variant: string | undefined, target?: string): string {
    return this.cfg.buildCommand.replace(/\$\{target\}/g, target ? shq(target) : '');
  }

  cleanCommand(): string | undefined {
    return this.cfg.cleanCommand;
  }

  async needsConfigure(): Promise<boolean> {
    return false;
  }

  async targets(): Promise<CMakeTarget[]> {
    return [];
  }

  compileCommandsPath(): string | undefined {
    const p = this.cfg.compileCommands;
    if (!p) return undefined;
    return p.startsWith('/') ? p : rjoin(this.remoteRoot, p);
  }
}
