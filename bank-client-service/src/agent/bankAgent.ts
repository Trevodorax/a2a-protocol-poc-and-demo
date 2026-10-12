import { ToolLoopAgent, stepCountIs, type LanguageModel, type ModelMessage } from "ai";
import { z } from "zod";
import { RemoteTaskNotFoundError, type RemoteAgent, type RemoteTaskOutcome } from "../a2a/remoteAgent.js";
import type { UiView } from "../a2a/uiResources.js";
import { AppError, ConflictError, NotFoundError, ServiceUnavailableError } from "../errors.js";
import type { Logger } from "../logger.js";
import type { Conversation, InMemoryConversationStore, PendingConfirmation } from "./conversationStore.js";
import { SYSTEM_PROMPT } from "./systemPrompt.js";
import type { BankTools } from "./tools/index.js";
import type { ActionsToolOutput } from "./tools/remoteAgents.js";

/**
 * Limits, and why each one exists.
 */
const LIMITS = {
  /**
   * Max model calls (steps) for ONE client message.
   * A normal question needs 2: one tool call (knowledge base or a remote agent), then the answer.
   * Some need 3-4 (a search that misses and is retried, or a question that needs both the
   * knowledge base and the client's data). The cap stops a confused model from looping forever,
   * which would cost money and leave the client waiting.
   */
  maxStepsPerTurn: 6,
  /**
   * Max client messages per conversation. Every turn re-sends the whole history, so cost and
   * latency grow with length; a client-service chat rarely needs more than a few turns.
   */
  maxTurnsPerConversation: 30,
  /**
   * Per-call output cap. Answers are short, but reasoning models also spend output tokens on
   * (hidden) reasoning and tool calls, so we leave plenty of room: being cut off mid-answer is
   * worse than a few more tokens.
   */
  maxOutputTokens: 16_000,
  /**
   * Total time allowed for one client message, all steps included. A remote agent call runs a whole
   * LLM loop on the other side, so this is longer than a single model call would need.
   */
  turnTimeoutMs: 120_000,
} as const;

export interface AgentReply {
  conversationId: string;
  answer: string;
  /**
   * - "answered": the agent completed the turn.
   * - "confirmation_required": answered, AND an operation is waiting for the client's decision
   *   (see `confirmation`). The app shows the actions agent's confirmation view (`confirmation.ui`,
   *   an MCP App rendered in a sandboxed iframe) with its Approve/Reject buttons.
   * - "fallback": a safe default message was returned.
   */
  status: "answered" | "confirmation_required" | "fallback";
  confirmation?: { summary: string; ui: UiView };
}

export type ConfirmationDecision = "approve" | "reject";

/** `clientId` comes from the authenticated request (see middleware/clientIdentity.ts), never from the body. */
export type AskInput = { clientId: string } & (
  | { message: string; conversationId?: string | undefined }
  | { conversationId: string; confirmation: { decision: ConfirmationDecision; comment?: string | undefined } }
);

export interface ClientServiceAgent {
  ask(input: AskInput): Promise<AgentReply>;
}

/**
 * Fallback message, used when the model couldn't produce a usable answer.
 *
 * WHY hardcoded and not generated: these are exactly the moments when the model can't be relied
 * on (error, refusal, loop). A fixed, reviewed message is predictable, and it always points
 * the client to a human channel so they are never left stuck.
 */
const FALLBACK_MESSAGE =
  "Je suis désolé, je n'ai pas pu traiter votre demande. Vous pouvez reformuler votre question, ou contacter un conseiller au +33 1 00 00 00 00. En cas de carte perdue ou volée, appelez immédiatement le +33 1 00 00 00 99 (24h/24).\n\n" +
  "I'm sorry, I couldn't process your request. You can rephrase your question, or contact an advisor at +33 1 00 00 00 00. If your card was lost or stolen, call +33 1 00 00 00 99 right away (24/7).";

/**
 * Per-request values for the A2A delegation tools, set by our code (never by the model): who the
 * client is, and which A2A context each remote agent should continue. `prepareCall` turns them into
 * each tool's `context` (see tools/remoteAgents.ts).
 */
const CallOptionsSchema = z.object({
  clientId: z.string(),
  informationsContextId: z.uuid(),
  actionsContextId: z.uuid(),
});
type CallOptions = z.infer<typeof CallOptionsSchema>;
const NIL_UUID = "00000000-0000-0000-0000-000000000000";

