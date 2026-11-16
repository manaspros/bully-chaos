# Bully Chaos: Self-Healing Leader Election (DS Mini Project #5)

Single source of truth for building the project and recording the demo video.
Part A = what to build. Part B = what to record. Part C = submission checklist.

---

## 0. Goal in one line

Five real node processes on one machine run the Bully algorithm to elect the
highest-ID live node as leader. A web dashboard lets us crash and revive nodes,
split the network, and unleash a Chaos-Monkey-style random killer, then watch
the cluster heal itself.

Spec coverage (what graders check, must be obvious in the video):

| Spec item | Where it lives |
|---|---|
| Simulate N nodes | N separate OS processes (`node.py`), `--nodes N` (default 5), ports 8001-800N |
| Kill a node -> new election | Dashboard "Kill" button sends a real SIGKILL; followers detect it through heartbeat timeout |
| Bully algorithm | `node.py`: ELECTION / OK / COORDINATOR messages, highest ID wins |
| Display leader status | Header line "Leader N5 for 42 s", a crown on the leader's lane, a live space-time diagram, and an event log |

Everything else (scenarios 4-9, chaos mode, metrics, leader workload) is extra.

---

## Part A: Build

### A1. Stack (decided)

- **Python 3.10+, standard library only.** Use `http.server.ThreadingHTTPServer`, `urllib.request`, `threading`, `subprocess` and `json`.
  - There is no pip and no venv, so it runs on any Ubuntu with `python3`.
  - 3.10 is the default on Ubuntu 22.04, so don't use 3.11+ features.
- **Dashboard:** one static `index.html` with vanilla JS and SVG. It polls every 300 ms. No framework and no CDN, so it works offline.
- **Communication:** HTTP + JSON between nodes. Each node is a tiny REST server.

### A2. File layout

```
ds/bully_chaos/
  PLAN.md            this file
  run.sh             one command: python3 control.py
  control.py         spawns/kills nodes, serves dashboard + control API, chaos thread, metrics
  node.py            one Bully node (REST server + election logic + heartbeats + worker)
  static/index.html  dashboard
  scenarios.py       scripted scenarios 1-8 with asserts (self-check + deterministic demo driver)
  README.md          course-format README
  group_details.txt  group number, title, names + roll numbers
  docs/architecture.png
```

### A3. Architecture

```
            Browser (dashboard, polls /api/state)
                         |
                  control.py :9000
   spawn / SIGKILL / revive | collect events | chaos thread | partition table
        |          |          |          |          |
     node1      node2      node3      node4      node5      (python3 node.py --id N)
     :8001      :8002      :8003      :8004      :8005
        <-------- HTTP: ELECTION / OK / COORDINATOR / HEARTBEAT / TASK -------->
```

- Nodes talk to each other directly. `control.py` only observes and injects faults.
- Every node POSTs each sent and received message to `control.py /event`. That feeds the log, the message animation, and the metrics.
- `control.py` is not part of the protocol: if it dies, the nodes keep electing. Say this in the video.
- **No call can stall the protocol:**
  - Every `urllib` call uses `timeout=0.5`.
  - Fan-out to peers (ELECTION, COORDINATOR, HEARTBEAT, `/whois`) runs in parallel threads.
  - `/event` reports go into a bounded `queue.Queue(maxsize=1000)`. A background thread drains it. When the queue is full, `put_nowait` drops the event, so a slow or dead `control.py` never delays an election.
- **Partitions survive restarts:** `control.py` owns the partition table and passes each node its blocked list as a spawn argument (`--blocked 3,4,5`). A node drops blocked traffic both when **sending** and when **receiving**, so the split holds even if only one side has been told about it.

### A4. Node protocol (`node.py`)

**No terms.** Bully already ranks nodes by id, so the id alone decides who leads. Nothing else is compared.

State per node, all guarded by **one `threading.Lock`**:
- `id`, `leader_id`
- `state`: FOLLOWER, CANDIDATE or LEADER
- `election_gen`: an int, explained below
- `got_ok`: set during an election when an OK arrives
- `hb_deadline`: time by which we must hear a heartbeat
- `blocked`: a set of ids

**Rule: never make a network call while holding the lock.** Read or update the state under the lock, release it, then send.

