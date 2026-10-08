import { pino } from "pino";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { ClientServiceAgent } from "../src/agent/bankAgent.js";
import { createApp } from "../src/app.js";
import { NotFoundError } from "../src/errors.js";

const logger = pino({ level: "silent" });

describe("POST /api/v1/chat", () => {
  it("returns the agent reply", async () => {
    const reply = { conversationId: "c1", answer: "Hello", status: "answered" as const };
    const agent: ClientServiceAgent = { ask: vi.fn().mockResolvedValue(reply) };

    const res = await request(createApp({ agent, logger, clientId: "c_001" })).post("/api/v1/chat").send({ message: "Hi" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(reply);
  });

  it("passes the authenticated client id to the agent", async () => {
    const agent: ClientServiceAgent = { ask: vi.fn().mockResolvedValue({}) };
    await request(createApp({ agent, logger, clientId: "c_001" })).post("/api/v1/chat").send({ message: "Hi" });

    expect(agent.ask).toHaveBeenCalledWith({ message: "Hi", clientId: "c_001" });
  });

  it("accepts a confirmation decision", async () => {
    const agent: ClientServiceAgent = { ask: vi.fn().mockResolvedValue({}) };
    const conversationId = crypto.randomUUID();
    const res = await request(createApp({ agent, logger, clientId: "c_001" }))
      .post("/api/v1/chat")
      .send({ conversationId, confirmation: { decision: "reject", comment: "I found it" } });

    expect(res.status).toBe(200);
    expect(agent.ask).toHaveBeenCalledWith({
      conversationId,
      confirmation: { decision: "reject", comment: "I found it" },
      clientId: "c_001",
    });
  });

  it("refuses a client id in the body", async () => {
    const agent: ClientServiceAgent = { ask: vi.fn() };
    const res = await request(createApp({ agent, logger, clientId: "c_001" }))
      .post("/api/v1/chat")
      .send({ message: "Hi", clientId: "c_002" });

    expect(res.status).toBe(400);
  });

  it("validates the body", async () => {
    const agent: ClientServiceAgent = { ask: vi.fn() };
    const res = await request(createApp({ agent, logger, clientId: "c_001" })).post("/api/v1/chat").send({ message: "" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_request");
    expect(agent.ask).not.toHaveBeenCalled();
  });

  it("maps app errors to their status", async () => {
    const agent: ClientServiceAgent = { ask: vi.fn().mockRejectedValue(new NotFoundError("Conversation not found")) };
    const res = await request(createApp({ agent, logger, clientId: "c_001" })).post("/api/v1/chat").send({ message: "Hi" });

    expect(res.status).toBe(404);
  });
});

describe("GET /", () => {
  it("serves the chat UI", async () => {
    const agent: ClientServiceAgent = { ask: vi.fn() };
    const res = await request(createApp({ agent, logger, clientId: "c_001" })).get("/");

    expect(res.status).toBe(200);
    expect(res.text).toContain('id="composer"');
  });
});
