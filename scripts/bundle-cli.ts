#!/usr/bin/env node
/**
 * Bundle dist/cli.js into dist/bin/ave.js with esbuild.
 *
 * Motivation: Node has to stat/resolve/parse every file it imports. For ave that
 * is ~1,100 files (including ~670 typebox files) on every startup, which makes
 * `ave --help`, `ave --version`, and plain `ave` take seconds on any cold or
 * slow filesystem (WSL /mnt/c, network mounts, CI with cold caches). esbuild
 * collapses the graph into a single entry plus a handful of split chunks for
 * the already-lazy provider modules, so startup only reads a few files.
 *
 * What stays external:
 *   - undici and the LLM SDKs that ship CJS with dynamic require() calls or
 *     expect their own file layout at runtime (node_http_handler, wasm loads,
 *     .bin lookups, etc.).
 *   - Native optional deps (koffi, canvas, @mariozechner/clipboard).
 *
 * Code splitting keeps each provider module (anthropic, google, mistral, ...)
 * in its own chunk so `import("./mistral.js")` in register-builtins.ts does
 * not pull the mistral SDK into the main bundle.
 */

import { chmodSync, copyFileSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const DIST = join(ROOT, "dist");
const OUTDIR = join(DIST, "bin");
const ENTRY = join(DIST, "cli.js");

// Deps that must stay external. Reasons:
//   undici                          - ships internal CJS using dynamic require
//   @aws-sdk/*, @smithy/*           - dynamic require of "tty" etc.
//   @anthropic-ai/sdk               - ships CJS + ESM, we load via external
//   @google/genai                   - internal dynamic require + native gRPC paths
//   @mistralai/mistralai            - CJS interop with dynamic requires
//   @silvia-odwyer/photon-node      - wasm loader expects disk layout
//   koffi / canvas / clipboard      - native bindings (optional deps)
//   @mariozechner/jiti              - runtime module resolver (itself a loader)
//   proxy-agent                     - spawns helper modules at runtime
//   extract-zip                     - CJS dynamic requires
//   proper-lockfile                 - CJS, plus uses fs.realpath specifics
//   cli-highlight                   - performs runtime language lookup
const EXTERNAL = [
	"undici",
	"@aws-sdk/*",
	"@smithy/*",
	"@anthropic-ai/sdk",
	"@google/genai",
	"@mistralai/mistralai",
	"@silvia-odwyer/photon-node",
	"koffi",
	"canvas",
	"@mariozechner/clipboard",
	"@mariozechner/jiti",
	"proxy-agent",
	"extract-zip",
	"proper-lockfile",
	"cli-highlight",
];

// Bundled ESM sometimes wraps bundled CJS deps that call require() at
// module-init time. Polyfill require via createRequire so those CJS shims
// resolve against the bundle file.
const BANNER = [
	`import { createRequire as __topLevelCreateRequire } from "node:module";`,
	`const require = __topLevelCreateRequire(import.meta.url);`,
].join("\n");

async function main(): Promise<void> {
	// Clean the output dir so stale split chunks don't accumulate across builds.
	rmSync(OUTDIR, { recursive: true, force: true });

	const result = await build({
		entryPoints: [ENTRY],
		outdir: OUTDIR,
		outbase: DIST,
		bundle: true,
		platform: "node",
		format: "esm",
		target: ["node20"],
		splitting: true,
		external: EXTERNAL,
		banner: { js: BANNER },
		// Keep names so stack traces remain useful; minification buys little on
		// startup vs. cost of harder debugging.
		minify: false,
		sourcemap: false,
		legalComments: "none",
		logLevel: "warning",
		metafile: true,
	});

	// With outbase=dist, the entry file lands at dist/bin/cli.js. Rename it to
	// dist/bin/ave.js so package.json bin can point at a stable filename.
	const entryOutPath = join(OUTDIR, "cli.js");
	const renamedPath = join(OUTDIR, "ave.js");
	renameSync(entryOutPath, renamedPath);

	// Ensure shebang is present and file is executable.
	const contents = readFileSync(renamedPath, "utf-8");
	const withShebang = contents.startsWith("#!") ? contents : `#!/usr/bin/env node\n${contents}`;
	writeFileSync(renamedPath, withShebang);
	chmodSync(renamedPath, 0o755);

	// Copy runtime assets that the bundled code resolves relative to the
	// bundle's own location. anchor-state-manager.ts looks for .hash_anchors
	// next to its module; in the bundled layout that means dist/bin/.
	copyFileSync(join(ROOT, "src/core/tools/.hash_anchors"), join(OUTDIR, ".hash_anchors"));

	// Print a small summary sorted by size for signal.
	const metafile = result.metafile;
	if (!metafile) return;
	const { outputs } = metafile;
	const totalBytes = Object.values(outputs).reduce((acc, o) => acc + o.bytes, 0);
	const fileCount = Object.keys(outputs).length;
	const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;
	console.log(`Bundled ${fileCount} file(s), ${kb(totalBytes)} total -> ${OUTDIR}`);
	const sorted = Object.entries(outputs).sort((a, b) => b[1].bytes - a[1].bytes);
	for (const [path, meta] of sorted) {
		const relPath = path.replace(`${ROOT}/`, "");
		const displayPath = relPath === "dist/bin/cli.js" ? "dist/bin/ave.js" : relPath;
		console.log(`  ${displayPath}  ${kb(meta.bytes)}`);
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
