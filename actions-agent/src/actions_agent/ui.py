"""UI resources sent over A2A, in the format of MCP Apps (and ChatGPT apps).

MCP Apps (https://modelcontextprotocol.io, extension SEP-1865) lets an MCP tool point to an HTML
resource (`ui://...`, mime type `text/html;profile=mcp-app`) that the host renders in a sandboxed
iframe and feeds with the tool's `structuredContent` over a postMessage JSON-RPC bridge. A2A has no
UI concept, but its parts can carry files, so this agent reuses the same format through an A2A
extension:

- The Agent Card advertises `UI_EXTENSION_URI` as a required extension (agent_card.py): callers
  declare it in the `A2A-Extensions` HTTP header, and must render the view.
- Every `input-required` status message carries a file part: the HTML in `raw`,
  `media_type` = `text/html;profile=mcp-app`, and `metadata` = `{"uri": "ui://...", "_meta": {"ui": ...}}`,
  the same fields as an MCP resource.
- The data part of the same message plays the role of the MCP tool result's `structuredContent`:
  the host passes it to the view with `ui/notifications/tool-result`.
- The view answers through the host with `tools/call` on `reply_to_task`, `{decision, comment?}`. The
  host turns it into the usual A2A reply (data part `{decision}` + text part), so consent still comes
  from the client's click and still arrives as structured data.
"""

from functools import cache
from importlib.resources import files

from a2a.helpers import new_raw_part
from a2a.types import Part

UI_EXTENSION_URI = "https://atlas-bank.example/a2a/extensions/mcp-app-ui/v1"
MCP_APP_MIME_TYPE = "text/html;profile=mcp-app"
CONFIRMATION_URI = "ui://actions-agent/confirmation"


def confirmation_ui_part() -> Part:
    part = new_raw_part(
        _html("confirmation.html"), media_type=MCP_APP_MIME_TYPE, filename="confirmation.html"
    )
    # No `csp` domains: the view is self-contained (inline script and styles, no network access).
    part.metadata.update({"uri": CONFIRMATION_URI, "_meta": {"ui": {"prefersBorder": True}}})
    return part


@cache
def _html(name: str) -> bytes:
    return files("actions_agent").joinpath("ui", name).read_bytes()
