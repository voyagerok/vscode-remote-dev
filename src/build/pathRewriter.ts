// Remote → local path rewriting for build output, compile databases and debugger maps.

export interface PathMapping {
  /** Absolute remote POSIX directory, no trailing slash. */
  remote: string;
  /** Absolute local directory, no trailing separator. */
  local: string;
}

function sortMappings(mappings: PathMapping[]): PathMapping[] {
  return [...mappings].filter((m) => m.remote.length > 1).sort((a, b) => b.remote.length - a.remote.length);
}

const BOUNDARY = /[/"'`\s:;,()<>=\[\]\x1b]/;

/**
 * Replace remote dir prefixes in arbitrary text. A match must be followed by a path
 * boundary so `/home/u/proj` does not rewrite `/home/u/project2`. On Windows the rest of
 * the path keeps forward slashes, which VS Code and clangd accept.
 */
export function rewriteText(text: string, mappings: PathMapping[]): string {
  const sorted = sortMappings(mappings);
  if (!sorted.length) return text;
  const pattern = new RegExp(sorted.map((m) => escapeRe(m.remote)).join('|'), 'g');
  return text.replace(pattern, (match, offset: number, whole: string) => {
    const next = whole.charAt(offset + match.length);
    if (next && !BOUNDARY.test(next)) return match;
    return sorted.find((m) => m.remote === match)!.local;
  });
}

/** Map a single remote path to local, or undefined if no mapping applies. */
export function toLocalPath(remotePath: string, mappings: PathMapping[]): string | undefined {
  for (const m of sortMappings(mappings)) {
    if (remotePath === m.remote) return m.local;
    if (remotePath.startsWith(m.remote + '/')) return m.local + remotePath.slice(m.remote.length);
  }
  return undefined;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Streaming variant: holds back a tail that could be the start of a split match so a
 * remote path spanning two chunks is still rewritten. Text is flushed at line breaks
 * to keep terminal output responsive.
 */
export class StreamRewriter {
  private buf = '';
  private readonly maxLen: number;

  constructor(private readonly mappings: PathMapping[]) {
    this.maxLen = Math.max(0, ...mappings.map((m) => m.remote.length));
  }

  push(chunk: string): string {
    this.buf += chunk;
    // Emit everything up to the last newline; keep partial line unless it grows large.
    let cut = this.buf.lastIndexOf('\n') + 1;
    if (cut === 0 && this.buf.length > this.maxLen * 2 + 4096) cut = this.buf.length - this.maxLen;
    if (cut === 0) {
      // No newline yet (e.g. a prompt): emit what cannot be part of a pending match.
      const safe = this.safePrefixLength(this.buf);
      cut = safe;
    }
    const out = this.buf.slice(0, cut);
    this.buf = this.buf.slice(cut);
    return rewriteText(out, this.mappings);
  }

  /** Length of the prefix that cannot contain the start of a mapping cut off at the end. */
  private safePrefixLength(s: string): number {
    for (let i = Math.max(0, s.length - this.maxLen - 1); i < s.length; i++) {
      const tail = s.slice(i);
      if (this.mappings.some((m) => m.remote.startsWith(tail) || tail.startsWith(m.remote))) return i;
    }
    return s.length;
  }

  end(): string {
    const out = rewriteText(this.buf, this.mappings);
    this.buf = '';
    return out;
  }
}
