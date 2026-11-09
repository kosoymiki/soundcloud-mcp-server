#!/usr/bin/env python3
"""Per-frame voice features to locate a speaker/phrase boundary."""
import os
import subprocess
import sys
import tempfile

import numpy as np

path = sys.argv[1]
start = float(sys.argv[2])
end = float(sys.argv[3])
SR = 44100

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

frame = int(SR * 0.030)
hop = int(SR * 0.010)
n = max(0, 1 + (x.size - frame) // hop)
rows = []
for i in range(n):
    seg = x[i * hop : i * hop + frame]
    rms = np.sqrt(np.mean(seg * seg))
    db = 20 * np.log10(max(rms, 1e-9))
    win = seg * np.hanning(seg.size)
    spec = np.abs(np.fft.rfft(win))
    freqs = np.fft.rfftfreq(seg.size, 1 / SR)
    centroid = float(np.sum(freqs * spec) / (np.sum(spec) + 1e-12))
    zcr = float(np.mean(np.abs(np.diff(np.signbit(seg).astype(int)))))
    # Autocorrelation F0 in 60-350 Hz.
    ac = np.correlate(win, win, mode="full")[win.size - 1 :]
    lo = int(SR / 350)
    hi = int(SR / 60)
    f0 = 0.0
    if hi < ac.size:
        lag = lo + int(np.argmax(ac[lo:hi]))
        if lag > 0 and ac[lag] > 0.25 * ac[0]:
            f0 = SR / lag
    rows.append((start + i * hop / SR, db, centroid, f0, zcr))

print("time_s rms_db centroid_hz f0_hz zcr")
for t, db, centroid, f0, zcr in rows:
    print(f"{t:8.3f} {db:7.1f} {centroid:8.0f} {f0:7.1f} {zcr:5.3f}")
