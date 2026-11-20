/**
 * Bounded Windows smoke test. No network except 127.0.0.1, no git remotes,
 * no credentials, no install changes, no shell, and no Start-Process.
 *
 *   C:\Users\qx\node.exe smoke\smoke-windows.mjs
 *   C:\Users\qx\node.exe smoke\smoke-windows.mjs --installed
 *
 * Exit 0 passes. Exit 1 is a failed check. Exit 2 is a wrong binary, hash, or
 * load path. Exit 3 means this process is not Windows, so it is not a pass.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const serverNode = "C:\\Users\\qx\\node.exe";
export const otherNode = "E:\\node.exe";
export const gitExe = "E:\\Git\\cmd\\git.exe";
export const adapterRoot = "C:\\Users\\qx\\AppData\\Roaming\\npm\\node_modules\\paperclipai\\node_modules\\@paperclipai\\adapter-utils";
export const serverLauncherFile = "C:\\Users\\qx\\AppData\\Roaming\\npm\\node_modules\\paperclipai\\node_modules\\@paperclipai\\server\\dist\\services\\heartbeat-github-launchers.js";
export const roundtripArgs = ["a b", "a&b", "工具", "100%", "say \"hi\"", "(x)", "^!"];
export const cmdRoundtripArgs = ["--version", "a b", "a&b", "工具", "say \"hi\"", "(x)", "^!"];
export const baseline = {
  "github-launcher.js": ["05b8853bdca289d86f3dda1c82a909a5817654885dbf1472de0beee22abefbcf", 7958],
  "execution-target.js": ["b31d890dbc0217da23f1d84b23f09143a90cc6c520caac70559134a6c9ac1557", 199348],
};
export const adapted = {
  "github-launcher.js": ["8b74bad7f18ee49cb66f512f32ae3b10c674b7daee3fabb78a4a63c434d26215", 12030],
  "execution-target.js": ["260de707d78e5ceea19de2ff3a204585d171a7fa711257b81104261c32c8a86e", 200445],
  "windows-github-launcher-shim.js": ["cb2504483ae9ca4fb9687cb2e056fc18ccbf4fbef35a327f737ae207dc53653d", 25043],
};

export function text(value) {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return "";
}

export function sha256Of(body) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
  return [createHash("sha256").update(buffer).digest("hex"), buffer.length];
}

export function sameIdentity(actual, expected) {
  return actual[0] === expected[0] && actual[1] === expected[1];
}

export function checkIgnoreRecord(args) {
  return Buffer.concat(args.map((arg) => Buffer.concat([Buffer.from([0, 0, 0]), Buffer.from(arg, "utf8"), Buffer.from([0])])));
}

export function createRun(spawnProcess = spawn) {
  return function run(file, args, env, cwd, stdin) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      const child = spawnProcess(file, args, {
        cwd, env, shell: false, windowsHide: true,
        stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      });
      const stdout = [];
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill();
        finish({ code: 124, stdout: Buffer.concat(stdout), stderr: stderr + "\ntimeout" });
      }, 20000);
      child.stdout?.on("data", (chunk) => { stdout.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); });
      child.stderr?.on("data", (chunk) => { stderr += text(chunk); });
      child.on("error", (error) => {
        clearTimeout(timer);
        finish({ code: 127, stdout: Buffer.concat(stdout), stderr: stderr + error.message });
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        finish({ code: code ?? 1, stdout: Buffer.concat(stdout), stderr });
      });
      if (stdin !== undefined && child.stdin) child.stdin.end(stdin);
    });
  };
}

export function findAdapterUtils(serverFile, pathApi, exists) {
  let dir = pathApi.dirname(serverFile);
  for (let hop = 0; hop < 8; hop += 1) {
    const candidate = pathApi.join(dir, "node_modules", "@paperclipai", "adapter-utils");
    if (exists(pathApi.join(candidate, "package.json"))) return candidate;
    const parent = pathApi.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "";
}

export function identifyInstalled(io) {
  const pathApi = io.pathApi ?? path.win32;
  const exists = io.existsSync ?? existsSync;
  const read = io.readFileSync ?? readFileSync;
  const serverFile = io.serverLauncherFile ?? serverLauncherFile;
  const expectedRoot = io.adapterRoot ?? adapterRoot;
  const log = io.log ?? (() => {});
  if (!exists(serverFile)) {
    const error = new Error("server launcher file is missing: " + serverFile);
    error.exitCode = 2;
    throw error;
  }
  const serverSource = text(read(serverFile));
  if (!serverSource.includes("from \"@paperclipai/adapter-utils/github-launcher\"")
    || !serverSource.includes("from \"@paperclipai/adapter-utils/execution-target\"")) {
    const error = new Error("server file does not import the adapter-utils launcher subpaths");
    error.exitCode = 2;
    throw error;
  }
  const found = findAdapterUtils(serverFile, pathApi, exists);
  if (pathApi.normalize(found).toLowerCase() !== pathApi.normalize(expectedRoot).toLowerCase()) {
    const error = new Error("Node module walk did not land on the known adapter-utils directory: " + found);
    error.exitCode = 2;
    throw error;
  }
  const packageInfo = JSON.parse(text(read(pathApi.join(found, "package.json"))));
  const star = packageInfo.exports && packageInfo.exports["./*"];
  if (packageInfo.name !== "@paperclipai/adapter-utils" || packageInfo.version !== "2026.1106.0"
    || !star || star.import !== "./dist/*.js" || star.require) {
    const error = new Error("adapter-utils package exports are not the inspected import-only map");
    error.exitCode = 2;
    throw error;
  }
  const launcherFile = pathApi.join(found, "dist", "github-launcher.js");
  const targetFile = pathApi.join(found, "dist", "execution-target.js");
  const shimFile = pathApi.join(found, "dist", "windows-github-launcher-shim.js");
  const launcherHash = sha256Of(read(launcherFile));
  const targetHash = sha256Of(read(targetFile));
  log("resolved github-launcher " + launcherFile);
  log("resolved execution-target " + targetFile);
  const baselineMatch = sameIdentity(launcherHash, baseline["github-launcher.js"])
    && sameIdentity(targetHash, baseline["execution-target.js"]) && !exists(shimFile);
  const adaptedMatch = sameIdentity(launcherHash, adapted["github-launcher.js"])
    && sameIdentity(targetHash, adapted["execution-target.js"])
    && exists(shimFile) && sameIdentity(sha256Of(read(shimFile)), adapted["windows-github-launcher-shim.js"]);
  if (!baselineMatch && !adaptedMatch) {
    const error = new Error("Installed hashes are neither the preserved baseline nor the adapted set.\ngithub-launcher " + launcherHash.join(" ") + "\nexecution-target " + targetHash.join(" "));
    error.exitCode = 2;
    throw error;
  }
  return { mode: baselineMatch ? "baseline" : "adapted", launcherFile, targetFile, shimFile };
}

function verifyArtifact(rootDir, read) {
  const sums = text(read(path.join(rootDir, "SHA256SUMS")));
  for (const line of sums.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const match = /^([a-f0-9]{64}) {2}(.+)$/.exec(line);
    if (!match) {
      const error = new Error("Malformed manifest line");
      error.exitCode = 2;
      throw error;
    }
    const actual = sha256Of(read(path.join(rootDir, match[2])));
    if (actual[0] !== match[1]) {
      const error = new Error("Artifact hash mismatch for " + match[2] + "\nexpected " + match[1] + "\nactual   " + actual[0]);
      error.exitCode = 2;
      throw error;
    }
  }
}

export async function executeSmoke(options = {}) {
  const platform = options.platform ?? process.platform;
  const execPath = options.execPath ?? process.execPath;
  const arch = options.arch ?? process.arch;
  const installedMode = options.installedMode ?? false;
  const pathApi = options.pathApi ?? path;
  const exists = options.existsSync ?? existsSync;
  const read = options.readFileSync ?? readFileSync;
  const write = options.writeFileSync ?? writeFileSync;
  const remove = options.rmSync ?? rmSync;
  const makeDir = options.mkdirSync ?? mkdirSync;
  const tempDir = options.mkdtempSync ?? mkdtempSync;
  const stat = options.statSync ?? statSync;
  const run = options.run ?? createRun();
  const importModule = options.importModule ?? ((href) => import(href));
  const log = options.log ?? ((line) => console.log(line));
  const warn = options.warn ?? ((line) => console.error(line));
  const lines = [];
  const note = (line) => { lines.push(line); log(line); };
  const failures = [];
  function check(name, ok, detail) {
    if (ok) note("PASS " + name);
    else {
      failures.push(name);
      warn("FAIL " + name + (detail ? "\n" + detail : ""));
    }
  }
  if (platform !== "win32") {
    warn("Not Windows. This smoke test did not run and is not a pass.");
    return { code: 3, lines, failures };
  }
  if (path.win32.normalize(execPath).toLowerCase() !== serverNode.toLowerCase()) {
    warn("Start this script with " + serverNode + ". This process is " + execPath);
    return { code: 2, lines, failures };
  }
  if (arch !== "x64") {
    warn("Node architecture is " + arch + ". The shim is x64 only.");
    return { code: 2, lines, failures };
  }
  const rootDir = options.rootDir ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  try {
    if (!installedMode) verifyArtifact(rootDir, read);
    if (!exists(options.gitExe ?? gitExe) || !stat(options.gitExe ?? gitExe).isFile()) throw new Error("missing " + (options.gitExe ?? gitExe));
    if (!exists(options.otherNode ?? otherNode) || !stat(options.otherNode ?? otherNode).isFile()) throw new Error("missing " + (options.otherNode ?? otherNode));
    const other = await run(options.otherNode ?? otherNode, ["-p", "process.version + ' ' + process.arch"], {
      SystemRoot: options.systemRoot ?? process.env.SystemRoot, PATHEXT: ".EXE",
    }, options.cwd ?? tmpdir());
    check("E:\\node.exe version", other.code === 0 && text(other.stdout).trim() === (options.nodeVersion ?? process.version) + " x64", text(other.stdout) + text(other.stderr));

    let shimMod;
    let launcherMod;
    let resultLabel = installedMode ? "Installed adapted smoke passed" : "Archive smoke passed";
    if (installedMode) {
      const installed = identifyInstalled({
        pathApi: options.resolutionPath ?? path.win32,
        existsSync: exists,
        readFileSync: read,
        serverLauncherFile: options.serverLauncherFile ?? serverLauncherFile,
        adapterRoot: options.adapterRoot ?? adapterRoot,
        log: note,
      });
      if (installed.mode === "baseline") {
        note("Installed adapter-utils is the preserved baseline. The shim file is absent, so this mode does not stage an executable from it.");
        note("The archive behavior checks are the default command, without --installed.");
        resultLabel = "Installed baseline confirmed";
      } else {
        shimMod = await importModule(pathToFileURL(installed.shimFile).href);
        launcherMod = await importModule(pathToFileURL(installed.launcherFile).href);
        note("Installed adapted modules loaded from " + path.win32.dirname(installed.launcherFile));
      }
    } else {
      shimMod = await importModule(pathToFileURL(pathApi.join(rootDir, "files", "windows-github-launcher-shim.js")).href);
      launcherMod = await importModule(pathToFileURL(pathApi.join(rootDir, "files", "github-launcher.js")).href);
    }
    if (!shimMod || !launcherMod) {
      if (failures.length) return { code: 1, lines, failures };
      note(resultLabel);
      return { code: 0, lines, failures };
    }

    const work = tempDir(pathApi.join(options.tempParent ?? tmpdir(), "paperclip-launcher-smoke-"));
    const repo = pathApi.join(work, "repo");
    const launcherDir = pathApi.join(work, "launcher");
    const cmdDir = pathApi.join(work, "cmd-fixture");
    const gitBinary = options.gitExe ?? gitExe;
    const nodeBinary = options.serverNode ?? serverNode;
    let endpoint;
    try {
      makeDir(repo);
      makeDir(launcherDir);
      makeDir(cmdDir);
      const shim = shimMod.windowsGitHubLauncherShim("x64");
      check("shim image", Buffer.isBuffer(shim) && shim.subarray(0, 2).toString("latin1") === "MZ", "");
      write(pathApi.join(launcherDir, "git.exe"), shim);
      write(pathApi.join(launcherDir, "git.cjs"), launcherMod.githubLauncherSource());
      write(pathApi.join(launcherDir, "node.path"), nodeBinary + "\n");
      write(pathApi.join(launcherDir, "package.json"), "{\"type\":\"commonjs\"}\n");
      check("no extensionless git", !exists(pathApi.join(launcherDir, "git")) && !exists(pathApi.join(launcherDir, "gh")), "");
      const captures = [];
      endpoint = await (options.listen ?? listenLocal)(captures);
      const port = endpoint.port;
      const env = {
        PATH: launcherDir + ";" + path.win32.dirname(gitBinary),
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
        SystemRoot: options.systemRoot ?? process.env.SystemRoot,
        WINDIR: options.windir ?? process.env.WINDIR,
        PAPERCLIP_GITHUB_BROKER_URL: "http://127.0.0.1:" + port,
        PAPERCLIP_GITHUB_BROKER_TOKEN: "smoke-local-token",
      };
      const version = await run(pathApi.join(launcherDir, "git.exe"), ["--version"], env, repo);
      check("git --version", version.code === 0 && /git version /i.test(text(version.stdout)), text(version.stderr).slice(0, 500));
      check("broker called once", captures.length === 1 && captures[0].capability === "smoke-local-token" && captures[0].body === "{}", JSON.stringify(captures));
      check("token stays out of git output", !text(version.stdout).includes("smoke-local-token") && !text(version.stderr).includes("smoke-local-token"), "");
      const execPathResult = await run(pathApi.join(launcherDir, "git.exe"), ["--exec-path"], env, repo);
      check("real git under E:\\Git", execPathResult.code === 0 && text(execPathResult.stdout).replaceAll("/", "\\").toLowerCase().includes("e:\\git\\"), text(execPathResult.stdout));
      const direct = await run(gitBinary, ["init", "-q"], {
        PATH: path.win32.dirname(gitBinary), PATHEXT: ".EXE",
        SystemRoot: options.systemRoot ?? process.env.SystemRoot, WINDIR: options.windir ?? process.env.WINDIR,
      }, repo);
      check("isolated repo init", direct.code === 0 && exists(pathApi.join(repo, ".git")), text(direct.stderr).slice(0, 400));
      const payload = Buffer.concat(roundtripArgs.map((arg) => Buffer.concat([Buffer.from(arg, "utf8"), Buffer.from([0])])));
      const echoed = await run(pathApi.join(launcherDir, "git.exe"), ["-c", "core.quotepath=false", "check-ignore", "-z", "-v", "--non-matching", "--stdin"], env, repo, payload);
      const expectedBytes = checkIgnoreRecord(roundtripArgs);
      check("argument roundtrip", echoed.code === 1 && Buffer.isBuffer(echoed.stdout) && echoed.stdout.equals(expectedBytes) && !text(echoed.stderr).includes("not a git repository") && !text(echoed.stderr).includes("launcher_setup_failed"), "code " + echoed.code + "\n" + text(echoed.stderr).slice(0, 500));
      write(pathApi.join(cmdDir, "record-args.cjs"), "const fs=require('node:fs'); const path=require('node:path'); fs.writeFileSync(path.join(__dirname, 'argv.json'), JSON.stringify(process.argv.slice(2)));\n");
      write(pathApi.join(cmdDir, "git.cmd"), "@echo off\r\n\"" + nodeBinary + "\" \"%~dp0record-args.cjs\" %*\r\n");
      const cmdEnv = { ...env, PATH: launcherDir + ";" + cmdDir };
      const cmdResult = await run(pathApi.join(launcherDir, "git.exe"), cmdRoundtripArgs, cmdEnv, repo);
      const argvFile = pathApi.join(cmdDir, "argv.json");
      const recorded = exists(argvFile) ? JSON.parse(text(read(argvFile))) : null;
      check("cmd argument roundtrip", cmdResult.code === 0 && JSON.stringify(recorded) === JSON.stringify(cmdRoundtripArgs), JSON.stringify(recorded) + "\n" + text(cmdResult.stderr).slice(0, 500));
      if (exists(argvFile)) remove(argvFile, { force: true });
      const rejected = await run(pathApi.join(launcherDir, "git.exe"), ["100%"], cmdEnv, repo);
      check("cmd percent rejected", rejected.code === 1 && text(rejected.stderr).includes("launcher_setup_failed: Error: Paperclip: GitHub command line rejected.") && !exists(argvFile), text(rejected.stderr).slice(0, 400));
    } finally {
      if (endpoint && typeof endpoint.close === "function") endpoint.close();
      remove(work, { recursive: true, force: true });
    }
    if (failures.length) return { code: 1, lines, failures };
    note(resultLabel);
    return { code: 0, lines, failures };
  } catch (error) {
    const message = error instanceof Error ? error.name + ": " + error.message : String(error);
    warn(message);
    lines.push("ERROR " + message);
    return { code: error && error.exitCode ? error.exitCode : 1, lines, failures };
  }
}

function listenLocal(captures) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      if (req.method !== "POST" || req.url !== "/runtime-tools/github/credentials") {
        res.writeHead(404);
        res.end("{}");
        return;
      }
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        captures.push({
          capability: String(req.headers["x-paperclip-github-capability"] ?? ""),
          body: Buffer.concat(chunks).toString("utf8"),
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "unavailable", reason: "smoke" }));
      });
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ port: address && typeof address === "object" ? address.port : 0, close: () => server.close() });
    });
  });
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entry && entry === fileURLToPath(import.meta.url)) {
  executeSmoke({ installedMode: process.argv.includes("--installed") }).then((result) => {
    for (const line of result.lines) console.log(line);
    process.exit(result.code);
  });
}
