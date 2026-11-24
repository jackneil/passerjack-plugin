/**
 * Where the plugin finds the programs it starts: the browser opener, the
 * clipboard reader and `git`.
 *
 * WHY NOT A BARE NAME. Node starts a program through libuv. On Windows, libuv
 * looks for a bare name in the CURRENT FOLDER first (`search_path` in
 * `src/win/process.c`: "If there's really only a filename, check the current
 * directory for file, then search all path directories"), and adds `.com` and
 * `.exe`. A Claude Code session's current folder is the project, so a cloned
 * repository that holds `rundll32.exe`, `powershell.exe` or `git.exe` would run
 * as the user instead of the real program. This is the class of
 * CVE-2020-26233 (GitHub CLI and `git.exe`). On macOS and Linux `execvp`
 * searches PATH only, but an empty or relative PATH entry (`::`, `.`) makes it
 * search the current folder too.
 *
 * So every program is started by an ABSOLUTE path: on Windows the system
 * programs from `%SystemRoot%\System32`, and anything else from an absolute
 * PATH entry only. On Windows the child also starts in System32, so a search
 * that the child itself makes does not start in the project.
 *
 * DEPENDENCY-FREE, like the rest of `bin/`. Every function takes the
 * environment, the platform and a file test as parameters, so the tests run
 * the Windows rules on any machine.
 */

import fs from "node:fs";
import path from "node:path";

/** The Windows programs this plugin starts, under System32. */
const WINDOWS_SYSTEM_PROGRAMS = {
  rundll32: ["rundll32.exe"],
  powershell: ["WindowsPowerShell", "v1.0", "powershell.exe"],
};

/** The extensions a bare name may take on Windows, in libuv's order. Never `.bat` or `.cmd`: those need a shell. */
const WINDOWS_EXTENSIONS = [".com", ".exe"];

function envValue(env, ...names) {
  for (const name of names) {
    const value = env?.[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/**
 * `%SystemRoot%`, when it is an absolute drive path, else `C:\Windows`.
 *
 * @param {Record<string, string | undefined>} [env]
 */
export function windowsRoot(env) {
  const value = envValue(env, "SystemRoot", "SYSTEMROOT", "windir", "WINDIR");
  return value && /^[A-Za-z]:[\\/]/.test(value) ? path.win32.normalize(value) : "C:\\Windows";
}

/**
 * `%SystemRoot%\System32`.
 *
 * @param {Record<string, string | undefined>} [env]
 */
export function windowsSystem32(env) {
  return path.win32.join(windowsRoot(env), "System32");
}

/**
 * The folder a child process starts in: System32 on Windows, the inherited one elsewhere.
 *
 * @param {string} platform
 * @param {Record<string, string | undefined>} [env]
 */
export function safeCwd(platform, env) {
  return platform === "win32" ? windowsSystem32(env) : undefined;
}

function defaultIsProgram(platform) {
  return (file) => {
    try {
      if (!fs.statSync(file).isFile()) return false;
      if (platform !== "win32") fs.accessSync(file, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
}

/**
 * `name` found in an ABSOLUTE PATH entry, or null. Relative and empty entries
 * are skipped, so the current folder is never searched.
 *
 * @param {string} name
 * @param {{ env?: Record<string, string | undefined>, platform?: string, isProgram?: (file: string) => boolean }} [options]
 */
export function findOnPath(name, { env = process.env, platform = process.platform, isProgram } = {}) {
  const win = platform === "win32";
  const p = win ? path.win32 : path.posix;
  const test = isProgram ?? defaultIsProgram(platform);
  const raw = envValue(env, "PATH", "Path", "path") ?? "";
  const names = win && !/\.[^\\/.]+$/.test(name) ? WINDOWS_EXTENSIONS.map((ext) => `${name}${ext}`) : [name];
  for (const entry of raw.split(win ? ";" : ":")) {
    const dir = entry.trim().replace(/^"(.*)"$/, "$1");
    if (!dir || !p.isAbsolute(dir)) continue;
    // A Windows path like `\tools` is "absolute" to path.win32 but relative to
    // the current drive: only a drive or a UNC path is taken.
    if (win && !/^(?:[A-Za-z]:[\\/]|\\\\)/.test(dir)) continue;
    for (const file of names) {
      const full = p.join(dir, file);
      if (test(full)) return full;
    }
  }
  return null;
}

/**
 * The absolute path to start for `name` on `platform`, or null when it is not
 * on this machine. On Windows `rundll32` and `powershell` are the System32
 * copies, whatever PATH says.
 *
 * @param {string} name
 * @param {{ env?: Record<string, string | undefined>, platform?: string, isProgram?: (file: string) => boolean }} [options]
 */
export function programPath(name, { env = process.env, platform = process.platform, isProgram } = {}) {
  if (platform === "win32" && Object.hasOwn(WINDOWS_SYSTEM_PROGRAMS, name)) {
    return path.win32.join(windowsSystem32(env), ...WINDOWS_SYSTEM_PROGRAMS[name]);
  }
  return findOnPath(name, { env, platform, isProgram });
}
