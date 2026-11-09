#!/usr/bin/env python3
"""Print an RMS envelope for a time window to find phrase boundaries."""
import os
import subprocess
import sys
import tempfile

import numpy as np

path = sys.argv[1]
start = float(sys.argv[2])
end = float(sys.argv[3])
SR = 44100
frame_ms = 20

tmp = tempfile.NamedTemporaryFile(suffix=".f32le", delete=False)
tmp.close()
try:
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-ss", str(start), "-to", str(end), "-i", path, "-f", "f32le", "-acodec", "pcm_f32le", "-ac", "1", "-ar", str(SR), tmp.name],
        check=True,
    )
    x = np.fromfile(tmp.name, dtype=np.float32)
finally:
    try:
        os.unlink(tmp.name)
    except OSError:
        pass

n = int(SR * frame_ms / 1000)
count = x.size // n
rows = []
for i in range(count):
    seg = x[i * n : (i + 1) * n]
    rms = float(np.sqrt(np.mean(seg.astype(np.float64) ** 2)))
    db = 20 * np.log10(max(rms, 1e-9))
    rows.append((start + i * frame_ms / 1000.0, db))

peak = max(r[1] for r in rows) if rows else -120
threshold = peak - 30
print(f"peak_db={peak:.1f} threshold_db={threshold:.1f}")
for t, db in rows:
    mark = "#" if db > threshold else "."
    print(f"{t:8.3f} {db:7.1f} {mark}")
