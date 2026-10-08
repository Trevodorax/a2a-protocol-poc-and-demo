import type { LanguageModelV4GenerateResult } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import { pino } from "pino";
import { describe, expect, it, vi } from "vitest";
import type { RemoteAgent, RemoteAgentRequest, RemoteTaskOutcome } from "../src/a2a/remoteAgent.js";
import { BankAgent, createLlmAgent } from "../src/agent/bankAgent.js";
import { InMemoryConversationStore } from "../src/agent/conversationStore.js";
import { createBankTools } from "../src/agent/tools/index.js";
import { ConflictError, NotFoundError, ServiceUnavailableError } from "../src/errors.js";

const CLIENT = "c_001";

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

function textStep(text: string, unified: "stop" | "content-filter" = "stop"): LanguageModelV4GenerateResult {
  return { content: text ? [{ type: "text", text }] : [], finishReason: { unified, raw: unified }, usage, warnings: [] };
}

function toolStep(toolName: string, input: object): LanguageModelV4GenerateResult {
  return {
    content: [{ type: "tool-call", toolCallId: "call_1", toolName, input: JSON.stringify(input) }],
    finishReason: { unified: "tool-calls", raw: "tool_calls" },
    usage,
    warnings: [],
  };
}

function searchStep(query: string): LanguageModelV4GenerateResult {
  return toolStep("search_knowledge_base", { query });
}

function fakeRemote(name: string, reply: (request: RemoteAgentRequest) => Partial<RemoteTaskOutcome>) {
  const send = vi.fn(async (request: RemoteAgentRequest): Promise<RemoteTaskOutcome> => ({
    state: "completed",
    taskId: "task-1",
    contextId: request.contextId,
    text: "",
    data: [],
    ...reply(request),
  }));
  return { name, send } satisfies RemoteAgent;
}

type MockGenerate = NonNullable<NonNullable<ConstructorParameters<typeof MockLanguageModelV4>[0]>["doGenerate"]>;

function makeAgent(
  doGenerate: MockGenerate,
  remote = {
    informations: fakeRemote("informations agent", () => ({ text: "Checking: 1842.50 EUR" })),
    actions: fakeRemote("actions agent", () => ({ state: "input-required", text: "Block the card ending in 4821." })),
  },
) {
  const model = new MockLanguageModelV4({ doGenerate });
  const store = new InMemoryConversationStore();
  const llm = createLlmAgent(model, createBankTools(remote));
  const agent = new BankAgent(llm, store, remote.actions, pino({ level: "silent" }));
  return { agent, store, model, remote };
}

