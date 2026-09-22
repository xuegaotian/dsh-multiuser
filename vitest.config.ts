import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    /**
     * Integration suites boot real DSH runtimes and delete their temporary homes
     * afterwards (per-user Profiles are symlink farms, which some filesystems
     * remove far more slowly than a plain tree). The 10s vitest default is not a
     * statement about correctness, so give hooks room to finish and let genuine
     * assertion failures — not cleanup timing — decide the result.
     */
    hookTimeout: 120_000,
  },
})
