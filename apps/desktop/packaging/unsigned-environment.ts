export function requireUnsignedEnvironment(env: NodeJS.ProcessEnv) {
  const windowsSigningTool =
    /^(?:SIGNTOOL_(?:PATH|TIMEOUT)|USE_SYSTEM_(?:OSSL)?SIGNCODE|ELECTRON_BUILDER_(?:OSSL_SIGNCODE|WINDOWS_KITS)_PATH)$/i;
  if (
    Object.keys(env).some(
      (key) => /^(?:CSC_|WIN_CSC_|APPLE_)/i.test(key) || windowsSigningTool.test(key),
    )
  )
    throw new Error("The unsigned workflow refuses signing or notarization variables.");
}

if (import.meta.main) requireUnsignedEnvironment(process.env);
