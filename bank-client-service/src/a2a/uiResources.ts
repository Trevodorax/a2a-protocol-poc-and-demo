import type { Part } from "@a2a-js/sdk";

/**
 * MCP Apps views carried over A2A (the actions agent's UI extension, see actions-agent/src/actions_agent/ui.py).
 *
 * A remote agent may attach an HTML view to a message, in the format MCP Apps (and ChatGPT apps) use
 * for tool UIs: a file part with media type `text/html;profile=mcp-app`, `metadata.uri` = `ui://...`
 * and `metadata._meta.ui` (border, CSP domains...). The browser renders it in a sandboxed iframe and
 * feeds it the message's `data` part as the tool result's `structuredContent` (public/index.html).
 *
 * We only receive views from agents we requested the extension from (the `A2A-Extensions` header,
 * see A2ARemoteAgent). The HTML is still treated as untrusted: it is rendered without
 * `allow-same-origin` (so it can't touch the bank app's page, cookies or API), and with a CSP that
 * blocks all network access. Domains declared in `_meta.ui.csp` are ignored: none are allowed here.
 */
export const UI_RESOURCE_EXTENSION = "https://atlas-bank.example/a2a/extensions/mcp-app-ui/v1";
export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";

const MAX_HTML_BYTES = 256 * 1024;

/** MCP Apps' default CSP, without 'self' (an iframe srcdoc would inherit the bank app's origin). */
const VIEW_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; form-action 'none'";

export interface UiResource {
  /** `ui://...`: identifies the view (a host could cache it by this URI). */
  uri: string;
  /** The view, CSP already injected. */
  html: string;
  /** MCP's `_meta.ui` (e.g. `prefersBorder`). */
  meta: Record<string, unknown>;
}

/** A view and the data it renders, as sent to the browser. */
export interface UiView {
  resource: UiResource;
  structuredContent: unknown;
}

/** The MCP App views among a message's parts. Other files, and oversized or unnamed views, are ignored. */
export function uiResourcesOf(parts: Part[]): UiResource[] {
  return parts.flatMap((p) => {
    if (p.content?.$case !== "raw" || p.mediaType !== MCP_APP_MIME_TYPE) return [];
    const uri: unknown = p.metadata?.["uri"];
    if (typeof uri !== "string" || !uri.startsWith("ui://") || p.content.value.byteLength > MAX_HTML_BYTES) return [];
    const meta: unknown = p.metadata?.["_meta"];
    const ui = typeof meta === "object" && meta !== null && "ui" in meta ? meta.ui : undefined;
    return [
      {
        uri,
        html: withCsp(Buffer.from(p.content.value).toString("utf8")),
        meta: typeof ui === "object" && ui !== null ? (ui as Record<string, unknown>) : {},
      },
    ];
  });
}

/**
 * Puts the CSP before anything the view contains, so no markup in the view (a fake `<head>` in a
 * comment...) can move it out of the head. The parser ignores the view's own doctype, and merges its
 * `<html>` / `<head>` into the implicit ones. A page can't loosen a CSP set this way: a second policy
 * only adds restrictions.
 */
function withCsp(html: string): string {
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${VIEW_CSP}">${html}`;
}
