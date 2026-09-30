import pkg from "../packages/livesync-workers/package.json" with { type: "json" };

// The Worker is released together with the library, so this is the release version.
export const VERSION: string = pkg.version;
