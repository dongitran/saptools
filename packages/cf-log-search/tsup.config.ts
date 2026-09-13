import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: { index: "src/index.ts" },
    format: ["esm"],
    target: "node20",
    clean: true,
    dts: true,
    sourcemap: true,
    splitting: false,
    shims: false,
  },
  {
    entry: { cli: "src/cli.ts" },
    format: ["esm"],
    target: "node20",
    dts: false,
    sourcemap: true,
    splitting: false,
    shims: false,
    banner: { js: "#!/usr/bin/env node" },
  },
]);
