# Bully Chaos explainer video

Re-record: `node video/record.mjs` (from the project root; needs Node 22+, ffmpeg, ffprobe, macOS `say`, Google Chrome, ports 9000/8001-8005/9333 free). Output: `~/Downloads/bully_chaos_explainer.mp4` (override with `OUT=`, `WORK=`, `STILLS=`).

- `record.mjs`: starts `control.py --slow 2`, drives headless Chrome over CDP, waits on real `/api/state`, voices every line with `say`, assembles with ffmpeg. The narration script and card text live in `T` and `CARDS` at the top; spoken numbers come from `/api/state` at run time.
- `overlay.js`: caption bar, spotlight ring and full-screen cards injected into the live dashboard.
- `storyboard.md`: the beat order.
