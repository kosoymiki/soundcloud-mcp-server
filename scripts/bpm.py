#!/usr/bin/env python3
"""Estimate tempo (BPM) from an audio file via spectral-flux autocorrelation."""
import json
import os
import subprocess
import sys
import tempfile

import numpy as np

path = sys.argv[1]
SR = 22050

tmp = tempfile.NamedTemporaryFile(suffix=".f32le", delete=False)
tmp.close()
try:
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-i", path, "-f", "f32le", "-acodec", "pcm_f32le", "-ac", "1", "-ar", str(SR), tmp.name],
        check=True,
    )
    x = np.fromfile(tmp.name, dtype=np.float32)
finally:
    try:
        os.unlink(tmp.name)
    except OSError:
        pass

frame = 1024
hop = 512
n_frames = max(0, 1 + (x.size - frame) // hop)
window = np.hanning(frame).astype(np.float32)
prev = None
flux = np.zeros(n_frames, dtype=np.float64)
for i in range(n_frames):
    seg = x[i * hop : i * hop + frame]
    mag = np.abs(np.fft.rfft(seg * window))
    if prev is not None:
        diff = np.diff(mag, prepend=0)
        flux[i] = np.sum(np.maximum(diff, 0))
    prev = mag

flux -= flux.mean()
if flux.std() > 0:
    flux /= flux.std()

min_bpm, max_bpm = 55.0, 190.0
min_lag = int(60.0 * SR / hop / max_bpm)
max_lag = int(60.0 * SR / hop / min_bpm)
corr = np.correlate(flux, flux, mode="full")[flux.size - 1 :]
best = (0.0, 0.0)
for lag in range(min_lag, min(max_lag, corr.size - 1)):
    if corr[lag] > best[1]:
        best = (lag, corr[lag])
bpm = 60.0 * SR / hop / best[0] if best[0] else 0.0
# Prefer the musically common 70-160 range by folding extremes.
while bpm and bpm < 70:
    bpm *= 2
while bpm > 160:
    bpm /= 2

print(json.dumps({
    "path": path,
    "bpm_estimate": round(float(bpm), 2),
    "duration_s": round(float(x.size / SR), 3),
    "frames": int(n_frames),
}, indent=2))