function toolsContextFor({ clientId, informationsContextId, actionsContextId }: CallOptions) {
  return {
    ask_informations_agent: { clientId, contextId: informationsContextId },
    ask_actions_agent: { clientId, contextId: actionsContextId },
  };
}

/**
 * Creates the LLM agent: model, instructions, tools and loop settings.
 *
 * WHY the Vercel AI SDK: its agent, tools and message formats are provider-neutral. The model
 * is created in model.ts (the only provider-specific file) and passed in here, so this file
 * doesn't change if the provider does. Changing the model itself is a config change (LLM_MODEL).
 *
 * WHY ToolLoopAgent: it runs the "call model -> run requested tools -> send results -> call
 * again" loop for us, validates tool inputs against their Zod schemas (invalid input goes back
 * to the model as an error it can fix), and sends tool failures back to the model instead of
 * crashing. That loop is also what the A2A delegation tools plug into: to the
 * agent, a remote agent is just another tool.
 *
 * WHY the agent is created once (not per request): its settings are identical for every request,
 * and constant instructions + tools are what keeps the provider's prompt cache warm.
 */
export function createLlmAgent(model: LanguageModel, tools: BankTools) {
  return new ToolLoopAgent({
    model,
    callOptionsSchema: CallOptionsSchema,
    // Required by the types at construction; always replaced by prepareCall with the request's values.
    toolsContext: toolsContextFor({ clientId: "", informationsContextId: NIL_UUID, actionsContextId: NIL_UUID }),
    prepareCall: ({ options, ...settings }) => ({ ...settings, toolsContext: toolsContextFor(options) }),
    /**
     * PROMPT CACHING: OpenAI caches long prompt prefixes automatically, with no request option.
     * That's why the instructions and tools must stay constant (see systemPrompt.ts). Caching only
     * kicks in above a minimum prompt size: check `cacheRead` in the logs to see whether it happens.
     */
    instructions: SYSTEM_PROMPT,
    tools,
    stopWhen: stepCountIs(LIMITS.maxStepsPerTurn),
    maxOutputTokens: LIMITS.maxOutputTokens,
    /**
     * Reasoning effort, in the SDK's provider-neutral form (mapped to each provider's own setting).
     * Answering FAQ-style questions from retrieved articles is a simple task, so "low" keeps
     * answers fast and cheap. Raise it if evaluations show mistakes, especially once the agent has
     * to choose between several specialized agents. Models without reasoning ignore it (the SDK
     * reports a warning, which we log).
     */
    reasoning: "low",
    /** Transient failures (429, 5xx, network) are retried with backoff by the SDK before we see them. */
    maxRetries: 2,
  });
}

type LlmAgent = ReturnType<typeof createLlmAgent>;

export class BankAgent implements ClientServiceAgent {
  constructor(
    private readonly llm: LlmAgent,
    private readonly conversations: InMemoryConversationStore,
    private readonly actionsAgent: RemoteAgent,
    private readonly logger: Logger,
  ) {}

  async ask(input: AskInput): Promise<AgentReply> {
    const isNewConversation = input.conversationId === undefined;
    const conversation = this.loadConversation(input.clientId, input.conversationId);

    // Mark the conversation as busy BEFORE the first await on the model, so a concurrent request
    // on the same conversation is rejected instead of interleaving with this one.
    conversation.busy = true;
    const log = this.logger.child({ conversationId: conversation.id });
    const request = "confirmation" in input ? JSON.stringify(input.confirmation) : JSON.stringify(input.message);
    // `exchange: true` marks the conversation-flow logs (highlighted by scripts/pretty-logs.mjs).
    log.info({ exchange: true }, `Client requested ${request} to bank agent`);
    try {
      const reply =
        "confirmation" in input
          ? await this.runConfirmation(conversation, input.confirmation)
          : await this.runTurn(conversation, input.message);
      log.info({ exchange: true, status: reply.status }, `bank agent answered: ${JSON.stringify(reply.answer)}`);
      return reply;
    } catch (error) {
      // If the very first turn failed, don't leave an empty conversation behind: the client never
      // received its id anyway.
      if (isNewConversation) this.conversations.delete(conversation.id);
      throw error;
    } finally {
      conversation.busy = false;
      conversation.lastActivityAt = Date.now();
    }
  }

