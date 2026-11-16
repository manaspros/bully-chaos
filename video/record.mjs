#!/usr/bin/env node
// Records the narrated Bully Chaos explainer from the REAL running cluster.
//   node video/record.mjs            (from anywhere; needs node >= 22, ffmpeg, ffprobe, macOS `say`, Google Chrome)
//   OUT=/path/out.mp4 WORK=/path/work STILLS=/path/stills node video/record.mjs
// Starts `control.py --slow 2`, drives headless Chrome over CDP, injects overlays (overlay.js) into the live
// dashboard, waits on real /api/state (never fixed sleeps) and aborts loudly if a wait times out.
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJ = path.resolve(HERE, "..");
const OUT = process.env.OUT || path.join(os.homedir(), "Downloads", "bully_chaos_explainer.mp4");
const WORK = process.env.WORK || path.join(os.tmpdir(), "bully_video_work");
const STILLS = process.env.STILLS || path.join(WORK, "stills");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const API = "http://127.0.0.1:9000";
const SLOW = 2, HB = 1.0 * SLOW, BOUND = ((3 + 1 + 1.5 + 3) * SLOW + 1) * 1000; // same bound as scenarios.py, in ms

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tnow = () => performance.now();
const log = (...a) => console.log(`[${((tnow() - (T0 ?? tnow())) / 1000).toFixed(1)}s]`, ...a);
let T0 = null;

// ---------------------------------------------------------------- narration text (the storyboard)
const T = {
  problem: [
    "Many systems need exactly one coordinator: one machine that hands out work, holds a lock, or decides the order of writes.",
    "But machines crash. When the coordinator dies, the others must pick a new one by themselves, with no human involved.",
  ],
  hardLead: "It is harder than it sounds, for three reasons.",
  hard: [
    "No shared memory: nodes can only send messages.",
    "A crashed node and a slow node look the same from outside.",
    "Everyone must end up agreeing on the same answer.",
  ],
  ideaLead: "The rule is simple. The node with the highest live ID always wins.",
  idea: [
    "A node that suspects the leader is dead sends ELECTION to every bigger ID. It asks: is anyone bigger alive?",
    "A bigger node that is alive answers OK. That means: stand down, I will take over.",
    "If nobody bigger answers, the node announces COORDINATOR: I am the leader.",
  ],
  arch: "We run five separate operating-system processes. Each one is a tiny web server, and they talk to each other directly over HTTP. A separate control process only watches and injects failures. It takes no part in the election, so if it dies, the nodes keep working.",
  tl: "This is the live view. Each row is one node, highest ID on top. Time moves to the right.",
  lane: "The thick amber line is the leader, N5. The faint slanted lines are heartbeats: every couple of seconds the leader tells everyone it is still alive.",
  status: "The header always answers one question: who is leading right now.",
  logl: "Every message is also logged here.",
  crash1: "Now we crash the leader. This is a real kill signal to the process, not a flag.",
  crash2: "Nobody tells the others. They only notice that the heartbeats have stopped.",
  crash3: "Look at what just happened. The timeout fired and an election started. Election messages climbed upward: each node asked the bigger ones if they were alive, and the bigger ones answered OK and took over.",
  crash5: "This gap is lost work. No leader means no progress, so recovery time is the number that matters.",
  back1: "Now N5 comes back.",
  back2: "N5 has a bigger ID, so it bullies its way back to the top. That is where the algorithm gets its name.",
  mid1: "What if the node that should win dies in the middle of the election?",
  mid1b: "We kill N5, then kill N4 the moment it starts the election.",
  mid2: "The lower nodes got an OK from N4, so they wait for its announcement. It never arrives. Their timer runs out, and they start again.",
  mid3: "N3 wins.",
  split1: "Now the hardest case. We cut the network in two. Every node is still alive; they just cannot reach each other.",
  split1b: "Both halves keep running, but each one stops hearing the other's heartbeats.",
  split2: "Each side believes the other side crashed, so each one elects its own leader. Two leaders at once. This is called split brain, and it is the real weakness of Bully.",
  split3: "When the network heals, the lower leader hears the higher one and steps down. We are back to one leader.",
  chaos1: "Finally, chaos. Like Netflix's Chaos Monkey, we kill a random node every few seconds and let the system fend for itself.",
  chaos2: "Each crash triggers a new election, and the highest live node takes over.",
  chaos3: "Watch the lanes: every cross is a crash, every orange burst is an election, and the amber line shows who leads.",
  chaos4: "Chaos off. We revived every node, and N5 is leading again.",
  take: [
    "Failure detection is a guess. A timeout cannot tell crashed from slow.",
    "Timeouts are the real design knob: too short causes false elections, too long means long outages.",
    "Without a majority rule, a network split gives you two leaders.",
    "That is why production systems like Kubernetes rely on etcd, which uses the Raft algorithm and needs a majority to elect a leader.",
  ],
};
const splitSentences = (t) => t.split(/(?<=[.?!])\s+/);

