/** Replaced by tools/build.ts; a source invocation is deliberately unstamped. */
export const build = {
  sha: process.env.CUSAGE_BUILD_SHA ?? null,
  builtAt: process.env.CUSAGE_BUILD_TIME ?? null,
  repo: process.env.CUSAGE_BUILD_REPO ?? null,
  dirty: process.env.CUSAGE_BUILD_DIRTY === "true",
};
