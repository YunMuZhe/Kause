from sqlmodel import SQLModel, create_engine, Session
import os

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

def get_session():
    with Session(engine) as session:
        yield session