describe("BankAgent", () => {
  it("searches the knowledge base, answers, and stores the turn", async () => {
    const { agent, store, model } = makeAgent([searchStep("opening hours"), textStep("Branches open at 9:00.")]);
    const reply = await agent.ask({ clientId: CLIENT, message: "When do branches open?" });

    expect(reply).toMatchObject({ status: "answered", answer: "Branches open at 9:00." });
    // user, assistant tool call, tool result, assistant answer
    expect(store.get(reply.conversationId)?.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    // The tool result sent back to the model contains the knowledge base article.
    expect(JSON.stringify(model.doGenerateCalls[1]?.prompt)).toContain("kb_contact_hours");
  });

  it("continues an existing conversation with its history", async () => {
    const { agent, model } = makeAgent([textStep("Hello!"), textStep("Sure.")]);
    const { conversationId } = await agent.ask({ clientId: CLIENT, message: "Hi" });
    await agent.ask({ clientId: CLIENT, message: "And on Saturday?", conversationId });

    const roles = model.doGenerateCalls[1]?.prompt.map((m) => m.role);
    expect(roles).toEqual(["system", "user", "assistant", "user"]);
  });

  it("returns a fallback and leaves history untouched when the answer is filtered", async () => {
    const { agent, store } = makeAgent([textStep("", "content-filter")]);
    const reply = await agent.ask({ clientId: CLIENT, message: "Bonjour" });

    expect(reply.status).toBe("fallback");
    expect(reply.answer).toContain("+33 1 00 00 00 00");
    expect(store.get(reply.conversationId)?.messages).toHaveLength(0);
  });

  it("stops looping after the step limit", async () => {
    const { agent } = makeAgent(async () => searchStep("fees"));
    const reply = await agent.ask({ clientId: CLIENT, message: "Fees?" });
    expect(reply.status).toBe("fallback");
  });

  it("maps LLM failures to 503", async () => {
    const { agent } = makeAgent(async () => {
      throw Object.assign(new Error("boom"), { statusCode: 400 });
    });
    await expect(agent.ask({ clientId: CLIENT, message: "Hi" })).rejects.toBeInstanceOf(ServiceUnavailableError);
  });

  it("rejects unknown conversations", async () => {
    const { agent } = makeAgent([textStep("Hello")]);
    await expect(agent.ask({ clientId: CLIENT, message: "Hi", conversationId: crypto.randomUUID() })).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("BankAgent A2A delegation", () => {
  it("asks the informations agent with the client id and the conversation's A2A context", async () => {
    const { agent, store, remote } = makeAgent([
      toolStep("ask_informations_agent", { request: "Balance of all accounts" }),
      textStep("Votre solde est de 1842,50 EUR."),
    ]);
    const reply = await agent.ask({ clientId: CLIENT, message: "Quel est mon solde ?" });

    expect(reply).toMatchObject({ status: "answered", answer: "Votre solde est de 1842,50 EUR." });
    const conversation = store.get(reply.conversationId);
    expect(remote.informations.send).toHaveBeenCalledWith(
      { clientId: CLIENT, contextId: conversation?.remoteContextIds.informations, text: "Balance of all accounts" },
      expect.anything(),
    );
  });

  it("sends a remote agent failure to the model as a tool error", async () => {
    const { agent, model } = makeAgent(
      [toolStep("ask_informations_agent", { request: "Balance" }), textStep("Service unavailable, sorry.")],
      {
        informations: fakeRemote("informations agent", () => {
          throw new Error("ECONNREFUSED");
        }),
        actions: fakeRemote("actions agent", () => ({})),
      },
    );
    const reply = await agent.ask({ clientId: CLIENT, message: "Balance?" });

    expect(reply.status).toBe("answered");
    expect(JSON.stringify(model.doGenerateCalls[1]?.prompt)).toContain("The informations agent is unavailable right now.");
  });

  it("returns confirmation_required when the actions agent pauses, without showing the task id to the model", async () => {
    const { agent, store, model } = makeAgent([
      toolStep("ask_actions_agent", { request: "Block card ending 4821" }),
      textStep("Please confirm with the buttons."),
    ]);
    const reply = await agent.ask({ clientId: CLIENT, message: "Bloquez ma carte 4821" });

    expect(reply).toMatchObject({ status: "confirmation_required", confirmation: { summary: "Block the card ending in 4821." } });
    expect(store.get(reply.conversationId)?.pendingConfirmation).toEqual({ taskId: "task-1", summary: "Block the card ending in 4821." });
    const toolResultSentToModel = JSON.stringify(model.doGenerateCalls[1]?.prompt);
    expect(toolResultSentToModel).toContain("confirmation_required");
    expect(toolResultSentToModel).not.toContain("task-1");
  });

  it("sends the client's decision to the paused A2A task, then reports the outcome", async () => {
    const actions = fakeRemote("actions agent", (request) =>
      request.taskId
        ? { state: "completed", text: "Card 4821 is now blocked." }
        : { state: "input-required", text: "Block the card ending in 4821." },
    );
    const { agent, store, model } = makeAgent(
      [toolStep("ask_actions_agent", { request: "Block card 4821" }), textStep("Please confirm."), textStep("Votre carte est bloquée.")],
      { informations: fakeRemote("informations agent", () => ({})), actions },
    );
    const { conversationId } = await agent.ask({ clientId: CLIENT, message: "Bloquez ma carte 4821" });
    const reply = await agent.ask({ clientId: CLIENT, conversationId, confirmation: { decision: "approve", comment: "vite" } });

    expect(reply).toMatchObject({ status: "answered", answer: "Votre carte est bloquée." });
    expect(actions.send).toHaveBeenLastCalledWith({
      clientId: CLIENT,
      contextId: store.get(conversationId)?.remoteContextIds.actions,
      taskId: "task-1",
      data: { decision: "approve" },
      text: "vite",
    });
    expect(store.get(conversationId)?.pendingConfirmation).toBeUndefined();
    const note = JSON.stringify(model.doGenerateCalls.at(-1)?.prompt);
    expect(note).toContain('[Bank app] The client clicked \\"Approve\\"');
    expect(note).toContain("Card 4821 is now blocked.");
  });

  it("rejects a confirmation when nothing is pending", async () => {
    const { agent } = makeAgent([textStep("Hello")]);
    const { conversationId } = await agent.ask({ clientId: CLIENT, message: "Hi" });

    await expect(agent.ask({ clientId: CLIENT, conversationId, confirmation: { decision: "approve" } })).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it("drops a pending confirmation when the client sends a new message", async () => {
    const { agent, store } = makeAgent([
      toolStep("ask_actions_agent", { request: "Block card 4821" }),
      textStep("Please confirm."),
      textStep("Sure, here are the fees."),
    ]);
    const { conversationId } = await agent.ask({ clientId: CLIENT, message: "Block my card 4821" });
    await agent.ask({ clientId: CLIENT, conversationId, message: "Actually, what are the card fees?" });

    expect(store.get(conversationId)?.pendingConfirmation).toBeUndefined();
  });

  it("does not let another client continue a conversation", async () => {
    const { agent } = makeAgent([textStep("Hello")]);
    const { conversationId } = await agent.ask({ clientId: CLIENT, message: "Hi" });

    await expect(agent.ask({ clientId: "c_002", conversationId, message: "Hi" })).rejects.toBeInstanceOf(NotFoundError);
  });
});
