/**
 * Fail-closed installer for the installed 2026.1106.0 tree.
 * It changes files only when every listed hash matches, and only with --apply.
 *
 *   C:\Users\qx\node.exe apply.cjs "C:\Users\qx\AppData\Roaming\npm\node_modules\paperclipai\node_modules\@paperclipai\adapter-utils"
 *   C:\Users\qx\node.exe apply.cjs --apply "<same directory>"
 */
"use strict";
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const before = {
  "dist/github-launcher.js": ["05b8853bdca289d86f3dda1c82a909a5817654885dbf1472de0beee22abefbcf", 7958],
  "dist/execution-target.js": ["b31d890dbc0217da23f1d84b23f09143a90cc6c520caac70559134a6c9ac1557", 199348],
};
const after = {
  "dist/github-launcher.js": ["8b74bad7f18ee49cb66f512f32ae3b10c674b7daee3fabb78a4a63c434d26215", 12030],
  "dist/execution-target.js": ["260de707d78e5ceea19de2ff3a204585d171a7fa711257b81104261c32c8a86e", 200445],
  "dist/windows-github-launcher-shim.js": ["cb2504483ae9ca4fb9687cb2e056fc18ccbf4fbef35a327f737ae207dc53653d", 25043],
};
const packageJsonHash = ["a5770839ee59e927abb3f7ddca3edeec21e2a566f70e0081a9b1aaadad631869", 2129];
const serverPackageJsonHash = ["88c09e899a9001306b1ef9c814233559aacf858d62ef943905978a0769519eac", 8749];
const publishedExecutionTarget = "cfabc0c2d3bfb4441f9b2fc5995ad4e243618cf5f92f082e9fb042362fcb8e5d";

function sha256(file) {
  const body = fs.readFileSync(file);
  return [createHash("sha256").update(body).digest("hex"), body.length];
}
function fail(message) {
  console.error(message);
  process.exit(2);
}
function same(actual, expected) {
  return actual[0] === expected[0] && actual[1] === expected[1];
}

const args = process.argv.slice(2).filter((arg) => arg !== "--apply");
const apply = process.argv.includes("--apply");
const root = args[0];
if (!root) fail("Pass the @paperclipai/adapter-utils directory.");
const packageJson = path.join(root, "package.json");
const packageActual = sha256(packageJson);
if (!same(packageActual, packageJsonHash)) {
  fail("adapter-utils package.json hash/size does not match the inspected 2026.1106.0 file.");
}
const packageInfo = JSON.parse(fs.readFileSync(packageJson, "utf8"));
if (packageInfo.name !== "@paperclipai/adapter-utils" || packageInfo.version !== "2026.1106.0") {
  fail("package.json name/version is not @paperclipai/adapter-utils 2026.1106.0.");
}
const serverPackage = path.resolve(root, "..", "server", "package.json");
if (!fs.existsSync(serverPackage)) fail("Sibling @paperclipai/server package.json is missing.");
if (!same(sha256(serverPackage), serverPackageJsonHash)) fail("server package.json does not match the inspected file. Refusing to continue.");
const serverInfo = JSON.parse(fs.readFileSync(serverPackage, "utf8"));
if (serverInfo.name !== "@paperclipai/server" || serverInfo.version !== "2026.1106.0") {
  fail("Sibling package is not @paperclipai/server 2026.1106.0.");
}

const current = {};
for (const rel of Object.keys(before)) current[rel] = sha256(path.join(root, rel));
const execution = current["dist/execution-target.js"];
if (execution[0] === publishedExecutionTarget) {
  fail("execution-target.js is the unmodified npm file. This installer is for the local file b31d890d only.");
}
const already = Object.entries(after).every(([rel, expected]) => {
  const file = path.join(root, rel);
  return fs.existsSync(file) && same(sha256(file), expected);
});
if (already) {
  console.log("Already applied. Hashes match the adapted files.");
  process.exit(0);
}
for (const [rel, expected] of Object.entries(before)) {
  if (!same(current[rel], expected)) {
    fail(rel + " hash/size is not the required local baseline.\nexpected " + expected[0] + " " + expected[1] + "\nactual   " + current[rel][0] + " " + current[rel][1]);
  }
}
const shimPath = path.join(root, "dist", "windows-github-launcher-shim.js");
if (fs.existsSync(shimPath)) fail("windows-github-launcher-shim.js already exists and the other files are not the adapted set.");
if (!apply) {
  console.log("Baseline matches. Re-run with --apply to copy the three files. No files were changed.");
  process.exit(0);
}
const filesDir = path.join(__dirname, "files");
for (const rel of Object.keys(after)) {
  const name = path.basename(rel);
  fs.copyFileSync(path.join(filesDir, name), path.join(root, rel));
}
for (const [rel, expected] of Object.entries(after)) {
  const actual = sha256(path.join(root, rel));
  if (!same(actual, expected)) fail("Post-copy hash mismatch for " + rel);
}
console.log("Applied. Three dist files match the adapted hashes.");
