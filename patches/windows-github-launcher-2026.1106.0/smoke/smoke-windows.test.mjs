import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as smoke from "./smoke-windows.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const acorn = loadAcorn(here);
const scriptPath = path.join(here, "smoke-windows.mjs");
const scriptText = readFileSync(scriptPath, "utf8");
const baselineDir = path.join(here, "fixtures");
const overlayFiles = path.join(here, "..", "files");

test("packaged smoke has no undefined references", () => {
  assert.deepEqual(freeReferences(scriptText), []);
  const sample = "import path from 'node:path';\nconst launcherFile = path.join('a');\nconsole.log(launcherUrl);\n";
  assert.deepEqual(freeReferences(sample), ["launcherUrl"]);
});

test("stdout values are buffers and every use converts them", () => {
  assert.equal(/\.\s*stdout\.(trim|includes|startsWith|replaceAll|toLowerCase|slice|split)\b/.test(scriptText), false);
  assert.equal(scriptText.includes("launcherUrl"), false);
  assert.equal(scriptText.includes("targetUrl"), false);
  assert.equal(smoke.text(Buffer.from(" v24.21.0 x64\n")).trim(), "v24.21.0 x64");
  assert.equal(smoke.text(undefined), "");
});

test("createRun returns stdout as a Buffer", async () => {
  const run = smoke.createRun(spawn);
  const result = await run(process.execPath, ["-e", "process.stdout.write('abc')"], {}, tmpdir());
  assert.equal(Buffer.isBuffer(result.stdout), true);
  assert.equal(result.stdout.toString("utf8"), "abc");
  assert.equal(typeof result.stderr, "string");
  assert.equal(smoke.text(result.stdout).trim(), "abc");
});

test("direct packaged script exits 3 on Linux", async () => {
  const result = await smoke.createRun(spawn)(process.execPath, [scriptPath], {}, here);
  assert.equal(result.code, 3);
  assert.match(result.stderr, /not a pass/);
});

test("windows gates fail closed before any launcher work", async () => {
  assert.equal((await smoke.executeSmoke({ platform: "linux" })).code, 3);
  assert.equal((await smoke.executeSmoke({ platform: "win32", execPath: "E:\\node.exe", arch: "x64" })).code, 2);
  assert.equal((await smoke.executeSmoke({ platform: "win32", execPath: smoke.serverNode, arch: "arm64" })).code, 2);
  const missingGit = await smoke.executeSmoke({ ...win32(), existsSync: () => false, statSync: () => ({ isFile: () => false }) });
  assert.equal(missingGit.code, 1);
  assert.match(missingGit.lines.at(-1), /missing/);
});

