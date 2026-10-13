import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

from langchain_core.tools import ToolException
from agent_backend import gsheet_auth


class GSheetAuthTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "credential.json"
        self.info = {"type": "service_account", "client_email": "fixture@example.com",
                     "private_key": "fixture-private-key", "token_uri": "https://oauth2.googleapis.com/token"}

    def tearDown(self):
        self.tmp.cleanup()

    def test_standard_json(self):
        self.path.write_text(json.dumps(self.info))
        self.assertEqual(gsheet_auth.load_service_account(self.path), self.info)

    def test_selects_named_dictionary_without_executing_other_code(self):
        self.path.write_text("raise RuntimeError('must not execute')\nclient_secret = " + repr(self.info) +
                             "\nclient_secret2 = " + repr({**self.info, "client_email": "second@example.com"}))
        result = gsheet_auth.load_service_account(self.path, "client_secret2")
        self.assertEqual(result["client_email"], "second@example.com")

    def test_rejects_executable_expression(self):
        self.path.write_text("client_secret = dict(type='service_account')")
        with self.assertRaises(ToolException):
            gsheet_auth.load_service_account(self.path)

    def test_rejects_missing_or_duplicate_name(self):
        self.path.write_text("client_secret = " + repr(self.info) + "\nclient_secret = " + repr(self.info))
        with self.assertRaises(ToolException):
            gsheet_auth.load_service_account(self.path)
        with self.assertRaises(ToolException):
            gsheet_auth.load_service_account(self.path, "missing")

    def test_only_google_token_endpoint_is_allowed(self):
        self.path.write_text(json.dumps({**self.info, "token_uri": "https://untrusted.example/token"}))
        with self.assertRaises(ToolException):
            gsheet_auth.load_service_account(self.path)

    def test_service_account_refreshes_and_takes_priority_over_manual_token(self):
        self.path.write_text(json.dumps(self.info))
        credential = Mock(valid=False, token="new-token")
        with patch.dict(os.environ, {"CHECK_GSHEET_SERVICE_ACCOUNT_FILE": str(self.path), "CHECK_GSHEET_ACCESS_TOKEN": "old-token"}, clear=True), \
             patch.object(gsheet_auth, "_credentials", return_value=credential):
            self.assertEqual(gsheet_auth.gsheet_token(), "new-token")
        credential.refresh.assert_called_once()

    def test_refresh_error_does_not_expose_provider_body(self):
        self.path.write_text(json.dumps(self.info))
        credential = Mock(valid=False)
        credential.refresh.side_effect = RuntimeError("fixture-private-key")
        with patch.dict(os.environ, {"CHECK_GSHEET_SERVICE_ACCOUNT_FILE": str(self.path)}, clear=True), \
             patch.object(gsheet_auth, "_credentials", return_value=credential):
            with self.assertRaises(ToolException) as error:
                gsheet_auth.gsheet_token()
        self.assertNotIn("fixture-private-key", str(error.exception))

    def test_manual_token_compatibility_and_missing_config(self):
        with patch.dict(os.environ, {"CHECK_GSHEET_ACCESS_TOKEN": "fixture-token"}, clear=True):
            self.assertEqual(gsheet_auth.gsheet_token(), "fixture-token")
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(ToolException):
                gsheet_auth.gsheet_token()


if __name__ == "__main__":
    unittest.main()
