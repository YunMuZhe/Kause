from sqlmodel import SQLModel, create_engine, Session
import os
from sqlalchemy import text

from .config import get_settings

settings = get_settings()

# Engine creation for MySQL
# pool_recycle helps avoid "MySQL server has gone away" errors by recycling connections every hour
engine = create_engine(
    settings.db.sqlalchemy_database_uri, 
    pool_recycle=3600
)

def create_db_and_tables():
    from . import models
    SQLModel.metadata.create_all(engine)

    # Lightweight forward-compatible migration for existing deployments.
    # Adds message.cluster_id when upgrading from older schema versions.
    with engine.begin() as conn:
        result = conn.execute(text("SHOW COLUMNS FROM message LIKE 'cluster_id'"))
        if result.first() is None:
            conn.execute(text("ALTER TABLE message ADD COLUMN cluster_id INTEGER NULL"))

def get_session():
    with Session(engine) as session:
        yield session
