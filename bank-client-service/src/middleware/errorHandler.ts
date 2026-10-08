import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";
import { AppError } from "../errors.js";
import type { Logger } from "../logger.js";

export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json({ error: { code: "not_found", message: "Route not found" } });
};

export function createErrorHandler(logger: Logger): ErrorRequestHandler {
  return (err: unknown, _req, res, _next) => {
    if (err instanceof ZodError) {
      res.status(400).json({
        error: {
          code: "invalid_request",
          message: "Invalid request body",
          details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        },
      });
      return;
    }
    if (err instanceof AppError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message } });
      return;
    }
    // Malformed JSON body from express.json()
    if (err instanceof SyntaxError && "status" in err && err.status === 400) {
      res.status(400).json({ error: { code: "invalid_json", message: "Malformed JSON body" } });
      return;
    }
    logger.error({ err }, "unhandled error");
    res.status(500).json({ error: { code: "internal_error", message: "An unexpected error occurred" } });
  };
}
