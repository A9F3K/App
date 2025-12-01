#!/usr/bin/env python3
"""
Script to generate a secure API key for the AI backend
"""
import secrets
import string

def generate_api_key(length=32):
    """
    Generate a secure random API key
    Uses URL-safe base64 characters for compatibility
    """
    # Use URL-safe base64 characters (A-Z, a-z, 0-9, -, _)
    alphabet = string.ascii_letters + string.digits + '-_'
    api_key = ''.join(secrets.choice(alphabet) for _ in range(length))
    return api_key

if __name__ == "__main__":
    api_key = generate_api_key(32)
    print(f"Generated API Key: {api_key}")
    print(f"\nSet this as your API_KEY environment variable:")
    print(f"export API_KEY={api_key}")
    print(f"\nOr for Windows:")
    print(f"set API_KEY={api_key}")















