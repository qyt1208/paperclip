import { isAbsolute } from "node:path";
import type { spawn as Spawn } from "node:child_process";

type LauncherFs = {
  realpathSync(target: string): string;
  statSync(target: string): { isFile(): boolean };
  accessSync(target: string, mode: number): void;
  constants: { X_OK: number };
};
type LauncherPath = {
  delimiter: string;
  join(...parts: string[]): string;
  dirname(target: string): string;
  resolve(target: string): string;
  extname(target: string): string;
};

/** Case-fold only on Windows. POSIX paths remain exact. */
export function githubLauncherDirectoriesMatch(left: string, right: string, platform: string, pathApi: Pick<LauncherPath, "resolve">): boolean {
  const resolvedLeft = pathApi.resolve(left);
  const resolvedRight = pathApi.resolve(right);
  return platform === "win32" ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase() : resolvedLeft === resolvedRight;
}

/** git.cmd, git.cjs, and git.exe are the git launcher. POSIX keeps the basename. */
export function githubLauncherCommandName(fileName: string, platform: string): string {
  if (platform !== "win32") return fileName;
  const lower = fileName.toLowerCase();
  for (const ext of [".cjs", ".js", ".cmd", ".bat", ".exe", ".com"]) {
    if (lower.endsWith(ext)) return lower.slice(0, -ext.length);
  }
  return lower;
}

/** Drop the launcher directory so the real git/gh cannot recurse into this shim. */
export function githubLauncherSearchPath(pathValue: string, directory: string, platform: string, fsApi: Pick<LauncherFs, "realpathSync">, pathApi: Pick<LauncherPath, "delimiter" | "resolve">): string[] {
  return String(pathValue || "").split(pathApi.delimiter).filter((entry) => {
    if (!entry) return false;
    try { return !githubLauncherDirectoriesMatch(fsApi.realpathSync(entry), directory, platform, pathApi); }
    catch { return true; }
  });
}

export function windowsPathExtensions(pathExt: string | undefined): string[] {
  const raw = pathExt && pathExt.trim() ? pathExt : ".COM;.EXE;.BAT;.CMD";
  const extensions: string[] = [];
  for (const part of raw.split(";")) {
    const trimmed = part.trim();
    // An empty or "." extension would select an extensionless file. Windows then
    // opens that file as a document. Never probe it.
    if (!trimmed || trimmed === ".") continue;
    extensions.push(trimmed.startsWith(".") ? trimmed : `.${trimmed}`);
  }
  return extensions;
}

/** PATHEXT order on Windows, extensionless plus execute-bit on POSIX. */
export function resolveGitHubLauncherExecutable(program: string, pathValue: string, directory: string, env: { PATHEXT?: string }, platform: string, fsApi: LauncherFs, pathApi: Pick<LauncherPath, "delimiter" | "join" | "dirname" | "resolve">): string | null {
  const extensions = platform === "win32" ? windowsPathExtensions(env.PATHEXT) : [""];
  for (const entry of githubLauncherSearchPath(pathValue, directory, platform, fsApi, pathApi)) {
    for (const ext of extensions) {
      const candidate = pathApi.join(entry, `${program}${ext}`);
      try {
        if (platform === "win32") {
          if (!fsApi.statSync(candidate).isFile()) continue;
        } else {
          fsApi.accessSync(candidate, fsApi.constants.X_OK);
          if (!fsApi.statSync(candidate).isFile()) continue;
        }
        const real = fsApi.realpathSync(candidate);
        if (githubLauncherDirectoriesMatch(pathApi.dirname(real), directory, platform, pathApi)) continue;
        return real;
      } catch { continue; }
    }
  }
  return null;
}

