import type { RemoteAgent } from "../../a2a/remoteAgent.js";
import { searchKnowledgeBaseTool } from "./faq.js";
import { createActionsAgentTool, createInformationsAgentTool } from "./remoteAgents.js";

export interface RemoteAgents {
  informations: RemoteAgent;
  actions: RemoteAgent;
}

/**
 * The agent's tool set.
 *
 * - search_knowledge_base: general bank information (fees, procedures, contacts), local.
 * - ask_informations_agent: the client's own data, delegated over A2A to the informations agent.
 * - ask_actions_agent: card blocking and internal transfers, delegated over A2A to the actions agent.
 *
 * WHY an object keyed by tool name: that's the AI SDK's format; the key is the name the model
 * sees and calls.
 *
 * WHY the tool set is built once, at startup: tool definitions are part of the prompt prefix that
 * providers cache (tools -> system -> messages). Per-request data (client id, A2A context ids)
 * goes through `toolsContext`, not into the definitions.
 */
export function createBankTools(remote: RemoteAgents) {
  return {
    search_knowledge_base: searchKnowledgeBaseTool,
    ask_informations_agent: createInformationsAgentTool(remote.informations),
    ask_actions_agent: createActionsAgentTool(remote.actions),
  };
}

export type BankTools = ReturnType<typeof createBankTools>;
