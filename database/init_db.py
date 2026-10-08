"""(Re)creates bank.db from schema.sql and seed.sql."""

import sqlite3
from pathlib import Path

HERE = Path(__file__).parent
DB_PATH = HERE / "bank.db"


def main() -> None:
    DB_PATH.unlink(missing_ok=True)
    with sqlite3.connect(DB_PATH) as conn:
        conn.executescript((HERE / "schema.sql").read_text())
        conn.executescript((HERE / "seed.sql").read_text())
    print(f"Created {DB_PATH}")


if __name__ == "__main__":
    main()
