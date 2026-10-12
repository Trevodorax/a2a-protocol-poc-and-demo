import { randomUUID } from "node:crypto";
import type { ModelMessage } from "ai";
import type { UiView } from "../a2a/uiResources.js";

/**
 * Conversation memory.
 *
 * WHY the server keeps the history instead of the client sending it each time:
 * LLM APIs are stateless, so the full history must be re-sent on every call. If the
 * client app sent it, a malicious client could forge it, e.g. insert fake assistant turns or
 * fake knowledge base results with made-up fees. Keeping it server-side means the model only
 * ever sees history we produced.
 *
 * WHY we store the full messages (tool calls, tool results, reasoning) and not just the
 * question/answer text:
 * - Follow-up questions ("and for withdrawals?") work because the model still sees the articles
 *   it already retrieved, without searching again.
 * - Reasoning models return reasoning content that some providers need back, unchanged, in later
 *   turns to keep their context. Rewriting or summarizing earlier turns would invalidate it, so
 *   the history is APPEND-ONLY: we only ever add messages at the end.
 * - An unchanged prefix is also what makes prompt caching work across turns.
 *
 * WHY the AI SDK's `ModelMessage` format: it is provider-neutral, so the stored history doesn't
 * depend on which model the config selects.
 *
 * WHY in memory: good enough for a prototype. The class has a small interface, so a
 * Redis/database-backed store can replace it later; a conversation is a JSON-serializable object.
 */
export interface Conversation {
  readonly id: string;
  /**
   * The client who started the conversation. Every access checks it, so a conversation can only be
   * continued by its owner (conversation ids alone are not a secret once authentication exists).
   */
  readonly clientId: string;
  messages: ModelMessage[];
  /** Number of completed client turns. */
  turnCount: number;
  /**
   * Set while a turn is being processed. Two concurrent requests on the same conversation would
   * each append to the history independently and corrupt it, so the second one is rejected.
   */
  busy: boolean;
  lastActivityAt: number;
  /**
   * A2A context ids, one per remote agent, generated here and sent with every A2A message (see
   * a2a/remoteAgent.ts). A2A lets the caller choose the context id; choosing it ourselves ties the
   * remote agent's conversation memory to this conversation.
   */
  readonly remoteContextIds: { readonly informations: string; readonly actions: string };
  /**
   * An operation the actions agent paused for confirmation (its A2A task is in `input-required`).
   * Only the client's Approve/Reject buttons resolve it; any new client message drops it, and the
   * actions agent then rejects the paused task as superseded the next time it is called.
   */
  pendingConfirmation: PendingConfirmation | undefined;
}

export interface PendingConfirmation {
  /** The actions agent's A2A task id, to answer on the same task. */
  taskId: string;
  /** Built by the actions agent from its database, shown to the client as is. */
  summary: string;
  /** The actions agent's confirmation view (MCP App), shown to the client by the app. */
  ui: UiView;
}

export interface ConversationStoreOptions {
  /** Idle conversations are dropped after this delay, to bound memory use. */
  idleTtlMs: number;
}

export class InMemoryConversationStore {
  private readonly conversations = new Map<string, Conversation>();

  constructor(private readonly options: ConversationStoreOptions = { idleTtlMs: 30 * 60_000 }) {}

  create(clientId: string): Conversation {
    const conversation: Conversation = {
      // Random UUIDs: conversation ids can't be guessed, which matters while there is no auth.
      id: randomUUID(),
      clientId,
      messages: [],
      turnCount: 0,
      busy: false,
      lastActivityAt: Date.now(),
      remoteContextIds: { informations: randomUUID(), actions: randomUUID() },
      pendingConfirmation: undefined,
    };
    this.conversations.set(conversation.id, conversation);
    return conversation;
  }

  get(id: string): Conversation | undefined {
    this.evictIdle();
    return this.conversations.get(id);
  }

  delete(id: string): void {
    this.conversations.delete(id);
  }

  /**
   * Lazy eviction on access instead of a timer: no background job to start and stop (which
   * also keeps tests simple), and the cost is negligible at this scale.
   */
  private evictIdle(): void {
    const threshold = Date.now() - this.options.idleTtlMs;
    for (const [id, conversation] of this.conversations) {
      if (!conversation.busy && conversation.lastActivityAt < threshold) this.conversations.delete(id);
    }
  }
}