  private loadConversation(clientId: string, conversationId: string | undefined): Conversation {
    if (conversationId === undefined) return this.conversations.create(clientId);

    const conversation = this.conversations.get(conversationId);
    // Someone else's conversation looks exactly like a missing one: no hint that the id exists.
    if (!conversation || conversation.clientId !== clientId) {
      throw new NotFoundError("Conversation not found or expired; start a new one");
    }
    if (conversation.busy) throw new ConflictError("A message is already being processed in this conversation");
    if (conversation.turnCount >= LIMITS.maxTurnsPerConversation) {
      throw new AppError(409, "conversation_limit_reached", "This conversation is too long; please start a new one");
    }
    return conversation;
  }

  /**
   * The client clicked Approve or Reject on an operation the actions agent paused.
   *
   * A2A: we answer the paused task itself (same `taskId` and `contextId`) with a `data` part
   * `{ decision }`, plus the client's optional comment as a `text` part. This is the actions agent's
   * confirmation contract: only a structured decision counts as consent, and it is sent by this
   * code from the client's click, never by the model.
   *
   * The outcome is then given to the model as an app-generated note, so it can tell the client what
   * happened, in their language. If the model fails at that point, the client still gets the
   * actions agent's own answer, because the operation may already have happened.
   */
  private async runConfirmation(
    conversation: Conversation,
    { decision, comment }: { decision: ConfirmationDecision; comment?: string | undefined },
  ): Promise<AgentReply> {
    const pending = conversation.pendingConfirmation;
    if (!pending) throw new ConflictError("No operation is waiting for confirmation in this conversation");

    let outcome: RemoteTaskOutcome;
    try {
      outcome = await this.actionsAgent.send({
        clientId: conversation.clientId,
        contextId: conversation.remoteContextIds.actions,
        taskId: pending.taskId,
        data: { decision },
        text: comment,
      });
    } catch (error) {
      if (!(error instanceof RemoteTaskNotFoundError)) {
        // Unknown whether the decision arrived: keep the confirmation so the client can retry.
        // Retrying is safe, since the actions agent rejects a decision for a task that is no longer paused.
        this.logger.error({ err: error, conversationId: conversation.id }, "actions agent call failed");
        throw new ServiceUnavailableError("The service is temporarily unavailable, please try again later");
      }
      outcome = {
        state: "failed",
        taskId: pending.taskId,
        contextId: conversation.remoteContextIds.actions,
        text: "The confirmation expired (the actions service restarted). Nothing was changed; the client can ask again.",
        data: [],
        uiResources: [],
      };
    }
    conversation.pendingConfirmation = undefined;

    const reply = await this.runTurn(conversation, confirmationNote(pending, decision, comment, outcome));
    if (reply.status === "fallback" && outcome.text) return { ...reply, answer: outcome.text };
    return reply;
  }

  private async runTurn(conversation: Conversation, message: string): Promise<AgentReply> {
    const log = this.logger.child({ conversationId: conversation.id, turn: conversation.turnCount });

    // A NEW array: the stored history must not change until we decide to commit (only if the turn
    // succeeds, see below).
    const messages: ModelMessage[] = [...conversation.messages, { role: "user", content: message }];

    let result: Awaited<ReturnType<LlmAgent["generate"]>>;
    try {
      /**
       * WHY not streaming: the REST contract is request -> complete answer, and answers are short.
       * `agent.stream()` would be the next step if we want to show the answer as it is typed.
       */
      result = await this.llm.generate({
        messages,
        timeout: { totalMs: LIMITS.turnTimeoutMs },
        options: {
          clientId: conversation.clientId,
          informationsContextId: conversation.remoteContextIds.informations,
          actionsContextId: conversation.remoteContextIds.actions,
        },
      });
    } catch (error) {
      throw this.toAppError(error, log);
    }

    log.info(
      {
        finishReason: result.finishReason,
        steps: result.steps.length,
        tools: result.steps.flatMap((step) => step.toolCalls.map((call) => call.toolName)),
        model: result.response.modelId,
        usage: {
          input: result.totalUsage.inputTokens,
          output: result.totalUsage.outputTokens,
          cacheRead: result.totalUsage.inputTokenDetails.cacheReadTokens,
          cacheWrite: result.totalUsage.inputTokenDetails.cacheWriteTokens,
        },
      },
      "agent turn finished",
    );
    if (result.warnings?.length) log.warn({ warnings: result.warnings }, "LLM call warnings");

    const answer = result.text.trim();

    /**
     * Only a turn that finished normally ("stop") WITH text is a success. Everything else gets the
     * fallback message, and the conversation is NOT updated, so the next client message starts
     * from the last good state:
     * - "content-filter": the provider's safety system blocked or refused the answer. We don't
     *   keep that turn in history, so it can't affect the next turns.
     * - "tool-calls": we hit maxStepsPerTurn while the model still wanted tools.
     * - "length": the answer was cut off; a truncated banking answer may be misleading.
     * - "error" / "other": unexpected; nothing reliable to show.
     */
    if (result.finishReason !== "stop" || answer === "") {
      log.warn({ finishReason: result.finishReason, rawFinishReason: result.rawFinishReason }, "agent turn did not complete");
      return { conversationId: conversation.id, answer: FALLBACK_MESSAGE, status: "fallback" };
    }

    // Commit: append-only, see conversationStore.ts for why that matters. `responseMessages`
    // holds everything the model produced this turn (tool calls, tool results, reasoning, answer).
    conversation.messages = [...messages, ...result.responseMessages];
    conversation.turnCount += 1;
    // Any new message replaces the previous pending confirmation: only the latest operation the
    // actions agent paused (if any, in this turn) can be confirmed.
    conversation.pendingConfirmation = latestConfirmationRequest(result.steps);

    if (conversation.pendingConfirmation) {
      const { summary, ui } = conversation.pendingConfirmation;
      return {
        conversationId: conversation.id,
        answer,
        status: "confirmation_required",
        confirmation: { summary, ui },
      };
    }
    return { conversationId: conversation.id, answer, status: "answered" };
  }