| Endpoint | Meaning |
|---|---|
| `POST /election {from}` | A lower node asks "is anyone bigger alive?". We always reply `OK`. Then: if we are LEADER, re-send `COORDINATOR` to the sender only, with no new election. If an election is already running, do nothing more. Otherwise start our own election |
| `POST /coordinator {leader}` | If `leader > our id`, accept: set `leader_id`, become FOLLOWER, `election_gen += 1` (this cancels our timers), and set `hb_deadline = now + T_HB_DEAD`. If `leader < our id`: a LEADER re-sends COORDINATOR to that node (no flapping through CANDIDATE); anyone else bullies by starting an election |
| `POST /heartbeat {leader}` | Sent from the leader to every node every `HB_INTERVAL`. See the heartbeat rules below |
| `GET /whois` | Returns `{leader_id, state}`. Used when a node rejoins |
| `POST /task` | The worker asks the leader for the next task ticket. Only the leader serves it; followers return 409 |
| `POST /partition {blocked:[ids]}` | Set by control: drop all traffic to and from these ids (simulated network split) |
| `GET /state` | Used by the dashboard, by readiness checks and to confirm a leader on rejoin |

**Election timers (stale-timer rule):** starting an election and accepting a COORDINATOR both bump `election_gen`. Each timer captures the gen it was started with, and when it fires it acts only if `election_gen` still matches. A stale timer does nothing, so there are never duplicate elections or double COORDINATOR broadcasts.

Election (classic Bully):

0. The highest id (N) skips the wait: nobody is above it, so it becomes LEADER at once.
1. Under the lock: `election_gen += 1`, `g = election_gen`, `state = CANDIDATE`, `got_ok = False`. Release the lock, then send `ELECTION` to all higher ids in parallel.
2. Timer `T_OK` fires: if gen is still `g` and no `OK` arrived, become LEADER and broadcast `COORDINATOR` to everyone in parallel.
3. If an `OK` did arrive, the timer instead arms `T_COORD`. If that fires with gen still `g` (meaning no COORDINATOR came because the higher node died mid-election), restart at step 1. This is scenario 7.

**Heartbeat rules**, when a heartbeat arrives from leader `L`:
- **We are LEADER:**
  - `L > id`: step down and adopt `L`.
  - `L < id`: ignore it. `L` will step down when it hears our heartbeat.
- **We are a follower:**
  - `L < id`: start an election (bully).
  - `L == leader_id`: reset `hb_deadline`.
  - `L > leader_id`: adopt `L` and reset `hb_deadline`.
  - `L < leader_id`: ignore it. The higher leader's own heartbeats keep us.

Together these leave exactly one leader after a partition heals (scenario 8).

Failure detection: a follower whose `hb_deadline` passes starts an election. No human trigger is involved.

Rejoin rule. On startup, set `hb_deadline = now + T_HB_DEAD`, then ask every peer `/whois` in parallel:
- Take the **highest** leader id reported. If it is higher than our id, confirm it with a direct `GET /state` on that node (it must answer with `state == LEADER`) before adopting it. No election is needed (scenario 4).
- If the confirmation fails, or no leader is higher than us, start an election. A higher returning node therefore bullies its way back (scenario 3).
- If `/whois` returned a stale answer and we adopted it anyway, the heartbeat deadline still fires and corrects us.

Timing knobs (constants at the top of `node.py`; a `--slow` flag multiplies them by 2 for video pacing):

| Constant | Default |
|---|---|
| `HB_INTERVAL` | 1.0 s |
| `T_HB_DEAD` | 3.0 s |
| `T_OK` | 1.5 s |
| `T_COORD` | 3.0 s |

Leader workload: every node runs a worker loop that requests `/task` from the leader once a second. When there is no leader, the requests fail and the dashboard shows a gap in the throughput chart. This makes "why leaders matter" visible.

### A5. Control plane (`control.py`)

| Endpoint | What it does |
|---|---|
| `GET /` | Serves the dashboard |
| `GET /api/state` | Merged state: each node's alive/role/leader, recent messages, metrics |
| `POST /api/kill/<id>` | `proc.kill()` (a real SIGKILL, a real crash, not a flag), then `proc.wait()` so the port is free before anyone revives the node |
| `POST /api/revive/<id>` | Respawns the process with the current blocked list (`--blocked`). Then polls `/state` until the node answers, for up to 3 s, and returns `{ok: true}` or `{ok: false}`. `HTTPServer` already sets `allow_reuse_address`, so the port can be reused right away |
| `POST /api/partition {groups:[[1,2],[3,4,5]]}` | Stores the partition table and sends each node its blocked list |
| `POST /api/heal` | Clears the partition table and all blocked lists |
| `POST /api/reset` | Turns chaos off, heals, and revives every dead node |
| `POST /api/chaos {on, interval}` | Chaos Monkey: every `interval` seconds, kill a random live node. With 30% probability, revive a random dead one instead. Always keep at least 1 alive |
| `POST /event` | Nodes report messages here |

