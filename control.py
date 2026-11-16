#!/usr/bin/env python3
"""Control plane: spawns/kills nodes, injects partitions + chaos, collects events/metrics, serves dashboard."""
import argparse, atexit, json, os, random, signal, subprocess, sys, threading, time, urllib.request
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ap = argparse.ArgumentParser()
ap.add_argument("--nodes", type=int, default=5)
ap.add_argument("--port", type=int, default=9000)
ap.add_argument("--base-port", type=int, default=8000)
ap.add_argument("--slow", type=int, default=1, choices=[1, 2])
A = ap.parse_args()
N = A.nodes
HERE = os.path.dirname(os.path.abspath(__file__))

L = threading.Lock()    # data below
OPS = threading.RLock()  # serialises spawn/kill/revive (and chaos steps)
procs, part, cache = {}, {}, {}  # id -> Popen, id -> group index, id -> last polled row
chaos = {"on": False, "interval": 3.0, "next": 0.0}
EV, NOISY = deque(maxlen=300), deque(maxlen=300)  # NOISY: heartbeats/tasks, kept apart so they don't evict elections
M = {"started": 0, "completed": 0, "msgs": 0, "tasks": 0, "leaderless": 0.0, "rec": [], "kill_ts": None}
PER_SEC = deque([0] * 60, maxlen=60)
T0 = time.time()
closing = False


def req(port, path, body=None, timeout=0.3):
    try:
        data = None if body is None else json.dumps(body).encode()
        with urllib.request.urlopen(urllib.request.Request(
                f"http://127.0.0.1:{port}{path}", data, {"Content-Type": "application/json"}),
                timeout=timeout) as r:
            return json.loads(r.read())
    except Exception:
        return None


def pmap(f, xs):
    with ThreadPoolExecutor(len(xs) or 1) as ex:
        return list(ex.map(f, xs))


def add(type_, frm=None, to=None, text="", ts=None, **kw):
    e = {"ts": ts or time.time(), "type": type_, "from": frm, "to": to, "text": text, **kw}
    with L:
        (NOISY if type_ in ("HEARTBEAT", "TASK") else EV).append(e)
        if type_ == "STATE":
            M["started"] += kw.get("state") == "CANDIDATE"
            M["completed"] += kw.get("state") == "LEADER"
        elif type_ in ("ELECTION", "OK", "COORDINATOR"):
            M["msgs"] += 1
            if type_ == "COORDINATOR" and M["kill_ts"] and e["ts"] >= M["kill_ts"]:
                M["rec"].append(e["ts"] - M["kill_ts"])  # leader death -> next COORDINATOR
                M["kill_ts"] = None
        elif type_ == "TASK":
            M["tasks"] += kw.get("n", 0)


def blocked_of(i):  # ids in a different partition group (unlisted nodes share one group)
    return [j for j in range(1, N + 1) if j != i and part.get(j, -1) != part.get(i, -1)]


def alive_ids():
    return [i for i, p in procs.items() if p.poll() is None]


def push():
    pmap(lambda i: req(A.base_port + i, "/partition", {"blocked": blocked_of(i)}, 0.5), alive_ids())


def spawn(i):
    if closing:
        raise RuntimeError("closing")
    procs[i] = subprocess.Popen([
        sys.executable, os.path.join(HERE, "node.py"), "--id", str(i), "--nodes", str(N),
        "--base-port", str(A.base_port), "--control", f"http://127.0.0.1:{A.port}",
        "--slow", str(A.slow), "--blocked=" + ",".join(map(str, blocked_of(i)))],
        stdout=subprocess.DEVNULL)


def kill(i):
    with OPS:
        p = procs.get(i)
        if p is None or p.poll() is not None:
            return False
        s = req(A.base_port + i, "/state")
        lead, t = bool(s and s["state"] == "LEADER"), time.time()
        p.kill()  # real SIGKILL
        p.wait()  # port is free once this returns
    with L:
        cache[i] = row(i, None)
        if lead and M["kill_ts"] is None:
            M["kill_ts"] = t
    add("KILL", None, i, f"KILL N{i}" + (" (leader)" if lead else ""))
    return True


def revive(i):
    with OPS:
        p = procs.get(i)
        if p is not None and p.poll() is None:
            return False
        spawn(i)
        add("REVIVE", None, i, f"REVIVE N{i}")
        end = time.time() + 3
        while time.time() < end:
            if req(A.base_port + i, "/state"):
                return True
            time.sleep(0.05)
        return False


def heal():
    part.clear()
    push()
    add("HEAL", text="network healed")


def reset():
    chaos["on"] = False
    heal()
    for i in range(1, N + 1):
        revive(i)
    with L:
        M["kill_ts"] = None
    return len(alive_ids()) == N


def chaos_step():
    with OPS:
        if not chaos["on"]:
            return
        alive = alive_ids()
        dead = [i for i in range(1, N + 1) if i not in alive]
        if dead and (random.random() < 0.3 or len(alive) <= 1):
            i = random.choice(dead)
            add("CHAOS", None, i, f"CHAOS revives N{i}")
            revive(i)
        elif len(alive) > 1:  # always keep one alive
            i = random.choice(alive)
            add("CHAOS", None, i, f"CHAOS kills N{i}")
            kill(i)


