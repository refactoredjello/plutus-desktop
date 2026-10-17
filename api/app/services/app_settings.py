"""Key/value app settings with optional Fernet encryption of values.

The key is derived from `settings.secret_key`, so rotating SECRET_KEY invalidates stored secrets.
"""

import base64
import hashlib

from cryptography.fernet import Fernet, InvalidToken
from sqlalchemy.orm import Session

from app.config import Settings
from app.errors import DomainError
from app.models import AppSetting

SIMPLEFIN_ACCESS_URL = "simplefin_access_url"
SIMPLEFIN_CONNECTED_AT = "simplefin_connected_at"


def _fernet(settings: Settings) -> Fernet:
    digest = hashlib.sha256(settings.secret_key.get_secret_value().encode()).digest()
    return Fernet(base64.urlsafe_b64encode(digest))


def set_setting(
    db: Session, settings: Settings, key: str, value: str, *, encrypt: bool = False
) -> None:
    stored = _fernet(settings).encrypt(value.encode()).decode() if encrypt else value
    row = db.get(AppSetting, key)
    if row is None:
        db.add(AppSetting(key=key, value=stored, is_encrypted=encrypt))
    else:
        row.value = stored
        row.is_encrypted = encrypt
    db.commit()


def get_setting(db: Session, settings: Settings, key: str) -> str | None:
    row = db.get(AppSetting, key)
    if row is None:
        return None
    if not row.is_encrypted:
        return row.value
    try:
        return _fernet(settings).decrypt(row.value.encode()).decode()
    except InvalidToken as exc:
        raise DomainError(
            f"Stored setting '{key}' cannot be decrypted; SECRET_KEY has changed. Reconnect."
        ) from exc


def delete_setting(db: Session, key: str) -> None:
    row = db.get(AppSetting, key)
    if row is not None:
        db.delete(row)
        db.commit()
