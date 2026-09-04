/**
 * The hero band: the thesis, and the two controls that act on it. One primary
 * and one plain link, not equals — the address input moved to /scan because a
 * form short enough to sit under a headline cannot show its own settings, and
 * the run mode is the most consequential control in the product.
 *
 * THE EXAMPLE CARD IS A QUOTATION, NOT A PREVIEW. Every figure is read from
 * calibration/reports/compound-comet-cusdcv3.json at block 25,800,000, and the
 * card carries the address and block it was measured at, because nothing here
 * may look like a result the visitor's own run has not produced.
 *
 * THE SOURCE REPORT MUST BE PUBLISHABLE. The first draft quoted sUSDe, whose
 * report the disclosure gate blocks — putting its figures on the front page
 * would have published exactly what the gate withholds. The figures are
 * hardcoded strings because that is what a quotation is, and verify-claims.mjs
 * re-derives every one. No verdict is computed here.
 *
 * The background is a sparse authority graph whose query walks a CONNECTED PATH
 * of edges — the visual echo of authority.ts resolving an upgrade path.
 */
import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";

type View = "auditors" | "depositors";

const SUBHEAD: Record<View, string> = {
  auditors:
    "Ripcord traces privileged authority over a contract, tests on a sandbox fork what that power can actually move, and compares the shortest notice route with the time it takes users to leave.",
  depositors:
    "Ripcord traces who can still change the vault you are in, tests on a sandbox fork whether they can close its exit, and compares their fastest route with your time to leave.",
};

/**
 * Quoted from calibration/reports/compound-comet-cusdcv3.json. Changing any of
 * these means re-reading that report, not editing the string — the point of a
 * quotation is that somewhere a source says the same thing, and
 * scripts/verify-claims.mjs fails the build if one stops being true.
 *
 * The pair is the whole thesis in two numbers: the upgrade path carries two days
 * of notice, and the exit itself can be shut with none. Different routes, and
 * the window is the minimum.
 */
const EXAMPLE = {
  protocol: "Compound III",
  address: "0xc3d688B66703497DAA19211EEdff47f25384cdc3",
  block: "25,800,000",
  notice: "2D",
  exitCloses: "0s",
  proofUsd: "$540M",
  timeToExit: "0s",
  routes: "2",
  verdict: "No notice",
  statement: "a fork-confirmed restrictor can close the exit with no warning.",
} as const;

