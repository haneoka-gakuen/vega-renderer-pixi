import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(
  await readFile(resolve(root, "package.json"), "utf8"),
);
const expected = `v${manifest.version}`;
const actual = process.env.RELEASE_TAG;

if (actual !== expected) {
  throw new Error(
    `GitHub release tag ${JSON.stringify(actual)} must equal ${expected}`,
  );
}

console.log(`Verified release tag ${actual}.`);
