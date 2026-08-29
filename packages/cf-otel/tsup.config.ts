import { defineConfig } from "tsup";

// Two builds: the library entry must NOT carry a Node shebang (it ships in
// `import` form), while the CLI binary needs `#!/usr/bin/env node` so it can
// be exec'd directly via the `bin` entry in package.json.
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