// ---------------------------------------------------------------- cards (HTML injected into #v-card)
const nodesRow = (extra = "") => {
  const cx = (i) => 90 + (i - 1) * 150;
  const circles = [1, 2, 3, 4, 5].map((i) => `<g id="n${i}"><circle cx="${cx(i)}" cy="100" r="42" fill="${i === 5 ? "#f8faf7" : "#f8faf7"}" stroke="${i === 5 ? "#c98a04" : "#1a2229"}" stroke-width="${i === 5 ? 6 : 3}"/>` +
    `<text x="${cx(i)}" y="112" text-anchor="middle" font-family="ui-monospace,Menlo,monospace" font-weight="700" font-size="32" fill="#1a2229">N${i}</text></g>`).join("");
  const crown = `<g transform="translate(${cx(5) - 22},4) scale(2)"><path d="M1 15 L3 4 L8 9 L11 1 L14 9 L19 4 L21 15 Z" fill="#c98a04"/></g>`;
  return `<svg width="760" height="160" viewBox="0 0 760 160" style="margin-bottom:30px">${circles}${crown}${extra}</svg>`;
};
const crossN5 = `<g data-i="1"><path d="M${90 + 600 - 30} 70 L${90 + 600 + 30} 130 M${90 + 600 + 30} 70 L${90 + 600 - 30} 130" stroke="#cf4a1f" stroke-width="9" stroke-linecap="round"/></g>`;
const ARCH = "data:image/png;base64," + fs.readFileSync(path.join(PROJ, "docs", "architecture.png")).toString("base64");
const CARDS = {
  title: `<div class="k">Distributed Systems project</div><div class="h big">Bully Chaos</div>
    <div class="sub" style="margin-bottom:50px">Self-healing leader election on five real processes</div>${nodesRow()}`,
  problem: `<div class="k">The problem</div><div class="h">One boss. It can crash.</div>${nodesRow(crossN5)}`,
  hard: `<div class="k">The difficulty</div><div class="h">Why this is hard</div>
    ${T.hard.map((t, i) => `<div class="l" data-i="${i}"><b>${i + 1}</b>${t}</div>`).join("")}`,
  idea: `<div class="k">The idea</div><div class="h">The Bully rule: the highest live ID wins</div>
    ${[["ELECTION", "#cf4a1f", "is anyone bigger alive?"], ["OK", "#1e776f", "yes, stand down"], ["COORDINATOR", "#463cb0", "I am the leader"]]
      .map(([n, c, t], i) => `<div class="row" data-i="${i}"><div class="chip" style="background:${c}">${n}</div><div class="t">${t}</div></div>`).join("")}`,
  arch: `<div class="k">How it is built</div><div class="h" style="font-size:46px;margin-bottom:24px">Five processes, one control plane on the side</div><img src="${ARCH}">`,
  take: `<div class="k">Takeaways</div><div class="h">What this teaches about distributed systems</div>
    ${T.take.map((t, i) => `<div class="l" data-i="${i}" style="font-size:33px"><b>${i + 1}</b>${t}</div>`).join("")}`,
  end: `<div class="h big">Bully Chaos</div><div class="mono" style="margin-bottom:40px">python3 control.py, then open localhost:9000</div>
    <div class="sub">Group &lt;N&gt;</div>`,
};

