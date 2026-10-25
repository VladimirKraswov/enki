// Read-only Git information for the review panel.
//
// Git is executed from an absolute path (configured, or a known install
// location) with an argument vector — never through a shell and never resolved
// from the user's PATH. GIT_OPTIONAL_LOCKS=0 keeps status/diff from taking the
// index lock, so these reads never interfere with the agent or the user.

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const CANDIDATES = process.platform === "win32"
  ? [path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "cmd", "git.exe"), path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Git", "cmd", "git.exe")]
  : ["/usr/bin/git", "/opt/homebrew/bin/git", "/usr/local/bin/git", "/bin/git"];

export function findGit(configured?: string | null): string | null {
  for (const candidate of [configured, ...CANDIDATES]) {
    if (!candidate || !path.isAbsolute(candidate)) continue;
    try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* next */ }
  }
  return null;
}

export interface DiffFileDTO { file: string; before?: string; after?: string; additions?: number; deletions?: number; status?: string; patch?: string }

export class GitService {
  constructor(private readonly program: () => string | null) {}

  private run(cwd: string, args: string[], allowFailure = false): Promise<string> {
    const git = this.program();
    if (!git) return Promise.reject(new Error("Git не найден. Укажите путь к git в настройках Enki."));
    return new Promise((resolve, reject) => {
      execFile(git, args, {
        cwd, timeout: 15_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
      }, (error, stdout) => {
        if (error && !allowFailure) reject(new Error(`git ${args[0]}: ${error.message.split("\n")[0].slice(0, 300)}`));
        else resolve(stdout);
      });
    });
  }

  async info(directory: string): Promise<{ branch: string | null; default_branch: string | null; project: string } | null> {
    const inside = (await this.run(directory, ["rev-parse", "--is-inside-work-tree"], true)).trim();
    if (inside !== "true") return null;
    const branch = (await this.run(directory, ["rev-parse", "--abbrev-ref", "HEAD"], true)).trim() || null;
    const remoteHead = (await this.run(directory, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], true)).trim();
    const top = (await this.run(directory, ["rev-parse", "--show-toplevel"], true)).trim();
    return { branch, default_branch: remoteHead ? remoteHead.replace(/^origin\//, "") : null, project: top || directory };
  }

  async status(directory: string): Promise<{ branch: string | null; files: Array<{ file: string; status: string }> }> {
    const info = await this.info(directory);
    if (!info) return { branch: null, files: [] };
    const out = await this.run(directory, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    const files: Array<{ file: string; status: string }> = [];
    const records = out.split("\0").filter(Boolean);
    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      const code = record.slice(0, 2), file = record.slice(3);
      if (code.startsWith("R") || code.startsWith("C")) i++; // the next record is the source path
      files.push({ file, status: code === "??" ? "added" : code.includes("D") ? "deleted" : code.includes("A") ? "added" : code.startsWith("R") ? "rename" : "modified" });
    }
    return { branch: info.branch, files };
  }

  /** "git": working tree vs HEAD; "branch": working tree vs merge-base with the default branch. */
  async diff(directory: string, mode: "git" | "branch" = "git", context = 3): Promise<DiffFileDTO[]> {
    const info = await this.info(directory);
    if (!info) return [];
    let base = "HEAD";
    if (mode === "branch" && info.default_branch) {
      const mergeBase = (await this.run(directory, ["merge-base", "HEAD", `origin/${info.default_branch}`], true)).trim();
      if (/^[0-9a-f]{40,64}$/.test(mergeBase)) base = mergeBase;
    }
    const hasHead = (await this.run(directory, ["rev-parse", "--verify", "--quiet", "HEAD"], true)).trim() !== "";
    const out: DiffFileDTO[] = [];
    if (hasHead) {
      const numstat = await this.run(directory, ["diff", "--numstat", "-z", base, "--"]);
      const records = numstat.split("\0").filter(Boolean);
      for (let i = 0; i < records.length && out.length < 500; i++) {
        const [added, deleted, ...rest] = records[i].split("\t");
        let file = rest.join("\t");
        if (!file) { file = records[i + 2] ?? ""; i += 2; } // rename: "N\tM\t\0old\0new"
        if (!file) continue;
        const patch = await this.run(directory, ["diff", `-U${Math.max(0, Math.min(context, 20))}`, base, "--", file]);
        out.push({ file, additions: Number(added) || 0, deletions: Number(deleted) || 0, status: "modified", patch: patch.slice(0, 2_000_000) });
      }
    }
    const untracked = (await this.run(directory, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean);
    for (const file of untracked.slice(0, Math.max(0, 500 - out.length))) {
      let after: string | undefined;
      try {
        const full = path.join(directory, file);
        // lstat: a link is listed but never followed (it may point outside the
        // project, same rule as the file browser in platform/files.ts).
        const stat = fs.lstatSync(full);
        if (stat.isFile() && stat.size <= 1_000_000) after = fs.readFileSync(full, "utf8");
      } catch { after = undefined; }
      out.push({ file, status: "added", ...(after !== undefined ? { after, additions: after.split("\n").length, deletions: 0 } : {}) });
    }
    return out;
  }
}
