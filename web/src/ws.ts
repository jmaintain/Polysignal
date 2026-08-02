import { useEffect, useRef, useState } from "react";
import type {
  AppState,
  AssetId,
  ChartData,
  PriceTick,
  ServerMessage,
} from "@polysignal/shared";

const MAX_CHART_TICKS = 2400;

export interface LiveData {
  state: AppState | null;
  chart: ChartData | null;
  connected: boolean;
  setFocusAsset: (asset: AssetId) => void;
}

export function useLiveData(): LiveData {
  const [state, setState] = useState<AppState | null>(null);
  const [chart, setChart] = useState<ChartData | null>(null);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const focusRef = useRef<AssetId>("btc");

  useEffect(() => {
    let closed = false;
    let retry: number | undefined;

    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${location.host}/ws`);
      wsRef.current = ws;
      ws.onopen = () => {
        setConnected(true);
        ws.send(JSON.stringify({ kind: "focus", asset: focusRef.current }));
      };
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data) as ServerMessage;
        if (msg.kind === "state") {
          setState(msg.state);
        } else if (msg.kind === "chart") {
          setChart(msg.chart);
        } else if (msg.kind === "tick") {
          setChart((prev) => {
            if (!prev || prev.asset !== msg.asset) return prev;
            const key = msg.source;
            const arr = appendTick(prev[key], msg.tick);
            return { ...prev, [key]: arr };
          });
        }
      };
      ws.onclose = () => {
        setConnected(false);
        if (!closed) retry = window.setTimeout(connect, 2000);
      };
      ws.onerror = () => ws.close();
    };
    connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      wsRef.current?.close();
    };
  }, []);

  const setFocusAsset = (asset: AssetId) => {
    if (focusRef.current === asset) return;
    focusRef.current = asset;
    setChart(null);
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ kind: "focus", asset }));
    }
  };

  return { state, chart, connected, setFocusAsset };
}

function appendTick(arr: PriceTick[], tick: PriceTick): PriceTick[] {
  const last = arr[arr.length - 1];
  if (last && tick.ts <= last.ts) return arr;
  const next = arr.length >= MAX_CHART_TICKS ? arr.slice(-MAX_CHART_TICKS + 1) : arr.slice();
  next.push(tick);
  return next;
}
