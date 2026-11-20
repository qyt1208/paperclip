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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverNode = "C:\\Users\\qx\\node.exe";
const otherNode = "E:\\node.exe";
const gitExe = "E:\\Git\\cmd\\git.exe";
const adapterRoot = "C:\\Users\\qx\\AppData\\Roaming\\npm\\node_modules\\paperclipai\\node_modules\\@paperclipai\\adapter-utils";
const serverLauncherFile = "C:\\Users\\qx\\AppData\\Roaming\\npm\\node_modules\\paperclipai\\node_modules\\@paperclipai\\server\\dist\\services\\heartbeat-github-launchers.js";
const installedMode = process.argv.includes("--installed");
const roundtripArgs = ["a b", "a&b", "工具", "100%", "say \"hi\"", "(x)", "^!"];
const cmdRoundtripArgs = ["--version", "a b", "a&b", "工具", "say \"hi\"", "(x)", "^!"];
const baseline = {
  "github-launcher.js": ["05b8853bdca289d86f3dda1c82a909a5817654885dbf1472de0beee22abefbcf", 7958],
  "execution-target.js": ["b31d890dbc0217da23f1d84b23f09143a90cc6c520caac70559134a6c9ac1557", 199348],
};
const adapted = {
  "github-launcher.js": ["efefc81aa4ca26048e7e5866ed35945ca4d6f06c11074526be74a89eec9aee40", 11713],
  "execution-target.js": ["260de707d78e5ceea19de2ff3a204585d171a7fa711257b81104261c32c8a86e", 200445],
  "windows-github-launcher-shim.js": ["cb2504483ae9ca4fb9687cb2e056fc18ccbf4fbef35a327f737ae207dc53653d", 25043],
};

if (process.platform !== "win32") {
  console.error("Not Windows. This smoke test did not run and is not a pass.");
  process.exit(3);
}
if (path.win32.normalize(process.execPath).toLowerCase() !== serverNode.toLowerCase()) {
  console.error("Start this script with " + serverNode + ". This process is " + process.execPath);
  process.exit(2);
}
if (process.arch !== "x64") {
  console.error("Node architecture is " + process.arch + ". The shim is x64 only.");
  process.exit(2);
}

function sha256(file) {
  const body = readFileSync(file);
  return [createHash("sha256").update(body).digest("hex"), body.length];
}
function same(actual, expected) {
  return actual[0] === expected[0] && actual[1] === expected[1];
}
if (!installedMode) {
  const sums = readFileSync(path.join(root, "SHA256SUMS"), "utf8");
  for (const line of sums.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const hash = line.slice(0, 64);
    const rel = line.slice(66).trim();
    const actual = sha256(path.join(root, rel));
    if (actual[0] !== hash) {
      console.error("Artifact hash mismatch for " + rel);
      console.error("expected " + hash);
      console.error("actual   " + actual[0]);
      process.exit(2);
    }
  }
}

function run(file, args, env, cwd) {
  return new Promise((resolve) => {
    const child = spawn(file, args, {
      cwd, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve({ code: 124, stdout, stderr: stderr + "\ntimeout" });
    }, 20000);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => { clearTimeout(timer); resolve({ code: 127, stdout, stderr: stderr + error.message }); });
    child.on("exit", (code) => { clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr }); });
  });
}

const failures = [];
function check(name, ok, detail) {
  if (ok) console.log("PASS " + name);
  else {
    failures.push(name);
    console.error("FAIL " + name + (detail ? "\n" + detail : ""));
  }
}

