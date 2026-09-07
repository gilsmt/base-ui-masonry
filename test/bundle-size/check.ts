import { brotliCompressSync, gzipSync } from "node:zlib";

// Bundle-size check for the vendored single file. Mirrors the README table:
// row 1 bundles masonry.tsx with @base-ui/* external (copy/paste cost),
// row 2 bundles the tree-shaken @base-ui deps too (react external only).
// Run: bun run size — check against the snapshot
// Run: bun run size:update — after an intentional size change, refresh the
// snapshot and the README table in place
const SNAPSHOT_PATH = new URL("./snapshot.json", import.meta.url);
const README_PATH = new URL("../../README.md", import.meta.url);

interface BundleSizes {
    minified: number;
    gzipped: number;
    brotli: number;
}

async function bundle(external: string[]): Promise<BundleSizes> {
    const result = await Bun.build({
        entrypoints: ["src/masonry.tsx"],
        external: ["react", "react-dom", "react/jsx-runtime", ...external],
        minify: true,
    });
    if (!result.success) {
        throw new Error(`build failed:\n${result.logs.join("\n")}`);
    }
    const output = result.outputs[0];
    if (!output) throw new Error("build produced no output");
    const code = await output.text();
    const bytes = Buffer.byteLength(code);
    return {
        minified: bytes,
        gzipped: gzipSync(code).length,
        brotli: brotliCompressSync(code).length,
    };
}

function formatKB(bytes: number) {
    return `${(bytes / 1024).toFixed(2)} kB`;
}

// Table rows are identified by their label text; the size cells are replaced
// positionally. A missing or reshaped row must fail loudly, not silently skip.
async function updateReadmeTable(alone: BundleSizes, withDeps: BundleSizes) {
    const lines = (await Bun.file(README_PATH).text()).split("\n");
    const rows: [label: string, sizes: BundleSizes][] = [
        ["standalone copy/paste cost", alone],
        ["tree-shaken `@base-ui` deps", withDeps],
    ];
    for (const [label, sizes] of rows) {
        const matches = lines.flatMap((line, index) => (line.includes(label) ? [index] : []));
        if (matches.length !== 1) {
            throw new Error(
                `expected exactly one README table row containing "${label}", found ${matches.length}`,
            );
        }
        const lineIndex = matches[0];
        const line = lines[lineIndex];
        const rowShape = / \| [\d.]+ kB \| [\d.]+ kB \| [\d.]+ kB \|$/;
        if (!rowShape.test(line)) {
            throw new Error(`README table row does not match the expected shape: ${line}`);
        }
        lines[lineIndex] = line.replace(
            rowShape,
            ` | ${formatKB(sizes.minified)} | ${formatKB(sizes.gzipped)} | ${formatKB(sizes.brotli)} |`,
        );
    }
    await Bun.write(README_PATH, lines.join("\n"));
}

const alone = await bundle(["@base-ui/react", "@base-ui/utils"]);
const withDeps = await bundle([]);

console.log("masonry.tsx alone (@base-ui/* external) — standalone copy/paste cost");
console.log(
    `  minified ${formatKB(alone.minified)} · gzipped ${formatKB(alone.gzipped)} · brotli ${formatKB(alone.brotli)}`,
);
console.log("masonry.tsx + tree-shaken @base-ui deps");
console.log(
    `  minified ${formatKB(withDeps.minified)} · gzipped ${formatKB(withDeps.gzipped)} · brotli ${formatKB(withDeps.brotli)}`,
);

const snapshotFile = Bun.file(SNAPSHOT_PATH);
if (!(await snapshotFile.exists())) {
    await Bun.write(SNAPSHOT_PATH, `${JSON.stringify({ alone, withDeps }, null, 2)}\n`);
    console.log("\nwrote test/bundle-size/snapshot.json (first run)");
    process.exit(0);
}

if (process.argv.includes("--update")) {
    await Bun.write(SNAPSHOT_PATH, `${JSON.stringify({ alone, withDeps }, null, 2)}\n`);
    await updateReadmeTable(alone, withDeps);
    console.log("\nupdated snapshot.json and the README bundle-size table");
    process.exit(0);
}

const snapshot = (await snapshotFile.json()) as { alone: BundleSizes; withDeps: BundleSizes };
const HEADROOM = 1.05; // fail only on real growth, not bundler noise
let failed = false;
for (const [name, next, prev] of [
    ["alone.minified", alone.minified, snapshot.alone.minified],
    ["alone.gzipped", alone.gzipped, snapshot.alone.gzipped],
    ["alone.brotli", alone.brotli, snapshot.alone.brotli],
    ["withDeps.minified", withDeps.minified, snapshot.withDeps.minified],
    ["withDeps.gzipped", withDeps.gzipped, snapshot.withDeps.gzipped],
    ["withDeps.brotli", withDeps.brotli, snapshot.withDeps.brotli],
] as const) {
    if (next > prev * HEADROOM) {
        console.error(`size regression: ${name} ${prev} -> ${next} bytes (>5% over snapshot)`);
        failed = true;
    }
}
if (failed) process.exit(1);
console.log("\nwithin 5% of snapshot");
