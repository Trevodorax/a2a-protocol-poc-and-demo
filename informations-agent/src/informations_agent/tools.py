import sqlite3
from typing import Annotated, Any

from langchain.tools import ToolRuntime, tool
from pydantic import Field

from informations_agent.context import ClientContext
from informations_agent.db import format_eur


def build_tools(conn: sqlite3.Connection) -> list:
    @tool
    def list_accounts(runtime: ToolRuntime[ClientContext]) -> dict[str, Any]:
        """List the client's bank accounts with their type, masked IBAN and current balance."""
        rows = conn.execute(
            "SELECT id, type, iban, balance_cents FROM accounts WHERE client_id = ? ORDER BY id",
            (runtime.context.client_id,),
        ).fetchall()
        return {
            "accounts": [
                {
                    "account_id": r["id"],
                    "type": r["type"],
                    "iban": f"**** {r['iban'][-4:]}",
                    "balance": format_eur(r["balance_cents"]),
                }
                for r in rows
            ]
        }

    @tool
    def list_transactions(
        account_id: Annotated[str, Field(description="An account_id returned by list_accounts")],
        runtime: ToolRuntime[ClientContext],
        limit: Annotated[int, Field(ge=1, le=50)] = 10,
    ) -> dict[str, Any]:
        """List the latest transactions of one of the client's accounts, newest first.
        Negative amounts are debits."""
        rows = conn.execute(
            """
            SELECT t.amount_cents, t.label, t.created_at
            FROM transactions t JOIN accounts a ON a.id = t.account_id
            WHERE t.account_id = ? AND a.client_id = ?
            ORDER BY t.created_at DESC, t.id DESC
            LIMIT ?
            """,
            (account_id, runtime.context.client_id, limit),
        ).fetchall()
        if not rows and not _owns_account(conn, runtime.context.client_id, account_id):
            return {"status": "not_found", "account_id": account_id}
        return {
            "status": "ok",
            "transactions": [
                {"date": r["created_at"], "label": r["label"], "amount": format_eur(r["amount_cents"])}
                for r in rows
            ],
        }

    @tool
    def list_cards(runtime: ToolRuntime[ClientContext]) -> dict[str, Any]:
        """List the client's payment cards with their last 4 digits, status and linked account."""
        rows = conn.execute(
            """
            SELECT c.id, c.last4, c.status, c.account_id
            FROM cards c JOIN accounts a ON a.id = c.account_id
            WHERE a.client_id = ? ORDER BY c.id
            """,
            (runtime.context.client_id,),
        ).fetchall()
        return {
            "cards": [
                {
                    "card_id": r["id"],
                    "last4": r["last4"],
                    "status": r["status"],
                    "account_id": r["account_id"],
                }
                for r in rows
            ]
        }

    return [list_accounts, list_transactions, list_cards]


def _owns_account(conn: sqlite3.Connection, client_id: str, account_id: str) -> bool:
    return (
        conn.execute(
            "SELECT 1 FROM accounts WHERE id = ? AND client_id = ?", (account_id, client_id)
        ).fetchone()
        is not None
    )