async function identifyInstalled() {
  if (!existsSync(serverLauncherFile)) throw new Error("server launcher file is missing: " + serverLauncherFile);
  const parent = pathToFileURL(serverLauncherFile).href;
  const launcherUrl = import.meta.resolve("@paperclipai/adapter-utils/github-launcher", parent);
  const targetUrl = import.meta.resolve("@paperclipai/adapter-utils/execution-target", parent);
  const launcherFile = fileURLToPath(launcherUrl);
  const targetFile = fileURLToPath(targetUrl);
  const expectedDir = path.resolve(adapterRoot, "dist");
  if (path.win32.normalize(path.dirname(launcherFile)).toLowerCase() !== expectedDir.toLowerCase()
    || path.win32.normalize(path.dirname(targetFile)).toLowerCase() !== expectedDir.toLowerCase()) {
    throw new Error("Resolved files are not in the known adapter-utils dist directory.\n" + launcherFile + "\n" + targetFile);
  }
  const launcherHash = sha256(launcherFile);
  const targetHash = sha256(targetFile);
  console.log("resolved github-launcher " + launcherUrl);
  console.log("resolved execution-target " + targetUrl);
  const shimFile = path.join(expectedDir, "windows-github-launcher-shim.js");
  const baselineMatch = same(launcherHash, baseline["github-launcher.js"]) && same(targetHash, baseline["execution-target.js"]) && !existsSync(shimFile);
  const adaptedMatch = same(launcherHash, adapted["github-launcher.js"]) && same(targetHash, adapted["execution-target.js"])
    && existsSync(shimFile) && same(sha256(shimFile), adapted["windows-github-launcher-shim.js"]);
  if (!baselineMatch && !adaptedMatch) {
    console.error("Installed hashes are neither the preserved baseline nor the adapted set.");
    console.error("github-launcher " + launcherHash.join(" "));
    console.error("execution-target " + targetHash.join(" "));
    process.exit(2);
  }
  return { mode: baselineMatch ? "baseline" : "adapted", launcherFile, targetFile, shimFile };
}

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
      capability: req.headers["x-paperclip-github-capability"] ?? "",
      body: Buffer.concat(chunks).toString("utf8"),
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "unavailable", reason: "smoke" }));
  });
});
const captures = [];
let work = "";
let resultLabel = installedMode ? "Installed adapted smoke passed" : "Archive smoke passed";
try {
  if (!existsSync(gitExe) || !statSync(gitExe).isFile()) throw new Error("missing " + gitExe);
  if (!existsSync(otherNode) || !statSync(otherNode).isFile()) throw new Error("missing " + otherNode);
  const other = await run(otherNode, ["-p", "process.version + ' ' + process.arch"], {
    SystemRoot: process.env.SystemRoot, PATHEXT: ".EXE",
  }, tmpdir());
  check("E:\\node.exe version", other.code === 0 && other.stdout.trim() === process.version + " x64", other.stdout + other.stderr);

  let shimMod;
  let launcherMod;
  if (installedMode) {
    const installed = await identifyInstalled();
    if (installed.mode === "baseline") {
      console.log("Installed adapter-utils is the preserved baseline. The shim file is absent, so this mode does not stage an executable from it.");
      console.log("The archive behavior checks are the default command, without --installed.");
      resultLabel = "Installed baseline confirmed";
    } else {
      shimMod = await import(pathToFileURL(installed.shimFile).href);
      launcherMod = await import(pathToFileURL(installed.launcherFile).href);
      console.log("Installed adapted modules loaded from " + path.dirname(installed.launcherFile));
    }
  } else {
    shimMod = await import(pathToFileURL(path.join(root, "files", "windows-github-launcher-shim.js")).href);
    launcherMod = await import(pathToFileURL(path.join(root, "files", "github-launcher.js")).href);
  }
  if (!shimMod || !launcherMod) {
    if (failures.length) process.exit(1);
  } else {
  work = mkdtempSync(path.join(tmpdir(), "paperclip-launcher-smoke-"));
  const repo = path.join(work, "repo");
  const launcherDir = path.join(work, "launcher");
  const cmdDir = path.join(work, "cmd-fixture");
  mkdirSync(repo);
  mkdirSync(launcherDir);
  mkdirSync(cmdDir);
  const shim = shimMod.windowsGitHubLauncherShim("x64");
  check("shim image", Buffer.isBuffer(shim) && shim.subarray(0, 2).toString("latin1") === "MZ", "");
  writeFileSync(path.join(launcherDir, "git.exe"), shim);
  writeFileSync(path.join(launcherDir, "git.cjs"), launcherMod.githubLauncherSource());
  writeFileSync(path.join(launcherDir, "node.path"), serverNode + "\n");
  writeFileSync(path.join(launcherDir, "package.json"), "{\"type\":\"commonjs\"}\n");
  check("no extensionless git", !existsSync(path.join(launcherDir, "git")) && !existsSync(path.join(launcherDir, "gh")), "");

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const env = {
    PATH: launcherDir + ";" + path.win32.dirname(gitExe),
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    PAPERCLIP_GITHUB_BROKER_URL: "http://127.0.0.1:" + port,
    PAPERCLIP_GITHUB_BROKER_TOKEN: "smoke-local-token",
  };
  const version = await run(path.join(launcherDir, "git.exe"), ["--version"], env, repo);
  check("git --version", version.code === 0 && /git version /i.test(version.stdout), version.stderr.slice(0, 500));
  check("broker called once", captures.length === 1 && captures[0].capability === "smoke-local-token" && captures[0].body === "{}", JSON.stringify(captures));
  check("token stays out of git output", !version.stdout.includes("smoke-local-token") && !version.stderr.includes("smoke-local-token"), "");
  const execPath = await run(path.join(launcherDir, "git.exe"), ["--exec-path"], env, repo);
  check("real git under E:\\Git", execPath.code === 0 && execPath.stdout.replaceAll("/", "\\").toLowerCase().includes("e:\\git\\"), execPath.stdout);

  const direct = await run(gitExe, ["init", "-q"], {
    PATH: path.win32.dirname(gitExe), PATHEXT: ".EXE",
    SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
  }, repo);
  check("isolated repo init", direct.code === 0 && existsSync(path.join(repo, ".git")), direct.stderr.slice(0, 400));
  const echoed = await run(path.join(launcherDir, "git.exe"), ["-c", "core.quotepath=false", "check-ignore", "-v", "--non-matching", "--", ...roundtripArgs], env, repo);
  const lines = echoed.stdout.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n").filter(Boolean);
  const expected = roundtripArgs.map((arg) => "::\t" + arg);
  check("argument roundtrip", echoed.code === 1 && JSON.stringify(lines) === JSON.stringify(expected), "code " + echoed.code + "\n" + echoed.stdout + "\n" + echoed.stderr.slice(0, 500));

  writeFileSync(path.join(cmdDir, "record-args.cjs"), "const fs=require('node:fs'); const path=require('node:path'); fs.writeFileSync(path.join(__dirname, 'argv.json'), JSON.stringify(process.argv.slice(2)));\n");
  writeFileSync(path.join(cmdDir, "git.cmd"), "@echo off\r\n\"" + serverNode + "\" \"%~dp0record-args.cjs\" %*\r\n");
  const cmdEnv = { ...env, PATH: launcherDir + ";" + cmdDir };
  const cmdResult = await run(path.join(launcherDir, "git.exe"), cmdRoundtripArgs, cmdEnv, repo);
  let recorded = null;
  const argvFile = path.join(cmdDir, "argv.json");
  if (existsSync(argvFile)) recorded = JSON.parse(readFileSync(argvFile, "utf8"));
  check("cmd argument roundtrip", cmdResult.code === 0 && JSON.stringify(recorded) === JSON.stringify(cmdRoundtripArgs), JSON.stringify(recorded) + "\n" + cmdResult.stderr.slice(0, 500));
  rmSync(argvFile, { force: true });
  const rejected = await run(path.join(launcherDir, "git.exe"), ["100%"], cmdEnv, repo);
  check("cmd percent rejected", rejected.code === 1 && rejected.stderr.includes("launcher_setup_failed") && !existsSync(argvFile), rejected.stderr.slice(0, 400));
  }
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
  console.error(error);
} finally {
  server.close();
  if (work) rmSync(work, { recursive: true, force: true });
}
if (failures.length) {
  console.error(failures.length + " check(s) failed");
  process.exit(1);
}
console.log(resultLabel);
