// The overview's "live evidence graph" used to be a still image. This is the
// same card, drawn from the selected task's own record: the stages are the
// protocol's stages, the two verifier lanes are the task's actual verifiers,
// and the pulse moves through them in the order and at the relative intervals
// the chain recorded — creation, anchoring, each commit, each reveal,
// consensus, settlement — then holds and replays. A task still in flight shows
// the pulse reaching only what has happened, with the next stage waiting.
// Nothing here is illustrative; every lit node is an event that landed.
import { useEffect, useMemo, useState } from "react";
import type { TaskDetail } from "@/lib/types";

type Beat = { key: string; at: number | null };

const TRAVEL_MS = 9_000;
const HOLD_MS = 2_400;
/** Two events one second apart on a task that took five minutes would draw as one; keep every step readable. */
const MIN_GAP = 0.09;

const X = { creator: 54, storage: 160, commit: 272, reveal: 358, consensus: 456, settled: 530 };
const Y = { mid: 142, lanes: [88, 196] };

function stamp(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const at = new Date(iso).getTime();
  return Number.isFinite(at) ? at : null;
}

function eventAt(task: TaskDetail, label: string): number | null {
  return stamp(task.timeline.find((entry) => entry.label === label)?.at);
}

/**
 * Every beat's position on the loop, 0..1. Real timestamps, normalised, then
 * pushed apart to MIN_GAP so a burst of near-simultaneous events still reads as
 * a sequence; a beat with no timestamp has not happened and gets null.
 */
function schedule(task: TaskDetail | null | undefined) {
  const lanes = (task?.reports ?? []).slice(0, 2);
  const beats: Beat[] = task
    ? [
        { key: "created", at: stamp(task.createdAt) },
        { key: "anchored", at: eventAt(task, "Manifest anchored") ?? stamp(task.createdAt) },
        ...lanes.flatMap((report, i) => [
          { key: `commit${i}`, at: stamp(report.committedAt) },
          { key: `reveal${i}`, at: stamp(report.revealedAt) },
        ]),
        { key: "consensus", at: stamp(task.consensus?.evaluatedAt) ?? eventAt(task, "Consensus reached") },
        { key: "settled", at: eventAt(task, "Task finalized") },
      ]
    : [];
  const known = beats.filter((b): b is Beat & { at: number } => b.at !== null).sort((a, b) => a.at - b.at);
  const u = new Map<string, number>();
  if (known.length > 0) {
    const t0 = known[0].at;
    const span = Math.max(known[known.length - 1].at - t0, 1);
    let last = -Infinity;
    for (const beat of known) {
      let pos = (beat.at - t0) / span;
      if (pos < last + MIN_GAP) pos = last + MIN_GAP;
      u.set(beat.key, pos);
      last = pos;
    }
    // Re-fit after the spacing pass so the final beat lands exactly at 1.
    const max = Math.max(last, 1e-6);
    for (const [k, v] of u) u.set(k, v / max);
  }
  const reached = new Set(u.keys());
  const order = ["created", "anchored", ...lanes.flatMap((_, i) => [`commit${i}`, `reveal${i}`]), "consensus", "settled"];
  const next = order.find((k) => !reached.has(k)) ?? null;
  return { u, lanes, next, complete: next === null, any: known.length > 0 };
}

