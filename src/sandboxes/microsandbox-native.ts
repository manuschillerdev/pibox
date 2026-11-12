import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/** Work around Bun's compiled-executable resolution of packages with a .node main. */
export function prepareMicrosandboxNative(): void {
  const suffix = process.platform === "linux"
    ? `linux-${process.arch}-gnu`
    : process.platform === "win32"
      ? `win32-${process.arch}-msvc`
      : `${process.platform}-${process.arch}`;
  const require = createRequire(import.meta.url);
  const packageName = `@superradcompany/microsandbox-${suffix}`;
  const packageRoot = dirname(require.resolve(`${packageName}/package.json`));
  const nativeRequire = createRequire(require.resolve("microsandbox/native"));

  if (process.versions.bun && !process.env.NAPI_RS_NATIVE_LIBRARY_PATH) {
    const binding = nativeRequire.resolve(
      `${packageName}/microsandbox.${suffix}.node`,
    );
    // Load the normal upstream wrapper synchronously, with an explicit binding path.
    // Its module cache then serves subsequent SDK imports. Do not leave a global
    // NAPI-RS override behind: other native libraries use the same variable.
    process.env.NAPI_RS_NATIVE_LIBRARY_PATH = binding;
    try {
      nativeRequire("microsandbox/native");
    } finally {
      delete process.env.NAPI_RS_NATIVE_LIBRARY_PATH;
    }
  }

  const native = nativeRequire("microsandbox/native") as {
    setRuntimeMsbPath(path: string): void;
    setRuntimeLibkrunfwPath(path: string): void;
  };
  native.setRuntimeMsbPath(join(packageRoot, "bin", process.platform === "win32" ? "msb.exe" : "msb"));
  native.setRuntimeLibkrunfwPath(join(packageRoot, "lib", firmwareName()));
}

function firmwareName(): string {
  if (process.platform === "darwin") return "libkrunfw.5.dylib";
  if (process.platform === "win32") return "libkrunfw.dll";
  return "libkrunfw.so.5.6.1";
}
