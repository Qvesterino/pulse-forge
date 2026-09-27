/*
 * pcm-gen — reference PCM source for the framed pipe transport (ADR 0018).
 *
 * Generates a DETERMINISTIC stereo float32 signal (pure sine on the absolute
 * frame index) and streams it over stdout as length-prefixed frames. Every
 * consumer of the transport — the future ASIO streaming host included — must
 * produce exactly these frames, so the whole pipe stack is testable without
 * audio hardware: the test suite spawns this, verifies sample bytes against
 * the sine formula, measures throughput and pins the seq-contiguity contract.
 *
 * Frame format (ADR 0018, all integers little-endian):
 *   offset 0  magic  "KYXP"
 *   offset 4  type   u8  (1 = PCM f32le interleaved, 2 = JSON event,
 *                         3 = JSON stats, 4 = EOF)
 *   offset 5  flags  u8  (0)
 *   offset 6  reserved u16 (0)
 *   offset 8  seq    u32 (monotonic per stream, PCM frames only)
 *   offset 12 len    u32 (payload bytes)
 *   offset 16 payload
 *
 * Usage: pcm-gen [--rate 48000] [--channels 2] [--freq 440]
 *                [--seconds 10] [--block-frames 480]
 * stdout is switched to BINARY mode — Windows text mode would mangle bytes.
 */
#include <windows.h>
#include <mmsystem.h>
#include <io.h>
#include <fcntl.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define FRAME_MAGIC 0x5058594B /* "KYXP" little-endian */
#define TYPE_PCM 1
#define TYPE_EVENT 2
#define TYPE_STATS 3
#define TYPE_EOF 4

static void writeFrame(FILE *out, unsigned char type, unsigned long seq, const void *payload, unsigned long len) {
  unsigned char header[16];
  header[0] = 'K';
  header[1] = 'Y';
  header[2] = 'X';
  header[3] = 'P';
  header[4] = type;
  header[5] = 0; /* flags */
  header[6] = 0;
  header[7] = 0; /* reserved */
  memcpy(header + 8, &seq, 4);
  memcpy(header + 12, &len, 4);
  fwrite(header, 1, sizeof(header), out);
  if (len > 0) fwrite(payload, 1, len, out);
}

static void writeJsonFrame(FILE *out, unsigned char type, const char *json) {
  writeFrame(out, type, 0, json, (unsigned long)strlen(json));
}

int main(int argc, char **argv) {
  double rate = 48000;
  long channels = 2;
  double freq = 440;
  double seconds = 10;
  long blockFrames = 480;
  int realtime = 0;

  /* Parse one argv slot at a time — standalone flags (like --realtime)
     may appear anywhere, including after the last valued option. */
  for (int i = 1; i < argc; i++) {
    if (strcmp(argv[i], "--realtime") == 0) {
      realtime = 1;
      continue;
    }
    if (i + 1 >= argc) break;
    if (strcmp(argv[i], "--rate") == 0) rate = atof(argv[i + 1]);
    else if (strcmp(argv[i], "--channels") == 0) channels = atol(argv[i + 1]);
    else if (strcmp(argv[i], "--freq") == 0) freq = atof(argv[i + 1]);
    else if (strcmp(argv[i], "--seconds") == 0) seconds = atof(argv[i + 1]);
    else if (strcmp(argv[i], "--block-frames") == 0) blockFrames = atol(argv[i + 1]);
    else continue;
    i++; /* the value token */
  }
  if (rate < 8000 || rate > 384000 || channels < 1 || channels > 8 || blockFrames < 16 || blockFrames > 65536 ||
      seconds <= 0 || seconds > 3600) {
    fprintf(stderr, "pcm-gen: parameters out of range\n");
    return 4;
  }

  /* Binary stdout or Windows silently translates bytes (CRLF mangling). */
  if (_setmode(_fileno(stdout), _O_BINARY) == -1) {
    fprintf(stderr, "pcm-gen: cannot set binary stdout\n");
    return 3;
  }

  char event[128];
  snprintf(event, sizeof(event), "{\"rate\":%ld,\"channels\":%ld,\"blockFrames\":%ld}", (long)rate, channels,
           blockFrames);
  writeJsonFrame(stdout, TYPE_EVENT, event);

  const unsigned long totalFrames = (unsigned long)(rate * seconds);
  float *block = (float *)malloc(sizeof(float) * (size_t)blockFrames * (size_t)channels);
  if (!block) {
    fprintf(stderr, "pcm-gen: out of memory\n");
    return 3;
  }

  const double twoPiFOverRate = 6.283185307179586476925286766559 * freq / rate;
  unsigned long written = 0;
  unsigned long seq = 0;
  while (written < totalFrames) {
    unsigned long frames = totalFrames - written;
    if (frames > (unsigned long)blockFrames) frames = (unsigned long)blockFrames;
    for (unsigned long n = 0; n < frames; n++) {
      const double value = 0.25 * sin(twoPiFOverRate * (double)(written + n));
      for (long ch = 0; ch < channels; ch++) block[n * channels + ch] = (float)value;
    }
    writeFrame(stdout, TYPE_PCM, seq++, block, (unsigned long)(sizeof(float) * frames * (size_t)channels));
    written += frames;
    if (realtime) Sleep((DWORD)((double)frames / rate * 1000.0 + 0.5));
  }

  char stats[128];
  snprintf(stats, sizeof(stats), "{\"framesWritten\":%lu,\"blocksWritten\":%lu}", written, seq);
  writeJsonFrame(stdout, TYPE_STATS, stats);
  writeJsonFrame(stdout, TYPE_EOF, "{}");
  fflush(stdout);
  if (realtime) timeEndPeriod(1);
  free(block);
  return 0;
}
