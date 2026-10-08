import logging

import uvicorn

from informations_agent.config import Settings
from informations_agent.server import create_app


def main() -> None:
    settings = Settings()
    logging.basicConfig(level=settings.log_level, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    uvicorn.run(create_app(settings), host=settings.host, port=settings.port)


if __name__ == "__main__":
    main()
