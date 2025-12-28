import logging
from typing import Any, Callable, Dict, List, Optional, Type, AsyncGenerator
from pydantic import BaseModel
from .base import PlaybookResponse

logger = logging.getLogger(__name__)

class PlaybookMetadata(BaseModel):
    id: str
    title: str
    summary: str
    description: Optional[str] = None
    icon: str = "activity"
    args_model: Type[BaseModel]

class PlaybookRegistry:
    _instance = None
    
    def __init__(self):
        self._playbooks: Dict[str, Dict[str, Any]] = {}

    @classmethod
    def get_instance(cls):
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    def register(
        self, 
        playbook_id: str, 
        title: str, 
        summary: str, 
        args_model: Type[BaseModel],
        description: Optional[str] = None, 
        icon: str = "activity"
    ):
        def decorator(func: Callable):
            metadata = PlaybookMetadata(
                id=playbook_id,
                title=title,
                summary=summary,
                description=description,
                icon=icon,
                args_model=args_model
            )
            
            self._playbooks[playbook_id] = {
                "metadata": metadata,
                "handler": func
            }
            logger.info(f"Registered playbook: {playbook_id}")
            return func
        return decorator

    def list_playbooks(self) -> List[Dict[str, Any]]:
        return [
            {
                "id": p["metadata"].id,
                "title": p["metadata"].title,
                "summary": p["metadata"].summary,
                "description": p["metadata"].description,
                "icon": p["metadata"].icon,
                "args_model": p["metadata"].args_model.model_json_schema()
            }
            for p in self._playbooks.values()
        ]

    def get_playbook(self, playbook_id: str) -> Optional[Dict[str, Any]]:
        return self._playbooks.get(playbook_id)

    async def execute_streaming(self, playbook_id: str, inputs: Dict[str, Any]) -> AsyncGenerator[Dict[str, Any], None]:
        """
        Executes a playbook and yields events for SSE.
        Each yielded dict should have 'event' and 'data'.
        """
        playbook = self.get_playbook(playbook_id)
        if not playbook:
            yield {"event": "error", "data": f"Playbook {playbook_id} not found"}
            return
        
        handler = playbook["handler"]
        args_model = playbook["metadata"].args_model
        
        try:
            # Strict Validation
            validated_inputs = args_model.model_validate(inputs)
            yield {"event": "status", "data": "Validation successful"}
            
            # Check if it's a generator (streaming) or a regular coroutine
            import inspect
            if inspect.isasyncgenfunction(handler):
                async for event in handler(validated_inputs):
                    yield event
            else:
                # One-shot handler
                yield {"event": "status", "data": "Executing..."}
                result = await handler(validated_inputs)
                yield {"event": "result", "data": result.model_dump_json()}
                
        except Exception as e:
            logger.error(f"Error executing playbook {playbook_id}: {str(e)}")
            yield {"event": "error", "data": f"Execution error: {str(e)}"}

    async def execute(self, playbook_id: str, inputs: Dict[str, Any]) -> PlaybookResponse:
        playbook = self.get_playbook(playbook_id)
        if not playbook:
            return PlaybookResponse(success=False, message=f"Playbook {playbook_id} not found")
        
        handler = playbook["handler"]
        args_model = playbook["metadata"].args_model
        
        try:
            # Strict Validation
            validated_inputs = args_model.model_validate(inputs)
            # Invoke handler
            return await handler(validated_inputs)
        except Exception as e:
            logger.error(f"Error executing playbook {playbook_id}: {str(e)}")
            return PlaybookResponse(success=False, message=f"Execution error: {str(e)}")

# Singleton Access
registry = PlaybookRegistry.get_instance()
register_playbook = registry.register
