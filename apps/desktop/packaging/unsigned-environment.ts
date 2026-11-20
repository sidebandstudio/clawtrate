export function requireUnsignedEnvironment(env: NodeJS.ProcessEnv) {
  if (Object.keys(env).some((key) => /^(?:CSC_|WIN_CSC_|APPLE_)/i.test(key)))
    throw new Error("The unsigned workflow refuses signing or notarization variables.");
}

if (import.meta.main) requireUnsignedEnvironment(process.env);
