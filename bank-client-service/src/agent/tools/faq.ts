import { tool } from "ai";
import { z } from "zod";
import { searchKnowledgeBase } from "../knowledgeBase.js";

/**
 * The agent's only tool: search the bank's written knowledge base.
 *
 * WHY the agent searches instead of having the whole knowledge base in its prompt: see the
 * header of knowledgeBase.ts (the base can grow, the prompt stays stable and cacheable, and
 * every answer can be traced back to the articles retrieved).
 *
 * WHY this tool has no access to any client context: it only reads public, written bank
 * information that is the same for every client. Any question about a specific client's data
 * will be handled by a specialized agent later (see the TODOs in tools/index.ts).
 *
 * WHY the AI SDK's `tool()`: the definition is provider-neutral. The SDK converts the Zod schema
 * to whatever format the selected model's provider expects, and validates the model's arguments
 * against it before `execute` runs (model output is untrusted input). Switching provider later
 * doesn't touch this file.
 */
export const searchKnowledgeBaseTool = tool({
  // Tool descriptions are written for the model: they say what the tool returns AND when to
  // use it. A precise description is what makes the model use the tool at the right time
  // without extra routing instructions in the system prompt.
  description:
    "Search the bank's official knowledge base: fees, rates, transfer delays, opening hours, contact numbers, card and dispute procedures, savings products. " +
    "This is the only reliable source for the bank's policies and prices; use it instead of general knowledge. " +
    "If nothing relevant comes back, try once more with different keywords (French or English) before telling the client you don't have the information.",
  inputSchema: z.object({
    query: z.string().min(2).max(200).describe("A few keywords, e.g. 'international transfer fees'"),
  }),
  execute: async ({ query }) => {
    const articles = searchKnowledgeBase(query);
    // An explicit "no_results" status (rather than an empty list) makes it obvious to the
    // model that it must not improvise an answer.
    if (articles.length === 0) return { status: "no_results", query };
    // Structured output (serialized as JSON for the model): exact numbers and article ids are
    // unambiguous, and the model rephrases them for the client.
    return {
      status: "ok",
      articles: articles.map((a) => ({ id: a.id, title: a.title, content: a.content })),
    };
  },
});
