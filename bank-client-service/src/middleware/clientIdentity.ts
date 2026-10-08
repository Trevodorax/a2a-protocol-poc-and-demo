import type { RequestHandler } from "express";

/**
 * Identifies the client making the request and stores it in `res.locals.clientId`.
 *
 * TODO(auth): this is a stand-in. Every request is treated as coming from the same demo client
 * (DEMO_CLIENT_ID). Replace it with a middleware that verifies a token (e.g. a JWT from the bank's
 * identity provider) and reads the client id from it. Nothing else has to change: the id is only
 * ever read from `res.locals`, and from there it goes to the A2A requests as `metadata.client_id`.
 */
export function demoClientIdentity(clientId: string): RequestHandler {
  return (_req, res, next) => {
    res.locals["clientId"] = clientId;
    next();
  };
}
