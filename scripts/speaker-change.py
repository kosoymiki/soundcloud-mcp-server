#!/usr/bin/env python3
"""Hard speaker-change detection via MFCC window dissimilarity."""
import os
import subprocess
import sys
import tempfile

import numpy as np

path = sys.argv[1]
start = float(sys.argv[2])
end = float(sys.argv[3])
SR = 22050
frame = int(SR * 0.025)
hop = int(SR * 0.010)
n_mels = 26
n_mfcc = 13

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

def hz_to_mel(f):
    return 2595 * np.log10(1 + f / 700)

def mel_to_hz(m):
    return 700 * (10 ** (m / 2595) - 1)

mels = np.linspace(hz_to_mel(80), hz_to_mel(8000), n_mels + 2)
hz = mel_to_hz(mels)
bins = np.floor((frame + 1) * hz / SR).astype(int)
fb = np.zeros((n_mels, frame // 2 + 1))
for m in range(1, n_mels + 1):
    lo, mid, hi = bins[m - 1], bins[m], bins[m + 1]
    for k in range(lo, mid):
        if 0 <= k < fb.shape[1]:
            fb[m - 1, k] = (k - lo) / max(mid - lo, 1)
    for k in range(mid, hi):
        if 0 <= k < fb.shape[1]:
            fb[m - 1, k] = (hi - k) / max(hi - mid, 1)

# DCT-II matrix (orthonormal) for MFCC.
dct = np.zeros((n_mfcc, n_mels))
for k in range(n_mfcc):
    for n in range(n_mels):
        dct[k, n] = np.cos(np.pi * k * (n + 0.5) / n_mels)
dct *= np.sqrt(2.0 / n_mels)
dct[0] *= 1 / np.sqrt(2)

n_frames = max(0, 1 + (x.size - frame) // hop)
feats = []
for i in range(n_frames):
    seg = x[i * hop : i * hop + frame] * np.hanning(frame)
    spec = np.abs(np.fft.rfft(seg)) ** 2
    mel = np.log(fb @ spec + 1e-10)
    mfcc = dct @ mel
    energy = np.log(np.sum(seg ** 2) + 1e-10)
    feats.append(np.concatenate([mfcc[1:], [energy]]))
F = np.array(feats)
F = (F - F.mean(axis=0)) / (F.std(axis=0) + 1e-9)

win = int(0.40 / 0.010)
times = []
scores = []
for i in range(win, n_frames - win):
    left = F[i - win : i]
    right = F[i : i + win]
    d = np.linalg.norm(left.mean(axis=0) - right.mean(axis=0))
    times.append(start + i * hop / SR)
    scores.append(d)

order = np.argsort(scores)[::-1]
print("top_candidates:")
shown = 0
last_t = -99
for idx in order:
    t = times[idx]
    if t - last_t < 0.25:
        continue
    print(f"  t={t:.3f}s score={scores[idx]:.3f}")
    last_t = t
    shown += 1
    if shown >= 6:
        break
print("curve:")
for t, s in zip(times, scores):
    if 116.0 <= t <= 119.0 and (int(round(t * 20)) % 2 == 0):
        print(f"{t:8.3f} {s:6.3f} " + "#" * int(s * 12))