/** Escape one token for cmd.exe /d /s /c. Same rules as cross-spawn. */
export function escapeWindowsCmdCommand(arg: string): string {
  return arg.replace(/([()\][%!^"`<>&|;, *?])/g, "^$1");
}

/** Quote one argv element for cmd.exe, then caret-escape metacharacters. */
export function escapeWindowsCmdArgument(arg: string, doubleEscapeMetaChars = false): string {
  let escaped = String(arg);
  escaped = escaped.replace(/(?=(\\+?)?)\1"/g, "$1$1\\\"");
  escaped = escaped.replace(/(?=(\\+?)?)\1$/, "$1$1");
  escaped = `"${escaped}"`;
  const meta = /([()\][%!^"`<>&|;, *?])/g;
  escaped = escaped.replace(meta, "^$1");
  if (doubleEscapeMetaChars) escaped = escaped.replace(meta, "^$1");
  return escaped;
}

function windowsTextRejected(value: string): boolean {
  return /[\u0000\r\n]/.test(value);
}

export function startGitHubCommand(executable: string, args: readonly string[], env: NodeJS.ProcessEnv, platform: string, spawn: typeof Spawn, pathApi: Pick<LauncherPath, "extname" | "join">) {
  const ext = pathApi.extname(executable).toLowerCase();
  if (platform === "win32" && (ext === ".cmd" || ext === ".bat")) {
    const root = env.SystemRoot || env.WINDIR;
    if (typeof root !== "string" || !/^[A-Za-z]:[\\/][^"\u0000\r\n]*$/.test(root) || root.includes("..") || windowsTextRejected(executable) || args.some(windowsTextRejected)) {
      throw new Error("Paperclip: GitHub command line rejected.");
    }
    const cmd = pathApi.join(root, "System32", "cmd.exe");
    const doubleEscape = /node_modules[\\/]\.bin[\\/][^\\/]+\.(?:cmd|bat)$/i.test(executable);
    const shellCommand = [escapeWindowsCmdCommand(executable), ...args.map((arg) => escapeWindowsCmdArgument(arg, doubleEscape))].join(" ");
    return spawn(cmd, ["/d", "/s", "/c", "\"" + shellCommand + "\""], {
      env, stdio: "inherit", windowsVerbatimArguments: true, windowsHide: true,
    });
  }
  return spawn(executable, args, { env, stdio: "inherit", windowsHide: true });
}

function githubLauncherHelperSource(): string {
  return [
    githubLauncherDirectoriesMatch,
    githubLauncherCommandName,
    githubLauncherSearchPath,
    windowsPathExtensions,
    resolveGitHubLauncherExecutable,
    escapeWindowsCmdCommand,
    escapeWindowsCmdArgument,
    startGitHubCommand,
  ].map((fn) => fn.toString()).join("\n");
}

/** Standalone source for local, SSH, and sandbox runtimes. No secrets in files. */
export function githubLauncherSource(options: {
  brokerFile?: boolean;
  interpreterPath?: string;
  /** Tests pin this. Staging omits it and the script uses process.platform. */
  platform?: "win32" | "linux" | "darwin";
} = {}): string {
  if (options.interpreterPath !== undefined && (typeof options.interpreterPath !== "string"
    || !isAbsolute(options.interpreterPath) || /[\s\0]/u.test(options.interpreterPath))) {
    throw new Error("GitHub launcher interpreter must be an absolute path without whitespace");
  }
  // A controller restart stops a task's broker while its provider keeps running,
  // then publishes a replacement to broker.json. Only that file can change, so
  // only broker-file launchers wait for it; an inherited URL never recovers.
  const brokerRecoveryMs = options.brokerFile ? 60_000 : 0;
  return String.raw`#!${options.interpreterPath ?? "/usr/bin/env node"}
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
${githubLauncherHelperSource()}
// A PATH shim can capture this launcher's absolute path and call it again.
// Reject that cycle before resolving another executable or capturing authority.
if (process.env.PAPERCLIP_GITHUB_OPERATION_ACTIVE) {
  process.stderr.write('Paperclip: GitHub launcher_recursion_rejected.\n');
  process.exit(126);
}
const scriptPath = fs.realpathSync(process.argv[1]);
const directory = path.dirname(scriptPath);
const launcherPlatform = ${options.platform ? JSON.stringify(options.platform) : "process.platform"};
const program = githubLauncherCommandName(path.basename(scriptPath), launcherPlatform);
const originalPath = githubLauncherSearchPath(process.env.PATH || '', directory, launcherPlatform, fs, path);
const executable = resolveGitHubLauncherExecutable(program, process.env.PATH || '', directory, process.env, launcherPlatform, fs, path);
if (!['git', 'gh'].includes(program) || !executable) {
  process.stderr.write('Paperclip: requested GitHub command is not installed.\n');
  process.exit(127);
}
const localGitCommands = new Set(['init', 'status', 'add', 'config', 'rev-parse', 'log', 'diff', 'diff-files', 'write-tree', 'show', 'branch', 'checkout', 'switch', 'restore', 'reset', 'rm', 'mv', 'worktree', 'grep', 'blame', 'describe', 'ls-files', 'ls-tree', 'cat-file', 'rev-list', 'merge-base', 'show-ref', 'for-each-ref', 'symbolic-ref', 'check-ignore', 'version', 'help']);
const gitValueOptions = ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix', '--attr-source'];
const gitFlagOptions = ['-p', '-P', '--paginate', '--no-pager', '--bare', '--no-replace-objects', '--no-lazy-fetch', '--no-optional-locks', '--no-advice', '--literal-pathspecs', '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs'];
function isLocalGit(args) {
  if (program !== 'git') return false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (gitValueOptions.includes(arg)) { index += 1; continue; }
    if (gitValueOptions.some(option => arg.startsWith(option + '='))) continue;
    if (gitFlagOptions.includes(arg)) continue;
    return arg === '--version' || arg === '--help' || localGitCommands.has(arg);
  }
  return false;
}
// With a Paperclip GitHub connection, repositories are created and forked
// through its tools so access rules, approvals, owner defaults and audit apply.
const connectorRepositoryTools = new Map([['create', 'create_repository'], ['new', 'create_repository'], ['fork', 'fork_repository']]);
function connectorRepositoryTool(args) {
  if (program !== 'gh' || args[0] !== 'repo' || args.includes('--help') || args.includes('-h')) return null;
  return connectorRepositoryTools.get(args[1]) || null;
}
async function main() {
  let env = { ...process.env };
${options.brokerFile ? String.raw`
  delete env.PAPERCLIP_API_URL;
  delete env.PAPERCLIP_API_KEY;
  delete env.PAPERCLIP_GITHUB_BRIDGE_TOKEN;
  env.PAPERCLIP_GITHUB_BROKER_URL = '';
  env.PAPERCLIP_GITHUB_BROKER_TOKEN = '';
  // An unreadable file (for example during a rewrite) keeps the last location.
  // Only a missing file, or one without a usable broker, means the task's access ended.
  const readBroker = () => {
    let broker;
    try { broker = JSON.parse(fs.readFileSync(path.join(directory, 'broker.json'), 'utf8')); }
    catch (error) { return error && error.code === 'ENOENT' ? 'absent' : 'unreadable'; }
    // A failed replacement bridge publishes empty values, which also means no broker.
    if (!broker || typeof broker.url !== 'string' || typeof broker.token !== 'string' || !broker.url || !broker.token) return 'absent';
    env.PAPERCLIP_GITHUB_BROKER_URL = broker.url;
    env.PAPERCLIP_GITHUB_BROKER_TOKEN = broker.token;
    return 'present';
  };
  readBroker();
` : String.raw`
  const readBroker = () => 'present';
`}
  const diagnostic = (code) => process.stderr.write('Paperclip: GitHub ' + code + '; continuing without managed credentials.\n');
  let connected = false;
  const configRoot = env.GH_CONFIG_DIR || os.tmpdir();
  // A missing/unwritable scratch directory must not break local Git. The
  // fallback deliberately cannot load the host's gh authentication files.
  let configDirectory = path.join(directory, 'unavailable-gh-config');
  let configReady = false;
  let authorReady = false;
  try {
    fs.mkdirSync(configRoot, { recursive: true, mode: 0o700 });
    configDirectory = fs.mkdtempSync(path.join(configRoot, 'paperclip-github-operation-'));
    fs.chmodSync(configDirectory, 0o700);
    configReady = true;
    process.once('exit', () => { try { fs.rmSync(configDirectory, { recursive: true, force: true }); } catch {} });
    fs.writeFileSync(path.join(configDirectory, 'gitconfig'), '[user]\n\tname = Paperclip\n\temail = noreply@paperclip.ing\n', { mode: 0o600 });
    authorReady = true;
  } catch { diagnostic('configuration_directory_unavailable'); }
  {
    for (const key of Object.keys(env)) {
      if (/^(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|PAPERCLIP_GIT_TOKEN|GIT_AUTHOR_.*|GIT_COMMITTER_.*|GIT_CONFIG_.*|GIT_ASKPASS|SSH_ASKPASS|SSH_AUTH_SOCK|GIT_SSH.*)$/.test(key)) delete env[key];
    }
    Object.assign(env, {
      GH_CONFIG_DIR: configDirectory, SSH_AUTH_SOCK: '',
      GIT_CONFIG_GLOBAL: authorReady ? path.join(configDirectory, 'gitconfig') : '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_COUNT: '5', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '',
      GIT_CONFIG_KEY_1: 'url.https://github.com/.insteadOf', GIT_CONFIG_VALUE_1: 'git@github.com:',
      GIT_CONFIG_KEY_2: 'url.https://github.com/.insteadOf', GIT_CONFIG_VALUE_2: 'ssh://git@github.com/',
      GIT_CONFIG_KEY_3: 'core.askPass', GIT_CONFIG_VALUE_3: '',
      GIT_CONFIG_KEY_4: 'user.useConfigOnly', GIT_CONFIG_VALUE_4: 'true',
    });
    const base = env.PAPERCLIP_GITHUB_BROKER_URL || env.PAPERCLIP_API_URL;
    const askBroker = !isLocalGit(process.argv.slice(2));
    try {
    let response;
    if (askBroker && base && env.PAPERCLIP_GITHUB_BROKER_TOKEN) {
      // A slow or restarting control plane must not cost the operation its
      // managed identity, so a failed request is retried before giving up.
      // Busy (409) responses and transport failures keep separate budgets, and
      // the body is read inside the retry so a failed read is retried too.
      // Transport failures and 503 responses retry until the recovery deadline,
      // reading the broker location again so a replacement is used once published.
      // Authentication denials (401/403) still end the request at once.
      const recoveryDeadline = Date.now() + ${brokerRecoveryMs};
      let transportFailures = 0, conflicts = 0, result;
      for (;;) {
        try {
          const url = (env.PAPERCLIP_GITHUB_BROKER_URL || env.PAPERCLIP_API_URL).replace(/\/+$/, '').replace(/\/api$/, '') + '/runtime-tools/github/credentials';
          response = await fetch(url, {
            method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
            headers: { authorization: 'Bearer ' + (env.PAPERCLIP_GITHUB_BRIDGE_TOKEN || env.PAPERCLIP_API_KEY || env.PAPERCLIP_GITHUB_BROKER_TOKEN),
              'x-paperclip-github-capability': env.PAPERCLIP_GITHUB_BROKER_TOKEN, 'content-type': 'application/json' },
            body: '{}',
          });
          // A sandbox gateway that outlived its controller answers 503 until
          // the replacement broker is published, so it waits like a refusal.
          if (response.status === 503 && Date.now() < recoveryDeadline) {
            await response.arrayBuffer().catch(() => {});
            throw new Error('broker unavailable');
          }
          if (response.status === 409 && conflicts < 29) {
            conflicts += 1;
            await response.arrayBuffer();
            await new Promise(resolve => setTimeout(resolve, 1000));
            continue;
          }
          result = response.ok ? await response.json() : null;
          break;
        } catch (error) {
          transportFailures += 1;
          if (transportFailures >= 3 && Date.now() >= recoveryDeadline) throw error;
          if (transportFailures === 3) {
            process.stderr.write('Paperclip: GitHub credential service is not reachable; waiting up to ' +
              Math.ceil((recoveryDeadline - Date.now()) / 1000) + ' seconds for it to return.\n');
          }
          await new Promise(resolve => setTimeout(resolve, Math.min(500 * transportFailures, 2000)));
          // A removed broker file means the task's access ended; nothing will return.
          if (readBroker() === 'absent') throw error;
        }
      }
      if (!response.ok) {
        diagnostic(response.status === 401 || response.status === 403 ? 'capability_rejected' : 'broker_response_unavailable');
      } else {
      if (result.status === 'unavailable') {
        const reason = typeof result.reason === 'string'
          ? result.reason.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 500)
          : 'Check the GitHub connection in Paperclip';
        process.stderr.write('Paperclip: GitHub access unavailable: ' + reason + '. Continuing without GitHub credentials.\n');
      }
      connected = result.status === 'available';
      if (result.status === 'available' && configReady) {
        for (const [key, value] of Object.entries(result.env || {})) {
          if (/^(GH_TOKEN|GITHUB_TOKEN|PAPERCLIP_GIT_TOKEN|GIT_TERMINAL_PROMPT|GIT_AUTHOR_(NAME|EMAIL)|GIT_COMMITTER_(NAME|EMAIL)|GIT_CONFIG_COUNT|GIT_CONFIG_(KEY|VALUE)_\d+)$/.test(key) && typeof value === 'string') env[key] = value;
        }
      }
      }
    } else if (askBroker) { diagnostic('capability_missing'); }
    } catch { diagnostic('broker_transport_unavailable'); }
  }
  const connectorTool = connected ? connectorRepositoryTool(process.argv.slice(2)) : null;
  if (connectorTool) {
    process.stderr.write("Paperclip: use the GitHub connection's " + connectorTool + " tool instead of gh repo " + process.argv[3] +
      ", so the connection's access rules apply. " + (connectorTool === 'fork_repository'
        ? 'Then clone the fork or add it as a git remote.' : 'Then add the repository as a git remote and push.') + '\n');
    process.exitCode = 1;
    return;
  }
  // Only this invocation and its children inherit the captured credential.
  env.PAPERCLIP_GITHUB_OPERATION_ACTIVE = '1';
  // Its Git children use the real binary, so steering cannot split a gh operation.
  env.PATH = originalPath.join(path.delimiter);
  if (launcherPlatform === 'win32') env.Path = env.PATH;
  // Nested shell aliases must not reload the parent launcher profile and
  // recapture a newer identity. All ordinary descendants stay in this operation.
  env.ZDOTDIR = configDirectory;
  env.BASH_ENV = '/dev/null';
  env.GIT_SSH_COMMAND = 'ssh -F /dev/null -o IdentityAgent=none -o IdentitiesOnly=yes -o IdentityFile=none -o BatchMode=yes';
  const child = startGitHubCommand(executable, process.argv.slice(2), env, launcherPlatform, spawn, path);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
  child.once('error', () => { process.stderr.write('Paperclip: GitHub command could not start.\n'); process.exitCode = 1; });
  child.once('exit', (code, signal) => { process.exitCode = code === null ? 128 : code; });
}
main().catch(() => { process.stderr.write('Paperclip: GitHub launcher_setup_failed.\n'); process.exitCode = 1; });
`;
}

/** Override inherited credentials even when adapters merge the host environment later. */
export function githubBrokerEnvironment(input: Record<string, unknown>, broker: { url: string; token: string }): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) if (typeof value === "string") env[key] = value;
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "PAPERCLIP_GIT_TOKEN", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "GIT_CONFIG_COUNT", "PAPERCLIP_GITHUB_OPERATION_ACTIVE"]) env[key] = "";
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key)) env[key] = "";
  }
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_SYSTEM = "/dev/null";
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_ASKPASS = "";
  env.SSH_ASKPASS = "";
  env.GIT_SSH_COMMAND = "ssh -F /dev/null -o IdentityAgent=none -o IdentitiesOnly=yes -o IdentityFile=none -o BatchMode=yes";
  env.SSH_AUTH_SOCK = "";
  env.PAPERCLIP_GITHUB_BROKER_URL = broker.url;
  env.PAPERCLIP_GITHUB_BROKER_TOKEN = broker.token;
  return env;
}
