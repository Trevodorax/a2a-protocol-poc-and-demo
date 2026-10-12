import { TaskState, type Task } from "@a2a-js/sdk";
import type { ClientFactory } from "@a2a-js/sdk/client";
import { pino } from "pino";
import { describe, expect, it } from "vitest";
import { A2ARemoteAgent } from "../src/a2a/remoteAgent.js";

function fakeFactory(task: Partial<Task>): ClientFactory {
  const client = { sendMessage: async () => ({ id: "task-1", contextId: "ctx-1", artifacts: [], history: [], ...task }) };
  return { createFromUrl: async () => client } as unknown as ClientFactory;
}

function captureLogger() {
  const lines: string[] = [];
  const logger = pino({ level: "info" }, { write: (line: string) => lines.push(JSON.parse(line).msg) });
  return { logger, lines };
}

describe("A2ARemoteAgent logging", () => {
  it("logs the bank agent's request and the remote agent's answer", async () => {
    const { logger, lines } = captureLogger();
    const agent = new A2ARemoteAgent("actions agent", "http://unused", {
      logger,
      factory: fakeFactory({
        status: {
          state: TaskState.TASK_STATE_INPUT_REQUIRED,
          message: {
            messageId: "m",
            role: 2,
            contextId: "ctx-1",
            taskId: "task-1",
            parts: [{ content: { $case: "text", value: "Block the card ending in 4821." }, metadata: undefined, filename: "", mediaType: "" }],
            metadata: undefined,
            extensions: [],
            referenceTaskIds: [],
          },
          timestamp: undefined,
        },
      }),
    });

    await agent.send({ clientId: "c_001", contextId: "ctx-1", text: "Block card 4821" });
    await agent.send({ clientId: "c_001", contextId: "ctx-1", taskId: "task-1", data: { decision: "approve" }, text: "lost" });

    expect(lines).toEqual([
      'bank agent requested "Block card 4821" to actions agent',
      'actions agent answered (input-required): "Block the card ending in 4821."',
      'bank agent requested {"decision":"approve"} + "lost" to actions agent',
      'actions agent answered (input-required): "Block the card ending in 4821."',
    ]);
  });
});
