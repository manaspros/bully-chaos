// Injected into the live dashboard by record.mjs (Runtime.evaluate). Never edits static/index.html.
// Exposes window.V: caption bar, spotlight ring, full-screen explanation cards.
(() => {
  if (window.V) return;
  const CAP_H = 104; // px reserved at the bottom so the caption never covers the dashboard
  const st = document.createElement("style");
  st.textContent = `
  body{height:calc(100vh - ${CAP_H}px) !important}
  #v-cap{position:fixed;left:0;right:0;bottom:0;height:${CAP_H}px;z-index:10003;background:#1a2229;color:#eef1ec;
    border-top:5px solid #c98a04;display:none;align-items:center;padding:0 56px;
    font:600 29px/1.3 system-ui,-apple-system,sans-serif}
  #v-spot{position:fixed;z-index:10000;border-radius:10px;pointer-events:none;display:none;
    box-shadow:0 0 0 4px #c98a04,0 0 0 9999px rgba(26,34,41,.58);
    transition:left .35s,top .35s,width .35s,height .35s}
  #v-card{position:fixed;inset:0;z-index:10001;background:#eef1ec;color:#1a2229;display:none;flex-direction:column;
    justify-content:center;padding:60px 130px ${CAP_H + 40}px;opacity:0;transition:opacity .45s;
    font-family:system-ui,-apple-system,sans-serif}
  #v-card.in{opacity:1}
  #v-card .k{font:700 20px ui-monospace,Menlo,monospace;letter-spacing:.18em;text-transform:uppercase;color:#5b6660;margin-bottom:26px}
  #v-card .h{font:700 62px/1.12 ui-monospace,Menlo,monospace;letter-spacing:-.02em;margin-bottom:44px}
  #v-card .big{font-size:128px}
  #v-card .l{font:500 38px/1.35 system-ui,-apple-system,sans-serif;margin-bottom:22px}
  #v-card .l b{font:700 30px ui-monospace,Menlo,monospace;color:#c98a04;margin-right:18px}
  #v-card .sub{font:500 40px/1.3 system-ui,sans-serif;color:#5b6660}
  #v-card .mono{font:700 36px ui-monospace,Menlo,monospace}
  #v-card .row{display:flex;align-items:center;gap:30px;margin-bottom:30px}
  #v-card .chip{flex:none;width:300px;text-align:center;color:#fff;border-radius:10px;padding:14px 0;font:700 32px ui-monospace,Menlo,monospace;letter-spacing:.04em}
  #v-card .row .t{font:500 40px/1.3 system-ui,sans-serif}
  #v-card img{max-height:560px;max-width:100%;object-fit:contain;align-self:center;border:1px solid #c9d1ca;border-radius:8px;background:#fff}
  #v-card [data-i]{opacity:0;transition:opacity .5s}
  #v-card [data-i].on{opacity:1}
  #v-card .l[data-i]{transform:translateY(14px);transition:opacity .5s,transform .5s}
  #v-card .l[data-i].on{transform:none}
  `;
  document.head.appendChild(st);
  const mk = (id) => { const e = document.createElement("div"); e.id = id; document.body.appendChild(e); return e; };
  const spot = mk("v-spot"), card = mk("v-card"), cap = mk("v-cap");
  let sel = null;
  const rectOf = (s) => {
    if (s.startsWith("lane:")) { // one node's lane, label column + plot
      const lanes = [...document.querySelectorAll("#heads .lane")];
      const r = lanes[lanes.length - +s.slice(5)].getBoundingClientRect(), t = document.getElementById("tl").getBoundingClientRect();
      return { left: t.left, top: r.top, width: t.width, height: r.height };
    }
    return document.querySelector(s).getBoundingClientRect();
  };
  const place = () => {
    if (sel) {
      const r = rectOf(sel), p = 6;
      Object.assign(spot.style, { display: "block", left: r.left - p + "px", top: r.top - p + "px",
        width: r.width + 2 * p + "px", height: r.height + 2 * p + "px" });
    } else spot.style.display = "none";
    requestAnimationFrame(place);
  };
  requestAnimationFrame(place);
  window.V = {
    cap(t) { if (t) { cap.textContent = t; cap.style.display = "flex"; } else cap.style.display = "none"; },
    spot(s) { sel = s; },
    card(html) { card.innerHTML = html; card.style.display = "flex"; void card.offsetWidth; card.classList.add("in"); },
    show(i) { card.querySelectorAll('[data-i="' + i + '"]').forEach((x) => x.classList.add("on")); },
    off() { card.classList.remove("in"); setTimeout(() => { card.style.display = "none"; }, 500); },
  };
})();
