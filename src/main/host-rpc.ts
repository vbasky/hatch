import readline from "node:readline";
import type { HostEmit, HostHandlers } from "./host-handlers";

export type HostRpcRequest = {
  id: string;
  type: "request";
  channel: string;
  args: unknown[];
};

export type HostRpcResponse = {
  id: string;
  type: "response";
  ok: boolean;
  result?: unknown;
  error?: string;
};

export type HostRpcEvent = {
  type: "event";
  channel: string;
  payload: unknown;
};

export type HostRpcMessage = HostRpcRequest | HostRpcResponse | HostRpcEvent;

export function encodeHostRpcMessage(message: HostRpcMessage): string {
  return `${JSON.stringify(message)}\n`;
}

export function decodeHostRpcLine(line: string): HostRpcMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error("Invalid host RPC line");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("Invalid host RPC line");
  const message = parsed as Partial<HostRpcMessage>;
  if (message.type === "request") {
    if (typeof message.id !== "string" || typeof message.channel !== "string" || !Array.isArray(message.args)) {
      throw new Error("Invalid host RPC request");
    }
    return message as HostRpcRequest;
  }
  if (message.type === "response") {
    if (typeof message.id !== "string" || typeof message.ok !== "boolean") {
      throw new Error("Invalid host RPC response");
    }
    return message as HostRpcResponse;
  }
  if (message.type === "event") {
    if (typeof message.channel !== "string") throw new Error("Invalid host RPC event");
    return message as HostRpcEvent;
  }
  throw new Error("Invalid host RPC line");
}

export async function dispatchHostRpcRequest(
  handlers: HostHandlers,
  request: HostRpcRequest,
  emit: HostEmit,
): Promise<HostRpcResponse> {
  try {
    const result = await handlers.invoke(request.channel, request.args, emit);
    return { id: request.id, type: "response", ok: true, result };
  } catch (error) {
    return {
      id: request.id,
      type: "response",
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function createLockedWriter(output: { write(chunk: string): void }): (chunk: string) => void {
  let chain = Promise.resolve();
  return (chunk: string) => {
    chain = chain.then(() => {
      output.write(chunk);
    }, () => {
      output.write(chunk);
    });
  };
}

export async function runHostRpcStdio(
  handlers: HostHandlers,
  input: NodeJS.ReadableStream,
  output: { write(chunk: string): void },
  options: { emit?: HostEmit } = {},
): Promise<void> {
  const write = createLockedWriter(output);
  const emit: HostEmit = options.emit ?? ((channel, payload) => {
    write(encodeHostRpcMessage({ type: "event", channel, payload }));
  });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  const inFlight: Promise<void>[] = [];
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let message: HostRpcMessage;
    try {
      message = decodeHostRpcLine(trimmed);
    } catch (error) {
      write(
        encodeHostRpcMessage({
          id: "",
          type: "response",
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      continue;
    }
    if (message.type !== "request") continue;
    inFlight.push(
      dispatchHostRpcRequest(handlers, message, emit).then((response) => {
        write(encodeHostRpcMessage(response));
      }),
    );
  }
  await Promise.all(inFlight);
}
