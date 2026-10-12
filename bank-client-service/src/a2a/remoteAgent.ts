import { randomUUID } from "node:crypto";
import { Role, TaskState, type Message, type Part, type Task } from "@a2a-js/sdk";
import { ClientFactory, ServiceParameters, withA2AExtensions, type Client } from "@a2a-js/sdk/client";
import { TaskNotFoundError } from "@a2a-js/sdk/errors";
import type { Logger } from "../logger.js";
import { uiResourcesOf, type UiResource } from "./uiResources.js";

/**
 * A2A client for ONE remote agent (the informations agent or the actions agent).
 *
 * A2A IN ONE PARAGRAPH
 * A2A (Agent2Agent, https://a2a-protocol.org) is an open protocol for one agent to delegate work to
 * another over HTTP. The remote agent publishes an **Agent Card** (`/.well-known/agent-card.json`)
 * describing its skills and endpoint. The caller sends a **Message** (`parts`: text and/or JSON
 * `data`, plus free `metadata`) with the `SendMessage` method. The remote agent answers with a
 * **Task**: an id, a `contextId`, a **status** (`completed`, `failed`, `rejected`, `canceled`, or
 * an interrupted state such as `input-required`), and **artifacts** (the results).
 *
 * WHAT THIS CLASS DOES
 * - Discovery: on first use, `ClientFactory.createFromUrl(baseUrl)` fetches the Agent Card and picks
 *   the transport it advertises (`supportedInterfaces`: here JSON-RPC, protocol version 1.0). The
 *   client is created lazily, so this service starts even if a remote agent isn't up yet, and the
 *   card is fetched again after a failure (e.g. the agent was down and is now started).
 * - Transport: the SDK's JSON-RPC transport POSTs to the URL from the card and sends the
 *   `A2A-Version: 1.0` header (the Python agents refuse requests without it).
 * - Blocking calls: the default client config waits until the task reaches a terminal or an
 *   interrupted state, so `sendMessage()` resolves with the final Task. No streaming and no push
 *   notifications: our agents answer in seconds and their cards don't advertise either.
 * - Extensions: the URIs given to the constructor are sent in the `A2A-Extensions` header of every
 *   request, to opt in to optional features advertised in the Agent Card (here, the actions agent's
 *   MCP Apps views, see uiResources.ts).
 * - Logging: every request and every answer is logged ("bank agent requested ... to X" / "X answered ..."),
 *   with the A2A context and task ids, to follow a conversation across agents.
 * - Normalization: the Task is turned into a small `RemoteTaskOutcome` (state + text + data + UI
 *   views), so the rest of the code doesn't depend on A2A's protobuf-shaped types.
 *
 * CONTRACT WITH OUR PYTHON AGENTS (see their READMEs)
 * - `metadata.client_id` on every message: whose data the remote agent may read or change. It comes
 *   from our authenticated session (never from the LLM). Our agents reject a message without it.
 * - `contextId`: we generate it ourselves, once per conversation and per remote agent, and send it
 *   on every message. A2A lets the caller choose it, and doing so means the remote agent's
 *   conversation memory follows our conversation, with nothing to learn back from responses.
 * - `taskId`: only sent to answer a task that is waiting for input (`input-required`), i.e. the
 *   actions agent's confirmation. A message without `taskId` starts a new task.
 * - Results: the answer is the text of the task's artifacts. In other states, the status message
 *   explains (the confirmation summary, or why the task was rejected / failed).
 */

export type RemoteTaskState = "completed" | "input-required" | "rejected" | "failed" | "canceled" | "unknown";

export interface RemoteTaskOutcome {
  state: RemoteTaskState;
  taskId: string;
  contextId: string;
  /** Artifact text when completed; status message text otherwise. */
  text: string;
  /** JSON `data` parts of the status message (e.g. the actions agent's `confirmation_request`). */
  data: unknown[];
  /** MCP App views attached to the status message (only with the UI extension). */
  uiResources: UiResource[];
}

export interface RemoteAgentRequest {
  /** From our authenticated session. Sent as `metadata.client_id`. */
  clientId: string;
  /** Our conversation's context with this agent. */
  contextId: string;
  /** Set only to answer a task in `input-required`. */
  taskId?: string | undefined;
  text?: string | undefined;
  /** Sent as a `data` part, e.g. `{ decision: "approve" }`. */
  data?: Record<string, unknown> | undefined;
}

/** The remote agent no longer knows the task: it restarted, or the task never existed. */
export class RemoteTaskNotFoundError extends Error {
  constructor(agentName: string) {
    super(`The ${agentName} no longer knows this task`);
    this.name = "RemoteTaskNotFoundError";
  }
}

export interface RemoteAgent {
  readonly name: string;
  send(request: RemoteAgentRequest, signal?: AbortSignal): Promise<RemoteTaskOutcome>;
}

export interface A2ARemoteAgentOptions {
  /** A2A extension URIs to request, sent in the `A2A-Extensions` header. */
  extensions?: string[];
  /** Per-call cap. A remote agent runs its own LLM loop (up to 90 s on our Python agents). */
  timeoutMs?: number;
  factory?: ClientFactory;
  logger?: Logger;
}

