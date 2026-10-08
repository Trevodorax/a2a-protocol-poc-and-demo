import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";

/**
 * The single place where the LLM provider is chosen.
 *
 * WHY OpenAI is called directly (no gateway): every client question would otherwise transit
 * through a third party, which a bank's compliance has to approve. Calling the provider directly
 * keeps the data path to one vendor.
 *
 * WHY the rest of the agent stays provider-neutral: everything else (ToolLoopAgent, tools,
 * stored messages) uses the Vercel AI SDK's common interfaces and only receives a `LanguageModel`.
 * Switching provider later means installing another `@ai-sdk/*` package and changing this file;
 * the config keys (LLM_MODEL, LLM_API_KEY) don't name a vendor, so they stay as they are.
 *
 * WHY the API key is passed explicitly instead of letting the package read OPENAI_API_KEY:
 * the config is validated at startup (config.ts), so a missing key fails immediately with a clear
 * message, not on the first client question.
 *
 * Note: the default OpenAI model API in the AI SDK is the Responses API, which supports the
 * reasoning effort and tool calling the agent relies on.
 */
export function createLanguageModel({ model, apiKey }: { model: string; apiKey: string }): LanguageModel {
  return createOpenAI({ apiKey })(model);
}
