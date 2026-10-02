"""Unit tests for the Python mirror of creative-task runtime request safety."""
from __future__ import annotations

import importlib.util
import json
from types import SimpleNamespace
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TRAINER_PATH = ROOT / "scripts" / "train-creative-task-sft.py"
SPEC = importlib.util.spec_from_file_location("creative_task_sft_trainer", TRAINER_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Could not import creative SFT trainer: {TRAINER_PATH}")
TRAINER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(TRAINER)
COMPARISON_PATH = ROOT / "scripts" / "compare-creative-task-sft.py"
COMPARISON_SPEC = importlib.util.spec_from_file_location("creative_task_sft_comparison", COMPARISON_PATH)
if COMPARISON_SPEC is None or COMPARISON_SPEC.loader is None:
    raise RuntimeError(f"Could not import creative SFT comparison: {COMPARISON_PATH}")
COMPARISON = importlib.util.module_from_spec(COMPARISON_SPEC)
COMPARISON_SPEC.loader.exec_module(COMPARISON)


def request_fixture() -> dict:
    return {
        "conflicts": [],
        "requirements": {"bpmRange": [142, 142], "key": None, "lengthSteps": 128, "targetRoles": ["drums"]},
        "preferences": {
            "genre": "trap",
            "style": None,
            "mood": "dark",
            "energy": None,
            "density": None,
            "complexity": None,
            "variation": None,
        },
        "preserveRoles": ["bass"],
        "prohibitedRoles": ["lead"],
        "projectContext": {"availableRoles": ["drums", "bass", "chords", "lead"]},
    }


def proposal_fixture() -> dict:
    return {
        "version": 1,
        "status": "proposal",
        "suggestions": {
            "genre": "trap",
            "mood": "dark",
            "bpmRange": [142, 142],
            "lengthSteps": 128,
            "targetRoles": ["drums"],
            "preserveRoles": ["bass"],
            "prohibitedRoles": ["lead"],
        },
        "unknownFields": [],
    }


class CreativeTaskRequestSafetyTests(unittest.TestCase):
    def test_matching_proposal_is_valid(self) -> None:
        self.assertTrue(TRAINER.valid_for_request(proposal_fixture(), request_fixture()))

    def test_explicit_requirements_and_preferences_cannot_be_changed(self) -> None:
        request = request_fixture()
        for field, value in (("bpmRange", [140, 140]), ("genre", "house"), ("mood", "bright")):
            with self.subTest(field=field):
                output = proposal_fixture()
                output["suggestions"][field] = value
                self.assertFalse(TRAINER.valid_for_request(output, request))
                self.assertIn(f"changed-explicit:{field}", COMPARISON.request_failure_codes(output, request))

    def test_protected_and_prohibited_roles_cannot_be_targeted(self) -> None:
        request = request_fixture()
        for role in ("bass", "lead"):
            with self.subTest(role=role):
                output = proposal_fixture()
                output["suggestions"]["targetRoles"] = [role]
                self.assertFalse(TRAINER.valid_for_request(output, request))

    def test_project_unavailable_role_is_rejected(self) -> None:
        request = request_fixture()
        request["requirements"]["targetRoles"] = []
        request["projectContext"]["availableRoles"] = ["drums"]
        output = proposal_fixture()
        output["suggestions"]["targetRoles"] = ["chords"]
        self.assertFalse(TRAINER.valid_for_request(output, request))

    def test_unresolved_conflict_rejects_proposal_but_allows_clarification(self) -> None:
        request = request_fixture()
        request["conflicts"] = [{"role": "bass", "kind": "preserve-vs-addition"}]
        self.assertFalse(TRAINER.valid_for_request(proposal_fixture(), request))
        self.assertEqual(
            COMPARISON.request_failure_codes(proposal_fixture(), request),
            ["proposal-with-unresolved-conflict"],
        )
        clarification = {
            "version": 1,
            "status": "clarify",
            "suggestions": {},
            "unknownFields": ["roles"],
            "question": "Should the bass stay or should I add a new one?",
        }
        self.assertTrue(TRAINER.valid_for_request(clarification, request))

    def test_protected_role_failure_has_a_specific_diagnostic(self) -> None:
        request = request_fixture()
        request["requirements"]["targetRoles"] = []
        output = proposal_fixture()
        output["suggestions"]["targetRoles"] = ["bass"]
        output["suggestions"].pop("preserveRoles")
        self.assertEqual(
            COMPARISON.request_failure_codes(output, request),
            ["target-role-conflicts-with-preserve-or-prohibit"],
        )

    def test_prediction_differences_are_reported_by_field(self) -> None:
        prediction = proposal_fixture()
        expected = proposal_fixture()
        prediction["suggestions"]["mood"] = "bright"
        prediction["suggestions"].pop("genre")
        prediction["suggestions"]["style"] = "west coast"
        prediction["status"] = "clarify"
        self.assertEqual(
            COMPARISON.prediction_mismatch_codes(prediction, expected),
            ["status-mismatch", "missing-suggestion:genre", "value-mismatch:mood", "unexpected-suggestion:style"],
        )

    def test_case_diagnostic_hashes_identity_and_never_includes_prompt_or_output(self) -> None:
        row = {
            "id": "fixture-case-id",
            "language": "sk",
            "instruction": "private synthetic prompt fixture",
            "response": proposal_fixture(),
        }
        diagnostic = COMPARISON.build_case_diagnostic(row, proposal_fixture(), [])
        serialized = str(diagnostic)
        self.assertEqual(len(diagnostic["caseKey"]), 16)
        self.assertNotIn(row["id"], serialized)
        self.assertNotIn(row["instruction"], serialized)
        self.assertNotIn("suggestions", diagnostic)
        self.assertEqual(diagnostic["failureCodes"], [])
        malformed = COMPARISON.build_case_diagnostic(
            row,
            {"status": "private model output with prompt details"},
            ["invalid-schema"],
        )
        self.assertIsNone(malformed["predictedStatus"])
        self.assertNotIn("private model output", json.dumps(malformed))

    def test_evaluator_reports_reason_codes_without_recording_raw_briefs(self) -> None:
        request = request_fixture()
        conflicting_request = request_fixture()
        conflicting_request["conflicts"] = [{"role": "bass", "kind": "preserve-vs-addition"}]
        expected_clarification = {
            "version": 1,
            "status": "clarify",
            "suggestions": {},
            "unknownFields": ["roles"],
            "question": "Should the bass stay or should I add a new one?",
        }

        class FakeModel:
            device = "cpu"

            def eval(self) -> None:
                pass

            def train(self) -> None:
                pass

            def generate(self, *_args, **_kwargs) -> list[list[int]]:
                return [[1, 2, 3]]

        class FakeTokenizer:
            eos_token_id = 0

            def __init__(self) -> None:
                self.outputs = [json.dumps(proposal_fixture()), json.dumps(proposal_fixture())]

            def apply_chat_template(self, *_args, **_kwargs) -> str:
                return "private brief must not appear in diagnostics"

            def __call__(self, *_args, **_kwargs) -> SimpleNamespace:
                return SimpleNamespace(input_ids=[1, 2])

            def decode(self, *_args, **_kwargs) -> str:
                return self.outputs.pop(0)

        rows = [
            {
                "id": "synthetic-good",
                "language": "en",
                "instruction": json.dumps(request),
                "response": proposal_fixture(),
            },
            {
                "id": "synthetic-conflict",
                "language": "sk",
                "instruction": json.dumps(conflicting_request),
                "response": expected_clarification,
            },
        ]
        metrics = COMPARISON.evaluate_with_diagnostics(
            FakeModel(), FakeTokenizer(), "system", rows, 0, include_case_diagnostics=True
        )

        self.assertEqual(metrics["schemaAndSafetyValid"], 1)
        self.assertEqual(metrics["exact"], 1)
        self.assertEqual(metrics["failureCodeCounts"], {"proposal-with-unresolved-conflict": 1})
        self.assertEqual(len(metrics["caseDiagnostics"]), 2)
        self.assertNotIn("private brief must not appear", json.dumps(metrics["caseDiagnostics"]))
        self.assertNotIn("instruction", metrics["caseDiagnostics"][0])


if __name__ == "__main__":
    unittest.main(verbosity=2)