  /**
   * Maps LLM call failures to HTTP-friendly errors.
   *
   * WHY here and not in the Express error handler: the HTTP layer shouldn't know an LLM is behind
   * the agent.
   *
   * The SDK has already retried transient failures by the time we get here, so an error means the
   * service is really unavailable for now: the client gets a 503 rather than a confusing 500.
   * We only distinguish rate limiting (429) to give a more accurate message. The status is read
   * from the `statusCode` of the SDK's API call errors; after retries the SDK wraps the last one
   * in `lastError`.
   * Anything else (configuration, invalid model id, auth) is logged loudly with the same generic
   * answer: it's our problem, not the client's.
   */
  private toAppError(error: unknown, log: Logger): Error {
    log.error({ err: error }, "LLM call failed");
    const status = statusCodeOf(error);
    return new ServiceUnavailableError(
      status === 429
        ? "The assistant is very busy right now, please try again in a moment"
        : "The assistant is temporarily unavailable, please try again later",
    );
  }
}

/**
 * The last `ask_actions_agent` result of the turn that paused for confirmation. If the model called
 * the actions agent again afterwards in the same turn, that later call superseded it on the actions
 * agent's side, so only the last call counts.
 */
function latestConfirmationRequest(steps: ReadonlyArray<{ toolResults: ReadonlyArray<{ toolName: string; output: unknown }> }>) {
  const actionResults = steps
    .flatMap((step) => step.toolResults)
    .filter((r) => r.toolName === "ask_actions_agent")
    .map((r) => r.output as ActionsToolOutput);
  const last = actionResults.at(-1);
  return last?.status === "confirmation_required"
    ? { taskId: last.taskId, summary: last.summary, ui: last.ui }
    : undefined;
}

/**
 * How the outcome of a confirmation reaches the model: a user-role note generated by this code (the
 * system prompt explains the "[Bank app]" prefix). A client could type the same text, but it would
 * only mislead themselves: the note can't trigger anything, since decisions never come from the model.
 */
function confirmationNote(
  pending: PendingConfirmation,
  decision: ConfirmationDecision,
  comment: string | undefined,
  outcome: RemoteTaskOutcome,
): string {
  return [
    `[Bank app] The client clicked "${decision === "approve" ? "Approve" : "Reject"}" on: "${pending.summary}"`,
    comment ? `Client's comment: "${comment}"` : undefined,
    `Actions agent result (${outcome.state}): ${outcome.text || "no details"}`,
    "Tell the client the outcome.",
  ]
    .filter(Boolean)
    .join("\n");
}

function statusCodeOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  if ("statusCode" in error && typeof error.statusCode === "number") return error.statusCode;
  if ("lastError" in error) return statusCodeOf(error.lastError);
  return undefined;
}
