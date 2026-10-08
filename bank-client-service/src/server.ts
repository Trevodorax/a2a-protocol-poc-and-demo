import { A2ARemoteAgent } from "./a2a/remoteAgent.js";
import { BankAgent, createLlmAgent } from "./agent/bankAgent.js";
import { InMemoryConversationStore } from "./agent/conversationStore.js";
import { createLanguageModel } from "./agent/model.js";
import { createBankTools } from "./agent/tools/index.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL);

const remote = {
  informations: new A2ARemoteAgent("informations agent", config.INFORMATIONS_AGENT_URL),
  actions: new A2ARemoteAgent("actions agent", config.ACTIONS_AGENT_URL),
};
const model = createLanguageModel({ model: config.LLM_MODEL, apiKey: config.LLM_API_KEY });
const agent = new BankAgent(
  createLlmAgent(model, createBankTools(remote)),
  new InMemoryConversationStore(),
  remote.actions,
  logger,
);

const server = createApp({ agent, logger, clientId: config.DEMO_CLIENT_ID }).listen(config.PORT, () => {
  logger.info(
    {
      port: config.PORT,
      model: config.LLM_MODEL,
      informationsAgent: config.INFORMATIONS_AGENT_URL,
      actionsAgent: config.ACTIONS_AGENT_URL,
    },
    "bank client service listening",
  );
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    logger.info({ signal }, "shutting down");
    server.close(() => process.exit(0));
  });
}
