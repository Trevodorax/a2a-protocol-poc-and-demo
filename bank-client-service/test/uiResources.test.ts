import type { Part } from "@a2a-js/sdk";
import { describe, expect, it } from "vitest";
import { MCP_APP_MIME_TYPE, uiResourcesOf } from "../src/a2a/uiResources.js";

function filePart(html: string, mediaType: string, metadata: Record<string, unknown>): Part {
  return { content: { $case: "raw", value: Buffer.from(html) }, mediaType, filename: "view.html", metadata };
}

describe("uiResourcesOf", () => {
  it("reads an MCP App view and puts a CSP before its content", () => {
    const view = '<!-- <head> --><!doctype html><html><head><meta charset="utf-8"></head><body>Hi</body></html>';
    const [resource] = uiResourcesOf([
      { content: { $case: "text", value: "summary" }, mediaType: "", filename: "", metadata: undefined },
      filePart(view, MCP_APP_MIME_TYPE, { uri: "ui://agent/view", _meta: { ui: { prefersBorder: true } } }),
    ]);

    expect(resource).toMatchObject({ uri: "ui://agent/view", meta: { prefersBorder: true } });
    expect(resource?.html).toMatch(/^<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none';[^"]*connect-src 'none'/);
    expect(resource?.html.endsWith(view)).toBe(true);
  });

  it("ignores other files and views without a ui:// uri", () => {
    expect(
      uiResourcesOf([
        filePart("<p>x</p>", "text/html", { uri: "ui://agent/view" }),
        filePart("<p>x</p>", MCP_APP_MIME_TYPE, { uri: "https://evil.example/view" }),
        filePart("<p>x</p>", MCP_APP_MIME_TYPE, {}),
      ]),
    ).toEqual([]);
  });
});
