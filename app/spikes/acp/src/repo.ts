// Repository git di prova in una cartella temporanea: nessuno script tocca progetti reali.
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function makeTempRepo(label: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `blue-acp-${label}-`)));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "spike@blue.local");
  git("config", "user.name", "Blue spike");
  writeFileSync(join(dir, "README.md"), "# Repo di prova per lo spike ACP\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  return dir;
}

export function gitStatus(dir: string): string {
  return execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: dir, encoding: "utf8" });
}

export function gitDiff(dir: string): string {
  // Diff completo rispetto a HEAD, file nuovi compresi (come farebbe GitService di Blue).
  execFileSync("git", ["add", "-A", "--intent-to-add"], { cwd: dir });
  return execFileSync("git", ["diff", "HEAD"], { cwd: dir, encoding: "utf8" });
}
