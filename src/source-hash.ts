import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export function sourceHash(root: string): string {
  const hash = createHash("sha256");
  const visit = (directory: string) => {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) hash.update(path).update(readFileSync(join(root, path)));
    }
  };
  for (const directory of ["src", "public", "tests", "scripts", "skills", "config"]) visit(directory);
  for (const file of ["package.json", "pnpm-lock.yaml", "data/hotpotqa/validation-sample.json"]) hash.update(file).update(readFileSync(join(root, file)));
  return hash.digest("hex");
}

