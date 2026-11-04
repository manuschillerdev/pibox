import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// Erase types using the project's pinned compiler; resolve runtime imports to
// the actual dependency/source modules without requiring a new test runner.
export async function typescriptModuleUrl(path) {
  const url = path instanceof URL ? path : new URL(path, import.meta.url);
  let source = ts.transpileModule(await readFile(url, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  const imports = [...source.matchAll(/\bfrom\s+(['"])([^'"]+)\1/g)];
  for (const match of imports) {
    const specifier = match[2];
    if (specifier.startsWith('node:')) continue;
    let resolved;
    if (specifier.startsWith('.')) {
      const dependency = new URL(specifier, url);
      resolved = existsSync(fileURLToPath(dependency))
        ? dependency.href
        : await typescriptModuleUrl(new URL(specifier.replace(/\.js$/, '.ts'), url));
    } else {
      resolved = import.meta.resolve(specifier);
    }
    source = source.replace(match[0], `from ${JSON.stringify(resolved)}`);
  }
  return 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
}

export async function loadTypeScript(path) {
  return import(await typescriptModuleUrl(path));
}
