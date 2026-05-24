from cryptography.fernet import Fernet
import base64
from .config import get_settings

settings = get_settings()

def _get_fernet():
    # Ensure the key is 32 bytes and base64 encoded for Fernet
    key = settings.encryption_key.get_secret_value()
    # If the key is not already a valid Fernet key, we derive it
    # For now, we assume it's a valid 32-byte base64 string or we handle it
    try:
        return Fernet(key.encode())
    except Exception:
        # Fallback/Helper: If key is just a string, we pad/hash it to make it valid
        import hashlib
        h = hashlib.sha256(key.encode()).digest()
        key_b64 = base64.urlsafe_b64encode(h)
        return Fernet(key_b64)

def encrypt_data(data: str) -> str:
    """Encrypts a string and returns a base64 encoded string."""
    if not data:
        return ""
    f = _get_fernet()
    return f.encrypt(data.encode()).decode()

def decrypt_data(encrypted_data: str) -> str:
    """Decrypts a base64 encoded encrypted string."""
    if not encrypted_data:
        return ""
    f = _get_fernet()
    try:
        return f.decrypt(encrypted_data.encode()).decode()
    except Exception as e:
        print(f"Decryption failed: {e}")
        return ""
