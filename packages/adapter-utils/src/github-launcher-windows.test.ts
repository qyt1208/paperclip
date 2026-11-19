import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  escapeWindowsCmdArgument,
  escapeWindowsCmdCommand,
  githubLauncherSource,
  startGitHubCommand,
} from "./github-launcher.js";
import { planGitHubOperationLauncherFiles, prepareGitHubOperationLaunchers, cleanupGitHubOperationLaunchers } from "./execution-target.js";
import { windowsGitHubLauncherShim } from "./windows-github-launcher-shim.js";

const exec = promisify(execFile);
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const reportedBase = String.raw`E:\Git\cmd;C:\Windows\system32`;
const reportedDir = String.raw`C:\Users\qx\AppData\Local\Temp\paperclip-github-runtime\run-1`;

describe("Windows GitHub launcher layout", () => {
  it("joins a local Windows PATH with semicolons and stages exe shims instead of extensionless scripts", () => {
    const shim = Buffer.from("MZ" + "x".repeat(64));
    const plan = planGitHubOperationLauncherFiles({
      directory: reportedDir,
      basePath: reportedBase,
      remote: false,
      platform: "win32",
      pathDelimiter: ";",
      launcherSource: "launcher-source",
      nodePath: String.raw`E:\node.exe`,
      shim,
    });
    expect(plan.processPath).toBe(`${reportedDir};${reportedBase}`);
    expect(plan.processPath).not.toContain(`${reportedDir}:`);
    expect(plan.profile).not.toContain("export PATH=");
    expect(plan.profile).toContain("unset GIT_AUTHOR_NAME");
    expect(plan.profile).toContain("unset GIT_COMMITTER_EMAIL");
    const names = plan.files.map((file) => file.name);
    expect(names).toContain("git.exe");
    expect(names).toContain("gh.exe");
    expect(names).toContain("git.cjs");
    expect(names).toContain("gh.cjs");
    expect(names).not.toContain("git");
    expect(names).not.toContain("gh");
    expect(plan.files.find((file) => file.name === "node.path")?.body).toBe("E:\\node.exe\n");
    expect(plan.files.find((file) => file.name === "git.exe")?.body).toBe(shim);
    expect(plan.files.find((file) => file.name === "git.cjs")?.body).toBe("launcher-source");
  });

  it("keeps a remote launcher colon-joined and extensionless when the controller is Windows", () => {
    const plan = planGitHubOperationLauncherFiles({
      directory: "/remote/project/.paperclip-runtime/github/run-1",
      basePath: "/usr/local/bin:/usr/bin:/bin",
      remote: true,
      platform: "win32",
      pathDelimiter: ";",
      launcherSource: "remote-source",
      nodePath: String.raw`E:\node.exe`,
      shim: Buffer.from("MZ-not-used"),
    });
    expect(plan.processPath).toBe("/remote/project/.paperclip-runtime/github/run-1:/usr/local/bin:/usr/bin:/bin");
    expect(plan.profile.startsWith("export PATH=")).toBe(true);
    expect(plan.profile).toContain(plan.processPath);
    expect(plan.files.map((file) => file.name)).toContain("git");
    expect(plan.files.map((file) => file.name)).not.toContain("git.exe");
    expect(plan.files.every((file) => typeof file.body === "string")).toBe(true);
  });

  it("rejects a Node path that cannot be quoted into the Windows shim", () => {
    const input = {
      directory: reportedDir, basePath: reportedBase, remote: false, platform: "win32" as const,
      pathDelimiter: ";", launcherSource: "source", shim: Buffer.from("MZ" + "x".repeat(64)),
    };
    expect(() => planGitHubOperationLauncherFiles({ ...input, nodePath: "node" })).toThrow(/absolute Node/);
    expect(() => planGitHubOperationLauncherFiles({ ...input, nodePath: "E:\\node\".exe" })).toThrow(/absolute Node/);
    expect(() => planGitHubOperationLauncherFiles({ ...input, nodePath: undefined, shim: null })).toThrow(/x64/);
  });

  it("reads a Windows Path value when PATH is absent", async () => {
    const env = await prepareGitHubOperationLaunchers({
      runId: "windows-path-key", target: null, cwd: os.tmpdir(),
      env: { Path: `/usr/bin${path.delimiter}/bin` } as Record<string, string>,
    });
    cleanups.push(() => cleanupGitHubOperationLaunchers({ runId: "windows-path-key", target: null }));
    expect(env.PATH.startsWith(`${env.PAPERCLIP_GITHUB_LAUNCHER_DIR}${path.delimiter}`)).toBe(true);
    expect(env.PATH.endsWith(`/usr/bin${path.delimiter}/bin`)).toBe(true);
    const launcher = await readFile(path.join(env.PAPERCLIP_GITHUB_LAUNCHER_DIR, "git"), "utf8");
    expect(launcher.startsWith("#!/usr/bin/env node\n")).toBe(true);
  });
});