// ---------------------------------------------------------------- CDP + cluster helpers
function connect(url) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pend = new Map();
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      const p = m.id && pend.get(m.id);
      if (p) { pend.delete(m.id); m.error ? p.no(new Error(m.error.message)) : p.ok(m.result); }
    };
    ws.onerror = rej;
    ws.onopen = () => res({
      send: (method, params = {}) => new Promise((ok, no) => { const i = ++id; pend.set(i, { ok, no }); ws.send(JSON.stringify({ id: i, method, params })); }),
      close: () => ws.close(),
    });
  });
}
let cdp;
const ev = async (expression) => {
  const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true });
  if (r.exceptionDetails) throw new Error("page eval failed: " + expression.slice(0, 80) + " :: " + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
  return r.result.value;
};
const get = async (p) => (await fetch(API + p, { signal: AbortSignal.timeout(3000) })).json();
const post = async (p, b = {}) => (await fetch(API + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b), signal: AbortSignal.timeout(25000) })).json();
const agreed = (s, lid) => s.leaders.length === 1 && s.leaders[0] === lid && s.nodes.every((n) => n.state === "DEAD" || n.leader_id === lid);
async function waitFor(label, pred, timeoutMs) {
  const t = Date.now();
  for (;;) {
    const s = await get("/api/state").catch(() => null);
    if (s && pred(s)) { log(`wait ok: ${label} (${((Date.now() - t) / 1000).toFixed(1)}s)`); return s; }
    if (Date.now() - t > timeoutMs) throw new Error(`TIMEOUT (${timeoutMs / 1000}s) waiting for: ${label}`);
    await sleep(100);
  }
}
const retries = [];
async function stable5(timeoutMs = 4 * BOUND) { // leader N5 agreed by all, held for 2 heartbeats
  const end = Date.now() + timeoutMs;
  let since = null;
  while (Date.now() < end) {
    const s = await get("/api/state").catch(() => null);
    if (s && agreed(s, 5)) { since ??= Date.now(); if (Date.now() - since >= 2 * HB * 1000) return; } else since = null;
    await sleep(100);
  }
  throw new Error("TIMEOUT: leader N5 never stable");
}
async function resetCluster(label) {
  for (let a = 1; a <= 2; a++) {
    try {
      if (!(await post("/api/reset")).ok) throw new Error("reset: not all nodes came back");
      await stable5();
      log(`reset+stable ok: ${label}`);
      return;
    } catch (e) { retries.push(`${label} attempt ${a}: ${e.message}`); log("RETRY", retries.at(-1)); }
  }
  throw new Error(`reset failed twice: ${label}`);
}

