import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectDir = process.env.AER_ART_PROJECT_DIR
  ? path.resolve(process.env.AER_ART_PROJECT_DIR)
  : null;
const artRepoDir = process.env.AER_ART_DEBUGGER_ART_REPO_DIR
  ? path.resolve(process.env.AER_ART_DEBUGGER_ART_REPO_DIR)
  : null;
const runtimeGroupsDir = process.env.AER_ART_DEBUGGER_RUNTIME_GROUPS_DIR
  ? path.resolve(process.env.AER_ART_DEBUGGER_RUNTIME_GROUPS_DIR)
  : null;
const runtimeGitDir = process.env.AER_ART_DEBUGGER_RUNTIME_GIT_DIR
  ? path.resolve(process.env.AER_ART_DEBUGGER_RUNTIME_GIT_DIR)
  : null;
const repoGroupsDir = artRepoDir ? path.join(artRepoDir, 'groups') : null;
const projectGitDir = projectDir ? path.join(projectDir, '.git') : null;

function isInsidePath(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

function pathValue(input) {
  if (input instanceof URL) return fileURLToPath(input);
  if (Buffer.isBuffer(input)) return input.toString();
  return typeof input === 'string' ? input : null;
}

function restorePathShape(original, redirected) {
  if (original instanceof URL) return pathToFileURL(redirected);
  if (Buffer.isBuffer(original)) return Buffer.from(redirected);
  return redirected;
}

function redirectPath(input) {
  if (!repoGroupsDir || !runtimeGroupsDir) return input;
  const value = pathValue(input);
  if (!value) return input;

  const absolute = path.resolve(value);
  if (projectGitDir && runtimeGitDir && isInsidePath(absolute, projectGitDir)) {
    const relative = path.relative(projectGitDir, absolute);
    return restorePathShape(input, path.join(runtimeGitDir, relative));
  }

  if (isInsidePath(absolute, repoGroupsDir)) {
    const relative = path.relative(repoGroupsDir, absolute);
    return restorePathShape(input, path.join(runtimeGroupsDir, relative));
  }

  return input;
}

function redirectArgs(args, indexes) {
  const next = [...args];
  for (const index of indexes) {
    if (index < next.length) next[index] = redirectPath(next[index]);
  }
  return next;
}

function patchMethod(target, name, indexes = [0]) {
  const original = target?.[name];
  if (typeof original !== 'function') return;
  target[name] = function patchedFsMethod(...args) {
    return original.apply(this, redirectArgs(args, indexes));
  };
  if (typeof original.native === 'function') {
    target[name].native = function patchedFsNativeMethod(...args) {
      return original.native.apply(this, redirectArgs(args, indexes));
    };
  }
}

function patchPromises(name, indexes = [0]) {
  patchMethod(fs.promises, name, indexes);
}

function normalizeOptions(options) {
  return options && typeof options === 'object' ? options : {};
}

function cwdForOptions(options) {
  const cwd = normalizeOptions(options).cwd;
  return path.resolve(typeof cwd === 'string' ? cwd : process.cwd());
}

function isGitExecutable(command) {
  return typeof command === 'string' && path.basename(command) === 'git';
}

function isGitShellCommand(command) {
  return typeof command === 'string' && /^git(?:\s|$)/.test(command.trim());
}

function shouldRedirectGit(options) {
  if (!projectDir || !runtimeGitDir) return false;
  return isInsidePath(cwdForOptions(options), projectDir);
}

function withGitRedirectEnv(options) {
  if (!shouldRedirectGit(options)) return options;
  fs.mkdirSync(runtimeGitDir, { recursive: true });
  const current = normalizeOptions(options);
  return {
    ...current,
    env: {
      ...process.env,
      ...(current.env ?? {}),
      GIT_DIR: runtimeGitDir,
      GIT_WORK_TREE: projectDir,
    },
  };
}

function patchChildProcessGit() {
  const originalExecSync = childProcess.execSync;
  childProcess.execSync = function patchedExecSync(command, options) {
    return originalExecSync.call(
      this,
      command,
      isGitShellCommand(command) ? withGitRedirectEnv(options) : options,
    );
  };

  const originalExec = childProcess.exec;
  childProcess.exec = function patchedExec(command, options, callback) {
    if (typeof options === 'function') {
      return originalExec.call(this, command, isGitShellCommand(command) ? withGitRedirectEnv(undefined) : undefined, options);
    }
    return originalExec.call(
      this,
      command,
      isGitShellCommand(command) ? withGitRedirectEnv(options) : options,
      callback,
    );
  };

  const originalExecFileSync = childProcess.execFileSync;
  childProcess.execFileSync = function patchedExecFileSync(file, args, options) {
    return originalExecFileSync.call(
      this,
      file,
      args,
      isGitExecutable(file) ? withGitRedirectEnv(options) : options,
    );
  };

  const originalExecFile = childProcess.execFile;
  childProcess.execFile = function patchedExecFile(file, args, options, callback) {
    if (typeof args === 'function') {
      return originalExecFile.call(this, file, args);
    }
    if (typeof options === 'function') {
      return originalExecFile.call(this, file, args, isGitExecutable(file) ? withGitRedirectEnv(undefined) : undefined, options);
    }
    return originalExecFile.call(
      this,
      file,
      args,
      isGitExecutable(file) ? withGitRedirectEnv(options) : options,
      callback,
    );
  };

  const originalSpawnSync = childProcess.spawnSync;
  childProcess.spawnSync = function patchedSpawnSync(command, args, options) {
    return originalSpawnSync.call(
      this,
      command,
      args,
      isGitExecutable(command) ? withGitRedirectEnv(options) : options,
    );
  };

  const originalSpawn = childProcess.spawn;
  childProcess.spawn = function patchedSpawn(command, args, options) {
    return originalSpawn.call(
      this,
      command,
      args,
      isGitExecutable(command) ? withGitRedirectEnv(options) : options,
    );
  };
}

if ((repoGroupsDir && runtimeGroupsDir) || (projectGitDir && runtimeGitDir)) {
  if (runtimeGroupsDir) fs.mkdirSync(runtimeGroupsDir, { recursive: true });

  for (const name of [
    'accessSync',
    'appendFileSync',
    'chmodSync',
    'chownSync',
    'createReadStream',
    'createWriteStream',
    'existsSync',
    'lstatSync',
    'mkdirSync',
    'openSync',
    'opendirSync',
    'readFileSync',
    'readdirSync',
    'readlinkSync',
    'realpathSync',
    'rmSync',
    'rmdirSync',
    'statSync',
    'unlinkSync',
    'utimesSync',
    'writeFileSync',
  ]) {
    patchMethod(fs, name);
  }

  for (const name of ['copyFileSync', 'cpSync', 'renameSync', 'symlinkSync']) {
    patchMethod(fs, name, [0, 1]);
  }

  for (const name of [
    'access',
    'appendFile',
    'chmod',
    'chown',
    'lstat',
    'mkdir',
    'open',
    'opendir',
    'readFile',
    'readdir',
    'readlink',
    'realpath',
    'rm',
    'rmdir',
    'stat',
    'unlink',
    'utimes',
    'writeFile',
  ]) {
    patchPromises(name);
  }

  for (const name of ['copyFile', 'cp', 'rename', 'symlink']) {
    patchPromises(name, [0, 1]);
  }

  patchChildProcessGit();
  syncBuiltinESMExports();
}
