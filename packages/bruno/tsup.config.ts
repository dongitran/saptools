import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    cli: "src/cli.ts",
    postinstall: "src/postinstall.ts",
  },
  format: ["esm"],
  target: "node20",
  clean: true,
  dts: true,
  sourcemap: true,
  splitting: false,
  shims: false,
  banner: ({ format }) => (format === "esm" ? { js: "#!/usr/bin/env node" } : {}),
});
