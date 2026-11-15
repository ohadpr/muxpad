# Build tour.gif from screencast frames: real timing, typing sped up, idle capped.
import json, subprocess, os, sys
D = '/private/tmp/mxd/frames'
meta = json.load(open(f'{D}/frames.json'))
fr, marks = meta['frames'], meta['marks']
W = int(os.environ.get('W', 960)); COLORS = os.environ.get('COLORS', '96'); FPS = os.environ.get('FPS', '10')
LOSSY = os.environ.get('LOSSY', '30'); CAP = float(os.environ.get('CAP', '1.2'))
end = fr[-1]['t'] + 1.5
# Drop frames whose only change is a spinner: fewer than MINPX pixels differ
# from the last kept frame (at 1/4 scale). Their time folds into the kept one.
from PIL import Image
import numpy as np
MINPX = int(os.environ.get('MINPX', '1500'))
def small(n):
    im = Image.open(f'{D}/{n:04d}.png').convert('L')
    return np.asarray(im.resize((im.width // 4, im.height // 4)), dtype=np.int16)
kept, last = [], None
for f in fr:
    a = small(f['n'])
    if last is None or (np.abs(a - last) > 12).sum() * 16 >= MINPX:
        kept.append(f); last = a
print(len(fr), '->', len(kept), 'frames')
fr = kept
lines = ['ffconcat version 1.0']
total = 0
for i, f in enumerate(fr):
    nxt = fr[i + 1]['t'] if i + 1 < len(fr) else end
    d = nxt - f['t']
    if marks['typing'] <= f['t'] < marks['sent']:
        d /= 4
    d = min(d, CAP)
    total += d
    lines.append(f"file '{D}/{f['n']:04d}.png'")
    lines.append(f'duration {d:.3f}')
lines.append(f"file '{D}/{fr[-1]['n']:04d}.png'")
open(f'{D}/list.txt', 'w').write('\n'.join(lines) + '\n')
print(f'{total:.1f}s')
out = sys.argv[1] if len(sys.argv) > 1 else '/private/tmp/mxd/tour.gif'
vf = f'fps={FPS},scale={W}:-1:flags=lanczos'
subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', f'{D}/list.txt',
                '-vf', f'{vf},palettegen=max_colors={COLORS}:stats_mode={os.environ.get('STATS','diff')}', f'{D}/pal.png'], check=True)
subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', f'{D}/list.txt', '-i', f'{D}/pal.png',
                '-lavfi', f'{vf}[x];[x][1:v]paletteuse=dither=none:diff_mode=rectangle', f'{D}/raw.gif'], check=True)
subprocess.run(['gifsicle', '-O3', f'--lossy={LOSSY}', f'{D}/raw.gif', '-o', out], check=True)
print(os.path.getsize(out) // 1024, 'KB')
