import os
import pkgutil
import importlib
import logging

logger = logging.getLogger(__name__)

def discover_playbooks(package_name: str = __name__):
    """
    Walks through the subdirectories of the current package 
    and imports all modules to trigger decorator-based registration.
    """
    package = importlib.import_module(package_name)
    path = package.__path__
    
    for loader, module_name, is_pkg in pkgutil.walk_packages(path, package.__name__ + "."):
        try:
            importlib.import_module(module_name)
            logger.debug(f"Discovered module: {module_name}")
        except Exception as e:
            logger.error(f"Failed to import playbook module {module_name}: {e}")

# Automatically trigger discovery on package import
discover_playbooks()
