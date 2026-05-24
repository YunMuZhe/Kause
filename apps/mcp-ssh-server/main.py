import os
import json
import paramiko
from typing import Optional
from dotenv import load_dotenv
from mcp.server.fastmcp import FastMCP

# Load environment variables from .env file if it exists
load_dotenv()

# Initialize FastMCP server
mcp = FastMCP("SSH-Server")

# Server inventory: Loaded from SSH_SERVERS_JSON env var (list of dicts)
def get_inventory() -> dict:
    inventory_raw = os.getenv("SSH_SERVERS_JSON", "[]")
    try:
        servers = json.loads(inventory_raw)
        return {s["name"]: s for s in servers}
    except Exception:
        return {}

def get_ssh_client(server_name: Optional[str] = None,
                   host: Optional[str] = None, 
                   user: Optional[str] = None, 
                   password: Optional[str] = None, 
                   key_path: Optional[str] = None) -> paramiko.SSHClient:
    """Helper to create and return an SSH client."""
    inventory = get_inventory()
    
    if server_name and server_name in inventory:
        s = inventory[server_name]
        host = s.get("host")
        user = s.get("user")
        password = s.get("password")
        key_path = s.get("key_path")
    else:
        # Use provided values or fall back to single-server environment variables
        host = host or os.getenv("SSH_HOST")
        user = user or os.getenv("SSH_USER")
        password = password or os.getenv("SSH_PASSWORD")
        key_path = key_path or os.getenv("SSH_KEY_PATH")

    if not host or not user:
        raise ValueError("SSH Host and User must be provided or set in environment variables (SSH_HOST, SSH_USER)")

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    
    if key_path:
        key = paramiko.RSAKey.from_private_key_file(key_path)
        client.connect(hostname=host, username=user, pkey=key)
    else:
        client.connect(hostname=host, username=user, password=password)
    
    return client

def exec_ssh_command(command: str, 
                     server_name: Optional[str] = None,
                     host: Optional[str] = None, 
                     user: Optional[str] = None, 
                     password: Optional[str] = None, 
                     key_path: Optional[str] = None) -> str:
    """Helper to execute a command and return output."""
    client = get_ssh_client(server_name, host, user, password, key_path)
    try:
        stdin, stdout, stderr = client.exec_command(command)
        output = stdout.read().decode('utf-8')
        error = stderr.read().decode('utf-8')
        if error:
            return f"Output:\n{output}\nError:\n{error}"
        return output
    finally:
        client.close()

@mcp.tool()
def list_servers() -> str:
    """List all pre-configured servers in the inventory."""
    inventory = get_inventory()
    if not inventory:
        return "No servers configured in SSH_SERVERS_JSON."
    
    output = "Available Servers:\n"
    for name, s in inventory.items():
        output += f"- {name} ({s.get('host')}) : {s.get('description', 'No description')}\n"
    return output

@mcp.tool()
def ssh_ls(path: str = ".", 
           server_name: Optional[str] = None,
           host: Optional[str] = None, 
           user: Optional[str] = None, 
           password: Optional[str] = None) -> str:
    """List directory contents on a remote server."""
    return exec_ssh_command(f"ls -F {path}", server_name, host, user, password)

@mcp.tool()
def ssh_cat(path: str, 
            server_name: Optional[str] = None,
            host: Optional[str] = None, 
            user: Optional[str] = None, 
            password: Optional[str] = None) -> str:
    """Read file content from a remote server."""
    return exec_ssh_command(f"cat {path}", server_name, host, user, password)

@mcp.tool()
def ssh_tail(path: str, 
             lines: int = 10, 
             server_name: Optional[str] = None,
             host: Optional[str] = None, 
             user: Optional[str] = None, 
             password: Optional[str] = None) -> str:
    """Get the last N lines of a file from a remote server."""
    return exec_ssh_command(f"tail -n {lines} {path}", server_name, host, user, password)

@mcp.tool()
def ssh_grep(pattern: str, 
             path: str, 
             server_name: Optional[str] = None,
             host: Optional[str] = None, 
             user: Optional[str] = None, 
             password: Optional[str] = None) -> str:
    """Search for a pattern in a file on a remote server."""
    return exec_ssh_command(f"grep '{pattern}' {path}", server_name, host, user, password)

@mcp.tool()
def ssh_ps(server_name: Optional[str] = None,
           host: Optional[str] = None, 
           user: Optional[str] = None, 
           password: Optional[str] = None) -> str:
    """List running processes on the remote server."""
    return exec_ssh_command("ps aux", server_name, host, user, password)

@mcp.tool()
def ssh_df(server_name: Optional[str] = None,
           host: Optional[str] = None, 
           user: Optional[str] = None, 
           password: Optional[str] = None) -> str:
    """Check disk space usage on the remote server."""
    return exec_ssh_command("df -h", server_name, host, user, password)

@mcp.tool()
def ssh_free(server_name: Optional[str] = None,
             host: Optional[str] = None, 
             user: Optional[str] = None, 
             password: Optional[str] = None) -> str:
    """Check memory usage on the remote server."""
    return exec_ssh_command("free -m", server_name, host, user, password)

@mcp.tool()
def ssh_netstat(server_name: Optional[str] = None,
                host: Optional[str] = None, 
                user: Optional[str] = None, 
                password: Optional[str] = None) -> str:
    """List network connections on the remote server."""
    return exec_ssh_command("netstat -tupln || ss -tupln", server_name, host, user, password)

@mcp.tool()
def ssh_exec(command: str, 
             server_name: Optional[str] = None,
             host: Optional[str] = None, 
             user: Optional[str] = None, 
             password: Optional[str] = None) -> str:
    """Execute an arbitrary command on a remote server."""
    return exec_ssh_command(command, server_name, host, user, password)

if __name__ == "__main__":
    mcp.run()
