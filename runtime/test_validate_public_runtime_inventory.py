import json
import tempfile
import unittest
from pathlib import Path

from runtime.validate_public_runtime_inventory import validate_inventory


class PublicRuntimeInventoryTests(unittest.TestCase):
    def _fixture(self, root: Path) -> tuple[Path, Path]:
        public = root / "public"
        private = root / "command-center"
        workflows = public / ".github/workflows"
        runtime = public / "runtime"
        config = private / "config"
        workflows.mkdir(parents=True)
        runtime.mkdir(parents=True)
        config.mkdir(parents=True)
        (workflows / "runtime-self-test.yml").write_text(
            "name: Runtime self-test\non:\n  workflow_dispatch:\n", encoding="utf-8"
        )
        (runtime / "validate_public_runtime_inventory.py").write_text("# validator\n", encoding="utf-8")
        (public / "PUBLIC_EXPORT_MANIFEST.json").write_text(
            json.dumps(
                {
                    "allowlist": [
                        ".github/workflows/runtime-self-test.yml",
                        "runtime/validate_public_runtime_inventory.py",
                    ]
                }
            ),
            encoding="utf-8",
        )
        (config / "module_registry.json").write_text(
            json.dumps(
                {
                    "modules": [
                        {
                            "module_id": "public-runtime-bridge",
                            "state": "ENABLED",
                        }
                    ],
                    "public_workflow_bindings": {
                        "runtime-self-test.yml": "public-runtime-bridge"
                    },
                    "forbidden_public_paths": [
                        ".github/workflows/legacy.yml"
                    ],
                }
            ),
            encoding="utf-8",
        )
        return public, private

    def test_complete_bound_inventory_passes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            public, private = self._fixture(Path(tmp))
            result = validate_inventory(public_root=public, command_center=private)
            self.assertEqual(result["status"], "PASS")
            self.assertTrue(result["direct_private_main_push_absent"])

    def test_unbound_workflow_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            public, private = self._fixture(Path(tmp))
            (public / ".github/workflows/rogue.yml").write_text(
                "name: Rogue\non:\n  workflow_dispatch:\n", encoding="utf-8"
            )
            with self.assertRaisesRegex(ValueError, "unbound"):
                validate_inventory(public_root=public, command_center=private)

    def test_direct_private_main_push_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            public, private = self._fixture(Path(tmp))
            workflow = public / ".github/workflows/runtime-self-test.yml"
            workflow.write_text(
                workflow.read_text(encoding="utf-8") + "\n# git push origin HEAD:main\n",
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ValueError, "dangerous public workflow fragment"):
                validate_inventory(public_root=public, command_center=private)


if __name__ == "__main__":
    unittest.main()
