import pytest

from actions_agent.tools import describe_action, transfer_error


@pytest.mark.parametrize(
    ("source", "target", "amount", "expected"),
    [
        ("a_001", "a_002", 10000, None),
        ("a_001", "a_003", 10000, "account_not_found"),
        ("a_001", "a_001", 10000, "same_account"),
        ("a_001", "a_002", 0, "invalid_amount"),
        ("a_001", "a_002", 184251, "insufficient_funds"),
    ],
)
def test_transfer_error(conn, source, target, amount, expected):
    assert transfer_error(conn, "c_001", source, target, amount) == expected


def test_describe_action_refuses_another_clients_card(conn):
    assert describe_action(conn, "c_001", "block_card", {"card_id": "k_003"}) is None
    assert "1234" in describe_action(conn, "c_002", "block_card", {"card_id": "k_003"})


def test_describe_action_refuses_an_already_blocked_card(conn):
    conn.execute("UPDATE cards SET status = 'blocked' WHERE id = 'k_001'")
    assert describe_action(conn, "c_001", "block_card", {"card_id": "k_001"}) is None
