/** Short commit SHA identifying the running build, computed once at startup. */
function computeCommit(): string {
  if (Bun.env.COMMIT_SHA) return Bun.env.COMMIT_SHA;
  try {
    const result = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"]);
    const sha = result.stdout.toString().trim();
    return sha || "unknown";
  } catch {
    return "unknown";
  }
}

export const commit = computeCommit();
export const startedAt = new Date().toISOString();
