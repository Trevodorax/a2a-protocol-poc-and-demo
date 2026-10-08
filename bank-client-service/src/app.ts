import { fileURLToPath } from "node:url";
import express, { type Express } from "express";
import type { ClientServiceAgent } from "./agent/bankAgent.js";
import type { Logger } from "./logger.js";
import { demoClientIdentity } from "./middleware/clientIdentity.js";
import { createErrorHandler, notFoundHandler } from "./middleware/errorHandler.js";
import { createChatRouter } from "./routes/chat.routes.js";

export function createApp({
  agent,
  logger,
  clientId,
}: {
  agent: ClientServiceAgent;
  logger: Logger;
  clientId: string;
}): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "16kb" }));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });
  app.use("/api/v1", demoClientIdentity(clientId), createChatRouter(agent));
  app.use(express.static(fileURLToPath(new URL("../public", import.meta.url))));

  app.use(notFoundHandler);
  app.use(createErrorHandler(logger));
  return app;
}
