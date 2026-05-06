import { watch as fsWatch } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, relative } from "node:path";

declare const Bun: any;

const root = new URL("..", import.meta.url);
const rootPath = Bun.fileURLToPath(root);
const buildsRootDir = join(rootPath, ".dist-builds");
const distPath = join(rootPath, "dist");
const publicDir = join(rootPath, "public");
const templatePath = join(rootPath, "index.template.html");
const pierreWorkerDir = join(rootPath, "node_modules", "@pierre", "diffs", "dist", "worker");
const watch = Bun.argv.includes("--watch");

function newBuildId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function buildOnce() {
  const buildId = newBuildId();
  const buildDir = join(buildsRootDir, buildId);
  const buildAssetsDir = join(buildDir, "assets");
  await mkdir(buildAssetsDir, { recursive: true });

  const result = await Bun.build({
    entrypoints: [join(rootPath, "app", "entry.tsx")],
    outdir: buildAssetsDir,
    naming: "[name]-[hash].[ext]",
    minify: true,
    splitting: true,
    target: "browser",
  });

  if (!result.success) {
    throw new Error(result.logs.map((log: any) => log.message).join("\n"));
  }

  const cssResult = await Bun.spawn([
    "./node_modules/.bin/tailwindcss",
    "-i",
    "app/app.css",
    "-o",
    relative(rootPath, join(buildAssetsDir, "app.css")),
    "--minify",
  ], {
    cwd: rootPath,
    stdout: "inherit",
    stderr: "inherit",
  }).exited;

  if (cssResult !== 0) {
    throw new Error("Tailwind build failed");
  }

  await cp(publicDir, buildDir, { recursive: true });
  await copyPierreWorkerAssets(join(buildAssetsDir, "pierre-diffs-worker"));
  await writeIndexHtml(
    buildDir,
    result.outputs.map((output: any) => relative(buildDir, output.path)),
  );

  await publishBuild(buildDir);
  await pruneOldBuilds(buildId);
}

async function copyPierreWorkerAssets(targetDir: string) {
  await mkdir(targetDir, { recursive: true });
  await cp(
    join(pierreWorkerDir, "worker-portable.js"),
    join(targetDir, "worker-portable.js"),
  );

  const files = await readdir(pierreWorkerDir);
  for (const file of files) {
    if (!/^wasm-.*\.js$/.test(file)) continue;
    await cp(join(pierreWorkerDir, file), join(targetDir, file));
  }
}

async function writeIndexHtml(buildDir: string, outputs: string[]) {
  const template = await readFile(templatePath, "utf8");
  const scripts = outputs
    .filter((path) => path.endsWith(".js"))
    .map((path) => `<script type="module" src="/${path.replaceAll("\\\\", "/")}"></script>`)
    .join("\n    ");
  const styles = [
    "/assets/app.css",
    ...outputs.filter((path) => path.endsWith(".css")).map((path) => `/${path.replaceAll("\\\\", "/")}`),
  ]
    .filter((value, index, array) => array.indexOf(value) === index)
    .map((path) => `<link rel="stylesheet" href="${path}" />`)
    .join("\n    ");

  const html = template
    .replace("{{styles}}", styles)
    .replace("{{scripts}}", scripts);

  await writeFile(join(buildDir, "index.html"), html, "utf8");
}

// Atomically point `dist` at the freshly-built directory. Symlink replacement
// via rename(2) is atomic on macOS and Linux, so readers never see a partial
// build: they either resolve through the old symlink or the new one.
async function publishBuild(buildDir: string) {
  // Migrate from the pre-symlink layout: if `dist` exists as a real directory
  // (left over from an older version of this script), remove it so we can
  // replace it with a symlink. Hit at most once per machine.
  const existing = await lstatOrNull(distPath);
  if (existing && !existing.isSymbolicLink()) {
    await rm(distPath, { recursive: true, force: true });
  }

  const tmpLink = `${distPath}.tmp.${process.pid}.${Date.now()}`;
  await symlink(relative(rootPath, buildDir), tmpLink);
  await rename(tmpLink, distPath);
}

async function lstatOrNull(path: string) {
  try {
    return await lstat(path);
  } catch (error: any) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function pruneOldBuilds(currentId: string) {
  let entries: string[];
  try {
    entries = await readdir(buildsRootDir);
  } catch (error: any) {
    if (error?.code === "ENOENT") return;
    throw error;
  }

  for (const entry of entries) {
    if (entry === currentId) continue;
    try {
      await rm(join(buildsRootDir, entry), { recursive: true, force: true });
    } catch (error) {
      console.error(`Failed to prune ${entry}:`, error);
    }
  }
}

async function main() {
  if (!watch) {
    await buildOnce();
    return;
  }

  await buildOnce();
  let building = false;
  let rebuildQueued = false;

  async function rebuild() {
    if (building) {
      rebuildQueued = true;
      return;
    }

    building = true;
    do {
      rebuildQueued = false;
      try {
        await buildOnce();
      } catch (error) {
        console.error(error);
      }
    } while (rebuildQueued);
    building = false;
  }

  const watchers = [
    fsWatch(join(rootPath, "app"), { recursive: true }, rebuild),
    fsWatch(publicDir, { recursive: true }, rebuild),
    fsWatch(templatePath, rebuild),
  ];

  process.on("SIGINT", () => {
    for (const watcher of watchers) {
      watcher.close();
    }
    process.exit(0);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
