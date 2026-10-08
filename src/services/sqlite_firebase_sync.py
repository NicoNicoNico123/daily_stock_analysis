# -*- coding: utf-8 -*-
"""Persist the SQLite database file in Firebase Storage.

Cloud Run's local disk is discarded when the instance stops. Firebase Storage
is a Cloud Storage bucket, so the database file is downloaded before SQLite
opens and a consistent snapshot is uploaded while the process runs. The live
database stays on local disk; only the snapshot crosses the network.
"""

from __future__ import annotations

import atexit
import logging
import os
import signal
import sqlite3
import tempfile
import threading
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

_BUCKET_ENV = "SQLITE_FIREBASE_BUCKET"
_OBJECT_ENV = "SQLITE_FIREBASE_OBJECT"
_INTERVAL_ENV = "SQLITE_FIREBASE_SYNC_SECONDS"
_DEFAULT_OBJECT = "sqlite/stock_analysis.db"
_DEFAULT_INTERVAL_SEC = 20
_METADATA_URL = (
    "http://metadata.google.internal/computeMetadata/v1/"
    "instance/service-accounts/default/token"
)

_upload_allowed = False
_sync_started = False
_sync_lock = threading.Lock()


def firebase_bucket() -> str:
    return (os.getenv(_BUCKET_ENV) or "").strip()


def _object_name() -> str:
    name = (os.getenv(_OBJECT_ENV) or _DEFAULT_OBJECT).strip()
    return name or _DEFAULT_OBJECT


def _sync_interval_seconds() -> int:
    raw = (os.getenv(_INTERVAL_ENV) or "").strip()
    if not raw:
        return _DEFAULT_INTERVAL_SEC
    try:
        value = int(raw)
    except ValueError:
        return _DEFAULT_INTERVAL_SEC
    return value if value > 0 else _DEFAULT_INTERVAL_SEC


def _access_token() -> str:
    request = urllib.request.Request(
        _METADATA_URL,
        headers={"Metadata-Flavor": "Google"},
    )
    with urllib.request.urlopen(request, timeout=5) as response:
        import json
        payload = json.loads(response.read().decode("utf-8"))
    token = str(payload.get("access_token") or "")
    if not token:
        raise RuntimeError("metadata server returned an empty access token")
    return token


def _object_url(bucket: str, object_name: str, *, upload: bool) -> str:
    encoded = urllib.parse.quote(object_name, safe="")
    if upload:
        return (
            "https://storage.googleapis.com/upload/storage/v1/b/"
            f"{urllib.parse.quote(bucket, safe='')}/o"
            f"?uploadType=media&name={encoded}"
        )
    return (
        "https://storage.googleapis.com/storage/v1/b/"
        f"{urllib.parse.quote(bucket, safe='')}/o/{encoded}?alt=media"
    )


def _download(bucket: str, object_name: str, destination: Path) -> bool:
    """Download the snapshot. Return False when the object does not exist yet."""
    request = urllib.request.Request(
        _object_url(bucket, object_name, upload=False),
        headers={"Authorization": f"Bearer {_access_token()}"},
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            destination.parent.mkdir(parents=True, exist_ok=True)
            temporary = destination.with_suffix(destination.suffix + ".download")
            temporary.write_bytes(response.read())
            temporary.replace(destination)
            return True
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return False
        raise


def _upload_file(bucket: str, object_name: str, source: Path) -> None:
    data = source.read_bytes()
    request = urllib.request.Request(
        _object_url(bucket, object_name, upload=True),
        data=data,
        method="POST",
        headers={
            "Authorization": f"Bearer {_access_token()}",
            "Content-Type": "application/x-sqlite3",
        },
    )
    with urllib.request.urlopen(request, timeout=120):
        return


def _snapshot(database_path: Path) -> Optional[Path]:
    """Copy a consistent SQLite snapshot. Return None when the file is absent."""
    if not database_path.exists():
        return None
    handle = tempfile.NamedTemporaryFile(prefix="dsa-sqlite-", suffix=".db", delete=False)
    snapshot_path = Path(handle.name)
    handle.close()
    source = sqlite3.connect(str(database_path))
    destination = sqlite3.connect(str(snapshot_path))
    try:
        source.backup(destination)
    finally:
        destination.close()
        source.close()
    return snapshot_path


def restore_sqlite_from_firebase(database_path: str) -> bool:
    """Download the Firebase snapshot before SQLite opens. Missing object is fine."""
    global _upload_allowed
    bucket = firebase_bucket()
    if not bucket:
        return False
    path = Path(database_path)
    try:
        found = _download(bucket, _object_name(), path)
    except Exception as exc:
        _upload_allowed = False
        logger.warning("Firebase SQLite restore failed; local database left unchanged: %s", exc)
        return False
    _upload_allowed = True
    if found:
        logger.info("Restored SQLite database from Firebase Storage gs://%s/%s", bucket, _object_name())
    else:
        logger.info("No Firebase SQLite snapshot yet; a new database will be uploaded after startup")
    return found


def upload_sqlite_to_firebase(database_path: str) -> bool:
    """Upload a consistent snapshot. No-op until a restore attempt has succeeded or 404'd."""
    if not _upload_allowed:
        return False
    bucket = firebase_bucket()
    if not bucket:
        return False
    snapshot_path = _snapshot(Path(database_path))
    if snapshot_path is None:
        return False
    try:
        _upload_file(bucket, _object_name(), snapshot_path)
    except Exception as exc:
        logger.warning("Firebase SQLite upload failed: %s", exc)
        return False
    finally:
        snapshot_path.unlink(missing_ok=True)
    logger.info("Uploaded SQLite snapshot to Firebase Storage gs://%s/%s", bucket, _object_name())
    return True


def start_sqlite_firebase_sync(database_path: str) -> None:
    """Start a background uploader. Safe to call once after the database is open."""
    global _sync_started
    if not firebase_bucket() or not _upload_allowed:
        return
    with _sync_lock:
        if _sync_started:
            return
        _sync_started = True

    def _flush() -> None:
        upload_sqlite_to_firebase(database_path)

    def _loop() -> None:
        interval = _sync_interval_seconds()
        while True:
            threading.Event().wait(interval)
            _flush()

    def _on_term(signum, _frame) -> None:
        _flush()
        raise SystemExit(128 + int(signum))

    atexit.register(_flush)
    signal.signal(signal.SIGTERM, _on_term)
    threading.Thread(target=_loop, name="sqlite-firebase-sync", daemon=True).start()
