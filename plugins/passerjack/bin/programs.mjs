/**
 * Where the plugin finds the programs it starts: the browser opener, the
 * clipboard reader, `git` and `ps`. And the process table that `ps` gives
 * (`processTable`), which the permission waiters read.
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

import { execFile } from "node:child_process";
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

/**
 * `ps`'s ELAPSED TIME, `[[dd-]hh:]mm:ss`, in milliseconds (whole seconds), or
 * null for anything else.
 *
 * @param {string} text
 */
export function elapsedMs(text) {
  const m = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(String(text).trim());
  if (!m) return null;
  const [, days, hours, minutes, seconds] = m;
  return (((Number(days ?? 0) * 24 + Number(hours ?? 0)) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000;
}

/**
 * The output of `ps -A -o pid=,ppid=,etime=` as rows. Only the ids and the
 * age of each process: no command line, no user, nothing anybody typed.
 *
 * @param {string} text
 * @returns {{ pid: number, ppid: number, elapsedMs: number }[]}
 */
export function parseProcessTable(text) {
  const rows = [];
  for (const line of String(text).split("\n")) {
    const [pid, ppid, etime] = line.trim().split(/\s+/);
    const age = elapsedMs(etime ?? "");
    if (!/^\d+$/.test(pid ?? "") || !/^\d+$/.test(ppid ?? "") || age === null) continue;
    rows.push({ pid: Number(pid), ppid: Number(ppid), elapsedMs: age });
  }
  return rows;
}

/**
 * `pid` and every process above it in `table`, up to the first one that the
 * table does not hold (a loop in a table taken while processes changed ends
 * too).
 *
 * @param {{ pid: number, ppid: number }[]} table
 * @param {number} pid
 */
export function ancestorsOf(table, pid) {
  const parent = new Map(table.map((row) => [row.pid, row.ppid]));
  const seen = new Set();
  for (let at = pid; Number.isSafeInteger(at) && at > 0 && !seen.has(at); at = parent.get(at) ?? 0) seen.add(at);
  return seen;
}

/**
 * Every process on the machine, with its parent and its age, or null when
 * the table cannot be read: `ps` is not there (Windows), or it failed or took
 * too long. A caller treats null as "unknown", never as "no process".
 *
 * `ps` is started by its absolute path like every other program here, with
 * `LC_ALL=C` so that the columns do not move with the locale.
 *
 * @param {{ env?: Record<string, string | undefined>, platform?: string }} [options]
 * @returns {Promise<{ pid: number, ppid: number, elapsedMs: number }[] | null>}
 */
export function processTable({ env = process.env, platform = process.platform } = {}) {
  return new Promise((resolve) => {
    if (platform === "win32") return resolve(null);
    const ps = findOnPath("ps", { env, platform });
    if (!ps) return resolve(null);
    execFile(
      ps,
      ["-A", "-o", "pid=,ppid=,etime="],
      { timeout: 3000, windowsHide: true, encoding: "utf8", env: { PATH: env.PATH ?? "", LC_ALL: "C" }, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve(null);
        const table = parseProcessTable(stdout);
        resolve(table.length ? table : null);
      },
    );
  });
}

/**
 * The live children of `parent`, other than the caller's own line of
 * processes (`self` and everything above it), with their age, or null when
 * the table cannot be read (`processTable`).
 *
 * @param {number} parent
 * @param {{ self?: number, env?: Record<string, string | undefined>, platform?: string }} [options]
 * @returns {Promise<{ pid: number, ppid: number, elapsedMs: number }[] | null>}
 */
export async function childrenOf(parent, { self = process.pid, env = process.env, platform = process.platform } = {}) {
  if (!Number.isSafeInteger(parent) || parent <= 1) return null;
  const table = await processTable({ env, platform });
  if (!table) return null;
  const mine = ancestorsOf(table, self);
  return table.filter((row) => row.ppid === parent && !mine.has(row.pid));
}

