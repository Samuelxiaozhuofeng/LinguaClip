#!/usr/bin/env python3
"""Mix the silent picture with the score and the sound-effect plan (motion-video-kit audio rules).
Usage: python tools/mix.py out/picture.mp4 out/final.mp4 [--score media/music/175.mp3] [--no-sfx] [--music-lufs -19] [--master -16]
- music: 5 ms fade-in, 0.9 s fade-out ending on the last frame, levelled to --music-lufs integrated
- each effect: its loudest 50 ms is placed on the event time, level = local music 50 ms peak + OFF[name] dB;
  sounds within 0.15 s of the previous one are softened x0.7; the report lists each event's measured lift
  (mix vs music-only, 50 ms peak within ±0.15 s)
- master: limiter to -1 dBTP, report written next to the output (.txt)
Needs numpy + scipy (scratchpad venv)."""
import json, re, subprocess, sys
import numpy as np
from scipy.signal import butter, sosfilt

SR = 48000
args = sys.argv[1:]
pic, out = args[0], args[1]
opt = lambda k, d: args[args.index(k) + 1] if k in args else d
score = opt('--score', 'media/music/175.mp3'); music_lufs = float(opt('--music-lufs', '-19')); target = float(opt('--target', '5')); master = float(opt('--master', '-15.3'))
DUR = float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', pic], capture_output=True, text=True).stdout)
N = int(DUR * SR)

def load(p):
    return np.frombuffer(subprocess.run(['ffmpeg', '-v', 'error', '-i', p, '-ac', '1', '-ar', str(SR), '-f', 'f32le', '-'], capture_output=True).stdout, np.float32).copy()
def lufs(x, extra=''):
    e = subprocess.run(['ffmpeg', '-hide_banner', '-f', 'f32le', '-ar', str(SR), '-ac', '1', '-i', '-', '-af', 'ebur128=peak=true' + extra, '-f', 'null', '-'],
                       input=x.astype(np.float32).tobytes(), capture_output=True).stderr.decode()
    I = float(re.findall(r'I:\s+(-?[\d.]+) LUFS', e)[-1]); LRA = float(re.findall(r'LRA:\s+([\d.]+) LU', e)[-1])
    TP = float((re.findall(r'Peak:\s+(-?[\d.]+) dBFS', e) or ['nan'])[-1])
    return I, LRA, TP
def peak(y):
    h = int(.05 * SR)
    return max(10 * np.log10((y[i:i + h] ** 2).mean() + 1e-12) for i in range(0, max(1, len(y) - h), h // 2))

# ---- music ----
m = load(score)[:N]
m = np.pad(m, (0, max(0, N - len(m))))
fi, fo = int(.005 * SR), int(0.9 * SR)
m[:fi] *= np.linspace(0, 1, fi); m[-fo:] *= np.linspace(1, 0, fo) ** 1.5
I0, _, _ = lufs(m)
m *= 10 ** ((music_lufs - I0) / 20)

# ---- effects ----
# Each effect's loudest 50 ms lands on its film time; its level is set against the music's local 50 ms peak
# (OFF dB over it), so a quiet bar never makes it vanish and a loud bar never buries it.
OFF = {'whoosh': 0, 'click': 1, 'pop': 1.5, 'key': 3, 'chime': 3, 'tick': -2}
def env_peak(y):
    e = np.sqrt(np.convolve(y ** 2, np.ones(int(.05 * SR)) / int(.05 * SR), 'same'))
    return int(np.argmax(e)), 20 * np.log10(e.max() + 1e-9)
mix = m.copy(); report = []
if '--no-sfx' not in args:
    plan = json.load(open('assets/sfx/plan.json'))
    cache = {}
    last = -9
    for name, t in plan:
        s = cache.setdefault(name, load(f'assets/sfx/{name}.wav'))
        at, spk = env_peak(s)
        i = int(t * SR) - at                       # loudest moment on the event
        w = m[max(0, int(t * SR) - int(.3 * SR)): int(t * SR) + int(.3 * SR)]
        _, mpk = env_peak(w) if len(w) else (0, -40)
        g = 10 ** ((max(mpk, -30) + OFF[name] - spk) / 20)
        near = m[max(0, int((t - .15) * SR)): int((t + .15) * SR)]
        g = min(g, 10 ** ((max(env_peak(near)[1], -30) + 6 - spk) / 20))   # never more than +6 dB over the music right there
        if t - last < .15: g *= .7
        last = t
        a0 = max(0, i); s0 = s[a0 - i:]; n = min(len(s0), N - a0)
        mix[a0:a0 + n] += g * s0[:n]
        report.append([t, name, g, mpk])
    def lift(t):
        a, b = int((t - .15) * SR), int((t + .15) * SR)
        return env_peak(mix[a:b])[1] - env_peak(m[a:b])[1]
    report = [f'{t:6.2f}  {n:7s} gain {g:.3f}  music peak {mp:.1f} dB  lift {lift(t):+.1f} dB' for t, n, g, mp in report]

# ---- master: level to --master LUFS, then true-peak limiter ----
I1, _, _ = lufs(mix)
mix *= 10 ** ((master - I1) / 20)
tmp = out + '.wav'
subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'f32le', '-ar', str(SR), '-ac', '1', '-i', '-', '-af', 'alimiter=limit=0.84:level=false,aformat=channel_layouts=stereo', tmp],
               input=mix.astype(np.float32).tobytes(), check=True)
subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', pic, '-i', tmp, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '256k', '-shortest', out], check=True)
subprocess.run(['rm', tmp])
e = subprocess.run(['ffmpeg', '-hide_banner', '-i', out, '-af', 'ebur128=peak=true', '-f', 'null', '-'], capture_output=True, text=True).stderr
summary = ' | '.join(re.findall(r'(I:\s+-?[\d.]+ LUFS|LRA:\s+[\d.]+ LU|Peak:\s+-?[\d.]+ dBFS)', e)[-3:])
open(out + '.txt', 'w').write(f'score {score} music {music_lufs} LUFS target +{target} dB\n{summary}\n' + '\n'.join(report) + '\n')
print(summary)
