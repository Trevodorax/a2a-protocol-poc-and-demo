import sqlite3
import threading
from datetime import UTC, datetime
from typing import Annotated, Any

from langchain.tools import ToolRuntime, tool
from pydantic import Field

from actions_agent.context import ClientContext
from actions_agent.db import format_eur

WRITE_TOOLS = ("block_card", "transfer_between_own_accounts")


def build_tools(conn: sqlite3.Connection) -> list:
    # Sync tools run in worker threads and share one connection: writes must not interleave.
    write_lock = threading.Lock()

    @tool
    def list_accounts(runtime: ToolRuntime[ClientContext]) -> dict[str, Any]:
        """List the client's accounts (id, type, masked IBAN, balance). Use it to find account ids."""
        return {"accounts": [_account_view(r) for r in _accounts(conn, runtime.context.client_id)]}

    @tool
    def list_cards(runtime: ToolRuntime[ClientContext]) -> dict[str, Any]:
        """List the client's cards (id, last 4 digits, status, linked account). Use it to find card ids."""
        return {"cards": [dict(r) for r in _cards(conn, runtime.context.client_id)]}

    @tool
    def block_card(
        card_id: Annotated[str, Field(description="A card_id returned by list_cards")],
        runtime: ToolRuntime[ClientContext],
    ) -> dict[str, Any]:
        """Permanently block one of the client's cards (lost, stolen, suspected fraud).
        The client is asked to confirm before it runs."""
        with write_lock, conn:
            card = _card(conn, runtime.context.client_id, card_id)
            if card is None:
                return {"status": "error", "reason": "card_not_found"}
            if card["status"] == "blocked":
                return {"status": "error", "reason": "card_already_blocked"}
            conn.execute("UPDATE cards SET status = 'blocked' WHERE id = ?", (card_id,))
        return {"status": "ok", "card_id": card_id, "last4": card["last4"], "new_status": "blocked"}

    @tool
    def transfer_between_own_accounts(
        from_account_id: Annotated[str, Field(description="Account to debit, from list_accounts")],
        to_account_id: Annotated[str, Field(description="Account to credit, from list_accounts")],
        amount_cents: Annotated[
            int, Field(gt=0, description="Amount in euro cents, e.g. 15000 for 150.00 EUR")
        ],
        runtime: ToolRuntime[ClientContext],
    ) -> dict[str, Any]:
        """Transfer money between two accounts of the same client. The client is asked to confirm before it runs."""
        client_id = runtime.context.client_id
        error = transfer_error(conn, client_id, from_account_id, to_account_id, amount_cents)
        if error:
            return {"status": "error", "reason": error}
        now = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
        with write_lock, conn:
            debited = conn.execute(
                "UPDATE accounts SET balance_cents = balance_cents - ? "
                "WHERE id = ? AND client_id = ? AND balance_cents >= ?",
                (amount_cents, from_account_id, client_id, amount_cents),
            ).rowcount
            if not debited:
                return {"status": "error", "reason": "insufficient_funds"}
            conn.execute(
                "UPDATE accounts SET balance_cents = balance_cents + ? WHERE id = ? AND client_id = ?",
                (amount_cents, to_account_id, client_id),
            )
            conn.executemany(
                "INSERT INTO transactions (account_id, amount_cents, label, created_at) VALUES (?, ?, ?, ?)",
                [
                    (from_account_id, -amount_cents, "Internal transfer (sent)", now),
                    (to_account_id, amount_cents, "Internal transfer (received)", now),
                ],
            )
        balances = {r["id"]: format_eur(r["balance_cents"]) for r in _accounts(conn, client_id)}
        return {
            "status": "ok",
            "amount": format_eur(amount_cents),
            "new_balances": {
                from_account_id: balances[from_account_id],
                to_account_id: balances[to_account_id],
            },
        }

    return [list_accounts, list_cards, block_card, transfer_between_own_accounts]


def describe_action(conn: sqlite3.Connection, client_id: str, name: str, args: dict[str, Any]) -> str | None:
    """Human-readable summary of a pending write, built from the database rather than by the model,
    or None when the action can't succeed (so the client is never asked to confirm it)."""
    if name == "block_card":
        card = _card(conn, client_id, args.get("card_id", ""))
        if card is None or card["status"] == "blocked":
            return None
        return f"Block the card ending in {card['last4']}. Blocking is permanent and cannot be undone."
    if name == "transfer_between_own_accounts":
        source, target, amount = (
            args.get("from_account_id"),
            args.get("to_account_id"),
            args.get("amount_cents"),
        )
        if transfer_error(conn, client_id, source, target, amount):
            return None
        accounts = {r["id"]: r for r in _accounts(conn, client_id)}
        return (
            f"Transfer {format_eur(amount)} from the {_account_label(accounts[source])} "
            f"to the {_account_label(accounts[target])}."
        )
    return None


def transfer_error(
    conn: sqlite3.Connection, client_id: str, source: Any, target: Any, amount: Any
) -> str | None:
    accounts = {r["id"]: r for r in _accounts(conn, client_id)}
    if source not in accounts or target not in accounts:
        return "account_not_found"
    if source == target:
        return "same_account"
    if not isinstance(amount, int) or amount <= 0:
        return "invalid_amount"
    if accounts[source]["balance_cents"] < amount:
        return "insufficient_funds"
    return None


def _accounts(conn: sqlite3.Connection, client_id: str) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT id, type, iban, balance_cents FROM accounts WHERE client_id = ? ORDER BY id", (client_id,)
    ).fetchall()


def _cards(conn: sqlite3.Connection, client_id: str) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT c.id AS card_id, c.last4, c.status, c.account_id FROM cards c "
        "JOIN accounts a ON a.id = c.account_id WHERE a.client_id = ? ORDER BY c.id",
        (client_id,),
    ).fetchall()


def _card(conn: sqlite3.Connection, client_id: str, card_id: str) -> sqlite3.Row | None:
    return next((c for c in _cards(conn, client_id) if c["card_id"] == card_id), None)


def _account_view(row: sqlite3.Row) -> dict[str, str]:
    return {
        "account_id": row["id"],
        "type": row["type"],
        "iban": f"**** {row['iban'][-4:]}",
        "balance": format_eur(row["balance_cents"]),
    }


def _account_label(row: sqlite3.Row) -> str:
    return f"{row['type']} account (**** {row['iban'][-4:]})"