export function Hero({
  onScan,
  onOpenSample,
  liveDisabled,
  liveDisabledReason,
}: {
  onScan: () => void;
  /**
   * Null when this deployment has no publishable sample to open. The link is
   * then not rendered at all — a dead "see a sample report" is worse than none.
   */
  onOpenSample: (() => void) | null;
  /**
   * A deployment with no RPC can still show this page and still open saved
   * reports. The button stays reachable and the scan page states the reason,
   * because an outage in OUR infrastructure must never be presented as a
   * property of a contract.
   */
  liveDisabled: boolean;
  liveDisabledReason: string | null;
}): ReactElement {
  const [view, setView] = useState<View>("auditors");
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");

    type Node = { x: number; y: number; vx: number; vy: number; r: number; focal: boolean; phase: number };
    type Link = { a: Node; b: Node; strength: number };
    type Pulse = { path: Node[]; t: number };

    let W = 0;
    let H = 0;
    let reach = 134;
    let nodes: Node[] = [];
    let links: Link[] = [];
    let pulse: Pulse | null = null;
    let nextPulse = 0;
    let raf = 0;
    let last = 0;
    let clock = 0;
    let resizeTimer = 0;

    const SEG_MS = 230;
    const TAIL_MS = 520;

    function build(): void {
      const rect = canvas!.getBoundingClientRect();
      W = Math.max(1, rect.width);
      H = Math.max(1, rect.height);

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas!.width = Math.round(W * dpr);
      canvas!.height = Math.round(H * dpr);
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);

      // Fewer, larger, further-reaching nodes on a narrow viewport so the graph
      // stays a legible constellation instead of collapsing into noise.
      const narrow = W < 760;
      reach = narrow ? 172 : 134;
      const density = narrow ? 30000 : 16500;
      const count = Math.max(22, Math.min(115, Math.round((W * H) / density)));

      nodes = [];
      for (let i = 0; i < count; i++) {
        nodes.push({
          x: Math.random() * W,
          y: Math.random() * H,
          vx: (Math.random() - 0.5) * 0.07,
          vy: (Math.random() - 0.5) * 0.07,
          r: narrow ? 1.6 + Math.random() * 1.6 : 0.85 + Math.random() * 1.45,
          focal: Math.random() < 0.085,
          phase: Math.random() * Math.PI * 2,
        });
      }

      pulse = null;
      nextPulse = clock + 1200;
    }

    function computeLinks(): void {
      links = [];
      const r2 = reach * reach;
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i] as Node;
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j] as Node;
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < r2) links.push({ a, b, strength: 1 - Math.sqrt(d2) / reach });
        }
      }
    }

    function pick<T>(items: T[]): T | null {
      return items.length === 0 ? null : (items[(Math.random() * items.length) | 0] ?? null);
    }

    function makePulse(): Pulse | null {
      if (links.length < 4) return null;

      const adj = new Map<Node, Node[]>();
      for (const link of links) {
        const forA = adj.get(link.a) ?? [];
        forA.push(link.b);
        adj.set(link.a, forA);
        const forB = adj.get(link.b) ?? [];
        forB.push(link.a);
        adj.set(link.b, forB);
      }

      const seed = pick(links);
      if (!seed) return null;

      const path: Node[] = [seed.a, seed.b];
      const hops = 2 + ((Math.random() * 3) | 0);

      while (path.length < hops + 1) {
        const head = path[path.length - 1];
        if (!head) break;
        const next = pick((adj.get(head) ?? []).filter((n) => !path.includes(n)));
        if (!next) break;
        path.push(next);
      }

      if (path.length < 3) return null;
      return { path, t: 0 };
    }

    function drawPulse(): void {
      if (!pulse) return;
      const edges = pulse.path.length - 1;
      const walk = edges * SEG_MS;
      const idx = Math.min(edges - 1, Math.floor(pulse.t / SEG_MS));
      const frac = Math.min(1, (pulse.t - idx * SEG_MS) / SEG_MS);
      const fade = pulse.t <= walk ? 1 : Math.max(0, 1 - (pulse.t - walk) / TAIL_MS);

      ctx!.lineCap = "round";

      for (let s = 0; s <= idx; s++) {
        const a = pulse.path[s];
        const b = pulse.path[s + 1];
        if (!a || !b) continue;
        const alpha = Math.max(0, 0.5 - (idx - s) * 0.11) * fade;
        if (alpha <= 0.01) continue;
        ctx!.strokeStyle = `rgba(91,157,255,${alpha.toFixed(3)})`;
        ctx!.lineWidth = 1;
        ctx!.beginPath();
        ctx!.moveTo(a.x, a.y);
        ctx!.lineTo(b.x, b.y);
        ctx!.stroke();
      }

      const from = pulse.t <= walk ? pulse.path[idx] : undefined;
      const to = pulse.t <= walk ? pulse.path[idx + 1] : undefined;
      if (from && to) {
        const ease = frac < 0.5 ? 2 * frac * frac : 1 - Math.pow(-2 * frac + 2, 2) / 2;
        const hx = from.x + (to.x - from.x) * ease;
        const hy = from.y + (to.y - from.y) * ease;

        ctx!.strokeStyle = "rgba(231,237,228,0.7)";
        ctx!.lineWidth = 1.1;
        ctx!.beginPath();
        ctx!.moveTo(from.x, from.y);
        ctx!.lineTo(hx, hy);
        ctx!.stroke();

        ctx!.fillStyle = "rgba(231,237,228,0.95)";
        ctx!.beginPath();
        ctx!.arc(hx, hy, 1.9, 0, 6.2832);
        ctx!.fill();
      }

      ctx!.lineCap = "butt";
    }

    function draw(): void {
      ctx!.clearRect(0, 0, W, H);

      ctx!.lineWidth = 1;
      for (const link of links) {
        ctx!.strokeStyle = `rgba(231,237,228,${(link.strength * 0.17).toFixed(3)})`;
        ctx!.beginPath();
        ctx!.moveTo(link.a.x, link.a.y);
        ctx!.lineTo(link.b.x, link.b.y);
        ctx!.stroke();
      }

      drawPulse();

      for (const n of nodes) {
        const alpha = n.focal ? 0.66 + 0.28 * Math.sin(clock / 1500 + n.phase) : 0.3;
        ctx!.fillStyle = `rgba(231,237,228,${alpha.toFixed(3)})`;
        ctx!.beginPath();
        ctx!.arc(n.x, n.y, n.r, 0, 6.2832);
        ctx!.fill();

        if (n.focal) {
          ctx!.strokeStyle = "rgba(231,237,228,0.16)";
          ctx!.beginPath();
          ctx!.arc(n.x, n.y, n.r + 3.2, 0, 6.2832);
          ctx!.stroke();
        }
      }
    }

    function frame(now: number): void {
      const dt = Math.min(48, now - last);
      last = now;
      clock += dt;

      const step = dt / 16.6667;
      for (const n of nodes) {
        n.x += n.vx * step;
        n.y += n.vy * step;
        if (n.x < -30) n.x = W + 30;
        else if (n.x > W + 30) n.x = -30;
        if (n.y < -30) n.y = H + 30;
        else if (n.y > H + 30) n.y = -30;
      }

      computeLinks();

      if (pulse) {
        pulse.t += dt;
        if (pulse.t > (pulse.path.length - 1) * SEG_MS + TAIL_MS) {
          pulse = null;
          nextPulse = clock + 2200 + Math.random() * 3400;
        }
      } else if (clock >= nextPulse) {
        pulse = makePulse();
        if (!pulse) nextPulse = clock + 900;
      }

      draw();
      raf = window.requestAnimationFrame(frame);
    }

    function stop(): void {
      if (raf) {
        window.cancelAnimationFrame(raf);
        raf = 0;
      }
    }

    function start(): void {
      stop();
      if (reduce.matches) {
        computeLinks();
        draw();
        return;
      }
      last = window.performance.now();
      raf = window.requestAnimationFrame(frame);
    }

    function reset(): void {
      build();
      start();
    }

    function onResize(): void {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(reset, 160);
    }

    function onVisibility(): void {
      if (document.hidden) stop();
      else if (!reduce.matches) {
        last = window.performance.now();
        start();
      }
    }

    window.addEventListener("resize", onResize);
    document.addEventListener("visibilitychange", onVisibility);
    reduce.addEventListener("change", reset);
    reset();

    // StrictMode mounts this effect twice in development. Every listener, the
    // frame loop and the pending resize timer are torn down here, so the second
    // mount starts from nothing rather than running a second loop on the same
    // canvas.
    return () => {
      stop();
      window.clearTimeout(resizeTimer);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", onVisibility);
      reduce.removeEventListener("change", reset);
    };
  }, []);

  return (
    <section className="hb" aria-labelledby="hb-headline">
      <canvas className="hb-net" ref={canvasRef} aria-hidden="true" />
      <div className="hb-veil" aria-hidden="true" />

      <div className="hb-frame">
        <div className="hb-top">
          <p className="hb-eyebrow">
            <b>Privilege-path analysis</b> · Ethereum
          </p>
          <div className="hb-segmented" role="group" aria-label="Point of view">
            {(["auditors", "depositors"] as const).map((v) => (
              <button
                key={v}
                type="button"
                className="hb-seg"
                aria-pressed={view === v}
                onClick={() => setView(v)}
              >
                {v === "auditors" ? "Auditors" : "Depositors"}
              </button>
            ))}
          </div>
        </div>

        <div className="hb-stage">
          <div className="hb-copy">
            <h1 className="hb-headline" id="hb-headline">
              <span className="hb-setup">Audits check the code.</span>{"\u00a0"}
              Ripcord checks who can <span className="hb-emphasis">close the exit.</span>
            </h1>

            <p className="hb-sub">{SUBHEAD[view]}</p>

            <div className="hb-actions">
              <button className="hb-btn" type="button" onClick={onScan}>
                Scan an address
              </button>
              {onOpenSample && (
                <button className="hb-link" type="button" onClick={onOpenSample}>
                  See a sample report
                </button>
              )}
            </div>

            <p className="hb-help">
              {liveDisabled && liveDisabledReason
                ? liveDisabledReason
                : "No wallet connection is needed. Ripcord signs nothing and sends no mainnet transaction."}
            </p>
          </div>

          <aside className="hb-card" aria-label="Example result, quoted from a committed report">
            <div className="hb-card-meta">
              <span>Example · {EXAMPLE.protocol}</span>
              <span>Block {EXAMPLE.block}</span>
            </div>

            <div className="hb-card-top">
              <p className="hb-figure">
                {EXAMPLE.notice} <span className="hb-vs">vs</span> {EXAMPLE.exitCloses}
              </p>
              <p className="hb-card-label">Notice on a rule change vs. notice before the exit closes</p>

              <div className="hb-stats">
                <div className="hb-stat">
                  <div className="hb-stat-v">{EXAMPLE.proofUsd}</div>
                  <div className="hb-stat-k">moved on a fork</div>
                </div>
                <div className="hb-stat">
                  <div className="hb-stat-v">{EXAMPLE.timeToExit}</div>
                  <div className="hb-stat-k">time-to-exit</div>
                </div>
                <div className="hb-stat">
                  <div className="hb-stat-v">{EXAMPLE.routes}</div>
                  <div className="hb-stat-k">routes</div>
                </div>
              </div>
            </div>

            <div className="hb-card-bottom">
              <span className="hb-chip">{EXAMPLE.verdict}</span>
              <p className="hb-verdict">
                <span>Verdict:</span> {EXAMPLE.statement}
              </p>
            </div>

            <div className="hb-card-source">
              <p>
                The two days are the upgrade path; the zero is a pause a fork confirmed. Your own run produces its own
                numbers.
              </p>
              <p className="hb-source-addr">
                <span>Quoted from a committed calibration report for</span>
                <span className="mono">{EXAMPLE.address}</span>
              </p>
            </div>
          </aside>
        </div>

      </div>
    </section>
  );
}
