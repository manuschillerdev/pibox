import { createRequire } from "node:module";

/** Work around Bun's compiled-executable resolution of packages with a .node main. */
export function prepareMicrosandboxNative(): void {
  if (!process.versions.bun || process.env.NAPI_RS_NATIVE_LIBRARY_PATH) return;
  const suffix = process.platform === "linux"
    ? `linux-${process.arch}-gnu`
    : process.platform === "win32"
      ? `win32-${process.arch}-msvc`
      : `${process.platform}-${process.arch}`;
  const require = createRequire(import.meta.url);
  const nativeRequire = createRequire(require.resolve("microsandbox/native"));
  const binding = nativeRequire.resolve(
    `@superradcompany/microsandbox-${suffix}/microsandbox.${suffix}.node`,
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
