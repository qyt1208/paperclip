# Install the Windows Git launcher fix on paperclipai 2026.1106.0

Deployment is blocked. Do not copy these files onto the installed package.

The installed `dist/github-launcher.js` matches the published `2026.1106.0` file (`05b8853bdca289d86f3dda1c82a909a5817654885dbf1472de0beee22abefbcf`, 7958 bytes). The installed `dist/execution-target.js` does not. Its SHA-256 is `b31d890dbc0217da23f1d84b23f09143a90cc6c520caac70559134a6c9ac1557`, its size is 199348 bytes, and its mtime is 2026-11-18 00:36 Asia/Shanghai. The published file is `cfabc0c2d3bfb4441f9b2fc5995ad4e243618cf5f92f082e9fb042362fcb8e5d`, 198994 bytes, LF only. The hash gate below stays that published hash. Do not replace it with the observed hash, and do not overwrite the installed file. Preserve that file and its backup until the extra 354 bytes are identified.

The running service reports commit `d69631b01b9c658f80bf8bed389863dce82643e1` from `@paperclipai/server/dist/build-info.json`. That stamp is written at publish time. It does not hash `execution-target.js`, so a local edit of that file does not change the health report.

This overlay applies only to an unmodified official `execution-target.js`. The copy on disk is not that file.
Do not install the current `master` branch, and do not install this git branch, in place of that version. Those trees have moved on. Their builds are not a drop-in replacement.

The running server loads `@paperclipai/adapter-utils`. The server package does not inline this launcher. Replacing the three files below is the whole runtime change. No database, secret, task, or agent state is involved.

## Versions that must already be installed

Confirm all three before changing files. Stop if any version is different.

| Package | Required version | npm integrity |
| --- | --- | --- |
| `paperclipai` | `2026.1106.0` | `sha512-jcZrSB5DItxeDJGO7TccI0WcYca2IbBJxpbaKZN6kZp+isNIbVF2AgmfFQq394mjXD+TTHwS5P3AT6jjpqXbng==` |
| `@paperclipai/server` | `2026.1106.0` | `sha512-OqG0qydn5Pky3iHmTgL3fvAh47m77CYgkuM3CgV6ciw6tY/AmBgkO3greyr0LinLFk7x1FdLkF1sfVVukZo/YA==` |
| `@paperclipai/adapter-utils` | `2026.1106.0` | `sha512-Km34NudUnBlMCm6BiYGc8UMR3R8BZRpngpYP33Eg2vFbWvl8URFT+KlzK6sARYBDJbr1bqBW9zlpKd/Rafbk+g==` |

npm did not publish a `gitHead` for `paperclipai@2026.1106.0`. The published launcher source matches upstream tag `v2026.1106.0` (`d69631b01b9c658f80bf8bed389863dce82643e1`). That tag is not on this fork. This fork's `master` is `24132dac169fafc616615b4f3144e921aae8ad54`.

## Files

Work in the installed `@paperclipai/adapter-utils` directory. `package.json` there must say `"version": "2026.1106.0"`.

From this overlay directory, the replacement files are in `files/`:

- `files/github-launcher.js` replaces installed `dist/github-launcher.js`
- `files/execution-target.js` replaces installed `dist/execution-target.js`
- `files/windows-github-launcher-shim.js` is new at installed `dist/windows-github-launcher-shim.js`

`execution-target.js.patch`, `github-launcher.js.patch`, and `windows-github-launcher-shim.js.patch` reproduce those same bytes. From the installed package root, `patch -p1` applies each one. Copying the three files into `dist` is enough and does not need a patch tool.

## Check the current files

Hash with any local Node. The server process itself is `C:\Users\qx\node.exe` v24.21.0 x64. `E:\node.exe` is the same version and is not the server process. Do not use it as `process.execPath` for a launcher staged by that server.

```bat
C:\Users\qx\node.exe -e "const fs=require('fs');const c=require('crypto');for (const f of process.argv.slice(1)) console.log(c.createHash('sha256').update(fs.readFileSync(f)).digest('hex'), fs.statSync(f).size, f)" dist\github-launcher.js dist\execution-target.js
```

Required current hashes:

```text
05b8853bdca289d86f3dda1c82a909a5817654885dbf1472de0beee22abefbcf  dist/github-launcher.js
cfabc0c2d3bfb4441f9b2fc5995ad4e243618cf5f92f082e9fb042362fcb8e5d  dist/execution-target.js
```

Stop if either hash differs. Do not continue with a different build. The installed `execution-target.js` already fails this gate. Keep the backup. The apply steps are not authorized for that file.

## Apply

1. Stop the Paperclip server process so it is not executing these files.
2. Copy the two current files to `github-launcher.js.2026.1106.0.bak` and `execution-target.js.2026.1106.0.bak` in the same `dist` directory.
3. Copy `files/github-launcher.js` and `files/execution-target.js` onto the installed `dist/github-launcher.js` and `dist/execution-target.js`. Copy `files/windows-github-launcher-shim.js` to `dist/windows-github-launcher-shim.js`.
4. Repeat the hash command for all three files.

Required hashes after the copy:

```text
47b1df798c832f5ac1620ed1467b0c12b010bfa5ee872e5a245b7314a17152ed  dist/github-launcher.js
0530ec8cf6c39d68b71d356ee59af2cab5437f20c794fe4bd327e9a46be7691e  dist/execution-target.js
602e223d099ed0290d29589c982bef290ea301872e4d6fe2ffeca6c34737c623  dist/windows-github-launcher-shim.js
```

5. Start the same server again with the same Node binary, port, and data directory. This overlay does not migrate data.

The Node process must be 64-bit x64. The staged `git.exe` / `gh.exe` shim is an x64 console program. On any other architecture the server throws `Paperclip Windows Git launcher supports x64 Node only` when it stages a run, instead of writing an extensionless file.

## Roll back

Stop the server. Restore the two `.bak` files and delete `dist/windows-github-launcher-shim.js`. Start the server again.

Or reinstall only this version, which replaces the whole package with the published tarball:

```bat
npm install -g paperclipai@2026.1106.0
```

Do not run `npm install -g paperclipai` without the version. That selects the current latest release, which is not this overlay.
