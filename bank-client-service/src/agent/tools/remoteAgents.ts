import { tool } from "ai";
import { z } from "zod";
import type { RemoteAgent, RemoteTaskOutcome } from "../../a2a/remoteAgent.js";

/**
 * Delegation tools: each one forwards a request to a remote agent over A2A (see a2a/remoteAgent.ts).
 *
 * WHY a remote agent is "just a tool": the ToolLoopAgent already runs "model asks -> we execute ->
 * model continues". The model decides WHEN to delegate (from the descriptions below) and rephrases
 * the specialist's answer for the client; our code decides WHO the request is about and in which
 * A2A context it runs.
 *
 * WHY `clientId` and `contextId` come from the tool context, not from the input schema: the model
 * only writes a natural-language request. The client's identity and the A2A context are set by our
 * code for each call (`toolsContext` in bankAgent.ts), so a prompt injection can't make the model
 * target another client or another conversation.
 */
const RemoteCallContextSchema = z.object({
  clientId: z.string(),
  contextId: z.uuid(),
});
export type RemoteCallContext = z.infer<typeof RemoteCallContextSchema>;

const RequestSchema = z.object({
  request: z
    .string()
    .min(3)
    .max(1000)
    .describe("A self-contained request in English, e.g. 'List the last 5 transactions of the checking account'"),
});

export function createInformationsAgentTool(agent: RemoteAgent) {
  return tool({
    description:
      "Ask the bank's informations agent about the CURRENT client's own data: accounts, balances, transactions, cards and their status. " +
      "It is read-only and only sees this client's data. Write a self-contained request; it remembers the previous requests of this conversation.",
    inputSchema: RequestSchema,
    contextSchema: RemoteCallContextSchema,
    execute: async ({ request }, { context, abortSignal }) => {
      const outcome = await callRemote(agent, { ...context, text: request }, abortSignal);
      if (outcome.state === "completed") return { status: "ok" as const, answer: outcome.text };
      throw new Error(describeFailure(agent, outcome));
    },
  });
}

/**
 * The actions agent pauses every operation for the client's confirmation (A2A `input-required`).
 *
 * When that happens, this tool returns `confirmation_required` with the remote `taskId`, and
 * bankAgent.ts stores it in the conversation. The client then answers with the app's Approve/Reject
 * buttons, and bankAgent.ts sends that decision to the paused task itself: the model never sends a
 * decision, so it can't approve an operation on the client's behalf.
 *
 * `toModelOutput` removes the `taskId` from what the model sees: it has no use for it.
 */
export function createActionsAgentTool(agent: RemoteAgent) {
  return tool({
    description:
      "Ask the bank's actions agent to perform an operation for the CURRENT client: block one of their cards (lost, stolen, suspected fraud), " +
      "or transfer money between two of their own accounts. Every operation must then be confirmed by the client with the app's buttons; " +
      "if the result is 'confirmation_required', the operation has NOT been done yet.",
    inputSchema: RequestSchema,
    contextSchema: RemoteCallContextSchema,
    execute: async ({ request }, { context, abortSignal }) => {
      const outcome = await callRemote(agent, { ...context, text: request }, abortSignal);
      if (outcome.state === "completed") return { status: "done" as const, answer: outcome.text };
      if (outcome.state === "input-required") {
        return { status: "confirmation_required" as const, taskId: outcome.taskId, summary: outcome.text };
      }
      throw new Error(describeFailure(agent, outcome));
    },
    toModelOutput: ({ output }) =>
      output.status === "confirmation_required"
        ? {
            type: "json",
            value: {
              status: "confirmation_required",
              summary: output.summary,
              note: "Not done yet. The app now shows Approve and Reject buttons to the client. Explain what will happen and ask them to use the buttons.",
            },
          }
        : { type: "json", value: output },
  });
}

export type ActionsToolOutput =
  | { status: "done"; answer: string }
  | { status: "confirmation_required"; taskId: string; summary: string };

/**
 * Network errors and timeouts become a short, generic tool error: the SDK sends it to the model,
 * which can then tell the client to retry or give a phone number instead of failing the whole turn.
 */
async function callRemote(
  agent: RemoteAgent,
  request: RemoteCallContext & { text: string },
  signal: AbortSignal | undefined,
): Promise<RemoteTaskOutcome> {
  try {
    return await agent.send(request, signal);
  } catch {
    throw new Error(`The ${agent.name} is unavailable right now.`);
  }
}

function describeFailure(agent: RemoteAgent, outcome: RemoteTaskOutcome): string {
  return `The ${agent.name} could not handle the request (${outcome.state})${outcome.text ? `: ${outcome.text}` : "."}`;
}