describe("Windows GitHub command resolution", () => {
  it("publishes an x64 console image and no shim for other architectures", () => {
    const shim = windowsGitHubLauncherShim("x64");
    expect(shim).not.toBeNull();
    expect(createHash("sha256").update(shim!).digest("hex")).toBe("44254825ba2874f6c01064f97c50e62852cffb344d52f7150dafb7268b3f6f6b");
    expect(shim!.subarray(0, 2).toString("latin1")).toBe("MZ");
    const pe = shim!.readUInt32LE(0x3c);
    expect(shim!.subarray(pe, pe + 4).toString("latin1")).toBe("PE\0\0");
    expect(shim!.readUInt16LE(pe + 4)).toBe(0x8664);
    expect(windowsGitHubLauncherShim("arm64")).toBeNull();
    expect(windowsGitHubLauncherShim("ia32")).toBeNull();
  });

  it("quotes cmd.exe arguments for spaces, unicode, and metacharacters", () => {
    expect(escapeWindowsCmdCommand("a b")).toBe("a^ b");
    expect(escapeWindowsCmdArgument("a b", false)).toBe("^\"a^ b^\"");
    expect(escapeWindowsCmdArgument("工具", false)).toBe("^\"工具^\"");
    expect(escapeWindowsCmdArgument("a&b", false)).toBe("^\"a^&b^\"");
    expect(escapeWindowsCmdArgument("100%", false)).toBe("^\"100^%^\"");
    expect(escapeWindowsCmdArgument("say \"hi\"", false)).toBe("^\"say^ \\^\"hi\\^\"^\"");
    expect(escapeWindowsCmdArgument("", false)).toBe("^\"^\"");
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawn = ((command: string, args: string[]) => {
      calls.push({ command, args });
      return { once() { return this; }, on() { return this; }, kill() {} };
    }) as unknown as typeof import("node:child_process").spawn;
    startGitHubCommand(String.raw`E:\Git\cmd\git.exe`, ["--version", "a b", "工具"], {}, "win32", spawn, path.win32);
    expect(calls[0]).toEqual({ command: String.raw`E:\Git\cmd\git.exe`, args: ["--version", "a b", "工具"] });
    startGitHubCommand(String.raw`C:\Program Files\Git\cmd\git.cmd`, ["status", "a&b"], { SystemRoot: String.raw`C:\Windows` }, "win32", spawn, path.win32);
    expect(calls[1]?.command).toBe(String.raw`C:\Windows\System32\cmd.exe`);
    expect(calls[1]?.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(calls[1]?.args[3]).toContain("a^&b");
    expect(calls[1]?.args[3]?.startsWith("\"")).toBe(true);
  });

  it("resolves PATHEXT executables, skips the launcher directory, and forwards arguments", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-github-win-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const launcherDir = path.join(root, "launcher");
    const realDir = path.join(root, "tools 工具 & (parens)");
    await mkdir(launcherDir);
    await mkdir(realDir);
    const output = path.join(root, "out.json");
    const real = `const fs = require('node:fs');\nfs.writeFileSync(process.env.OUT, JSON.stringify(process.argv.slice(2)));\nprocess.exit(Number(process.env.CODE || 0));\n`;
    await writeFile(path.join(launcherDir, "git.EXE"), `#!${process.execPath}\nprocess.stderr.write('decoy\\n'); process.exit(9);\n`, { mode: 0o700 });
    await writeFile(path.join(realDir, "git"), `#!${process.execPath}\nprocess.stderr.write('bare\\n'); process.exit(8);\n`, { mode: 0o700 });
    await writeFile(path.join(realDir, "git.CMD"), `#!${process.execPath}\nprocess.stderr.write('cmd\\n'); process.exit(7);\n`, { mode: 0o700 });
    await writeFile(path.join(realDir, "git.EXE"), `#!${process.execPath}\n${real}`, { mode: 0o700 });
    const script = path.join(launcherDir, "git.cjs");
    await writeFile(script, githubLauncherSource({ platform: "win32" }), { mode: 0o700 });
    const env = {
      ...process.env,
      OUT: output,
      CODE: "42",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      PATH: `${launcherDir}${path.delimiter}${realDir}`,
    };
    const args = ["--version", "a b", "工具", "a&b", "a|b", "100%", "say \"hi\"", "trail\\", "(x)", "^!"];
    await expect(exec(process.execPath, [script, ...args], { env })).rejects.toMatchObject({ code: 42 });
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual(args);
  });

  it("exits 127 when Windows has no PATHEXT match and ignores extensionless files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-github-win-missing-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const bin = path.join(root, "bin");
    await mkdir(bin);
    await writeFile(path.join(bin, "git"), `#!${process.execPath}\nprocess.stdout.write('bare\\n');\n`, { mode: 0o700 });
    const script = path.join(root, "git.cjs");
    await writeFile(script, githubLauncherSource({ platform: "win32" }), { mode: 0o700 });
    await expect(exec(process.execPath, [script, "--version"], {
      env: { ...process.env, PATHEXT: ".COM;.EXE;.BAT;.CMD", PATH: bin },
    })).rejects.toMatchObject({
      code: 127,
      stderr: expect.stringContaining("Paperclip: requested GitHub command is not installed."),
    });
  });

  it("keeps POSIX lookup extensionless when PATHEXT is set", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-github-posix-ext-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const bin = path.join(root, "bin");
    await mkdir(bin);
    await writeFile(path.join(bin, "git.EXE"), `#!${process.execPath}\nprocess.stdout.write('windows-name\\n');\n`, { mode: 0o700 });
    const script = path.join(root, "git");
    await writeFile(script, githubLauncherSource(), { mode: 0o700 });
    await expect(exec(process.execPath, [script, "--version"], {
      env: { ...process.env, PATHEXT: ".EXE", PATH: bin },
    })).rejects.toMatchObject({ code: 127, stderr: expect.stringContaining("not installed") });
    await writeFile(path.join(bin, "git"), `#!${process.execPath}\nprocess.stdout.write('posix-git\\n');\n`, { mode: 0o700 });
    const ran = await exec(process.execPath, [script, "--version"], {
      env: { ...process.env, PATHEXT: ".EXE", PATH: bin },
    });
    expect(ran.stdout).toBe("posix-git\n");
  });

  it("still asks the credential broker for a remote git command on the Windows launcher path", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-github-win-broker-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const bin = path.join(root, "bin");
    await mkdir(bin);
    await writeFile(path.join(bin, "git.EXE"), `#!${process.execPath}\nprocess.stdout.write('git-ran\\n');\n`, { mode: 0o700 });
    const script = path.join(root, "git.cjs");
    await writeFile(script, githubLauncherSource({ platform: "win32" }), { mode: 0o700 });
    const { createServer } = await import("node:http");
    let captures = 0;
    const server = createServer((req, res) => {
      captures += 1;
      expect(req.method).toBe("POST");
      expect(req.url).toBe("/runtime-tools/github/credentials");
      expect(req.headers["x-paperclip-github-capability"]).toBe("run-capability");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "unavailable", reason: "No GitHub connection" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const { port } = server.address() as { port: number };
    const env = {
      ...process.env,
      PATH: `${bin}${path.delimiter}/usr/bin${path.delimiter}/bin`,
      PATHEXT: ".EXE",
      PAPERCLIP_GITHUB_BROKER_URL: `http://127.0.0.1:${port}`,
      PAPERCLIP_GITHUB_BROKER_TOKEN: "run-capability",
    };
    const remote = await exec(process.execPath, [script, "ls-remote", "origin"], { env });
    expect(remote.stdout).toBe("git-ran\n");
    expect(captures).toBe(1);
    const local = await exec(process.execPath, [script, "status"], { env });
    expect(local.stdout).toBe("git-ran\n");
    expect(captures).toBe(1);
  });
});
