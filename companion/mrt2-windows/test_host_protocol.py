"""Protocol smoke test for the Windows companion without model dependencies."""

from __future__ import annotations

import json
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest

from kyx_mrt2_windows_host import AUDIO_HEADER_BYTES, AUDIO_HEADER_FORMAT


HOST = Path(__file__).with_name("kyx_mrt2_windows_host.py")


def frame(frame_type: int, transport_id: str, payload: bytes = b"") -> bytes:
  identifier = transport_id.encode("utf-8")
  body = bytes((frame_type,)) + struct.pack(">H", len(identifier)) + identifier + payload
  return struct.pack(">I", len(body)) + body


class WindowsCompanionProtocolTest(unittest.TestCase):
  def test_output_packet_header_matches_shared_electron_layout(self):
    self.assertEqual(struct.calcsize(AUDIO_HEADER_FORMAT), 32)
    self.assertEqual(AUDIO_HEADER_BYTES, 32)

  def test_ready_and_unavailable_handshake_without_runtime(self):
    with tempfile.TemporaryDirectory(prefix="kyx-mrt2-host-") as model_root:
      process = subprocess.Popen(
        [sys.executable, str(HOST), "--model-root", model_root],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
      )
      try:
        ready = json.loads(process.stdout.readline().decode("utf-8"))
        self.assertEqual(ready["type"], "ready")
        self.assertEqual(ready["providerId"], "mrt2")
        message = {"version": 1, "type": "hello", "requestId": "smoke", "client": "kyx"}
        assert process.stdin is not None
        process.stdin.write(frame(0, "smoke-transport", json.dumps(message).encode("utf-8")))
        process.stdin.flush()
        assert process.stdout is not None
        header = process.stdout.read(4)
        (body_length,) = struct.unpack(">I", header)
        body = process.stdout.read(body_length)
        id_length = struct.unpack(">H", body[1:3])[0]
        response = json.loads(body[3 + id_length :].decode("utf-8"))
        self.assertEqual(response["type"], "hello.ok")
        self.assertFalse(response["supportsRealtime"])
        self.assertFalse(response["supportsCapture"])
      finally:
        if process.stdin:
          process.stdin.write(frame(3, ""))
          process.stdin.close()
        process.wait(timeout=5)
        if process.stdout:
          process.stdout.close()
        if process.stderr:
          process.stderr.close()


if __name__ == "__main__":
  unittest.main()