function useCursor(active: boolean, complete: boolean): number {
  const [cursor, setCursor] = useState(0);
  useEffect(() => {
    if (!active) return;
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (still) { setCursor(1); return; }
    let frame = 0;
    let start = performance.now();
    const total = TRAVEL_MS + HOLD_MS;
    const tick = (now: number) => {
      if (!document.hidden) {
        const elapsed = (now - start) % total;
        const c = Math.min(elapsed / TRAVEL_MS, 1);
        setCursor((prev) => (Math.abs(prev - c) > 0.003 || c === 1 ? c : prev));
      } else {
        start = now; // do not race through the loop while the tab was hidden
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [active, complete]);
  return cursor;
}

/** How far along an edge the pulse is, given where its two ends sit on the loop. */
function along(cursor: number, from: number | undefined, to: number | undefined): number {
  if (from === undefined) return 0;
  if (to === undefined) return cursor >= from ? 0 : 0;
  if (to <= from) return cursor >= to ? 1 : 0;
  return Math.max(0, Math.min(1, (cursor - from) / (to - from)));
}

type EdgeSpec = { d: string; from: string; to: string; x1: number; y1: number; x2: number; y2: number };

export default function EvidenceFlow({ task, pending }: { task: TaskDetail | null | undefined; pending: boolean }) {
  const plan = useMemo(() => schedule(task), [task]);
  const cursor = useCursor(plan.any, plan.complete);
  const lit = (key: string) => { const u = plan.u.get(key); return u !== undefined && cursor >= u; };

  const edges: EdgeSpec[] = [
    { d: `M${X.creator} ${Y.mid} H${X.storage}`, from: "created", to: "anchored", x1: X.creator, y1: Y.mid, x2: X.storage, y2: Y.mid },
    ...plan.lanes.flatMap((_, i) => {
      const y = Y.lanes[i];
      const cx = (X.storage + X.commit) / 2;
      const rx = (X.reveal + X.consensus) / 2;
      return [
        { d: `M${X.storage} ${Y.mid} C${cx} ${Y.mid} ${cx} ${y} ${X.commit} ${y}`, from: "anchored", to: `commit${i}`, x1: X.storage, y1: Y.mid, x2: X.commit, y2: y },
        { d: `M${X.commit} ${y} H${X.reveal}`, from: `commit${i}`, to: `reveal${i}`, x1: X.commit, y1: y, x2: X.reveal, y2: y },
        { d: `M${X.reveal} ${y} C${rx} ${y} ${rx} ${Y.mid} ${X.consensus} ${Y.mid}`, from: `reveal${i}`, to: "consensus", x1: X.reveal, y1: y, x2: X.consensus, y2: Y.mid },
      ];
    }),
    { d: `M${X.consensus} ${Y.mid} H${X.settled}`, from: "consensus", to: "settled", x1: X.consensus, y1: Y.mid, x2: X.settled, y2: Y.mid },
  ];

  const node = (key: string, x: number, y: number, label: string, sub?: string) => {
    const on = lit(key);
    const waiting = plan.any && cursor >= 1 && plan.next === key;
    return (
      <g key={key} className={`flow-node-group ${on ? "lit" : ""} ${waiting ? "waiting" : ""}`}>
        <circle className="flow-halo" cx={x} cy={y} r={18} />
        <circle className="flow-node" cx={x} cy={y} r={11} />
        <text className="flow-label" x={x} y={y + 27} textAnchor="middle">{label}</text>
        {sub && <text className="flow-sub" x={x} y={y + 41} textAnchor="middle">{sub}</text>}
      </g>
    );
  };

  return (
    <svg className={`evidence-flow ${pending ? "is-pending" : ""}`} viewBox="0 0 570 300" preserveAspectRatio="xMidYMid meet" role="img"
      aria-label={task ? `${task.ref}: the task's events replayed in the order the chain recorded them` : "Evidence flow"}>
      {edges.map((edge, i) => {
        const p = along(cursor, plan.u.get(edge.from), plan.u.get(edge.to));
        return (
          <g key={i}>
            <path className="flow-edge" d={edge.d} />
            <path className="flow-edge flow-edge-lit" d={edge.d} pathLength={1} strokeDasharray="1" strokeDashoffset={1 - p} />
          </g>
        );
      })}
      {edges.map((edge, i) => {
        const p = along(cursor, plan.u.get(edge.from), plan.u.get(edge.to));
        if (p <= 0 || p >= 1) return null;
        // The pulse rides the edge's straight chord; the curves are shallow
        // enough that this reads as on-path at card size.
        const px = edge.x1 + (edge.x2 - edge.x1) * p;
        const py = edge.y1 + (edge.y2 - edge.y1) * (p < 0.5 ? 2 * p * p : 1 - 2 * (1 - p) * (1 - p));
        return <circle key={`pulse${i}`} className="flow-pulse" cx={px} cy={py} r={4} />;
      })}
      {node("created", X.creator, Y.mid, "Creator", "escrows")}
      {node("anchored", X.storage, Y.mid, "0G Storage", "anchors")}
      {plan.lanes.map((report, i) => (
        <g key={report.verifier}>
          <text className="flow-lane" x={(X.commit + X.reveal) / 2} y={Y.lanes[i] - 22} textAnchor="middle">{report.verifierLabel}</text>
          {node(`commit${i}`, X.commit, Y.lanes[i], "commit")}
          {node(`reveal${i}`, X.reveal, Y.lanes[i], "reveal")}
        </g>
      ))}
      {plan.lanes.length === 0 && !pending && (
        <text className="flow-lane" x={(X.commit + X.reveal) / 2} y={Y.mid - 22} textAnchor="middle">no verifier assigned yet</text>
      )}
      {node("consensus", X.consensus, Y.mid, "Consensus", "keeper")}
      {node("settled", X.settled, Y.mid, "Settled", task ? (plan.u.has("settled") ? "finalized" : "pending") : undefined)}
    </svg>
  );
}
