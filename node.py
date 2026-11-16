#!/usr/bin/env python3
"""One Bully node: REST server + election + heartbeat + task worker. Stdlib only (3.10+)."""
import argparse, json, queue, threading, time, urllib.request
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ap = argparse.ArgumentParser()
ap.add_argument("--id", type=int, required=True)
ap.add_argument("--nodes", type=int, default=5)
ap.add_argument("--base-port", type=int, default=8000)
ap.add_argument("--control", default="http://127.0.0.1:9000")
ap.add_argument("--slow", type=int, default=1, choices=[1, 2])
ap.add_argument("--blocked", default="")
A = ap.parse_args()
me, N = A.id, A.nodes
peers = [i for i in range(1, N + 1) if i != me]
HB_INTERVAL, T_HB_DEAD, T_OK, T_COORD = (x * A.slow for x in (1.0, 3.0, 1.5, 3.0))
HTTP_TIMEOUT = 0.5

lock = threading.Lock()  # guards S; never held across a network call
S = {"state": "FOLLOWER", "leader": None, "gen": 0, "got_ok": False,
     "hb": time.time() + T_HB_DEAD, "tasks": 0}
B = {int(x) for x in A.blocked.split(",") if x}  # simulated partition; replaced, never mutated
Q = queue.Queue(maxsize=1000)  # events for control.py; dropped when full


def ev(type_, to=None, text="", **kw):
    try:
        Q.put_nowait({"ts": time.time(), "type": type_, "from": me, "to": to, "text": text, **kw})
    except queue.Full:
        pass


def drain():
    while True:
        e = Q.get()
        try:
            urllib.request.urlopen(urllib.request.Request(
                A.control + "/event", json.dumps(e).encode(),
                {"Content-Type": "application/json"}), timeout=HTTP_TIMEOUT).read()
        except Exception:
            pass


def call(to, path, body=None):
    """POST (body given) or GET to a peer; None on block/timeout/error."""
    if to in B:
        return None
    url = f"http://127.0.0.1:{A.base_port + to}{path}"
    data = None
    if body is None:
        url += f"?from={me}"
    else:
        data = json.dumps({"from": me, **body}).encode()
    try:
        with urllib.request.urlopen(urllib.request.Request(
                url, data, {"Content-Type": "application/json"}), timeout=HTTP_TIMEOUT) as r:
            return json.loads(r.read())
    except Exception:
        return None


def bg(f, *a):
    threading.Thread(target=f, args=a, daemon=True).start()


def later(delay, f, *a):
    t = threading.Timer(delay, f, a)
    t.daemon = True
    t.start()


def set_state(st, ld):  # lock held
    if (st, ld) != (S["state"], S["leader"]):
        ev("STATE", None, f"N{me} {st} leader={ld}", state=st, leader_id=ld)
    S["state"], S["leader"] = st, ld


def adopt(ld):  # lock held: follow a higher leader, cancels our timers
    S["gen"] += 1
    S["hb"] = time.time() + T_HB_DEAD
    set_state("FOLLOWER", ld)


def send_coord(p):
    if p not in B:
        ev("COORDINATOR", p, f"N{me} -> N{p} COORDINATOR")
        call(p, "/coordinator", {"leader": me})


def send_hb(p):
    if p not in B:
        ev("HEARTBEAT", p, f"N{me} -> N{p} HEARTBEAT")
        call(p, "/heartbeat", {"leader": me})


def ask(h, g):
    if h in B:
        return
    ev("ELECTION", h, f"N{me} -> N{h} ELECTION")
    if call(h, "/election", {}):
        with lock:
            if S["gen"] == g:
                S["got_ok"] = True


def start_election(idle_only=False):
    with lock:
        if idle_only and S["state"] in ("CANDIDATE", "LEADER"):
            return
        S["gen"] += 1
        g = S["gen"]
        S["state"], S["leader"], S["got_ok"] = "CANDIDATE", None, False
        ev("STATE", None, f"N{me} CANDIDATE", state="CANDIDATE", leader_id=None)
    if me == N:
        return become_leader(g)
    for h in range(me + 1, N + 1):
        bg(ask, h, g)
    later(T_OK, ok_timer, g)


