# Rebuild the x64 launcher shim

Source file: `github-launcher-shim.c` in this directory.

The checked image is the one embedded in `files/windows-github-launcher-shim.js`.
Its SHA-256 is `1cf1462d86f7d646263bf0201622053ddf402ca3cbe2f3159f1ec205554ba0fc` and its size is 18432 bytes.

Build command, from this directory:

```text
x86_64-w64-mingw32-gcc -Os -s -mconsole -o github-launcher-shim-x64.exe github-launcher-shim.c
```

The compiler used for the embedded image was `x86_64-w64-mingw32-gcc` 13.2.0.
A different compiler can produce different bytes. Do not replace the embedded image unless the smoke test is run again on Windows.

The shim starts only `git.exe` or `gh.exe`. It reads `node.path` beside itself, rejects quotes, controls, and `..` segments, and requires the sibling `git.cjs` or `gh.cjs` to exist. It then `CreateProcessW`s that Node program. It does not call `cmd.exe`, `ShellExecute`, or `Start-Process`.
