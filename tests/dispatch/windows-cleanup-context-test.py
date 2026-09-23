"""Windows cleanup transport regressions; stdlib only, no accounts or ACL edits.

Run with the existing pinned Windows Python before the account-creating probe.
The production module is copied byte-for-byte to an isolated stage and imported.
Only token identity and deletion boundaries are injected: these are binding
tests, NOT ordinary-token or protected-stage ACL evidence. Real Win32 attribute
walks inspect real temporary files. Optional NTFS symlinks use existing rights;
unavailable link creation is explicitly skipped, never reported as coverage.
"""

import argparse
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock


@unittest.skipUnless(sys.platform == "win32", "native Windows required")
class CleanupContextTests(unittest.TestCase):
    SID = "S-1-5-21-1-2-3-1001"  # Synthetic identity; no account is created.
    RUN = "1234abcd"
    NAMES = ("auth-metadata.json", "linkcheck.bin", "linkcheck.link",
             "reparse.link", "publish.tmp", "published.json")

    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="wcc-")
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name).absolute()
        self.stage = self.base / "stage"
        self.stage.mkdir()
        self.target = self.base / "receipts" / "cleanup-receipt.json"
        self.target.parent.mkdir()
        self.root = self.base / "fixture" / ("windows-private-auth-" + self.RUN)
        self.root.mkdir(parents=True)
        self.sentinel = self.base / "outside.bin"
        self.sentinel.write_bytes(b"preserve outside fixture")
        self.leaf = self.root / "published.json"
        self.leaf.write_bytes(b"preserve at instrumented boundary")
        source = Path(__file__).with_name("windows-private-auth-probe.py")
        staged = self.stage / source.name
        staged.write_bytes(source.read_bytes())
        self.assertEqual(staged.read_bytes(), source.read_bytes())
        spec = importlib.util.spec_from_file_location("cleanup_probe_under_test", staged)
        self.probe = importlib.util.module_from_spec(spec)
        # Avoid import caches in the copied production stage.
        with mock.patch.object(sys, "dont_write_bytecode", True):
            spec.loader.exec_module(self.probe)
        self.api = self.probe.WinAPI([])
        self.manifest = self.stage / "cleanup-context.json"
        self.document = dict(schema=1, root=str(self.root), runId=self.RUN,
                             expectSid=self.SID, receipt=str(self.target),
                             objects=[str(self.root), str(self.leaf)])
        self.write_document(self.document)
        self.unlinks = []
        self.native_deletes = []
        # Defense in depth: no test may call a real native deletion API.
        for name in ("DeleteFileW", "RemoveDirectoryW"):
            def intercepted(path, name=name):
                self.native_deletes.append((name, str(path)))
                return 1
            self.api.functions[name] = intercepted

    def write_document(self, document):
        self.manifest.write_bytes(json.dumps(document).encode("utf-8"))

    def boundary(self, api, path, is_root, receipt, sid):
        self.unlinks.append((str(path), is_root, sid))
        return dict(path=str(path), isRoot=is_root, state="absent")

    def invoke(self, extra=(), *, real_unlink=False, ordinary=True):
        self.unlinks.clear()
        self.native_deletes.clear()
        argv = [str(self.stage / "windows-private-auth-probe.py"),
                "--role", "cleanup", "--cleanup-context",
                "--attest-local-unsynced-disposable-parent", *extra]
        with contextlib.ExitStack() as stack:
            stack.enter_context(mock.patch.object(sys, "argv", argv))
            stack.enter_context(mock.patch.object(self.probe, "WinAPI", return_value=self.api))
            stack.enter_context(mock.patch.object(self.api, "token_identity", return_value={
                "userSid": self.SID, "ordinaryPrincipalVerified": ordinary,
                "evidenceSource": "TEST_INJECTED_NOT_TOKEN_EVIDENCE"}))
            if not real_unlink:
                stack.enter_context(mock.patch.object(self.probe, "unlink_recorded",
                                                       side_effect=self.boundary))
            stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
            stack.enter_context(contextlib.redirect_stderr(io.StringIO()))
            code = self.probe.main()
        receipt = json.loads(self.target.read_bytes())
        self.assertFalse(receipt["activationAuthorized"])
        self.assertFalse(receipt["powerLossProven"])
        self.assertEqual(receipt["obligations"], self.probe.OBLIGATIONS)
        self.assertEqual(self.sentinel.read_bytes(), b"preserve outside fixture")
        return code, receipt

    def refused(self, *, reason=None, error=None, real_unlink=False):
        code, receipt = self.invoke(real_unlink=real_unlink)
        self.assertEqual(code, 1 if error else 2, receipt)
        self.assertEqual(receipt["status"], "harness_failure" if error else "capability_refusal")
        if reason:
            self.assertEqual(receipt["reason"], reason)
        if error:
            self.assertEqual(receipt["errorType"], error)
        self.assertEqual(self.unlinks, [], "refusal must precede unlink_recorded")
        self.assertEqual(self.native_deletes, [], "refusal must precede native deletion")

    def test_exact_six_fields_load_and_main(self):
        args = argparse.Namespace()
        self.probe.load_cleanup_context(self.api, args, self.target)
        self.assertEqual(vars(args), dict(root=str(self.root), run_id=self.RUN,
                                         expect_sid=self.SID, object=self.document["objects"]))
        code, receipt = self.invoke()
        self.assertEqual(code, 0, receipt)
        self.assertEqual(self.unlinks, [(str(self.leaf), False, self.SID),
                                       (str(self.root), True, self.SID)])
        self.assertEqual(receipt["cleanup"]["recordedCount"], 2)
        self.assertEqual(self.leaf.read_bytes(), b"preserve at instrumented boundary")

    def test_all_seven_allowed_objects_and_empty_list(self):
        for objects in ([str(self.root), *(str(self.root / n) for n in self.NAMES)], []):
            with self.subTest(objects=objects):
                self.write_document(dict(self.document, objects=objects))
                code, receipt = self.invoke()
                self.assertEqual(code, 0, receipt)
                self.assertEqual({x[0] for x in self.unlinks}, {str(self.root), *objects})
                self.assertTrue(self.unlinks[-1][1])

    def test_duplicate_unknown_and_missing_fields(self):
        for key in self.document:
            with self.subTest(duplicate=key):
                raw = json.dumps(self.document)
                self.manifest.write_text(raw[:-1] + "," + json.dumps(key) + ":null}", encoding="utf-8")
                self.refused(reason="cleanup_context_duplicate_field")
            with self.subTest(missing=key):
                self.write_document({k: v for k, v in self.document.items() if k != key})
                self.refused(reason="cleanup_context_schema")
        self.write_document(dict(self.document, unexpected="ignored?"))
        self.refused(reason="cleanup_context_schema")

    def test_top_level_and_schema_types(self):
        for value in (None, True, False, 1, 1.0, "1", [], [self.document]):
            with self.subTest(top_level=value):
                self.write_document(value)
                self.refused(reason="cleanup_context_schema")
        for value in (None, True, False, 0, 2, 1.0, "1", [], {}):
            with self.subTest(schema=value):
                self.write_document(dict(self.document, schema=value))
                self.refused(reason="cleanup_context_schema")

    def test_string_fields_and_object_container_types(self):
        for key in ("root", "runId", "expectSid", "receipt"):
            for value in (None, True, 1, [], {}, "", "x" * 201, "a\0b"):
                with self.subTest(key=key, value=value):
                    self.write_document(dict(self.document, **{key: value}))
                    self.refused(reason="cleanup_context_schema")
        for value in (None, True, 1, "", {}, [str(self.root)] * 8):
            with self.subTest(objects=value):
                self.write_document(dict(self.document, objects=value))
                self.refused(reason="cleanup_context_schema")

    def test_byte_limit_and_bad_encoding(self):
        raw = json.dumps(self.document).encode("utf-8")
        self.manifest.write_bytes(raw + b" " * (16384 - len(raw)))
        self.assertEqual(self.invoke()[0], 0)
        self.manifest.write_bytes(raw + b" " * (16385 - len(raw)))
        self.refused(reason="cleanup_context_size_bound")
        self.manifest.write_bytes(b"\xff")
        self.refused(error="UnicodeDecodeError")
        for raw in (b"", b"{", b"{} trailing", b"\xef\xbb\xbf{}"):
            with self.subTest(raw=raw):
                self.manifest.write_bytes(raw)
                self.refused(error="JSONDecodeError")

    def test_run_root_receipt_and_sid_binding(self):
        for run in ("1234ABCd", "1234abcg", "1234abc", "1234abcde", "../abcde"):
            with self.subTest(run=run):
                self.write_document(dict(self.document, runId=run))
                self.refused(reason="cleanup_context_run_id")
        for changes in (dict(runId="deadbeef"), dict(root=str(self.sentinel)),
                        dict(root=str(self.root) + "-other"), dict(root="relative"),
                        dict(receipt=str(self.sentinel)), dict(receipt="relative")):
            with self.subTest(changes=changes):
                self.write_document(dict(self.document, **changes))
                self.refused(reason="cleanup_context_binding")
        for sid in ("S-1-5-21-1-2-3-1002", "not-a-sid"):
            with self.subTest(sid=sid):
                self.write_document(dict(self.document, expectSid=sid))
                self.refused(reason="cleanup_principal_is_not_the_recording_owner")

    def test_all_objects_checked_before_first_unlink(self):
        for value in (None, True, 1, {}, [], str(self.sentinel), "relative",
                      str(self.root / "unrecorded.bin"), str(self.root / "sub" / "published.json"),
                      str(self.root / ".." / "outside.bin"), str(self.root / "*.json"),
                      str(self.leaf) + ":stream", str(self.leaf) + " "):
            with self.subTest(object=value):
                self.write_document(dict(self.document, objects=[str(self.leaf), value]))
                self.refused(reason="cleanup_context_object_binding")

    def test_cli_overrides_refused_before_api_or_receipt_write(self):
        cases = [(flag, str(self.sentinel)) for flag in
                 ("--receipt", "--parent", "--root", "--object")]
        cases += [("--run-id", self.RUN), ("--expect-sid", self.SID),
                  ("--target-name", "other.json"), ("--role", "owner"),
                  ("--role", "other"), ("--cleanup-context", str(self.manifest)),
                  ("--cleanup-context=" + str(self.manifest),)]
        for extra in cases:
            with self.subTest(extra=extra):
                self.target.write_bytes(b"untouched receipt")
                with mock.patch.object(self.api, "safe_existing", wraps=self.api.safe_existing) as walk:
                    with self.assertRaises(SystemExit) as error:
                        self.invoke(extra)
                    self.assertEqual(error.exception.code, 2)
                    walk.assert_not_called()
                self.assertEqual(self.unlinks, [])
                self.assertEqual(self.native_deletes, [])
                self.assertEqual(self.target.read_bytes(), b"untouched receipt")
                self.assertEqual(self.sentinel.read_bytes(), b"preserve outside fixture")

    def test_fixed_manifest_ignores_cwd_and_missing_manifest_fails(self):
        decoy = self.base / "cleanup-context.json"
        decoy.write_bytes(b"invalid decoy")
        previous = Path.cwd()
        try:
            os.chdir(self.base)
            self.assertEqual(self.invoke()[0], 0)
            self.manifest.unlink()
            decoy.write_bytes(json.dumps(self.document).encode("utf-8"))
            code, receipt = self.invoke()
            self.assertEqual(code, 1, receipt)
            self.assertEqual(receipt["failedApi"], "GetFileAttributesW")
            self.assertEqual(self.unlinks, [])
            self.assertEqual(self.native_deletes, [])
        finally:
            os.chdir(previous)

    def test_manifest_directory_and_wrong_stage_name(self):
        self.manifest.unlink()
        self.manifest.mkdir()
        self.refused(reason="cleanup_context_is_directory")
        self.manifest.rmdir()
        self.write_document(self.document)
        renamed = self.base / "not-stage"
        self.stage.rename(renamed)
        with mock.patch.object(self.probe, "__file__", str(renamed / "windows-private-auth-probe.py")):
            self.refused(reason="cleanup_context_binding")

    def test_nonordinary_token_refused_before_manifest(self):
        with mock.patch.object(self.api, "safe_existing", wraps=self.api.safe_existing) as walk:
            code, receipt = self.invoke(ordinary=False)
            self.assertEqual(code, 2, receipt)
            self.assertEqual(receipt["reason"], "not_an_ordinary_principal_token")
            walk.assert_not_called()
        self.assertEqual(self.unlinks, [])
        self.assertEqual(self.native_deletes, [])

    def symlink_or_skip(self, link, target, *, directory=False):
        facts = {}
        try:
            self.probe.volume_facts(self.api, self.base, facts)
        except self.probe.Refusal as error:
            if str(error) == "requires_identified_fixed_ntfs":
                self.skipTest("Native link coverage unavailable: fixed NTFS required")
            raise
        try:
            link.symlink_to(target, target_is_directory=directory)
        except OSError as error:
            if error.winerror in (1, 5, 50, 1314):
                self.skipTest("NTFS symlink unavailable with existing rights: winerror="
                              + str(error.winerror))
            raise

    def test_native_manifest_symlink_rejected(self):
        original = self.base / "original-context.json"
        self.manifest.rename(original)
        self.symlink_or_skip(self.manifest, original)
        self.refused(reason="reparse_offline_or_recall_path", real_unlink=True)

    def test_native_stage_ancestor_symlink_rejected(self):
        original = self.base / "original-stage"
        self.stage.rename(original)
        self.symlink_or_skip(self.stage, original, directory=True)
        self.refused(reason="reparse_offline_or_recall_path", real_unlink=True)

    def test_native_substituted_root_refused_before_child_deletion(self):
        # Deliberately NOT expectedFailure: a root check after deleting children
        # violates the no-follow invariant. Intercept actual Win32 deletions so
        # the fixture-local victim remains intact even on the vulnerable path.
        original = self.base / "substituted-target"
        self.root.rename(original)
        self.symlink_or_skip(self.root, original, directory=True)
        self.refused(reason="cleanup_root_is_not_a_plain_directory", real_unlink=True)
        self.assertEqual((original / "published.json").read_bytes(),
                         b"preserve at instrumented boundary")

    def test_root_reparse_ordering_with_injected_attributes(self):
        # Deterministic ordering regression even without symlink privileges.
        # Only the root attribute is injected; this is NOT NTFS link evidence.
        original = self.api.functions["GetFileAttributesW"]

        def attributes(path):
            if str(path) == str(self.root):
                return self.probe.DIRECTORY | self.probe.REPARSE
            return original(path)

        with mock.patch.dict(self.api.functions, GetFileAttributesW=attributes):
            self.refused(reason="cleanup_root_is_not_a_plain_directory", real_unlink=True)


if __name__ == "__main__":
    if sys.platform != "win32":
        raise SystemExit("Native Windows required; non-Windows execution is not validation")
    unittest.main(verbosity=2)
