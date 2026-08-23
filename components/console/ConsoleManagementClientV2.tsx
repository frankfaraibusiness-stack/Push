"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import type { ChartConfiguration } from "chart.js";
import DashboardChart from "@/components/dashboard/DashboardChart";
import "@/app/styles/management-v2.css";

type RangeKey =
  | "today" | "yesterday" | "this-week" | "this-month" | "last-month"
  | "90d" | "this-year" | "last-year" | "lifetime";

const RANGES: { key: RangeKey; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "this-week", label: "This week" },
  { key: "this-month", label: "This month" },
  { key: "last-month", label: "Last month" },
  { key: "90d", label: "90 days" },
  { key: "this-year", label: "This year" },
  { key: "last-year", label: "Last year" },
  { key: "lifetime", label: "Lifetime" },
];

interface DailySeries {
  days: string[];
  siteVisits: number[];
  revenue: number[];
  conversionRate: number[];
}

interface StatsResponse {
  ok: true;
  range: RangeKey;
  generatedAt: string;
  users: {
    total: number;
    totalDeltaPct: number | null;
    buyers: number;
    buyersDeltaPct: number | null;
    sellers: number;
    sellersDeltaPct: number | null;
    browsing: number;
    browsingDeltaPct: number | null;
    newInRange: number;
    newInRangeDeltaPct: number | null;
    activeListings: number;
  };
  traffic: {
    siteVisits: number;
    siteVisitsDeltaPct: number | null;
    totalImpressions: number;
  };
  financials: {
    dealsCompleted: number;
    dealsCompletedDeltaPct: number | null;
    grossVolume: number;
    grossVolumeDeltaPct: number | null;
    platformFees: number;
    platformFeesDeltaPct: number | null;
    sellerPayouts: number;
    sellerPayoutsDeltaPct: number | null;
    byCategory: Record<string, number>;
    conversionRate: number;
    conversionRateDeltaPct: number | null;
  };
  series: DailySeries;
}

