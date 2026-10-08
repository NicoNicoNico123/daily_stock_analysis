# -*- coding: utf-8 -*-
"""Firebase Storage snapshot restore for the SQLite file."""

import io
import unittest
import urllib.error
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

import src.services.sqlite_firebase_sync as sync


class SqliteFirebaseSyncTestCase(unittest.TestCase):
    def setUp(self) -> None:
        sync._upload_allowed = False
        sync._sync_started = False

    def test_missing_snapshot_allows_later_upload(self) -> None:
        error = urllib.error.HTTPError(
            url="https://storage.googleapis.com/example",
            code=404,
            msg="missing",
            hdrs=None,
            fp=io.BytesIO(b""),
        )
        with TemporaryDirectory() as tmp:
            database = str(Path(tmp) / "stock_analysis.db")
            with patch.object(sync, "firebase_bucket", return_value="demo-bucket"), \
                    patch.object(sync, "_access_token", return_value="token"), \
                    patch.object(sync.urllib.request, "urlopen", side_effect=error):
                found = sync.restore_sqlite_from_firebase(database)
        self.assertFalse(found)
        self.assertTrue(sync._upload_allowed)
        self.assertFalse(Path(database).exists())

    def test_upload_skipped_before_restore(self) -> None:
        with TemporaryDirectory() as tmp:
            database = Path(tmp) / "stock_analysis.db"
            database.write_bytes(b"sqlite")
            with patch.object(sync, "firebase_bucket", return_value="demo-bucket"):
                self.assertFalse(sync.upload_sqlite_to_firebase(str(database)))
