from dataclasses import dataclass


@dataclass(frozen=True)
class ClientContext:
    client_id: str