const money = (n: number) => n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const int = (n: number) => n.toLocaleString();
const pct = (n: number) => `${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;

function exportCsv(data: StatsResponse) {
  const rows: string[] = [
    `Siterifty Console Overview — range: ${data.range}, generated: ${data.generatedAt}`,
    "",
    "Section,Metric,Value,Delta vs prior",
    `Traffic,Site Visits,${data.traffic.siteVisits},${data.traffic.siteVisitsDeltaPct ?? ""}`,
    `Traffic,Total Impressions,${data.traffic.totalImpressions},`,
    `Financials,Total Revenue,${data.financials.grossVolume},${data.financials.grossVolumeDeltaPct ?? ""}`,
    `Financials,Conversion Rate,${data.financials.conversionRate},${data.financials.conversionRateDeltaPct ?? ""}`,
    `People,Total Users,${data.users.total},${data.users.totalDeltaPct ?? ""}`,
    `People,New Signups,${data.users.newInRange},${data.users.newInRangeDeltaPct ?? ""}`,
    `People,Sellers,${data.users.sellers},${data.users.sellersDeltaPct ?? ""}`,
    `People,Buyers,${data.users.buyers},${data.users.buyersDeltaPct ?? ""}`,
    `People,Browsing Only,${data.users.browsing},${data.users.browsingDeltaPct ?? ""}`,
    `People,Active Listings,${data.users.activeListings},`,
    `Financials,Deals Completed,${data.financials.dealsCompleted},${data.financials.dealsCompletedDeltaPct ?? ""}`,
    `Financials,Platform Fees,${data.financials.platformFees},${data.financials.platformFeesDeltaPct ?? ""}`,
    `Financials,Seller Payouts,${data.financials.sellerPayouts},${data.financials.sellerPayoutsDeltaPct ?? ""}`,
    "",
    "Deals by category,Count",
    ...Object.entries(data.financials.byCategory).map(([k, v]) => `${k},${v}`),
    "",
    "Daily series,Date,Site Visits,Revenue,Conversion Rate",
    ...data.series.days.map((d, i) => `,${d},${data.series.siteVisits[i]},${data.series.revenue[i]},${data.series.conversionRate[i]}`),
  ];
  const blob = new Blob([rows.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `siterifty-overview-${data.range}-${data.generatedAt.slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

const TABS = [
  { href: "/console/management", label: "Overview", icon: "M3 3h7v9H3V3zm11 0h7v5h-7V3zm0 9h7v9h-7v-9zM3 16h7v5H3v-5z" },
  { href: "/console/listings", label: "Listings", icon: "M3 3h18v18H3V3zm0 6h18M9 21V9" },
  { href: "/console/deals", label: "Deals", icon: "M20.59 13.41L11 3.83A2 2 0 0 0 9.59 3.17H4a1 1 0 0 0-1 1v5.59a2 2 0 0 0 .66 1.41l9.59 9.59a2 2 0 0 0 2.82 0l4.52-4.52a2 2 0 0 0 0-2.83z" },
  { href: "/console/users", label: "Users", icon: "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 7a4 4 0 1 1 0-8 4 4 0 0 1 0 8z" },
];

function IconWrap({ path, viewBox = "0 0 24 24" }: { path: string; viewBox?: string }) {
  return (
    <svg viewBox={viewBox} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d={path} />
    </svg>
  );
}

function Delta({ value }: { value: number | null | undefined }) {
  if (value === null || value === undefined) return null;
  const dir = value > 0 ? "up" : value < 0 ? "down" : "flat";
  const arrow = dir === "up" ? "▲" : dir === "down" ? "▼" : "–";
  return (
    <span className={`mgv2-delta ${dir}`}>
      {arrow} {Math.abs(value)}% vs prior
    </span>
  );
}

function Sparkline({ points, color }: { points?: number[]; color: string }) {
  if (!points || points.length < 2) return null;
  const w = 100, h = 32;
  const max = Math.max(...points);
  const min = Math.min(...points);
  const span = max - min || 1;
  const stepX = w / (points.length - 1);
  const d = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${(i * stepX).toFixed(1)},${(h - ((p - min) / span) * (h - 4) - 2).toFixed(1)}`)
    .join(" ");
  return (
    <svg className="mgv2-sparkline" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <path d={d} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function MetricCard({
  tone, iconPath, label, value, loading, deltaPct, sparkline,
}: {
  tone: "lime" | "purple";
  iconPath: string;
  label: string;
  value: string | null;
  loading: boolean;
  deltaPct?: number | null;
  sparkline?: number[];
}) {
  return (
    <div className={`mgv2-metric-card tone-${tone}`}>
      <div className="mgv2-metric-top">
        <span className={`mgv2-metric-icon tone-${tone}`}><IconWrap path={iconPath} /></span>
        <div>
          <span className="mgv2-metric-label">{label}</span>
          <span className="mgv2-metric-value mgv2-mono">{loading || value === null ? "—" : value}</span>
        </div>
      </div>
      <Delta value={loading ? undefined : deltaPct} />
      <Sparkline points={sparkline} color={tone === "lime" ? "#a3e635" : "#a78bfa"} />
    </div>
  );
}

function PeopleCard({
  iconPath, label, value, loading, deltaPct,
}: {
  iconPath: string;
  label: string;
  value: string | null;
  loading: boolean;
  deltaPct?: number | null;
}) {
  return (
    <div className="mgv2-people-card">
      <span className="mgv2-people-label"><IconWrap path={iconPath} />{label}</span>
      <div className="mgv2-people-value mgv2-mono">{loading || value === null ? "—" : value}</div>
      <Delta value={loading ? undefined : deltaPct} />
      <span className="mgv2-people-watermark"><IconWrap path={iconPath} /></span>
    </div>
  );
}

export default function ConsoleManagementClientV2({ onOpenMore }: { onOpenMore?: () => void }) {
  const router = useRouter();
  const pathname = usePathname();
  const [range, setRange] = useState<RangeKey>("this-month");
  const [data, setData] = useState<StatsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rangeOpen, setRangeOpen] = useState(false);
  const rangeRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!rangeOpen) return;
    function onDown(e: MouseEvent) {
      if (rangeRef.current && !rangeRef.current.contains(e.target as Node)) setRangeOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setRangeOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [rangeOpen]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/console-stats?range=${range}`, { cache: "no-store" })
      .then((res) => {
        if (!res.ok) throw new Error("Failed to load stats.");
        return res.json();
      })
      .then((json) => {
        if (!cancelled) setData(json);
      })
      .catch(() => {
        if (!cancelled) setError("Couldn't load stats. Try again.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [range]);

  const categories = useMemo(() => {
    if (!data) return [];
    const entries = Object.entries(data.financials.byCategory).sort((a, b) => b[1] - a[1]);
    const max = Math.max(1, ...entries.map(([, v]) => v));
    return entries.map(([label, count]) => ({ label, count, pctOfMax: (count / max) * 100 }));
  }, [data]);

  const trafficConfig = useMemo((): ChartConfiguration<"line"> | null => {
    if (!data || data.series.days.length === 0) return null;
    const labels = data.series.days.map((d) => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric" }));
    return {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: "Visits",
            data: data.series.siteVisits,
            borderColor: "#a3e635",
            backgroundColor: "rgba(163,230,53,0.12)",
            tension: 0.35,
            pointRadius: 0,
            borderWidth: 2,
            fill: true,
            yAxisID: "y",
          },
          {
            label: "Impressions",
            data: data.series.revenue,
            borderColor: "#a78bfa",
            backgroundColor: "rgba(167,139,250,0.10)",
            tension: 0.35,
            pointRadius: 0,
            borderWidth: 2,
            fill: true,
            yAxisID: "y1",
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (ctx) => ctx.dataset.label === "Impressions" ? `Revenue: ${money(Number(ctx.raw))}` : `Visits: ${int(Number(ctx.raw))}`,
            },
          },
        },
        scales: {
          y: { position: "left", ticks: { color: "rgba(238,241,246,0.5)" }, grid: { color: "rgba(255,255,255,0.06)" } },
          y1: { position: "right", ticks: { color: "rgba(238,241,246,0.5)", callback: (v) => money(Number(v)) }, grid: { display: false } },
          x: { ticks: { color: "rgba(238,241,246,0.5)", maxRotation: 0, autoSkip: true }, grid: { display: false } },
        },
      },
    };
  }, [data]);

  const revenueBarConfig = useMemo((): ChartConfiguration<"bar"> | null => {
    if (!data || data.series.days.length === 0) return null;
    const labels = data.series.days.map((d) => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric" }));
    return {
      type: "bar",
      data: {
        labels,
        datasets: [
          {
            label: "Revenue",
            data: data.series.revenue,
            backgroundColor: "rgba(163,230,53,0.55)",
            borderRadius: 4,
            barPercentage: 0.7,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (ctx) => money(Number(ctx.raw)) } },
        },
        scales: {
          y: { ticks: { color: "rgba(238,241,246,0.5)", callback: (v) => money(Number(v)) }, grid: { color: "rgba(255,255,255,0.06)" } },
          x: { ticks: { color: "rgba(238,241,246,0.5)", maxRotation: 0, autoSkip: true }, grid: { display: false } },
        },
      },
    };
  }, [data]);

  return (
    <div className="mgv2-root">
      <div className="mgv2-head">
        <div>
          <h1 className="mgv2-title">Overview</h1>
          <p className="mgv2-subtitle">Platform activity and financials</p>
        </div>
        {data && (
          <span className="mgv2-updated">
            <span className="mgv2-updated-dot" />
            Updated {new Date(data.generatedAt).toLocaleTimeString()}
          </span>
        )}
      </div>

      <div className="mgv2-controls">
        <div className="mgv2-range-wrap" ref={rangeRef}>
          <span className="mgv2-range-label">Date range</span>
          <button type="button" className="mgv2-range-trigger" aria-haspopup="listbox" aria-expanded={rangeOpen} onClick={() => setRangeOpen((v) => !v)}>
            <IconWrap path="M3 4h18v18H3V4zm13-2v6M8 2v6M3 10h18" />
            <span>{RANGES.find((r) => r.key === range)?.label ?? "Select range"}</span>
            <svg className="mgv2-range-chevron" viewBox="0 0 10 6" fill="none">
              <path d="M1 1L5 5L9 1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          {rangeOpen && (
            <div className="mgv2-range-panel" role="listbox">
              {RANGES.map((opt) => (
                <button
                  key={opt.key}
                  type="button"
                  role="option"
                  aria-selected={opt.key === range}
                  className={`mgv2-range-option${opt.key === range ? " active" : ""}`}
                  onClick={() => { setRange(opt.key); setRangeOpen(false); }}
                >
                  {opt.label}
                  {opt.key === range && <IconWrap path="M20 6L9 17l-5-5" />}
                </button>
              ))}
            </div>
          )}
        </div>
        <button type="button" className="mgv2-export-btn" disabled={!data} onClick={() => data && exportCsv(data)}>
          <IconWrap path="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
          Export
        </button>
      </div>

      {error && <div className="mgv2-error">{error}</div>}

      <div className="mgv2-section-row">
        <span className="mgv2-section-title">Key Metrics</span>
      </div>
      <div className="mgv2-grid-2">
        <MetricCard
          tone="lime"
          iconPath="M2 4h20v14H2V4zm4 12l4-4 3 3 5-6"
          label="Site Visits"
          value={data ? int(data.traffic.siteVisits) : null}
          loading={loading}
          deltaPct={data?.traffic.siteVisitsDeltaPct}
          sparkline={data?.series.siteVisits}
        />
        <MetricCard
          tone="purple"
          iconPath="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"
          label="Total Impressions"
          value={data ? int(data.traffic.totalImpressions) : null}
          loading={loading}
        />
        <MetricCard
          tone="lime"
          iconPath="M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"
          label="Total Revenue"
          value={data ? money(data.financials.grossVolume) : null}
          loading={loading}
          deltaPct={data?.financials.grossVolumeDeltaPct}
          sparkline={data?.series.revenue}
        />
        <MetricCard
          tone="purple"
          iconPath="M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z"
          label="Conversion Rate"
          value={data ? pct(data.financials.conversionRate) : null}
          loading={loading}
          deltaPct={data?.financials.conversionRateDeltaPct}
          sparkline={data?.series.conversionRate}
        />
      </div>

      <div className="mgv2-section-row">
        <span className="mgv2-section-title">People</span>
      </div>
      <div className="mgv2-grid-2">
        <PeopleCard iconPath="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 7a4 4 0 1 0 0-8 4 4 0 0 0 0 8z" label="Total Users" value={data ? int(data.users.total) : null} loading={loading} deltaPct={data?.users.totalDeltaPct} />
        <PeopleCard iconPath="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M8.5 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM20 8v6M17 11h6" label="New Signups" value={data ? int(data.users.newInRange) : null} loading={loading} deltaPct={data?.users.newInRangeDeltaPct} />
        <PeopleCard iconPath="M3 9l1.5-5h15L21 9M3 9a2 2 0 0 0 4 0 2 2 0 0 0 4 0 2 2 0 0 0 4 0 2 2 0 0 0 4 0M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9" label="Sellers" value={data ? int(data.users.sellers) : null} loading={loading} deltaPct={data?.users.sellersDeltaPct} />
        <PeopleCard iconPath="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4zM3 6h18M16 10a4 4 0 0 1-8 0" label="Buyers" value={data ? int(data.users.buyers) : null} loading={loading} deltaPct={data?.users.buyersDeltaPct} />
        <PeopleCard iconPath="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" label="Browsing Only" value={data ? int(data.users.browsing) : null} loading={loading} deltaPct={data?.users.browsingDeltaPct} />
        <PeopleCard iconPath="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM13 2v7h7M8 13h8M8 17h8" label="Active Listings" value={data ? int(data.users.activeListings) : null} loading={loading} />
      </div>

      <div className="mgv2-panel">
        <div className="mgv2-panel-head">
          <span className="mgv2-panel-title">Traffic Overview</span>
          <div className="mgv2-legend">
            <span className="mgv2-legend-item"><span className="mgv2-legend-dot" style={{ background: "#a3e635" }} />Visits</span>
            <span className="mgv2-legend-item"><span className="mgv2-legend-dot" style={{ background: "#a78bfa" }} />Impressions</span>
          </div>
        </div>
        <div className="mgv2-chart-box">
          {trafficConfig ? <DashboardChart config={trafficConfig} /> : <div className="mgv2-empty">No data for this range yet.</div>}
        </div>
      </div>

      <div className="mgv2-panel">
        <div className="mgv2-panel-head">
          <span className="mgv2-panel-title">Revenue by Day</span>
        </div>
        <div className="mgv2-chart-box">
          {revenueBarConfig ? <DashboardChart config={revenueBarConfig} /> : <div className="mgv2-empty">No data for this range yet.</div>}
        </div>
      </div>

      <div className="mgv2-panel">
        <div className="mgv2-panel-head">
          <span className="mgv2-panel-title">Deals by Category</span>
        </div>
        {categories.length === 0 ? (
          <div className="mgv2-empty">No completed deals in this range yet.</div>
        ) : (
          categories.map((c) => (
            <div className="mgv2-cat-row" key={c.label}>
              <span className="mgv2-cat-label">{c.label}</span>
              <span className="mgv2-cat-track"><span className="mgv2-cat-fill" style={{ width: `${c.pctOfMax}%` }} /></span>
              <span className="mgv2-cat-count mgv2-mono">{c.count}</span>
            </div>
          ))
        )}
      </div>

      <nav className="mgv2-tabbar" aria-label="Console sections">
        {TABS.map((t) => (
          <button key={t.href} type="button" className={`mgv2-tab${pathname === t.href ? " active" : ""}`} onClick={() => router.push(t.href)}>
            <IconWrap path={t.icon} />
            <span>{t.label}</span>
          </button>
        ))}
        <button type="button" className="mgv2-tab" onClick={onOpenMore}>
          <IconWrap path="M12 12h.01M19 12h.01M5 12h.01" />
          <span>More</span>
        </button>
      </nav>
    </div>
  );
}
