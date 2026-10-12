# Remote Dev with Local Sources

A VS Code extension that brings CLion's **"remote development with local sources"** workflow to VS Code.
Your sources stay on your machine: you edit them, use git, and get IntelliSense locally.
Builds, runs and debugging happen on a Linux host over SSH that has the toolchain. The extension
keeps a mirror of the project on the remote and maps every remote path back to your local files.

Local: Windows, macOS, Linux. Remote: Linux (bash/sh, GNU coreutils/findutils, tar, and gdb for debugging).

## Features

- **Smart sync**, implemented in Node with no `rsync`/`ssh` binaries needed:
  - An initial or full resync diffs the local tree against a single remote `find` listing. Only
    changed files are sent, as one tar stream that keeps mtimes and modes. Remote orphans are deleted.
  - Incremental sync follows file-system events (saves, git checkouts, external tools). Events are
    debounced and coalesced, and large bursts such as a branch switch fall back to a full diff.
  - Before every build or debug session, the extension flushes pending changes and checks the
    local tree against what it believes is on the remote.
  - **Resync project**, **Force resync** (compares SHA-1 hashes on both sides) and
    **Resync / Force resync** for a single file or folder from the Explorer context menu.
  - Excludes come from `.gitignore` (nested files and `.git/info/exclude` included), profile
    `exclude` globs and built-in defaults (`.git/`, `build*/`, `cmake-build-*/`, …). Remote build
    dirs are never deleted.
  - Windows: bytes are uploaded verbatim with no line-ending conversion. Exec bits come from the
    git index, and the remote's exec bit is kept for files git doesn't know about.
- **Build** through the `remote-dev` task type (Ctrl+Shift+B): Configure, Build, Clean, Run and
  arbitrary commands. Remote output is rewritten to local paths, so `$gcc` problems and terminal
  links open your local files.
  - **CMake**: build types or `CMakePresets.json`/`CMakeUserPresets.json` configure presets, any
    generator, and targets with artifact paths read through the CMake File API.
  - **Custom**: any build/clean/configure command (Make, Meson, scripts).
- **Debug** with the `remote-gdb` debug type, which resolves to `cppdbg` (ms-vscode.cpptools).
  gdb runs on the remote. Its stdio is relayed over the extension's already authenticated SSH
  connection, so you need no local gdb or ssh, and password, agent and key auth behave the same
  on every OS. Breakpoints and stepping use `sourceFileMap`: remote paths map to local sources and
  system headers map to the local header cache. Supports launch, attach with a remote process
  picker, a target picker, and build-before-launch.
