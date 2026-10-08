import { Router } from "express";
import { z } from "zod";
import type { ClientServiceAgent } from "../agent/bankAgent.js";

/**
 * Two kinds of body:
 * - a client message: `{ message, conversationId? }`;
 * - the client's click on Approve/Reject for an operation awaiting confirmation:
 *   `{ conversationId, confirmation: { decision, comment? } }`. It is a separate field, not a chat
 *   message, because consent must come from an explicit UI action, never from text the model reads.
 */
const ChatRequestSchema = z.union([
  z.strictObject({
    message: z.string().trim().min(1).max(2000),
    conversationId: z.uuid().optional(),
  }),
  z.strictObject({
    conversationId: z.uuid(),
    confirmation: z.strictObject({
      decision: z.enum(["approve", "reject"]),
      comment: z.string().trim().max(500).optional(),
    }),
  }),
]);

export function createChatRouter(agent: ClientServiceAgent): Router {
  const router = Router();

  router.post("/chat", async (req, res) => {
    const body = ChatRequestSchema.parse(req.body);
    const clientId = z.string().parse(res.locals["clientId"]);
    const reply = await agent.ask({ ...body, clientId });
    res.json(reply);
  });

  return router;
}