def chaos_loop():
    while True:
        time.sleep(0.2)
        if chaos["on"] and time.time() >= chaos["next"]:
            chaos["next"] = time.time() + chaos["interval"]
            chaos_step()


def row(i, s):
    return {"id": i, "port": A.base_port + i, "alive": bool(s), "state": s["state"] if s else "DEAD",
            "leader_id": s["leader_id"] if s else None, "blocked": blocked_of(i)}


def poll_loop():
    last, last_sec, last_tasks = time.time(), time.time(), 0
    while True:
        t0 = time.time()
        rows = pmap(lambda i: row(i, req(A.base_port + i, "/state")), range(1, N + 1))
        now = time.time()
        with L:
            for r in rows:
                cache[r["id"]] = r
            if not any(r["state"] == "LEADER" for r in rows):
                M["leaderless"] += now - last
            if now - last_sec >= 1:
                PER_SEC.append(M["tasks"] - last_tasks)
                last_sec, last_tasks = now, M["tasks"]
        last = now
        time.sleep(max(0, 0.3 - (now - t0)))


def api_state():
    with L:
        nodes = [cache.get(i) or row(i, None) for i in range(1, N + 1)]
        rec = M["rec"]
        return {
            "nodes": nodes,
            "leaders": [r["id"] for r in nodes if r["state"] == "LEADER"],
            "events": sorted(list(EV) + list(NOISY), key=lambda e: e["ts"]),  # both capped at 300 each
            "metrics": {
                "elections_started": M["started"], "elections_completed": M["completed"],
                "last_recovery_s": round(rec[-1], 2) if rec else None,
                "avg_recovery_s": round(sum(rec) / len(rec), 2) if rec else None,
                "msgs_per_election": round(M["msgs"] / M["completed"], 1) if M["completed"] else None,
                "leaderless_s": round(M["leaderless"], 1), "uptime_s": round(time.time() - T0, 1),
                "tasks_served": M["tasks"], "tasks_per_sec": list(PER_SEC)},
            "chaos": {"on": chaos["on"], "interval": chaos["interval"]},
            "slow": A.slow, "n": N}


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, code, body, ctype="application/json"):
        b = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        if self.path == "/api/state":
            return self.send(200, api_state())
        if self.path in ("/", "/index.html"):
            try:
                with open(os.path.join(HERE, "static", "index.html"), "rb") as f:
                    return self.send(200, f.read(), "text/html; charset=utf-8")
            except OSError:
                return self.send(200, b"<h1>Bully Chaos</h1><p>static/index.html is missing.</p>",
                                 "text/html; charset=utf-8")
        self.send(404, {"error": "not found"})

    def do_POST(self):
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
            p = self.path.strip("/").split("/")
            if p[0] == "event":
                add(body["type"], body.get("from"), body.get("to"), body.get("text", ""), body.get("ts"),
                    **{k: body[k] for k in ("n", "state", "leader_id") if k in body})
                return self.send(200, {"ok": True})
            if p[0] != "api":
                return self.send(404, {"error": "not found"})
            if p[1] in ("kill", "revive"):
                i = int(p[2])
                if not 1 <= i <= N:
                    raise ValueError
                return self.send(200, {"ok": (kill if p[1] == "kill" else revive)(i)})
            if p[1] == "partition":
                groups = [[int(i) for i in g] for g in body["groups"]]
                if not all(1 <= i <= N for g in groups for i in g):
                    raise ValueError
                part.clear()
                part.update({i: gi for gi, g in enumerate(groups) for i in g})
                push()
                add("PARTITION", text="network split " + " | ".join(",".join(map(str, g)) for g in groups))
                return self.send(200, {"ok": True})
            if p[1] == "heal":
                heal()
                return self.send(200, {"ok": True})
            if p[1] == "reset":
                return self.send(200, {"ok": reset()})
            if p[1] == "chaos":
                chaos["interval"] = max(0.5, float(body.get("interval", chaos["interval"])))
                chaos["on"] = bool(body["on"])
                chaos["next"] = time.time() + chaos["interval"]
                add("CHAOS", text=f"chaos {'ON' if chaos['on'] else 'OFF'} every {chaos['interval']}s")
                return self.send(200, {"ok": True})
            self.send(404, {"error": "not found"})
        except (ValueError, KeyError, TypeError, IndexError, AttributeError):
            self.send(400, {"error": "bad request"})


def cleanup():
    global closing
    chaos["on"] = False
    if OPS.acquire(timeout=4):  # let an in-flight kill/revive finish, then nothing respawns
        closing = True
    for p in procs.values():
        if p.poll() is None:
            p.kill()
    for p in procs.values():
        p.wait()


if __name__ == "__main__":
    srv = ThreadingHTTPServer(("127.0.0.1", A.port), H)  # bind first: fail before spawning anything
    atexit.register(cleanup)
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    with OPS:
        for i in range(N, 0, -1):
            spawn(i)
    for f in (poll_loop, chaos_loop):
        threading.Thread(target=f, daemon=True).start()
    print(f"Bully Chaos: dashboard http://127.0.0.1:{A.port}/  ({N} nodes, slow={A.slow})", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