- **IntelliSense from the remote toolchain:**
  - Downloads `compile_commands.json` and mirrors the remote compiler's system include dirs, any
    out-of-tree `-I` dirs and generated headers in build dirs into a local cache.
  - Writes a rewritten `.vscode/remote-dev/compile_commands.json` for clangd. It adds
    `-nostdinc`, `--target` and the mirrored `-isystem` dirs.
  - Acts as a cpptools **custom configuration provider**. Each file gets its include paths,
    defines (including the remote compiler's built-ins), standard and IntelliSense mode, and no
    local compiler is ever queried.
- **SSH**: honors `~/.ssh/config` (`HostName`, `User`, `Port`, `IdentityFile`, `IdentitiesOnly`,
  `ProxyJump` chains). Supports the ssh-agent (Pageant and the Windows OpenSSH agent included),
  encrypted keys, password and keyboard-interactive auth, and known_hosts verification (hashed
  entries, `@revoked`, prompts on unknown or changed keys). It keeps the connection alive and
  reconnects with backoff.
- A status bar entry shows connection state, pending uploads and errors, with a menu of all actions.
  A second entry selects the build type or preset. **Open Remote Terminal** opens a shell in the
  remote project dir.

## Getting started

1. Install `ms-vscode.cpptools`. The remote needs `cmake` (or your build tool), a compiler and `gdb`.
2. Run **Remote Dev: Configure Remote Host**. Pick an `~/.ssh/config` alias or enter `user@host[:port]`,
   choose the remote directory and the build system. This writes `.vscode/remote-dev.json`.
3. The extension connects and runs the initial sync. Then use **Ctrl+Shift+B → Remote Dev: Build**
   or press **F5** with a `remote-gdb` launch configuration:

```jsonc
// .vscode/launch.json
{
  "configurations": [
    { "type": "remote-gdb", "request": "launch", "name": "Remote: app", "program": "${target:app}", "args": ["--verbose"] },
    { "type": "remote-gdb", "request": "attach", "name": "Remote: attach", "program": "${target:app}", "processId": "${command:remoteDev.pickRemoteProcess}" }
  ]
}
```

`program` takes `${target:<cmake target>}`, an absolute remote path, or a path relative to the
build dir. If you leave it empty, the extension asks you to pick an executable target.

```jsonc
// .vscode/tasks.json — custom tasks
{
  "tasks": [
    { "type": "remote-dev", "action": "build", "target": "unit_tests", "label": "Build tests" },
    { "type": "remote-dev", "action": "run", "target": "unit_tests", "args": ["--gtest_brief=1"], "label": "Run tests" },
    { "type": "remote-dev", "action": "command", "command": "ctest --test-dir cmake-build-debug", "label": "ctest" }
  ]
}
```

For clangd instead of cpptools, add `--compile-commands-dir=${workspaceFolder}/.vscode/remote-dev` to `clangd.arguments`.

## Configuration

`.vscode/remote-dev.json` (or the `remoteDev.profiles` setting). See `remote-dev.example.json` in the repository.

| Profile field | Meaning |
|---|---|
| `host` | `user@host[:port]` or an `~/.ssh/config` alias |
| `port`, `user`, `identityFile` | Override ssh config |
| `remoteRoot` | Remote mirror dir (absolute or `~/…`; default `~/.remote-dev/<project>-<hash>`) |
| `envSetup` | Shell snippet run before every build/run/debug command (commands run in a login shell) |
| `exclude` | Extra gitignore-style patterns |
| `useGitignore` | Honor `.gitignore` files (default `true`) |
| `deleteRemoteOrphans` | Delete remote files that no longer exist locally (default `true`) |
| `build.kind: "cmake"` | `buildTypes`, `buildDir` (`${buildType}` substituted), `generator`, `configureArgs`, `buildArgs`, `configurePreset`, `buildPreset`, `cmakePath` |
| `build.kind: "custom"` | `buildCommand` (`${target}` substituted), `cleanCommand`, `configureCommand`, `buildDir`, `compileCommands` |

Settings: `remoteDev.autoSync`, `remoteDev.autoConnect`, `remoteDev.syncDebounceMs`, `remoteDev.rememberPasswords`, `remoteDev.activeProfile`.

The active profile and build type you pick are stored per machine (workspace state), so a shared,
committed `remote-dev.json` can list everyone's targets.

## How sync decides what to upload

Uploads carry the local mtime in the tar header. A remote file counts as up to date when its size,
whole-second mtime and mode match the local file, which is rsync's "quick check". The extension
also keeps an in-memory view of what it last uploaded. That lets the pre-build check run with only
local `stat` calls and no remote listing. **Force resync** compares SHA-1 content hashes and so also
catches edits made directly on the remote. The local copy always wins, as in CLion.

## Limitations / notes

- The remote login shell must be POSIX-compatible for the helper commands. fish as the login
  shell is not supported.
- Header caches can be large on hosts with many `-dev` packages. They are kept per host under the
  extension's global storage. **Refresh IntelliSense** downloads them again.
- Symlinks inside the project are uploaded as symlinks. Symlinks in mirrored system headers are
  dereferenced so the cache works on Windows.

## Development

```sh
npm install
npm run build        # bundle to dist/
npm test             # unit tests + in-process SSH server tests (connection, auth, debug bridge)
# integration tests against a real Linux target:
docker build -t remote-dev-target test/docker
docker run -d --rm -p 2222:22 --name remote-dev-target remote-dev-target
RD_TEST_HOST=dev@127.0.0.1:2222 RD_TEST_PASSWORD=dev npm run test:remote
```

Press F5 in VS Code to launch an Extension Development Host on `test/fixtures/hello-cmake`.

| Path | Responsibility |
|---|---|
| `src/ssh/` | Connection, auth, known_hosts, ssh config, login-shell wrapper |
| `src/sync/` | Ignore rules, local enumeration, diff planner, tar transfer, sync service |
| `src/build/` | CMake/custom builders, File API and presets, task provider, pseudoterminal, path rewriting |
| `src/intellisense/` | Compile DB parsing/rewrite, header mirroring, cpptools provider |
| `src/debug/` | `remote-gdb` → `cppdbg` provider, stdio bridge and the `pipeProxy` helper |
