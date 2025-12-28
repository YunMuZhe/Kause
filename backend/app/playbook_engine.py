import os
import json
import yaml
import asyncio
from pathlib import Path
from typing import Dict, List, Any, Optional, AsyncGenerator
from jinja2 import Template, Environment

class PlaybookEngine:
    def __init__(self, playbook_dir: str, mcp_session, openai_client, model_name: str):
        self.playbook_dir = Path(playbook_dir)
        self.mcp_session = mcp_session
        self.openai_client = openai_client
        self.model_name = model_name
        self.env = Environment()
        # Custom filter for JSON conversion in templates
        self.env.filters['to_json'] = lambda v: json.dumps(v, indent=2, ensure_ascii=False)

    def list_playbooks(self) -> List[Dict[str, Any]]:
        playbooks = []
        if not self.playbook_dir.exists():
            return []
        
        for file in self.playbook_dir.glob("*.yaml"):
            try:
                with open(file, 'r', encoding='utf-8') as f:
                    data = yaml.safe_load(f)
                    if data:
                        metadata = data.get('metadata', {})
                        playbooks.append({
                            "id": data.get('id'),
                            "title": metadata.get('title'),
                            "description": metadata.get('description'),
                            "icon": metadata.get('icon'),
                            "summary": metadata.get('summary'),
                            "inputs": data.get('inputs', []),
                            "steps": data.get('steps', [])
                        })
            except Exception as e:
                print(f"Error loading playbook {file}: {e}")
        return playbooks

    async def execute_playbook(self, playbook_id: str, user_inputs: Dict[str, Any]) -> AsyncGenerator[Dict[str, Any], None]:
        # 1. Load playbook
        file_path = self.playbook_dir / f"{playbook_id}.yaml"
        if not file_path.exists():
            yield {"type": "error", "message": f"Playbook {playbook_id} not found"}
            return

        with open(file_path, 'r', encoding='utf-8') as f:
            playbook = yaml.safe_load(f)

        context = user_inputs.copy()
        steps = playbook.get('steps', [])
        
        yield {"type": "info", "message": f"Starting playbook: {playbook['metadata']['title']}"}

        # 2. Execute steps
        for step in steps:
            step_id = step['id']
            step_name = step['name']
            step_type = step['type']
            
            yield {"type": "step_start", "step_id": step_id, "name": step_name}
            
            try:
                if step_type == "tool_call":
                    # Render arguments
                    tool_name = step['tool_name']
                    args_template = step.get('args', {})
                    rendered_args = {}
                    for k, v in args_template.items():
                        if isinstance(v, str) and "{{" in v:
                            rendered_args[k] = self.env.from_string(v).render(context)
                        else:
                            rendered_args[k] = v
                    
                    yield {"type": "info", "message": f"Executing tool: {tool_name}..."}
                    
                    # Call MCP tool
                    result = await self.mcp_session.call_tool(tool_name, rendered_args)
                    
                    # Process result
                    content = ""
                    for item in result.content:
                        if hasattr(item, "text"):
                            content += item.text
                    
                    # Store in context (try to parse as JSON if possible)
                    try:
                        context[step['output_key']] = json.loads(content)
                    except:
                        context[step['output_key']] = content
                        
                    yield {"type": "step_finish", "step_id": step_id, "status": "success"}

                elif step_type == "llm_analysis":
                    # Render prompt
                    prompt_template = step['prompt_template']
                    rendered_prompt = self.env.from_string(prompt_template).render(context)
                    
                    yield {"type": "info", "message": f"AI Analysing..."}
                    
                    # Call LLM
                    response = self.openai_client.chat.completions.create(
                        model=self.model_name,
                        messages=[
                            {"role": "system", "content": "你是一个专业的 Kubernetes 专家。"},
                            {"role": "user", "content": rendered_prompt}
                        ]
                    )
                    
                    analysis_result = response.choices[0].message.content
                    context[step['output_key']] = analysis_result
                    
                    yield {"type": "step_finish", "step_id": step_id, "status": "success"}
                
                else:
                    yield {"type": "error", "message": f"Unknown step type: {step_type}"}
                    return

            except Exception as e:
                yield {"type": "step_finish", "step_id": step_id, "status": "error", "message": str(e)}
                yield {"type": "error", "message": f"Step {step_id} failed: {e}"}
                return

        # 3. Final output
        report_template = playbook['output']['report_template']
        final_report = self.env.from_string(report_template).render(context)
        
        yield {"type": "report", "content": final_report}
        yield {"type": "info", "message": "Playbook execution completed."}
