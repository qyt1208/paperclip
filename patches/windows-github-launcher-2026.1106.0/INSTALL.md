# Windows launcher overlay for this installed tree

Deployment changes only three files under the already installed adapter-utils package. It does not replace Paperclip, clone the repository, or touch the database.

The installed `execution-target.js` is the published `2026.1106.0` file plus three local PATH edits. Those edits stay. The overlay adds the Windows `git.exe` / `gh.exe` launcher on top of that file. `github-launcher.js` matched the published file and is replaced only from that exact baseline.

## Load path

`C:\Users\qx\node.exe` starts `C:\Users\qx\AppData\Roaming\npm\node_modules\paperclipai\dist\index.js`.

That CLI depends on `@paperclipai/server@2026.1106.0`. The server package exports only `.` and its main is `./dist/index.js`. Server code imports `@paperclipai/adapter-utils/execution-target` and `@paperclipai/adapter-utils/github-launcher`. Those packages are `"type": "module"` and the subpath export condition is `import` only, so `createRequire` reports `ERR_PACKAGE_PATH_NOT_EXPORTED`. The running ESM process selects the `import` condition and loads:

`C:\Users\qx\AppData\Roaming\npm\node_modules\paperclipai\node_modules\@paperclipai\adapter-utils\dist\execution-target.js`

`C:\Users\qx\AppData\Roaming\npm\node_modules\paperclipai\node_modules\@paperclipai\adapter-utils\dist\github-launcher.js`

The CLI bundle does not contain `github-launcher` or `execution-target`. The server bundle does not contain the launcher implementation. Only those two resolved files, plus the new `dist/windows-github-launcher-shim.js`, change.

`E:\node.exe` is the same Node version and is not the server process. The launcher records `process.execPath` when the server stages a run, which is `C:\Users\qx\node.exe`.

## Preserved local edits

Relative to npm `execution-target.js` `cfabc0c2d3bfb4441f9b2fc5995ad4e243618cf5f92f082e9fb042362fcb8e5d` (198994 bytes), the installed file keeps:

- case-insensitive `PATH` lookup on a local Windows target
- `remote ? ":" : path.delimiter` when joining the launcher directory
- removal of an existing `Path`/`PATH` entry before setting the managed `PATH`

The adapted file still contains those three lines. It also stages `git.exe`, `gh.exe`, `git.cjs`, `gh.cjs`, and `node.path` on local Windows, and it does not export the semicolon PATH from the POSIX profile files.

## Fail-closed apply

Backups already exist at `E:\Paperclip\backups\windows-launcher-fix-20261120_074701`. Do not delete them.

From this directory:

```bat
C:\Users\qx\node.exe apply.cjs "C:\Users\qx\AppData\Roaming\npm\node_modules\paperclipai\node_modules\@paperclipai\adapter-utils"
```

That checks hashes and writes nothing. It must print `Baseline matches`. Then:

```bat
C:\Users\qx\node.exe apply.cjs --apply "C:\Users\qx\AppData\Roaming\npm\node_modules\paperclipai\node_modules\@paperclipai\adapter-utils"
```

Required before the copy:

```text
05b8853bdca289d86f3dda1c82a909a5817654885dbf1472de0beee22abefbcf  7958  dist/github-launcher.js
b31d890dbc0217da23f1d84b23f09143a90cc6c520caac70559134a6c9ac1557  199348  dist/execution-target.js
a5770839ee59e927abb3f7ddca3edeec21e2a566f70e0081a9b1aaadad631869  2129  adapter-utils/package.json
88c09e899a9001306b1ef9c814233559aacf858d62ef943905978a0769519eac  8749  server/package.json
```

The published `execution-target.js` hash `cfabc0c2...` is rejected. Any other hash is rejected. The installer does not change `server/package.json`.

Required after the copy:

```text
8b74bad7f18ee49cb66f512f32ae3b10c674b7daee3fabb78a4a63c434d26215  12030  dist/github-launcher.js
260de707d78e5ceea19de2ff3a204585d171a7fa711257b81104261c32c8a86e  200445  dist/execution-target.js
cb2504483ae9ca4fb9687cb2e056fc18ccbf4fbef35a327f737ae207dc53653d  25043  dist/windows-github-launcher-shim.js
```

Stop the server before `--apply`, then start it again with `C:\Users\qx\node.exe` and the same data directory.

A `.cmd` or `.bat` target rejects any argument that contains `%`. Wine showed that `cmd.exe` drops that character (`100%` becomes `100`) even after caret escaping. `.exe` targets, including `E:\Git\cmd\git.exe`, still receive `%` through CreateProcess.

## Smoke test

From this extracted directory, without changing the npm package:

```bat
C:\Users\qx\node.exe smoke\smoke-windows.mjs
```

That stages the archive's launcher in a temporary directory, initializes a temporary Git repository, and sends the arguments to `git check-ignore -z -v --non-matching --stdin`. The stdout bytes must be the raw NUL records Git documents for non-matching paths: three NUL bytes, the pathname unchanged, and a NUL. Exit 128 is a failure. A separate temporary `git.cmd` must record the same arguments except `%`. An argument that contains `%` must be rejected with `launcher_setup_failed: Error: Paperclip: GitHub command line rejected.` before that `.cmd` runs.

To read the installed package without modifying it:

```bat
C:\Users\qx\node.exe smoke\smoke-windows.mjs --installed
```

Before apply, this must resolve the live ESM files, match the baseline hashes above, and report that the shim is absent. It does not stage an executable from that baseline. After apply, the same command loads the adapted modules from the resolved dist paths and runs the behavior checks. It does not push, clone, or read credentials. Exit 3 on a non-Windows machine is not a pass.

## Roll back

Stop the server. Restore `dist/github-launcher.js` and `dist/execution-target.js` from `E:\Paperclip\backups\windows-launcher-fix-20261120_074701`. Delete `dist/windows-github-launcher-shim.js` if that backup does not contain it. Start the server again.

Do not run `npm install -g paperclipai` without a version. That can replace this local `execution-target.js`.
