from datetime import datetime
from typing import Optional, List
from sqlmodel import SQLModel, Field, Relationship
from sqlalchemy import Column, Text

class Cluster(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    name: str = Field(index=True, unique=True)
    kubeconfig: str = Field(sa_column=Column(Text))
    description: Optional[str] = Field(default=None, sa_column=Column(Text))

class Conversation(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    title: str = Field(default="New Chat")
    created_at: datetime = Field(default_factory=datetime.utcnow)
    cluster_id: Optional[int] = Field(default=None, foreign_key="cluster.id")

class Message(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    conversation_id: int = Field(foreign_key="conversation.id")
    role: str # "user" | "assistant" | "system"
    content: str = Field(sa_column=Column(Text)) # Text or JSON string
    type: str # "text" | "widget"
    created_at: datetime = Field(default_factory=datetime.utcnow)
