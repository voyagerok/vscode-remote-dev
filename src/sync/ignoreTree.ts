import * as fs from 'fs';
import * as path from 'path';
import ignore, { Ignore } from 'ignore';

/**
 * gitignore-style exclusion over a directory tree: profile excludes at the root,
 * plus (optionally) every `.gitignore` and `.git/info/exclude`, with nested files
 * scoped to their own subtree. All paths are POSIX, relative to the root.
 */
export class IgnoreTree {
  private readonly rootRules: Ignore;
  private readonly perDir = new Map<string, Ignore | null>();
  private readonly verdicts = new Map<string, boolean>();

  constructor(private readonly root: string, excludes: string[], private readonly useGitignore: boolean) {
    this.rootRules = ignore().add(excludes);
    if (useGitignore) {
      try {
        this.rootRules.add(fs.readFileSync(path.join(root, '.git', 'info', 'exclude'), 'utf8'));
      } catch {
        /* none */
      }
    }
  }

  /** Forget cached rules after a .gitignore changes. */
  invalidate(): void {
    this.perDir.clear();
    this.verdicts.clear();
  }

  private rulesFor(dir: string): Ignore | null {
    if (!this.useGitignore) return null;
    let r = this.perDir.get(dir);
    if (r === undefined) {
      try {
        r = ignore().add(fs.readFileSync(path.join(this.root, dir, '.gitignore'), 'utf8'));
      } catch {
        r = null;
      }
      this.perDir.set(dir, r);
    }
    return r;
  }

  /** Decide for a single path assuming its ancestors are not ignored. */
  private decide(rel: string, isDir: boolean): boolean {
    const target = isDir ? `${rel}/` : rel;
    let ignored = false;
    const root = this.rootRules.test(target);
    if (root.ignored) ignored = true;
    else if (root.unignored) ignored = false;

    // Nested .gitignore files, root → deepest; a deeper file overrides shallower ones.
    const parts = rel.split('/');
    for (let i = 0; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/');
      const rules = this.rulesFor(dir);
      if (!rules) continue;
      const sub = (i === 0 ? rel : parts.slice(i).join('/')) + (isDir ? '/' : '');
      const t = rules.test(sub);
      if (t.ignored) ignored = true;
      else if (t.unignored) ignored = false;
    }
    return ignored;
  }

  /** True if `rel` or any of its ancestor directories is excluded. */
  isIgnored(rel: string, isDir = false): boolean {
    if (!rel || rel === '.') return false;
    const key = `${rel}\0${isDir ? 1 : 0}`;
    const cached = this.verdicts.get(key);
    if (cached !== undefined) return cached;
    const slash = rel.lastIndexOf('/');
    const result = (slash > 0 && this.isIgnored(rel.slice(0, slash), true)) || this.decide(rel, isDir);
    if (this.verdicts.size > 50000) this.verdicts.clear();
    this.verdicts.set(key, result);
    return result;
  }
}
