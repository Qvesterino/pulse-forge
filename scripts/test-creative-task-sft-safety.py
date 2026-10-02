"""Unit tests for the Python mirror of creative-task runtime request safety."""
from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TRAINER_PATH = ROOT / "scripts" / "train-creative-task-sft.py"
SPEC = importlib.util.spec_from_file_location("creative_task_sft_trainer", TRAINER_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Could not import creative SFT trainer: {TRAINER_PATH}")
TRAINER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(TRAINER)


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
        clarification = {
            "version": 1,
            "status": "clarify",
            "suggestions": {},
            "unknownFields": ["roles"],
            "question": "Should the bass stay or should I add a new one?",
        }
        self.assertTrue(TRAINER.valid_for_request(clarification, request))


if __name__ == "__main__":
    unittest.main(verbosity=2)