def ok_timer(g):
    with lock:
        if S["gen"] != g:
            return  # stale timer
        got = S["got_ok"]
    if got:
        later(T_COORD, coord_timer, g)
    else:
        become_leader(g)


def coord_timer(g):
    with lock:
        stale = S["gen"] != g
    if not stale:  # higher node died mid-election
        start_election()


def become_leader(g):
    with lock:
        if S["gen"] != g:
            return
        set_state("LEADER", me)
    for p in peers:
        bg(send_coord, p)


def monitor():  # failure detector
    while True:
        time.sleep(0.1)
        with lock:
            due = S["state"] == "FOLLOWER" and time.time() > S["hb"]
        if due:
            start_election(True)


def hb_loop():
    while True:
        time.sleep(HB_INTERVAL)
        with lock:
            lead, n, S["tasks"] = S["state"] == "LEADER", S["tasks"], 0
        if lead:
            for p in peers:
                bg(send_hb, p)
            if n:
                ev("TASK", None, f"N{me} served {n} task(s)", n=n)


def worker():
    while True:
        time.sleep(HB_INTERVAL)
        with lock:
            st, ld = S["state"], S["leader"]
            if st == "LEADER":
                S["tasks"] += 1
        if st != "LEADER" and ld is not None:
            call(ld, "/task", {})


def rejoin():
    with ThreadPoolExecutor(len(peers) or 1) as ex:
        rs = list(ex.map(lambda p: call(p, "/whois"), peers))
    best = max([r["leader_id"] for r in rs if r and r.get("leader_id")], default=0)
    if best > me:
        s = call(best, "/state")  # don't trust a possibly stale /whois
        if s and s.get("state") == "LEADER":
            with lock:
                adopt(best)
            return
    start_election(True)


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def reply(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        path, _, q = self.path.partition("?")
        frm = int(q[5:]) if q.startswith("from=") and q[5:].isdigit() else None
        if frm in B:
            return self.reply(503, {})
        with lock:
            if path == "/whois":
                return self.reply(200, {"leader_id": S["leader"], "state": S["state"]})
            if path == "/state":
                return self.reply(200, {"id": me, "state": S["state"], "leader_id": S["leader"],
                                        "blocked": sorted(B)})
        self.reply(404, {})

    def do_POST(self):
        global B
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
            frm = body.get("from")
            if frm in B:  # simulated partition: drop on receive too
                return self.reply(503, {})
            if self.path == "/partition":
                B = {int(x) for x in body["blocked"]}
                return self.reply(200, {"ok": True})
            if self.path == "/election":
                ev("OK", frm, f"N{me} -> N{frm} OK")
                with lock:
                    lead = S["state"] == "LEADER"
                if lead:  # a leader never re-elects, it just re-announces itself
                    bg(send_coord, frm)
                else:
                    bg(start_election, True)
                return self.reply(200, {"ok": True})
            if self.path == "/coordinator":
                L = body["leader"]
                act = None
                with lock:
                    if L > me:
                        adopt(L)
                    elif L < me:
                        act = "coord" if S["state"] == "LEADER" else "elect"
                if act == "coord":
                    bg(send_coord, L)
                elif act:
                    bg(start_election, True)
                return self.reply(200, {"ok": True})
            if self.path == "/heartbeat":
                L, act = body["leader"], False
                with lock:
                    if S["state"] == "LEADER":
                        if L > me:
                            adopt(L)
                    elif L < me:
                        act = True
                    elif L == S["leader"]:
                        S["hb"] = time.time() + T_HB_DEAD
                    elif S["leader"] is None or L > S["leader"]:
                        adopt(L)
                if act:
                    bg(start_election, True)
                return self.reply(200, {"ok": True})
            if self.path == "/task":
                with lock:
                    ok = S["state"] == "LEADER"
                    if ok:
                        S["tasks"] += 1
                return self.reply(200 if ok else 409, {"ok": ok})
            self.reply(404, {})
        except (ValueError, KeyError, TypeError, AttributeError):
            self.reply(400, {})


srv = ThreadingHTTPServer(("127.0.0.1", A.base_port + me), H)
for f in (drain, monitor, hb_loop, worker, rejoin):
    bg(f)
srv.serve_forever()