export class A2ARemoteAgent implements RemoteAgent {
  private client: Promise<Client> | undefined;
  private readonly extensions: string[];
  private readonly timeoutMs: number;
  private readonly factory: ClientFactory;
  private readonly logger: Logger | undefined;

  constructor(
    readonly name: string,
    private readonly baseUrl: string,
    { extensions = [], timeoutMs = 100_000, factory = new ClientFactory(), logger }: A2ARemoteAgentOptions = {},
  ) {
    this.extensions = extensions;
    this.timeoutMs = timeoutMs;
    this.factory = factory;
    this.logger = logger;
  }

  async send(request: RemoteAgentRequest, signal?: AbortSignal): Promise<RemoteTaskOutcome> {
    // `exchange: true` marks the conversation-flow logs (highlighted by scripts/pretty-logs.mjs).
    const ids = { exchange: true, contextId: request.contextId, taskId: request.taskId };
    this.logger?.info(ids, `bank agent requested ${describeRequest(request)} to ${this.name}`);
    const outcome = await this.call(request, signal);
    this.logger?.info(
      { ...ids, taskId: outcome.taskId, state: outcome.state },
      `${this.name} answered${outcome.state === "completed" ? "" : ` (${outcome.state})`}: ${JSON.stringify(outcome.text)}`,
    );
    return outcome;
  }

  private async call(request: RemoteAgentRequest, signal: AbortSignal | undefined): Promise<RemoteTaskOutcome> {
    const client = await this.getClient();
    const timeout = AbortSignal.timeout(this.timeoutMs);

    let result: Message | Task;
    try {
      result = await client.sendMessage(
        {
          tenant: "",
          message: toMessage(request),
          // Defaults: blocking call, no push notification, full history (unused by us).
          configuration: undefined,
          metadata: undefined,
        },
        {
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
          ...(this.extensions.length && {
            serviceParameters: ServiceParameters.create(withA2AExtensions(...this.extensions)),
          }),
        },
      );
    } catch (error) {
      if (error instanceof TaskNotFoundError) throw new RemoteTaskNotFoundError(this.name);
      throw error;
    }

    // A2A allows an agent to answer with a bare Message instead of a Task (for trivial,
    // stateless replies). Our agents always create a Task, but we accept both.
    if (!("status" in result)) {
      return { state: "completed", taskId: "", contextId: result.contextId, text: textOf(result.parts), data: [], uiResources: [] };
    }
    return toOutcome(result);
  }

  private getClient(): Promise<Client> {
    this.client ??= this.factory.createFromUrl(this.baseUrl).catch((error: unknown) => {
      this.client = undefined;
      throw error;
    });
    return this.client;
  }
}

/** `"text"`, `{"decision":"approve"}`, or both joined with "+". */
function describeRequest({ text, data }: RemoteAgentRequest): string {
  return [data && JSON.stringify(data), text && JSON.stringify(text)].filter(Boolean).join(" + ");
}

function toMessage({ clientId, contextId, taskId, text, data }: RemoteAgentRequest): Message {
  const parts: Part[] = [];
  if (data) parts.push(part({ $case: "data", value: data }));
  if (text) parts.push(part({ $case: "text", value: text }));
  return {
    messageId: randomUUID(),
    role: Role.ROLE_USER,
    contextId,
    taskId: taskId ?? "",
    parts,
    metadata: { client_id: clientId },
    extensions: [],
    referenceTaskIds: [],
  };
}

function part(content: NonNullable<Part["content"]>): Part {
  return { content, metadata: undefined, filename: "", mediaType: "" };
}

function toOutcome(task: Task): RemoteTaskOutcome {
  const state = STATES[task.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED] ?? "unknown";
  const statusParts = task.status?.message?.parts ?? [];
  const artifactText = task.artifacts.map((a) => textOf(a.parts)).filter(Boolean).join("\n");
  return {
    state,
    taskId: task.id,
    contextId: task.contextId,
    text: state === "completed" ? artifactText : textOf(statusParts),
    data: statusParts.flatMap((p) => (p.content?.$case === "data" ? [p.content.value] : [])),
    uiResources: uiResourcesOf(statusParts),
  };
}

function textOf(parts: Part[]): string {
  return parts
    .flatMap((p) => (p.content?.$case === "text" ? [p.content.value] : []))
    .join("\n")
    .trim();
}

/**
 * `submitted` / `working` never come back from a blocking call; `auth-required` isn't used by our
 * agents. They all map to "unknown", which callers treat as a failure.
 */
const STATES: Partial<Record<TaskState, RemoteTaskState>> = {
  [TaskState.TASK_STATE_COMPLETED]: "completed",
  [TaskState.TASK_STATE_INPUT_REQUIRED]: "input-required",
  [TaskState.TASK_STATE_REJECTED]: "rejected",
  [TaskState.TASK_STATE_FAILED]: "failed",
  [TaskState.TASK_STATE_CANCELED]: "canceled",
};