Metrics:
- Elections started and completed
- Time to recover: from the leader's death to the new `COORDINATOR`
- Messages per election (shows the O(n^2) worst case)
- Leaderless downtime in seconds
- Tasks served

### A6. Dashboard (`static/index.html`)

- **Space-time diagram (replaces the ring):** one horizontal lane per node, with the highest id on top, and time scrolling left over the last 30 s × slow.
  - Lane line: thin ink for a follower, thick amber for the leader, orange while electing, dotted grey after a crash marked with ×. A tinted band means the node is partitioned.
  - Each message is a slanted arrow from sender to receiver, Lamport style, coloured by type. ELECTION arrows climb the lanes and COORDINATOR fans down, so the bully pattern is visible. Heartbeats are faint.
- **Lane head per node:** id, state, crown when leading, what it follows, and one Kill/Revive button.
- **Header:** one status sentence: "Leader N5 for 42 s", "No leader 2.1 s and counting", or "Split brain N2 + N5".
- **Global buttons:** Split [1,2 | 3,4,5], Heal, Chaos ON/OFF, Reset (`/api/reset`).
- **Panels:** live event log (newest at the top, colour-coded), metrics cards, and a throughput sparkline (tasks/sec).
- **Large fonts** so they are readable in a 1080p recording.

### A7. Self-check (`scenarios.py`)

- Drives `control.py`'s API and asserts the outcome of each scenario 1-8.
- **`reset()` runs before every scenario.** It calls `/api/reset`, then waits until leader = N has stayed stable for 2 heartbeats.
- **Assert bounds are computed from the constants, never hard-coded:**
  `BOUND = (T_HB_DEAD + HB_INTERVAL + T_OK + T_COORD) × slow + 1 s`.
  That is 9.5 s by default and 18 s with `--slow`. Scenario 7 runs two elections back to back, so it uses `2 × BOUND`.
- **Scenario 7 is scripted:** kill N5, then poll N4's `/state` every 50 ms and kill N4 as soon as its state is CANDIDATE. The candidate window is `T_OK`, which is 1.5 s (3 s with `--slow`), so the kill lands every time.
- It prints the measured recovery time for each scenario, and those are the numbers the narration uses.
- It is also the deterministic driver for the video: `python3 scenarios.py --pause` waits for Enter between scenarios.

### A8. Build order (tiers)

Do not start a tier until the previous one passes.

- **T1, the spec core:**
  - `node.py`: election, heartbeat, stale-timer rule, timeouts.
  - `control.py`: spawn, kill+wait, revive+readiness, `/api/state`, `/api/reset`, `--nodes N`.
  - `scenarios.py`: scenarios 1-3 pass.
  - Dashboard lanes and event log.
  - README and `group_details.txt`.
  - Ubuntu run test: Docker `ubuntu:22.04`, `apt install python3`, then `./run.sh`.
- **T2:** scenarios 4-8 (rejoin, double crash, crash mid-election, split brain + heal) pass 3 runs in a row, both with and without `--slow`.
- **T3, the extras:**
  - Chaos mode, metrics and task workload (scenario 9).
  - Arrow animation and the throughput sparkline.
  - Architecture diagram.

Record only after T1 and T2 pass.

---

## Part B: Video (5:00 max, target 4:30)

Recording setup:
- 1920x1080, browser at 125% zoom, dashboard full-screen.
- Start the cluster with `--slow` so the arrows are watchable.
- Close notifications.
- Terminal font 18 pt or larger.

Recording tool: the screen-recording skill Manas will provide (TBD). The team records the voice intro and narration themselves.

| Time | Segment | On screen | Narration (draft) |
|---|---|---|---|
Run `scenarios.py --slow --pause` as the driver. It calls `reset()` before every scenario. Cut the reset waits out in the edit, or say "reset" over them.

