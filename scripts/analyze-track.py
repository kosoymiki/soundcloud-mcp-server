#!/usr/bin/env python3
"""Spectral / level analysis for a track (evidence for sound-engineering decisions)."""
import json
import subprocess
import sys
import tempfile
import os

import numpy as np

path = sys.argv[1]
SR = 44100

tmp = tempfile.NamedTemporaryFile(suffix=".f32le", delete=False)
tmp.close()
try:
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-i", path, "-f", "f32le", "-acodec", "pcm_f32le", "-ac", "2", "-ar", str(SR), tmp.name],
        check=True,
    )
    raw = np.fromfile(tmp.name, dtype=np.float32)
finally:
    try:
        os.unlink(tmp.name)
    except OSError:
        pass

samples = raw.reshape(-1, 2)
mono = samples.mean(axis=1)
n = mono.size
duration = n / SR

peak = float(np.max(np.abs(samples)))
rms = float(np.sqrt(np.mean(mono.astype(np.float64) ** 2)))
peak_db = 20 * np.log10(max(peak, 1e-9))
rms_db = 20 * np.log10(max(rms, 1e-9))
clipped = int(np.sum(np.abs(samples) >= 0.999))
clipped_pct = 100.0 * clipped / samples.size

# Average power spectrum (Welch style, 8192-point Hann frames, 50% overlap).
frame = 8192
hop = frame // 2
window = np.hanning(frame).astype(np.float32)
frames = max(0, 1 + (n - frame) // hop)
acc = np.zeros(frame // 2 + 1, dtype=np.float64)
limit = min(frames, 6000)
for i in range(limit):
    start = i * hop
    seg = mono[start : start + frame]
    if seg.size < frame:
        break
    spec = np.fft.rfft(seg * window)
    acc += np.abs(spec) ** 2
acc /= max(limit, 1)
freqs = np.fft.rfftfreq(frame, 1 / SR)

bands = {
    "sub_20_60": (20, 60),
    "bass_60_120": (60, 120),
    "lowmid_120_250": (120, 250),
    "mid_250_500": (250, 500),
    "mid_500_1k": (500, 1000),
    "upmid_1k_2k": (1000, 2000),
    "presence_2k_4k": (2000, 4000),
    "harsh_4k_6k": (4000, 6000),
    "sibilance_6k_10k": (6000, 10000),
    "air_10k_16k": (10000, 16000),
}
total = float(np.sum(acc)) or 1.0
band_db = {}
band_pct = {}
for name, (lo, hi) in bands.items():
    mask = (freqs >= lo) & (freqs < hi)
    energy = float(np.sum(acc[mask]))
    band_db[name] = round(10 * np.log10(max(energy / total, 1e-12)), 2)
    band_pct[name] = round(100.0 * energy / total, 2)

centroid = float(np.sum(freqs * acc) / total)
cum = np.cumsum(acc)
rolloff85 = float(freqs[np.searchsorted(cum, cum[-1] * 0.85)])

# Stereo correlation / width.
left, right = samples[:, 0].astype(np.float64), samples[:, 1].astype(np.float64)
denom = np.sqrt(np.sum(left * left) * np.sum(right * right)) or 1.0
correlation = float(np.sum(left * right) / denom)

print(json.dumps({
    "path": path,
    "duration_s": round(duration, 3),
    "sample_rate": SR,
    "channels": 2,
    "peak_dbfs": round(peak_db, 2),
    "rms_dbfs": round(rms_db, 2),
    "crest_db": round(peak_db - rms_db, 2),
    "clipped_samples": clipped,
    "clipped_pct": round(clipped_pct, 4),
    "spectral_centroid_hz": round(centroid, 1),
    "rolloff85_hz": round(rolloff85, 1),
    "stereo_correlation": round(correlation, 3),
    "bands_rel_db": band_db,
    "bands_pct": band_pct,
}, indent=2))
