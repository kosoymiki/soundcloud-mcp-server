#!/usr/bin/env python3
"""Fine 5ms RMS around a candidate boundary."""
import os
import subprocess
import sys
import tempfile

import numpy as np

path = sys.argv[1]
start = float(sys.argv[2])
end = float(sys.argv[3])
SR = 44100
ms = float(sys.argv[4]) if len(sys.argv) > 4 else 5.0

tmp = tempfile.NamedTemporaryFile(suffix=".f32le", delete=False)
tmp.close()
try:
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-ss", str(start), "-to", str(end), "-i", path, "-f", "f32le", "-acodec", "pcm_f32le", "-ac", "1", "-ar", str(SR), tmp.name],
        check=True,
    )
    x = np.fromfile(tmp.name, dtype=np.float32).astype(np.float64)
finally:
    try:
        os.unlink(tmp.name)
    except OSError:
        pass

n = int(SR * ms / 1000)
count = x.size // n
for i in range(count):
    seg = x[i * n : (i + 1) * n]
    rms = np.sqrt(np.mean(seg * seg))
    db = 20 * np.log10(max(rms, 1e-9))
    peak = np.max(np.abs(seg))
    print(f"{start + i * ms / 1000:9.4f} {db:7.1f} peak={peak:6.3f}")