// ---------------------------------------------------------------- narration
const clips = []; // {file, start(ms since T0), text}
const synthCache = new Map();
let clipN = 0;
// TTS=gemini (default when LITELLM_* env is set) uses Gemini TTS via the LiteLLM proxy; TTS=say uses macOS `say`.
const TTS = process.env.TTS || (process.env.LITELLM_BASE_URL && process.env.LITELLM_API_KEY ? "gemini" : "say");
const TTS_MODEL = process.env.TTS_MODEL || "gemini-2.5-flash-preview-tts", TTS_VOICE = process.env.TTS_VOICE || "Kore";
async function geminiTTS(text, file) {
  for (let attempt = 1; ; attempt++) {
    const r = await fetch(process.env.LITELLM_BASE_URL.replace(/\/$/, "") + "/audio/speech", {
      method: "POST", signal: AbortSignal.timeout(90000),
      headers: { Authorization: `Bearer ${process.env.LITELLM_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: TTS_MODEL, voice: TTS_VOICE, input: text, response_format: "wav" }),
    }).catch((e) => ({ ok: false, status: e.name }));
    if (r.ok) { fs.writeFileSync(file, Buffer.from(await r.arrayBuffer())); return; }
    if (attempt >= 3) throw new Error(`TTS failed (status ${r.status}) for: ${text.slice(0, 40)}`); // status only: proxy errors can echo key fragments
    await sleep(2000 * attempt);
  }
}
function synth(text) {
  if (!synthCache.has(text)) {
    synthCache.set(text, (async () => {
      const file = path.join(WORK, "clips", `c${String(clipN++).padStart(3, "0")}.${TTS === "gemini" ? "wav" : "aiff"}`);
      if (TTS === "gemini") await geminiTTS(text, file);
      else await run("say", ["-v", "Samantha", "-r", "175", "-o", file, text], { timeout: 30000 });
      const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
      return { file, dur: parseFloat(stdout) };
    })());
  }
  return synthCache.get(text);
}
const cap = (t) => ev(`V.cap(${JSON.stringify(t)})`);
const spot = (s) => ev(`V.spot(${JSON.stringify(s)})`);
async function narrate(text, { caption = true } = {}) { // one clip per sentence; hold = clip + 0.4 s
  const ss = splitSentences(text);
  const done = await Promise.all(ss.map(synth));
  for (let k = 0; k < ss.length; k++) {
    if (caption) await cap(ss[k]);
    clips.push({ file: done[k].file, start: tnow() - T0, text: ss[k] });
    await sleep(done[k].dur * 1000 + 400);
  }
}
const line = async (i, text) => { await ev(`V.show(${i})`); await narrate(text, { caption: false }); };
const marks = {};
const mark = (name, offsetS = 0) => { marks[name] = (tnow() - T0) / 1000 + offsetS; };
const card = async (name) => { await cap(null); await ev(`V.card(${JSON.stringify(CARDS[name])})`); await sleep(600); };
const cardOff = async () => { await ev("V.off()"); await sleep(600); };

// ---------------------------------------------------------------- main
let control = null, chrome = null, frameLoop = null, recording = false;
const frames = [];
const frameWrites = [];

async function main() {
  fs.rmSync(WORK, { recursive: true, force: true });
  for (const d of ["clips", "frames"]) fs.mkdirSync(path.join(WORK, d), { recursive: true });
  fs.mkdirSync(STILLS, { recursive: true });
  const spokenSetup = [T.problem, T.hardLead, T.hard, T.ideaLead, T.idea, T.arch, T.tl, T.lane, T.status, T.logl, T.crash1, T.crash2, T.crash3,
    T.crash5, T.back1, T.back2, T.mid1, T.mid1b, T.mid2, T.mid3, T.split1, T.split1b, T.split2, T.split3, T.chaos1, T.chaos2, T.chaos3, T.chaos4, T.take,
    "N4 is now the highest live node, so it announces itself to everyone."].flat(); // static half of the heal line
  const pending = spokenSetup.flatMap(splitSentences);
  const width = TTS === "gemini" ? 4 : 1; // parallel `say` hangs; the proxy is fine with 4
  log(`TTS: ${TTS}${TTS === "gemini" ? ` (${TTS_MODEL}, ${TTS_VOICE})` : ""}, pre-synthesizing ${pending.length} lines`);
  for (let k = 0; k < pending.length; k += width) await Promise.all(pending.slice(k, k + width).map(synth));

  control = spawn("python3", ["control.py", "--slow", "2"], { cwd: PROJ, stdio: "ignore" });
  await waitFor("control.py up", () => true, 15000);

  chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=9333", "--window-size=1536,864", "--force-device-scale-factor=1.25",
    "--no-first-run", "--hide-scrollbars", "--mute-audio", "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows", `--user-data-dir=${path.join(WORK, "chrome-profile")}`, API + "/"], { stdio: "ignore" });
  let target;
  for (let i = 0; i < 100 && !target; i++) {
    try { target = (await (await fetch("http://127.0.0.1:9333/json")).json()).find((t) => t.type === "page" && t.url.startsWith(API)); } catch {}
    if (!target) await sleep(200);
  }
  if (!target) throw new Error("Chrome page target not found");
  cdp = await connect(target.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1536, height: 864, deviceScaleFactor: 1.25, mobile: false });
  // inject only after the dashboard finished loading, else the navigation wipes the overlay global
  for (let i = 0; i < 100 && !(await ev(`document.readyState === "complete" && !!document.querySelector(".lane")`)); i++) await sleep(200);
  await ev(fs.readFileSync(path.join(HERE, "overlay.js"), "utf8"));
  if (!(await ev(`typeof V === "object"`))) throw new Error("overlay did not inject");
  await ev(`V.card(${JSON.stringify(CARDS.title)})`);
  await sleep(1200);

  // frame capture loop, real time (the dashboard scrolls with the wall clock)
  recording = true;
  T0 = tnow();
  frameLoop = (async () => {
    for (let i = 0; recording; i++) {
      const t1 = tnow();
      const r = await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 85 });
      frames.push((t1 + tnow()) / 2);
      frameWrites.push(fs.promises.writeFile(path.join(WORK, "frames", `${String(i).padStart(6, "0")}.jpg`), Buffer.from(r.data, "base64")));
    }
  })();

  // 0 title (the cluster elects N5 and settles behind the card)
  mark("title", 1.5);
  await Promise.all([sleep(4000), stable5()]);

  // 1 problem
  await cardOff(); await card("problem"); mark("problem", 8);
  await narrate(T.problem[0]);
  await ev("V.show(1)");
  await narrate(T.problem[1]);

  // 2 why hard
  await cardOff(); await card("hard");
  await narrate(T.hardLead, { caption: false });
  for (let i = 0; i < 3; i++) await line(i, T.hard[i]);
  mark("hard", -1);

  // 3 idea
  await cardOff(); await card("idea");
  await narrate(T.ideaLead, { caption: false });
  for (let i = 0; i < 3; i++) await line(i, T.idea[i]);
  mark("idea", -1);

  // 4 architecture
  await cardOff(); await card("arch"); mark("arch", 2);
  await narrate(T.arch);

  // 5 live tour
  await cardOff(); await cap(null);
  mark("tour_tl", 2);
  await spot("#tl"); await narrate(T.tl);
  await spot("lane:5"); mark("tour_lane", 3); await narrate(T.lane);
  await spot("#status"); await narrate(T.status);
  await spot("#log"); await narrate(T.logl);

  // 6 leader crash
  await resetCluster("pre-crash");
  const nums = {};
  await spot("lane:5"); await narrate(T.crash1);
  await post("/api/kill/5"); await spot(null); log("KILLED N5"); mark("crash", 1);
  await narrate(T.crash2);
  await waitFor("any node CANDIDATE", (s) => s.nodes.some((n) => n.state === "CANDIDATE"), BOUND);
  await spot("#tl"); mark("election", 5);
  const healP = waitFor("leader N4 + last_recovery_s", (s) => agreed(s, 4) && s.metrics.last_recovery_s != null, BOUND).then(async (s) => {
    nums.last_recovery_s = s.metrics.last_recovery_s; // pre-synthesize the number line while crash3 is still being spoken
    const txt = `N4 is now the highest live node, so it announces itself to everyone. The cluster healed in ${nums.last_recovery_s.toFixed(1)} seconds, with no human involved.`;
    await Promise.all(splitSentences(txt).map(synth));
    return txt;
  });
  await narrate(T.crash3);
  const healTxt = await healP;
  await spot("#status"); mark("healed", 4);
  await narrate(healTxt);
  await spot("#spark"); await narrate(T.crash5);
  await spot(null);

  // 7 old leader returns
  await narrate(T.back1);
  await post("/api/revive/5"); log("REVIVED N5");
  await waitFor("leader N5 agreed", (s) => agreed(s, 5), BOUND);
  await spot("#tl"); mark("return", 3);
  await narrate(T.back2);
  await spot(null);

  // 8 crash mid-election
  const rp = resetCluster("pre-mid-election");
  await Promise.all([rp, narrate(T.mid1)]);
  await spot("#tl");
  await post("/api/kill/5"); log("KILLED N5 (mid-election scenario)");
  const watcher = (async () => { // same approach as scenarios.py s7: kill N4 the instant it is CANDIDATE
    const end = Date.now() + BOUND;
    while (Date.now() < end) {
      try {
        const r = await fetch("http://127.0.0.1:8004/state", { signal: AbortSignal.timeout(300) });
        if ((await r.json()).state === "CANDIDATE") { await post("/api/kill/4"); log("KILLED N4 while CANDIDATE"); return; }
      } catch {}
      await sleep(50);
    }
    throw new Error("N4 never became CANDIDATE");
  })();
  await Promise.all([watcher, narrate(T.mid1b)]);
  await narrate(T.mid2); mark("mid", -3);
  await waitFor("leader N3 agreed (N4,N5 dead)", (s) => agreed(s, 3), 2 * BOUND);
  await narrate(T.mid3);
  await spot(null);

  // 9 split brain
  await Promise.all([resetCluster("pre-split"), narrate(T.split1)]);
  await post("/api/partition", { groups: [[1, 2], [3, 4, 5]] }); log("PARTITION");
  await spot("#tl");
  await narrate(T.split1b);
  await waitFor("two leaders", (s) => s.leaders.length === 2, 2 * BOUND);
  await spot("#status"); mark("split", 4);
  await narrate(T.split2);
  await post("/api/heal"); log("HEAL"); await spot("#tl");
  await cap("Network healed: waiting for the lower leader to hear the higher one");
  await waitFor("single leader N5 after heal", (s) => agreed(s, 5), 2 * BOUND);
  await narrate(T.split3);
  await spot(null);

  // 10 chaos monkey
  await Promise.all([resetCluster("pre-chaos"), narrate(T.chaos1)]);
  const CHAOS_CAP = "Chaos Monkey: a random crash every 4 seconds";
  await cap(CHAOS_CAP);
  await post("/api/chaos", { on: true, interval: 4 }); log("CHAOS ON");
  const c0 = tnow();
  await sleep(4000); mark("chaos", 0);
  await narrate(T.chaos2);
  await spot("#tl"); await narrate(T.chaos3); await spot(null); await cap(CHAOS_CAP);
  await sleep(Math.max(0, 20000 - (tnow() - c0)));
  await post("/api/chaos", { on: false, interval: 4 }); log("CHAOS OFF");
  await cap("Chaos off: reviving every node");
  await resetCluster("post-chaos");
  const m = (await get("/api/state")).metrics; // read after the reset settles, so spoken numbers match the panel on screen
  nums.leaderless_s = m.leaderless_s; nums.msgs_per_election = m.msgs_per_election;
  const parts = [];
  if (m.leaderless_s != null) parts.push(`the cluster had spent ${m.leaderless_s.toFixed(1)} seconds in total without a leader`);
  if (m.msgs_per_election != null) parts.push(`each election cost about ${Math.round(m.msgs_per_election)} messages`);
  const readTxt = parts.length ? `Across this whole run, ${parts.join(", and ")}.` : null;
  const readP = readTxt ? Promise.all(splitSentences(readTxt).map(synth)) : null;
  await narrate(T.chaos4); // covers the synth latency of the number line
  if (readP) await readP; // synth first so the caption never lags the spotlight
  await spot("#readout"); mark("readout", 1);
  if (readTxt) await narrate(readTxt);
  await spot(null);

  // 11 takeaways, 12 end
  await cap(null);
  await card("take");
  for (let i = 0; i < 4; i++) await line(i, T.take[i]);
  mark("take", 0);
  await sleep(2500);
  await cardOff(); await card("end"); mark("end", 2);
  await sleep(3000);
  const tEnd = tnow();
  recording = false;
  await frameLoop; await Promise.all(frameWrites);
  return { tEnd, nums };
}

async function assemble(tEnd, nums) {
  const total = (tEnd - T0) / 1000;
  const list = [];
  const fp = (i) => path.join(WORK, "frames", `${String(i).padStart(6, "0")}.jpg`);
  frames.forEach((ts, i) => {
    const d = (i + 1 < frames.length ? frames[i + 1] : tEnd) - (i === 0 ? T0 : ts);
    list.push(`file '${fp(i)}'`, `duration ${Math.max(d, 1) / 1000}`);
  });
  list.push(`file '${fp(frames.length - 1)}'`);
  fs.writeFileSync(path.join(WORK, "frames.txt"), list.join("\n"));
  const K = clips.length;
  const aud = clips.map((c, k) => `[${k + 1}:a]aresample=48000,adelay=${Math.round(c.start)}:all=1[a${k}]`).join(";");
  const fc = `[0:v]fps=30,scale=1920:1080:flags=lanczos,format=yuv420p[v];${aud};` +
    clips.map((_, k) => `[a${k}]`).join("") + `amix=inputs=${K}:normalize=0:duration=longest,apad=whole_dur=${total.toFixed(3)},atrim=0:${total.toFixed(3)}[a]`;
  await run("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", path.join(WORK, "frames.txt"),
    ...clips.flatMap((c) => ["-i", c.file]), "-filter_complex", fc, "-map", "[v]", "-map", "[a]",
    "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-r", "30", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", "-t", total.toFixed(3), OUT],
  { maxBuffer: 1 << 26 });
  const dur = async (sel) => parseFloat((await run("ffprobe", ["-v", "error", "-select_streams", sel, "-show_entries", "stream=duration", "-of", "csv=p=0", OUT])).stdout);
  const vd = await dur("v:0"), ad = await dur("a:0");
  const lastClip = clips.at(-1), audioTimeline = lastClip.start / 1000 + (await synth(lastClip.text)).dur;
  for (const [n, t] of Object.entries(marks)) {
    await run("ffmpeg", ["-y", "-loglevel", "error", "-ss", String(Math.max(0, t)), "-i", OUT, "-frames:v", "1", path.join(STILLS, `${n}.png`)]);
  }
  const report = { out: OUT, total_s: +total.toFixed(2), video_s: vd, audio_s: ad, audio_speech_end_s: +audioTimeline.toFixed(2),
    frames: frames.length, avg_fps: +(frames.length / total).toFixed(1), clips: K, numbers_spoken: nums, retries, marks };
  fs.writeFileSync(path.join(WORK, "report.json"), JSON.stringify(report, null, 1));
  console.log(JSON.stringify(report, null, 1));
  if (Math.abs(vd - total) > 0.5 || Math.abs(ad - total) > 0.5) throw new Error("A/V duration mismatch > 0.5 s");
}

const count = async (re) => { try { return (await run("pgrep", ["-f", re])).stdout.trim().split("\n").filter(Boolean).length; } catch { return 0; } };
let ok = false;
try {
  const { tEnd, nums } = await main();
  await assemble(tEnd, nums);
  ok = true;
} catch (e) {
  console.error("FAILED:", e.message);
} finally {
  recording = false;
  try { cdp?.close(); } catch {}
  chrome?.kill("SIGTERM");
  if (control) {
    control.kill("SIGTERM");
    await Promise.race([new Promise((r) => control.once("exit", r)), sleep(10000)]);
  }
  await sleep(500);
  console.log(`leftover processes: control.py=${await count("[c]ontrol\\.py")} node.py=${await count("[n]ode\\.py --id")} chrome-9333=${await count("remote-debugging-port=[9]333")}`);
}
process.exit(ok ? 0 : 1);