test("archive hash failures stay fail closed", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "smoke-sums-"));
  try {
    writeFileSync(path.join(root, "SHA256SUMS"), "not a hash line\n");
    writeFileSync(path.join(root, "INSTALL.md"), "x");
    const malformed = await smoke.executeSmoke({ ...win32(), rootDir: root });
    assert.equal(malformed.code, 2);
    writeFileSync(path.join(root, "SHA256SUMS"), "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  INSTALL.md\n");
    const mismatch = await smoke.executeSmoke({ ...win32(), rootDir: root });
    assert.equal(mismatch.code, 2);
    assert.match(mismatch.lines.at(-1), /Artifact hash mismatch/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("archive controller accepts exact NUL records and rejects weakened outcomes", async () => {
  const good = await runController({ roundtripCode: 1, roundtripStdout: smoke.checkIgnoreRecord(smoke.roundtripArgs) });
  assert.equal(good.code, 0, detail(good));
  assert.equal(good.lines.includes("PASS argument roundtrip"), true);
  assert.equal(good.lines.includes("PASS cmd argument roundtrip"), true);
  assert.equal(good.lines.includes("PASS cmd percent rejected"), true);
  assert.equal(good.lines.includes("PASS broker called once"), true);
  const payload = Buffer.concat(smoke.roundtripArgs.map((arg) => Buffer.concat([Buffer.from(arg, "utf8"), Buffer.from([0])])));
  assert.equal(Buffer.isBuffer(good.seenStdin) && good.seenStdin.equals(payload), true);
  const badCode = await runController({ roundtripCode: 128, roundtripStdout: Buffer.from("fatal") });
  assert.equal(badCode.code, 1);
  assert.equal(badCode.failures.includes("argument roundtrip"), true);
  const badBytes = await runController({ roundtripCode: 1, roundtripStdout: Buffer.from("::\tsay \"hi\"\n") });
  assert.equal(badBytes.failures.includes("argument roundtrip"), true);
  const badCmd = await runController({ roundtripCode: 1, roundtripStdout: smoke.checkIgnoreRecord(smoke.roundtripArgs), writeArgv: false });
  assert.equal(badCmd.failures.includes("cmd argument roundtrip"), true);
  const hiddenPercent = await runController({
    roundtripCode: 1,
    roundtripStdout: smoke.checkIgnoreRecord(smoke.roundtripArgs),
    percentStderr: "Paperclip: GitHub launcher_setup_failed\n",
  });
  assert.equal(hiddenPercent.failures.includes("cmd percent rejected"), true);
});

test("installed baseline resolution uses the node_modules walk and exact hashes", () => {
  const io = fixtureIo("baseline");
  const found = smoke.identifyInstalled(io);
  assert.equal(found.mode, "baseline");
  assert.equal(found.launcherFile.endsWith("github-launcher.js"), true);
  assert.equal(io.logs.some((line) => line.includes(found.launcherFile)), true);
  assert.equal(smoke.findAdapterUtils("C:\\no\\such\\file.js", path.win32, () => false), "");
});

test("installed baseline mode does not stage and adapted mode loads the resolved files", async () => {
  const baselineRun = await runController({ installedMode: true, fixture: "baseline" });
  assert.equal(baselineRun.code, 0, detail(baselineRun));
  assert.equal(baselineRun.lines.includes("Installed baseline confirmed"), true);
  assert.equal(baselineRun.lines.some((line) => line.startsWith("PASS shim image")), false);
  assert.deepEqual(baselineRun.imported, []);
  const adaptedRun = await runController({ installedMode: true, fixture: "adapted" });
  assert.equal(adaptedRun.code, 0, detail(adaptedRun));
  assert.equal(adaptedRun.lines.includes("PASS argument roundtrip"), true);
  const launcher = "C:\\Users\\qx\\AppData\\Roaming\\npm\\node_modules\\paperclipai\\node_modules\\@paperclipai\\adapter-utils\\dist\\github-launcher.js";
  const shim = "C:\\Users\\qx\\AppData\\Roaming\\npm\\node_modules\\paperclipai\\node_modules\\@paperclipai\\adapter-utils\\dist\\windows-github-launcher-shim.js";
  assert.equal(adaptedRun.imported.includes(pathToFileURL(launcher).href), true);
  assert.equal(adaptedRun.imported.includes(pathToFileURL(shim).href), true);
});

test("installed hash, export, and import failures stay fail closed", () => {
  assert.throws(() => smoke.identifyInstalled(fixtureIo("mismatch")), (error) => error.exitCode === 2);
  assert.throws(() => smoke.identifyInstalled(fixtureIo("no-import")), (error) => error.exitCode === 2);
  assert.throws(() => smoke.identifyInstalled(fixtureIo("missing-server")), (error) => error.exitCode === 2);
  assert.throws(() => smoke.identifyInstalled(fixtureIo("bad-exports")), (error) => error.exitCode === 2);
  assert.throws(() => smoke.identifyInstalled(fixtureIo("walk-miss")), (error) => error.exitCode === 2);
});

test("check-ignore record is the documented three-NUL pattern", () => {
  const record = smoke.checkIgnoreRecord(["a b", "say \"hi\""]);
  assert.deepEqual([...record.subarray(0, 3)], [0, 0, 0]);
  assert.equal(record.subarray(3, 6).toString("utf8"), "a b");
  assert.equal(record[6], 0);
  assert.equal(record.includes(0x3a), false);
});

function win32() {
  return {
    platform: "win32",
    execPath: smoke.serverNode,
    arch: "x64",
    nodeVersion: "v24.21.0",
    systemRoot: "C:\\Windows",
    windir: "C:\\Windows",
    gitExe: smoke.gitExe,
    otherNode: smoke.otherNode,
  };
}

function fixtureIo(kind) {
  const root = "C:\\Users\\qx\\AppData\\Roaming\\npm\\node_modules\\paperclipai\\node_modules\\@paperclipai";
  const serverFile = root + "\\server\\dist\\services\\heartbeat-github-launchers.js";
  const adapter = root + "\\adapter-utils";
  const files = new Map();
  const logs = [];
  const put = (file, body) => files.set(path.win32.normalize(file).toLowerCase(), Buffer.isBuffer(body) ? body : Buffer.from(body));
  const serverSource = kind === "no-import"
    ? "export const unrelated = true;\n"
    : "import { githubBrokerEnvironment } from \"@paperclipai/adapter-utils/github-launcher\";\nimport { prepareGitHubOperationLaunchers } from \"@paperclipai/adapter-utils/execution-target\";\n";
  if (kind !== "missing-server") put(serverFile, serverSource);
  const packageJson = JSON.parse(readFileSync(path.join(baselineDir, "adapter-utils-package.json"), "utf8"));
  if (kind === "bad-exports") packageJson.exports["./*"].require = "./dist/*.js";
  put(adapter + "\\package.json", JSON.stringify(packageJson));
  const launcherName = kind === "adapted" ? path.join(overlayFiles, "github-launcher.js") : path.join(baselineDir, "github-launcher.js");
  const targetName = kind === "adapted" ? path.join(overlayFiles, "execution-target.js") : path.join(baselineDir, "execution-target.js");
  put(adapter + "\\dist\\github-launcher.js", readFileSync(launcherName));
  put(adapter + "\\dist\\execution-target.js", readFileSync(targetName));
  if (kind === "adapted") put(adapter + "\\dist\\windows-github-launcher-shim.js", readFileSync(path.join(overlayFiles, "windows-github-launcher-shim.js")));
  if (kind === "mismatch") put(adapter + "\\dist\\github-launcher.js", Buffer.from("different"));
  const walkedServer = kind === "walk-miss" ? "D:\\other\\server\\dist\\services\\heartbeat-github-launchers.js" : serverFile;
  if (kind === "walk-miss") put(walkedServer, serverSource);
  return {
    pathApi: path.win32,
    existsSync: (file) => files.has(path.win32.normalize(file).toLowerCase()),
    readFileSync: (file) => {
      const body = files.get(path.win32.normalize(file).toLowerCase());
      if (!body) throw new Error("missing " + file);
      return body;
    },
    serverLauncherFile: walkedServer,
    adapterRoot: adapter,
    log: (line) => logs.push(line),
    logs,
  };
}

async function runController({
  roundtripCode = 1,
  roundtripStdout = smoke.checkIgnoreRecord(smoke.roundtripArgs),
  installedMode = false,
  fixture = "baseline",
  writeArgv = true,
  percentStderr,
}) {
  const io = fixtureIo(fixture);
  const imported = [];
  const warnings = [];
  let seenStdin;
  const result = await smoke.executeSmoke({
    ...win32(),
    installedMode,
    rootDir: path.join(here, ".."),
    existsSync: (file) => file === smoke.gitExe || file === smoke.otherNode || io.existsSync(file) || existsSync(file),
    statSync: (file) => (file === smoke.gitExe || file === smoke.otherNode ? { isFile: () => true } : statSync(file)),
    readFileSync: (file) => {
      const normalized = path.win32.normalize(String(file)).toLowerCase();
      if (normalized.includes("\\@paperclipai\\") || normalized.endsWith("heartbeat-github-launchers.js")) return io.readFileSync(file);
      return readFileSync(file);
    },
    resolutionPath: path.win32,
    adapterRoot: io.adapterRoot,
    serverLauncherFile: io.serverLauncherFile,
    importModule: async (href) => {
      imported.push(href);
      const name = decodeURIComponent(href).split(/[/\\]/).at(-1);
      return import(pathToFileURL(path.join(overlayFiles, name)).href);
    },
    log() {},
    warn: (line) => warnings.push(line),
    run: async (file, args, env, cwd, stdin) => {
      if (String(file) === smoke.otherNode) return { code: 0, stdout: Buffer.from("v24.21.0 x64\n"), stderr: "" };
      if (args[0] === "--version" && args.length === 1) {
        await postBroker(env);
        return { code: 0, stdout: Buffer.from("git version 2.43.0\n"), stderr: "Paperclip: GitHub access unavailable: smoke. Continuing without GitHub credentials.\n" };
      }
      if (args[0] === "--exec-path") return { code: 0, stdout: Buffer.from("E:/Git/mingw64/libexec/git-core\n"), stderr: "" };
      if (args[0] === "init") {
        mkdirSync(path.join(cwd, ".git"), { recursive: true });
        return { code: 0, stdout: Buffer.alloc(0), stderr: "" };
      }
      if (args.includes("--stdin")) {
        seenStdin = stdin;
        return { code: roundtripCode, stdout: roundtripStdout, stderr: roundtripCode === 128 ? "fatal: not a git repository\n" : "" };
      }
      if (JSON.stringify(args) === JSON.stringify(smoke.cmdRoundtripArgs)) {
        if (writeArgv) writeFileSync(path.join(cwd, "..", "cmd-fixture", "argv.json"), JSON.stringify(args));
        return { code: writeArgv ? 0 : 1, stdout: Buffer.alloc(0), stderr: "" };
      }
      if (args.length === 1 && args[0] === "100%") {
        return {
          code: 1,
          stdout: Buffer.alloc(0),
          stderr: percentStderr ?? "Paperclip: GitHub launcher_setup_failed: Error: Paperclip: GitHub command line rejected.\n",
        };
      }
      return { code: 1, stdout: Buffer.alloc(0), stderr: "unexpected " + JSON.stringify(args) };
    },
  });
  return { ...result, imported, warnings, seenStdin };
}

function postBroker(env) {
  return new Promise((resolve, reject) => {
    const req = http.request(env.PAPERCLIP_GITHUB_BROKER_URL + "/runtime-tools/github/credentials", {
      method: "POST",
      headers: { "x-paperclip-github-capability": "smoke-local-token", "content-type": "application/json" },
    }, (res) => {
      res.resume();
      res.on("end", resolve);
    });
    req.on("error", reject);
    req.end("{}");
  });
}

function loadAcorn(start) {
  let dir = start;
  for (let hop = 0; hop < 8; hop += 1) {
    const direct = path.join(dir, "node_modules", "acorn", "package.json");
    if (existsSync(direct)) return createRequire(direct)("acorn");
    const pnpm = path.join(dir, "node_modules", ".pnpm");
    if (existsSync(pnpm)) {
      const version = readdirSync(pnpm).find((name) => name.startsWith("acorn@"));
      if (version) return createRequire(path.join(pnpm, version, "node_modules", "acorn", "package.json"))("acorn");
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("acorn is not installed");
}

function detail(result) {
  return result.lines.concat(result.warnings).join("\n");
}

function freeReferences(source) {
  const ast = acorn.parse(source, { ecmaVersion: "latest", sourceType: "module" });
  const globals = new Set(["Buffer", "console", "process", "URL", "setTimeout", "clearTimeout", "undefined", "NaN", "Infinity", "Object", "Array", "String", "Number", "Boolean", "Error", "JSON", "Math", "Date", "Promise", "RegExp", "Map", "Set", "Symbol", "BigInt", "parseInt", "parseFloat", "isNaN", "isFinite"]);
  const scopes = [new Set()];
  for (const statement of ast.body) bindStatement(statement, scopes[0]);
  const free = [];
  visit(ast, null, null);
  return [...new Set(free)];

  function visit(node, parent, key) {
    if (!node || typeof node.type !== "string") return;
    const scopeNode = node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression";
    if (scopeNode) scopes.push(bindings(node));
    if (node.type === "Identifier" && isReference(node, parent, key) && !scopes.some((scope) => scope.has(node.name)) && !globals.has(node.name)) {
      free.push(node.name);
    }
    for (const childKey of Object.keys(node)) {
      if (childKey === "type" || childKey === "start" || childKey === "end") continue;
      const child = node[childKey];
      if (Array.isArray(child)) child.forEach((item) => visit(item, node, childKey));
      else visit(child, node, childKey);
    }
    if (scopeNode) scopes.pop();
  }

  function bindings(fn) {
    const names = new Set();
    if (fn.id) names.add(fn.id.name);
    for (const param of fn.params ?? []) collectPattern(param, names);
    collectBody(fn.body, names);
    return names;
  }
}

function bindStatement(statement, scope) {
  if (!statement) return;
  if (statement.type === "ImportDeclaration") statement.specifiers.forEach((spec) => scope.add(spec.local.name));
  if (statement.type === "FunctionDeclaration" && statement.id) scope.add(statement.id.name);
  if (statement.type === "ClassDeclaration" && statement.id) scope.add(statement.id.name);
  if (statement.type === "VariableDeclaration") statement.declarations.forEach((decl) => collectPattern(decl.id, scope));
  if (statement.type === "ExportNamedDeclaration" || statement.type === "ExportDefaultDeclaration") bindStatement(statement.declaration, scope);
}

function collectBody(node, names) {
  if (!node || typeof node.type !== "string") return;
  if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression") {
    if (node.type === "FunctionDeclaration" && node.id) names.add(node.id.name);
    return;
  }
  if (node.type === "VariableDeclaration") node.declarations.forEach((decl) => collectPattern(decl.id, names));
  if (node.type === "CatchClause" && node.param) collectPattern(node.param, names);
  if (node.type === "ClassDeclaration" && node.id) names.add(node.id.name);
  for (const key of Object.keys(node)) {
    const child = node[key];
    if (Array.isArray(child)) child.forEach((item) => collectBody(item, names));
    else collectBody(child, names);
  }
}

function collectPattern(node, names) {
  if (!node) return;
  if (node.type === "Identifier") names.add(node.name);
  if (node.type === "ObjectPattern") node.properties.forEach((prop) => collectPattern(prop.value ?? prop.argument, names));
  if (node.type === "ArrayPattern") node.elements.forEach((item) => collectPattern(item, names));
  if (node.type === "AssignmentPattern") collectPattern(node.left, names);
  if (node.type === "RestElement") collectPattern(node.argument, names);
}

function isReference(node, parent, key) {
  if (!parent) return false;
  if (parent.type === "MemberExpression" && parent.property === node && !parent.computed) return false;
  if (parent.type === "Property" && parent.key === node && !parent.computed) return false;
  if (parent.type === "MetaProperty") return false;
  if (parent.type === "VariableDeclarator" && parent.id === node) return false;
  if ((parent.type === "FunctionDeclaration" || parent.type === "FunctionExpression" || parent.type === "ClassDeclaration") && parent.id === node) return false;
  if (key === "params" || parent.type === "CatchClause" && parent.param === node) return false;
  if (parent.type === "ImportSpecifier" || parent.type === "ImportDefaultSpecifier" || parent.type === "ImportNamespaceSpecifier") return false;
  if (parent.type === "ExportSpecifier") return false;
  if (parent.type === "LabeledStatement" && parent.label === node) return false;
  if ((parent.type === "BreakStatement" || parent.type === "ContinueStatement") && parent.label === node) return false;
  return true;
}
