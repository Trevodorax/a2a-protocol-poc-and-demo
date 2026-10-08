import sqlite3
from decimal import Decimal
from pathlib import Path


def connect(path: Path) -> sqlite3.Connection:
    if not path.exists():
        raise FileNotFoundError(f"Database not found: {path} (run database/init_db.py)")
    conn = sqlite3.connect(path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def format_eur(cents: int) -> str:
    return f"{Decimal(cents).scaleb(-2):.2f} EUR"
