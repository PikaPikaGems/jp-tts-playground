// Publishes deploy/ to the `gh-pages` branch of this repository's `origin` (GitHub Pages serves that branch).
//
//   npm run build:deploy && npm run publish:gh-pages
//
// It clones the branch into a temporary directory, replaces its contents with deploy/, commits and pushes (a normal,
// non-force push). Because build-deploy.mjs output is deterministic, unchanged big files are stored only once.
//   --trailer "Co-Authored-By: ..."   optional line appended to the commit message
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const DEPLOY = path.join(ROOT, "deploy");
if (!fs.existsSync(path.join(DEPLOY, "index.html"))) { console.error("deploy/ not found - run `npm run build:deploy` first."); process.exit(1); }

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
const origin = git(ROOT, "remote", "get-url", "origin");
const sha = git(ROOT, "rev-parse", "--short", "HEAD");
const ti = process.argv.indexOf("--trailer");
const trailer = ti > 0 ? process.argv[ti + 1] : "";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gh-pages-"));
try {
  try { git(os.tmpdir(), "clone", "--quiet", "--branch", "gh-pages", "--single-branch", "--depth", "1", origin, tmp); }
  catch { git(tmp, "init", "--quiet", "-b", "gh-pages"); git(tmp, "remote", "add", "origin", origin); } // first publish: create the branch
  for (const e of fs.readdirSync(tmp)) if (e !== ".git") fs.rmSync(path.join(tmp, e), { recursive: true, force: true });
  fs.cpSync(DEPLOY, tmp, { recursive: true });
  git(tmp, "add", "-A");
  if (!git(tmp, "status", "--porcelain")) { console.log("Nothing to publish: gh-pages is already up to date."); process.exit(0); }
  git(tmp, "commit", "--quiet", "-m", `Deploy site built from ${sha}${trailer ? `\n\n${trailer}` : ""}`);
  console.log(git(tmp, "-c", "http.postBuffer=524288000", "push", "--quiet", "origin", "gh-pages") || "Pushed to gh-pages.");
  console.log("Published. GitHub Pages usually updates within a minute or two.");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
