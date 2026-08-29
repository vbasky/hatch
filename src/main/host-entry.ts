import { createLockedWriter, encodeHostRpcMessage, runHostRpcStdio } from "./host-rpc";
import { createHostRuntime, hostProductName } from "./host-runtime";
import type { HostEmit } from "./host-handlers";

export async function startSidecarHost(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const write = createLockedWriter(process.stdout);
  const emit: HostEmit = (channel, payload) => {
    write(encodeHostRpcMessage({ type: "event", channel, payload }));
  };

  const isPackaged = env.HATCH_PACKAGED === "1";
  const sourceRoot = env.HATCH_HOST_ROOT?.trim() || process.cwd();
  const runtime = await createHostRuntime({
    sourceRoot,
    isPackaged,
    homeDir: env.HOME,
    resourcesPath: env.HATCH_RESOURCES_PATH,
    hostBundle: isPackaged ? "tauri" : "electron",
    productName: hostProductName(env),
    version: env.HATCH_VERSION?.trim() || "0.0.0",
    emit,
    nodeCommand: process.execPath,
    env,
  });

  const shutdown = () => {
    runtime.close();
  };
  process.on("SIGTERM", () => {
    shutdown();
    process.exit(0);
  });
  process.on("SIGINT", () => {
    shutdown();
    process.exit(0);
  });

  try {
    await runHostRpcStdio(runtime.handlers, process.stdin, process.stdout, { emit });
  } finally {
    shutdown();
  }
}

if (!process.env.VITEST) {
  startSidecarHost().catch((error) => {
    console.error("[hatch] sidecar host failed", error);
    process.exitCode = 1;
  });
}
