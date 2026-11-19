/**
 * Bounded Windows smoke test. No network except 127.0.0.1, no git remotes,
 * no credentials, no install changes, no shell, no Start-Process.
 *
 * Run:
 *   C:\Users\qx\node.exe smoke\smoke-windows.mjs
 *
 * Exit 0 passes. Exit 1 is a failed check. Exit 2 is a wrong binary or a bad
 * artifact hash. Exit 3 means this process is not Windows.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverNode = "C:\\Users\\qx\\node.exe";
const otherNode = "E:\\node.exe";
const gitExe = "E:\\Git\\cmd\\git.exe";

if (process.platform !== "win32") {
  console.error("Not Windows. This smoke test did not run.");
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
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}
const sums = readFileSync(path.join(root, "SHA256SUMS"), "utf8");
for (const line of sums.split(/\r?\n/)) {
  if (!line.trim() || line.trim().startsWith("#")) continue;
  const hash = line.slice(0, 64);
  const rel = line.slice(66).trim();
  const actual = sha256(path.join(root, rel));
  if (actual !== hash) {
    console.error("Artifact hash mismatch for " + rel);
    console.error("expected " + hash);
    console.error("actual   " + actual);
    process.exit(2);
  }
}

function run(file, args, env, cwd) {
  return new Promise((resolve) => {
    const child = spawn(file, args, {
      cwd, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => { child.kill(); resolve({ code: 124, stdout, stderr: stderr + "\ntimeout" }); }, 15000);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => { clearTimeout(timer); resolve({ code: 127, stdout, stderr: stderr + error.message }); });
    child.on("exit", (code) => { clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr }); });
  });
}

const failures = [];
function check(name, ok, detail) {
  if (ok) console.log("PASS " + name);
  else { failures.push(name); console.error("FAIL " + name + (detail ? "\n" + detail : "")); }
}

const work = mkdtempSync(path.join(tmpdir(), "paperclip-launcher-smoke-"));
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
      authorization: req.headers.authorization ?? "",
      capability: req.headers["x-paperclip-github-capability"] ?? "",
      body: Buffer.concat(chunks).toString("utf8"),
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "unavailable", reason: "smoke" }));
  });
});
const captures = [];
try {
  if (!existsSync(gitExe) || !statSync(gitExe).isFile()) throw new Error("missing " + gitExe);
  if (!existsSync(otherNode) || !statSync(otherNode).isFile()) throw new Error("missing " + otherNode);
  const other = await run(otherNode, ["-p", "process.version + ' ' + process.arch"], { SystemRoot: process.env.SystemRoot, PATHEXT: ".EXE" }, work);
  check("E:\\node.exe version", other.code === 0 && other.stdout.trim() === process.version + " x64", other.stdout + other.stderr);
  const shimMod = await import(pathToFileURL(path.join(root, "files", "windows-github-launcher-shim.js")).href);
  const launcherMod = await import(pathToFileURL(path.join(root, "files", "github-launcher.js")).href);
  const shim = shimMod.windowsGitHubLauncherShim("x64");
  check("shim image", Buffer.isBuffer(shim) && shim.subarray(0, 2).toString("latin1") === "MZ", "");
  writeFileSync(path.join(work, "git.exe"), shim);
  writeFileSync(path.join(work, "git.cjs"), launcherMod.githubLauncherSource());
  writeFileSync(path.join(work, "node.path"), serverNode + "\n");
  writeFileSync(path.join(work, "package.json"), "{\"type\":\"commonjs\"}\n");
  check("no extensionless git", !existsSync(path.join(work, "git")) && !existsSync(path.join(work, "gh")), "");
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const env = {
    PATH: work + ";" + path.win32.dirname(gitExe),
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    PAPERCLIP_GITHUB_BROKER_URL: "http://127.0.0.1:" + port,
    PAPERCLIP_GITHUB_BROKER_TOKEN: "smoke-local-token",
  };
  const version = await run(path.join(work, "git.exe"), ["--version"], env, work);
  check("git --version", version.code === 0 && /git version /i.test(version.stdout), version.stderr.slice(0, 400));
  check("broker called once", captures.length === 1 && captures[0].capability === "smoke-local-token" && captures[0].body === "{}", JSON.stringify(captures));
  check("token stays out of git output", !version.stdout.includes("smoke-local-token") && !version.stderr.includes("smoke-local-token"), "");
  const execPath = await run(path.join(work, "git.exe"), ["--exec-path"], env, work);
  const folded = execPath.stdout.replaceAll("/", "\\").toLowerCase();
  check("real git under E:\\Git", execPath.code === 0 && folded.includes("e:\\git\\"), execPath.stdout);
  const weird = await run(path.join(work, "git.exe"), ["check-ignore", "-v", "--", "a b", "a&b", "工具", "100%"], env, work);
  check("metacharacter args", (weird.code === 0 || weird.code === 1) && !weird.stderr.includes("not installed") && !weird.stderr.includes("command line rejected"), weird.stderr.slice(0, 400));
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
  console.error(error);
} finally {
  server.close();
  rmSync(work, { recursive: true, force: true });
}
if (failures.length) {
  console.error(failures.length + " check(s) failed");
  process.exit(1);
}
console.log("Windows smoke passed");
