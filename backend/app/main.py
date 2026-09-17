from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from app.core import config
from app.db.connection import connect, init_db
from app.routers import ai, documents, search, workspace


def create_app(db_path=None, files_dir=None):
    app = FastAPI(title="LexBench · 法研台")
    db_path = Path(db_path) if db_path else config.DB_PATH
    files_dir = Path(files_dir) if files_dir else config.FILES_DIR

    init_db(db_path)
    app.state.conn = connect(db_path)
    app.state.db_path = db_path
    app.state.files_dir = files_dir

    app.include_router(documents.router, prefix="/api")
    app.include_router(search.router, prefix="/api")
    app.include_router(workspace.router, prefix="/api")
    app.include_router(ai.router, prefix="/api")

    if config.FRONTEND_DIST.exists():
        app.mount("/", StaticFiles(directory=config.FRONTEND_DIST, html=True), name="frontend")
    return app


app = create_app()