| Time | Segment | On screen | Narration (draft) |
|---|---|---|---|
| 0:00-0:20 | Intro | Title card: Group N, "Bully Chaos", member names | Group N members introduce themselves and the project name |
| 0:20-1:10 | What it does | Dashboard idle, 5 nodes, N5 has the crown | "Distributed systems need one coordinator. If it dies, the rest must agree on a new one without a human. We built the Bully algorithm on 5 real processes and attacked it Netflix-Chaos-Monkey style to prove it heals itself." Name the 3 messages: ELECTION, OK, COORDINATOR |
| 1:10-2:00 | Architecture | `docs/architecture.png`, then the code tree for 5 s | 5 node processes talking HTTP; `control.py` only watches and injects faults; heartbeats detect failure; the highest live id wins, and id alone decides, so a stale leader always yields to a higher one |
| 2:00-2:20 | Scenario 1+2: leader crash | Kill N5 and watch the arrows | "No one told them. Heartbeats stopped, and N4 won the election in [measured] seconds." Point at the throughput gap |
| 2:20-2:35 | Scenario 3: old leader returns | Revive N5 | "N5 is bigger, so it bullies its way back." |
| 2:35-2:55 | Scenario 4+5: low node returns, then double crash | Kill and revive N1, then kill N5 and N4 together | "N1 just asks who the leader is, so there is no election. Now we take out the top two: N3 takes over." |
| 2:55-3:10 | Scenario 7: crash mid-election | Scripted: the driver kills N5, then kills N4 the instant it turns orange | The OK timeout fires and the election restarts. N3 wins |
| 3:10-3:30 | Scenario 8: split brain | Split [1,2 \| 3,4,5], then Heal | Two crowns appear, then one. "Bully's real weakness" |
| 3:30-4:00 | Scenario 9: Chaos Monkey | Chaos ON for 25 s, metrics counting | "Random crashes every [interval] seconds. Leaderless time stays at [measured]%." Read the metrics aloud |
| 4:00-4:25 | Learned | Metrics frozen, or a face cam | Simple to build, but O(n^2) messages and split brain. That is why production systems use Raft or etcd (Kubernetes uses etcd leases). Timeouts are the real design knob |

Total: 4:25.

Scenario 6 (two nodes notice at once) happens naturally during chaos. Point it out if it shows up, and don't stage it.

Shots to capture separately as B-roll:
- `./run.sh` starting in the terminal
- `scenarios.py` printing all PASS
- the Ubuntu container run

Fill in the real numbers (recovery time, downtime %) from the actual run. Do not script numbers in advance.

---

## Review log (Codex review of the first draft; all 10 findings accepted)

| # | Sev | Finding | Resolution |
|---|---|---|---|
| 1 | High | Terms conflict with highest-id healing | Terms dropped; the id alone decides (§A4) |
| 2 | High | Election timers are never cancelled, so elections duplicate | One lock plus the `election_gen` stale-timer rule (§A4) |
| 3 | High | A late `/election` disrupts a healthy cluster | A leader replies OK and re-sends COORDINATOR. An election already running replies OK only (§A4) |
| 4 | High | Rejoin trusts a stale `/whois` | Take the highest reported leader, confirm it with `/state`, and set the startup heartbeat deadline (§A4) |
| 5 | High | Video scenarios leave nodes dead | `reset()` before every scenario (§A7, Part B) |
| 6 | High | Blocking HTTP eats election deadlines | 0.5 s timeouts, parallel fan-out, async event queue (§A3) |
| 7 | Med | A revived node crosses an active partition | Blocked list passed at spawn and dropped on both send and receive (§A3, §A5) |
| 8 | Med | Timing asserts are wrong under `--slow`; the scenario 7 kill is a race | Bounds computed from the constants; scenario 7 auto-kill by 50 ms polling (§A7) |
| 9 | Med | Revive races the kill and the port release | `kill()` + `wait()`; revive readiness poll (§A5) |
| 10 | Med | Scope too big, video at 4:50, N fixed | `--nodes N`, tiers T1/T2/T3, video at 4:25 (§A8, Part B) |

---

## Part C: Submission checklist

Drive folder `Group_<N>_BullyChaos/` (sharing: anyone with the link can view):

- [ ] `/code/`: the contents of `ds/bully_chaos/` (without PLAN.md)
- [ ] `/README.md`: how to run (exact commands), dependencies (python3 only), 3-5 line architecture, group details
- [ ] `/demo_video.mp4`: 5:00 or shorter
- [ ] `/group_details.txt`: group number, project title, names + roll numbers
- [ ] Ran `./run.sh` on Ubuntu 22.04
- [ ] Submitted the link in the Google Form

## Open inputs (needed from the team)

- [ ] Group number
- [ ] Member names + roll numbers
- [ ] Confirm the assignment sheet allows us to pick #5 (it may assign projects)
- [ ] Screen-recording skill
- [ ] Who narrates which segment
