#!/usr/bin/env python3
"""Scripted scenarios 1-9 with asserts. Starts control.py itself unless one is already running.
   python3 scenarios.py [--slow] [--runs K] [--pause] [--only 2,7] [--port 9000]   (9 = chaos smoke, only via --only 9)"""
import argparse, json, os, subprocess, sys, time, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ap = argparse.ArgumentParser()
ap.add_argument("--slow", action="store_true")
ap.add_argument("--runs", type=int, default=1)
ap.add_argument("--pause", action="store_true", help="wait for Enter before each scenario (video driver)")
ap.add_argument("--only", default="1,2,3,4,5,6,7,8")
ap.add_argument("--port", type=int, default=9000)
A = ap.parse_args()
BASE = f"http://127.0.0.1:{A.port}"


def api(path, body=None, timeout=20):
    data = None if body is None else json.dumps(body).encode()
    with urllib.request.urlopen(urllib.request.Request(BASE + path, data, {"Content-Type": "application/json"}),
                                timeout=timeout) as r:
        return json.loads(r.read())


def up():
    try:
        return api("/api/state", timeout=1)
    except OSError:
        return None


proc = None
s0 = up()
if s0 is None:
    proc = subprocess.Popen([sys.executable, os.path.join(HERE, "control.py"), "--port", str(A.port)]
                            + (["--slow", "2"] if A.slow else []), cwd=HERE, stdout=subprocess.DEVNULL)
    for _ in range(100):
        time.sleep(0.1)
        s0 = up()
        if s0:
            break
SLOW, N = s0["slow"], s0["n"]  # a control that is already running decides the pacing
HB = 1.0 * SLOW
BOUND = (3.0 + 1.0 + 1.5 + 3.0) * SLOW + 1  # T_HB_DEAD + HB_INTERVAL + T_OK + T_COORD, + 1 s slack


def snap():
    return api("/api/state", timeout=2)


def ok(s, lid):  # exactly one leader == lid and every live node follows it
    return s["leaders"] == [lid] and all(n["leader_id"] == lid for n in s["nodes"] if n["state"] != "DEAD")


def agreed(lid):
    return ok(snap(), lid)


def wait(cond, timeout):
    t = time.time()
    while time.time() - t < timeout:
        if cond():
            return time.time() - t
        time.sleep(0.1)
    raise AssertionError(f"timeout after {timeout:.1f}s (bound)")


def kill(*ids):
    for i in ids:
        assert api(f"/api/kill/{i}", {})["ok"], f"kill {i}"


def reset():
    assert api("/api/reset", {})["ok"], "reset: not all nodes came back"
    t, end = None, time.time() + 4 * BOUND
    while time.time() < end:
        if agreed(N):
            t = t or time.time()
            if time.time() - t >= 2 * HB:
                return
        else:
            t = None
        time.sleep(0.1)
    raise AssertionError("reset: leader never stable")


def s1():
    assert agreed(N)
    return f"leader N{N}, all {N} nodes agree"


def s2():
    kill(N)
    t = wait(lambda: agreed(N - 1), BOUND)
    return f"N{N} killed, N{N - 1} leads after {t:.2f}s (bound {BOUND:.1f}s)"


def s3():
    kill(N)
    wait(lambda: agreed(N - 1), BOUND)
    assert api(f"/api/revive/{N}", {})["ok"]
    t = wait(lambda: agreed(N), BOUND)
    return f"N{N} revived and bullied back in {t:.2f}s"


def s4():
    kill(1)
    before = snap()["metrics"]["elections_started"]
    assert api("/api/revive/1", {})["ok"]
    t = wait(lambda: agreed(N), BOUND)
    time.sleep(2 * HB)
    s = snap()
    assert ok(s, N) and s["metrics"]["elections_started"] == before, "low node triggered an election"
    return f"N1 rejoined as follower in {t:.2f}s, no election"


def s5():
    kill(N, N - 1)
    t = wait(lambda: agreed(N - 2), BOUND)
    return f"N{N} and N{N - 1} killed, N{N - 2} leads after {t:.2f}s"


def s6():
    kill(N)
    seen = []

    def cond():
        s = snap()
        seen.append(len(s["leaders"]))
        return ok(s, N - 1)
    t = wait(cond, BOUND)
    for _ in range(int(2 * HB / 0.1)):
        assert agreed(N - 1), "leader flapped"
        time.sleep(0.1)
    assert max(seen) <= 1, "two leaders at once"
    return f"all followers noticed at once, one leader N{N - 1} after {t:.2f}s, stable"


def s7():
    port = snap()["nodes"][N - 2]["port"]
    kill(N)
    end = time.time() + BOUND
    while time.time() < end:  # kill N-1 the instant it turns CANDIDATE
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/state", timeout=0.3) as r:
                if json.loads(r.read())["state"] == "CANDIDATE":
                    break
        except OSError:
            pass
        time.sleep(0.05)
    else:
        raise AssertionError(f"N{N - 1} never became CANDIDATE")
    kill(N - 1)
    t = wait(lambda: agreed(N - 2), 2 * BOUND)
    return f"N{N - 1} killed mid-election, N{N - 2} leads {t:.2f}s later (bound {2 * BOUND:.1f}s)"


def s8():
    assert N >= 4, "needs >= 4 nodes"
    api("/api/partition", {"groups": [[1, 2], list(range(3, N + 1))]})
    t = wait(lambda: snap()["leaders"] == [2, N], BOUND)
    api("/api/heal", {})
    t2 = wait(lambda: agreed(N), BOUND)
    return f"split brain (N2 + N{N}) after {t:.2f}s, one leader N{N} {t2:.2f}s after heal"


def s9():
    api("/api/chaos", {"on": True, "interval": 3.0})
    time.sleep(15)
    m = snap()["metrics"]
    reset()  # also turns chaos off
    assert snap()["leaders"] == [N]
    return (f"chaos 15s: elections={m['elections_completed']} avg_recovery={m['avg_recovery_s']} "
            f"leaderless={m['leaderless_s']}s tasks={m['tasks_served']}; reset -> N{N} sole leader")


SC = {1: ("startup", s1), 2: ("leader crash", s2), 3: ("old leader returns", s3), 4: ("low node returns", s4),
      5: ("double crash", s5), 6: ("simultaneous detection", s6), 7: ("crash mid-election", s7),
      8: ("split brain + heal", s8), 9: ("chaos smoke", s9)}
fails = 0
try:
    for run in range(1, A.runs + 1):
        print(f"--- run {run}/{A.runs} (slow={SLOW}, n={N}) ---", flush=True)
        for k in (int(x) for x in A.only.split(",")):
            name, fn = SC[k]
            try:
                reset()
                if A.pause:
                    input(f"[Enter] to run scenario {k}: {name} ")
                print(f"PASS {k} {name}: {fn()}", flush=True)
            except Exception as e:  # AssertionError, URLError...
                fails += 1
                print(f"FAIL {k} {name}: {type(e).__name__}: {e}", flush=True)
    print("ALL PASS" if not fails else f"{fails} FAILED")
finally:
    if proc:
        proc.terminate()  # control.py kills its nodes on SIGTERM
        try:
            proc.wait(10)
        except subprocess.TimeoutExpired:
            proc.kill()
sys.exit(1 if fails else 0)
