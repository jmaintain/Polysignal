import { useEffect, useRef, useState } from "react";
import type { ChartData, SessionState } from "@polysignal/shared";

const WINDOWS: { label: string; ms: number }[] = [
  { label: "5m", ms: 5 * 60 * 1000 },
  { label: "15m", ms: 15 * 60 * 1000 },
  { label: "45m", ms: 45 * 60 * 1000 },
];

export function ChartCanvas({
  chart,
  session,
}: {
  chart: ChartData | null;
  session: SessionState | null;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [windowMs, setWindowMs] = useState(WINDOWS[1].ms);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.scale(dpr, dpr);
      render(ctx, rect.width, rect.height, chart, session, windowMs);
    };
    draw();
    const onResize = () => draw();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [chart, session, windowMs]);

  return (
    <div className="chartwrap">
      <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
        {WINDOWS.map((w) => (
          <button
            key={w.label}
            className="btn"
            style={{
              padding: "3px 10px",
              fontSize: 11,
              borderColor: windowMs === w.ms ? "var(--gold)" : undefined,
              color: windowMs === w.ms ? "var(--gold)" : undefined,
            }}
            onClick={() => setWindowMs(w.ms)}
          >
            {w.label}
          </button>
        ))}
      </div>
      <canvas ref={canvasRef} className="chart" />
      <div className="chart-legend">
        <span>
          <span className="legend-swatch" style={{ background: "#f3ba2f" }} />
          Chainlink (resolution feed)
        </span>
        <span>
          <span className="legend-swatch" style={{ background: "#4f8cff" }} />
          Binance spot
        </span>
        <span>
          <span className="legend-swatch" style={{ background: "#eaecef", height: 1 }} />
          Price to beat
        </span>
      </div>
    </div>
  );
}

function render(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  chart: ChartData | null,
  session: SessionState | null,
  windowMs: number,
) {
  ctx.clearRect(0, 0, w, h);
  if (!chart || chart.chainlink.length === 0) {
    ctx.fillStyle = "#848e9c";
    ctx.font = "12px sans-serif";
    ctx.fillText("waiting for ticks…", 12, 20);
    return;
  }
  const now = Date.now();
  const t0 = now - windowMs;
  const cl = chart.chainlink.filter((t) => t.ts >= t0);
  const bn = chart.binance.filter((t) => t.ts >= t0);
  const prices = [...cl.map((t) => t.price), ...bn.map((t) => t.price)];
  if (session?.strike != null) prices.push(session.strike);
  if (prices.length === 0) return;
  let min = Math.min(...prices);
  let max = Math.max(...prices);
  const pad = Math.max((max - min) * 0.12, max * 1e-5);
  min -= pad;
  max += pad;

  const padL = 8;
  const padR = 64;
  const padT = 8;
  const padB = 18;
  const x = (ts: number) => padL + ((ts - t0) / (now - t0)) * (w - padL - padR);
  const y = (p: number) => padT + (1 - (p - min) / (max - min)) * (h - padT - padB);

  // Horizontal grid.
  ctx.strokeStyle = "rgba(43,47,54,0.6)";
  ctx.fillStyle = "#848e9c";
  ctx.font = "10px monospace";
  ctx.lineWidth = 1;
  const steps = 4;
  for (let i = 0; i <= steps; i++) {
    const p = min + ((max - min) * i) / steps;
    const yy = y(p);
    ctx.beginPath();
    ctx.moveTo(padL, yy);
    ctx.lineTo(w - padR, yy);
    ctx.stroke();
    ctx.fillText(p.toLocaleString("en-US", { maximumFractionDigits: 2 }), w - padR + 4, yy + 3);
  }

  // Session start boundary.
  if (session?.market && session.market.startTs >= t0) {
    const xx = x(session.market.startTs);
    ctx.strokeStyle = "rgba(132,142,156,0.5)";
    ctx.setLineDash([2, 4]);
    ctx.beginPath();
    ctx.moveTo(xx, padT);
    ctx.lineTo(xx, h - padB);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillText("open", xx + 3, padT + 10);
  }

  // Strike line.
  if (session?.strike != null) {
    const yy = y(session.strike);
    ctx.strokeStyle = "rgba(234,236,239,0.8)";
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(padL, yy);
    ctx.lineTo(w - padR, yy);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#eaecef";
    ctx.fillText(
      session.strike.toLocaleString("en-US", { maximumFractionDigits: 2 }),
      w - padR + 4,
      yy - 4,
    );
  }

  const drawLine = (ticks: ChartData["chainlink"], color: string, width: number, alpha = 1) => {
    if (ticks.length < 2) return;
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(x(ticks[0].ts), y(ticks[0].price));
    for (let i = 1; i < ticks.length; i++) ctx.lineTo(x(ticks[i].ts), y(ticks[i].price));
    ctx.stroke();
    ctx.globalAlpha = 1;
  };

  drawLine(bn, "#4f8cff", 1, 0.55);
  drawLine(cl, "#f3ba2f", 1.6);

  // Last price marker.
  const last = cl[cl.length - 1];
  if (last) {
    const yy = y(last.price);
    ctx.fillStyle = "#f3ba2f";
    ctx.beginPath();
    ctx.arc(x(last.ts), yy, 3, 0, Math.PI * 2);
    ctx.fill();
    // Color the last-price label green/red vs strike.
    if (session?.strike != null) {
      ctx.fillStyle = last.price >= session.strike ? "#00c076" : "#cf304a";
    }
    ctx.fillRect(w - padR + 1, yy - 8, 2, 16);
  }
}
