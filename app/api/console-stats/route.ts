// GET /api/console-stats?range=today|yesterday|this-week|this-month|last-month|90d|this-year|last-year|lifetime
//
// Management dashboard v2 — rebuilt from scratch (see FIX/rebuild notes).
// Returns platform-wide metrics, People breakdown, a deal-category
// distribution, and two daily series (traffic+revenue, and a standalone
// revenue-by-day bucket for the new bar chart).
//
// Auth: same console session cookie every /console/* API uses. Any role
// may read this — it's aggregate reporting, not a privileged mutation.

import { cookies } from "next/headers";
import { FieldPath } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/server/adminDb";
import { verifyConsoleSessionToken, CONSOLE_SESSION_COOKIE } from "@/lib/server/consoleAuth";

type RangeKey =
  | "today" | "yesterday" | "this-week" | "this-month" | "last-month"
  | "90d" | "this-year" | "last-year" | "lifetime";

const VALID_RANGES: RangeKey[] = [
  "today", "yesterday", "this-week", "this-month", "last-month",
  "90d", "this-year", "last-year", "lifetime",
];

const DEAL_CATEGORIES = ["website", "app", "game", "domain", "template", "3d"] as const;

interface Window {
  start: Date | null;
  end: Date | null;
}

function windowForRange(range: RangeKey, now: Date): Window {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);

  if (range === "today") return { start: midnight, end: null };

  if (range === "yesterday") {
    const start = new Date(midnight);
    start.setDate(start.getDate() - 1);
    return { start, end: midnight };
  }

  if (range === "this-week") {
    const dow = midnight.getDay();
    const back = dow === 0 ? 6 : dow - 1;
    const start = new Date(midnight);
    start.setDate(start.getDate() - back);
    return { start, end: null };
  }

  if (range === "this-month") {
    return { start: new Date(now.getFullYear(), now.getMonth(), 1), end: null };
  }

  if (range === "last-month") {
    return {
      start: new Date(now.getFullYear(), now.getMonth() - 1, 1),
      end: new Date(now.getFullYear(), now.getMonth(), 1),
    };
  }

  if (range === "90d") {
    const start = new Date(midnight);
    start.setDate(start.getDate() - 89);
    return { start, end: null };
  }

  if (range === "this-year") {
    return { start: new Date(now.getFullYear(), 0, 1), end: null };
  }

  if (range === "last-year") {
    return {
      start: new Date(now.getFullYear() - 1, 0, 1),
      end: new Date(now.getFullYear(), 0, 1),
    };
  }

  return { start: null, end: null }; // lifetime
}

function priorWindow(range: RangeKey, win: Window, now: Date): Window {
  if (!win.start) return { start: null, end: null };

  if (range === "this-month" || range === "last-month") {
    return {
      start: new Date(win.start.getFullYear(), win.start.getMonth() - 1, 1),
      end: new Date(win.start.getFullYear(), win.start.getMonth(), 1),
    };
  }
  if (range === "this-year" || range === "last-year") {
    return {
      start: new Date(win.start.getFullYear() - 1, 0, 1),
      end: new Date(win.start.getFullYear(), 0, 1),
    };
  }

  const end = win.end ?? now;
  const span = end.getTime() - win.start.getTime();
  return { start: new Date(win.start.getTime() - span), end: new Date(win.start.getTime()) };
}

function pctChange(now: number, prior: number | null): number | null {
  if (prior === null) return null;
  if (prior === 0) return now > 0 ? null : 0;
  return parseFloat((((now - prior) / prior) * 100).toFixed(1));
}

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function countWhere(
  ref: FirebaseFirestore.CollectionReference,
  field: string,
  op: FirebaseFirestore.WhereFilterOp,
  value: unknown
): Promise<number> {
  const snap = await ref.where(field, op, value).count().get();
  return snap.data().count;
}

async function usersCreatedInWindow(
  ref: FirebaseFirestore.CollectionReference,
  win: Window
): Promise<number | null> {
  if (!win.start) return null;
  let q: FirebaseFirestore.Query = ref.where("createdAt", ">=", win.start);
  if (win.end) q = q.where("createdAt", "<", win.end);
  const snap = await q.count().get();
  return snap.data().count;
}

async function usersAsOf(
  ref: FirebaseFirestore.CollectionReference,
  cutoff: Date | null,
  role?: string
): Promise<number | null> {
  if (!cutoff) return null;
  let q: FirebaseFirestore.Query = ref.where("createdAt", "<", cutoff);
  if (role) q = q.where("role", "==", role);
  const snap = await q.count().get();
  return snap.data().count;
}

async function visitsInWindow(
  db: FirebaseFirestore.Firestore,
  win: Window
): Promise<{ total: number; byDay: Record<string, number> }> {
  let q: FirebaseFirestore.Query = db.collection("siteVisits");
  if (win.start) q = q.where(FieldPath.documentId(), ">=", dayKey(win.start));
  if (win.end) q = q.where(FieldPath.documentId(), "<=", dayKey(new Date(win.end.getTime() - 1)));
  const snap = await q.get();
  const byDay: Record<string, number> = {};
  let total = 0;
  snap.forEach((doc) => {
    const n = doc.data()?.count;
    if (typeof n === "number") {
      byDay[doc.id] = n;
      total += n;
    }
  });
  return { total, byDay };
}

interface DealAgg {
  count: number;
  gross: number;
  fees: number;
  payouts: number;
  byCategory: Record<string, number>;
  byDayGross: Record<string, number>;
  byDayCount: Record<string, number>;
}

function emptyDealAgg(): DealAgg {
  const byCategory: Record<string, number> = {};
  DEAL_CATEGORIES.forEach((c) => (byCategory[c] = 0));
  return { count: 0, gross: 0, fees: 0, payouts: 0, byCategory, byDayGross: {}, byDayCount: {} };
}

function dealNetAmount(deal: FirebaseFirestore.DocumentData, fee: number): number {
  if (typeof deal.sellerNetAmount === "number") return deal.sellerNetAmount;
  if (typeof deal.escrowAmount === "number") return deal.escrowAmount - fee;
  if (typeof deal.listingPrice === "number") return deal.listingPrice - fee;
  if (typeof deal.offerPrice === "number") return deal.offerPrice - fee;
  return 0;
}

async function dealsInWindow(db: FirebaseFirestore.Firestore, win: Window): Promise<DealAgg> {
  let q = db
    .collectionGroup("deals")
    .where("status", "==", "complete")
    .where("dealOutcome", "==", "successful");
  if (win.start) q = q.where("createdAt", ">=", win.start);
  if (win.end) q = q.where("createdAt", "<", win.end);

  const snap = await q.get();
  const agg = emptyDealAgg();

  snap.forEach((doc) => {
    const deal = doc.data();
    agg.count += 1;

    const fee = typeof deal.platformFee === "number" ? deal.platformFee : 0;
    const net = dealNetAmount(deal, fee);
    const gross = net + fee;

    agg.fees += fee;
    agg.payouts += net;
    agg.gross += gross;

    const cat = DEAL_CATEGORIES.includes(deal.listingType) ? deal.listingType : "website";
    agg.byCategory[cat] += 1;

    const createdAt = deal.createdAt?.toDate ? deal.createdAt.toDate() : null;
    if (createdAt) {
      const key = dayKey(createdAt);
      agg.byDayGross[key] = (agg.byDayGross[key] || 0) + gross;
      agg.byDayCount[key] = (agg.byDayCount[key] || 0) + 1;
    }
  });

  agg.gross = parseFloat(agg.gross.toFixed(2));
  agg.fees = parseFloat(agg.fees.toFixed(2));
  agg.payouts = parseFloat(agg.payouts.toFixed(2));
  return agg;
}

export async function GET(request: Request) {
  const jar = await cookies();
  const session = verifyConsoleSessionToken(jar.get(CONSOLE_SESSION_COOKIE)?.value);
  if (!session) {
    return Response.json({ error: "Not authenticated." }, { status: 401 });
  }

  const url = new URL(request.url);
  const rangeParam = (url.searchParams.get("range") || "this-month") as RangeKey;
  const range: RangeKey = VALID_RANGES.includes(rangeParam) ? rangeParam : "this-month";

  const db = getAdminDb();
  const now = new Date();
  const win = windowForRange(range, now);
  const prior = priorWindow(range, win, now);

  const usersRef = db.collection("users");

  const [
    totalNow, buyersNow, sellersNow, browsingNow,
    signupsNow, signupsPrior,
    totalPrior, buyersPrior, sellersPrior, browsingPrior,
  ] = await Promise.all([
    usersRef.count().get().then((s) => s.data().count),
    countWhere(usersRef, "role", "==", "buyer"),
    countWhere(usersRef, "role", "==", "seller"),
    countWhere(usersRef, "role", "==", "browsing"),
    usersCreatedInWindow(usersRef, win),
    usersCreatedInWindow(usersRef, prior),
    usersAsOf(usersRef, prior.end),
    usersAsOf(usersRef, prior.end, "buyer"),
    usersAsOf(usersRef, prior.end, "seller"),
    usersAsOf(usersRef, prior.end, "browsing"),
  ]);

  const [visitsNow, visitsPrior] = await Promise.all([
    visitsInWindow(db, win),
    visitsInWindow(db, prior),
  ]);

  const [platformTotalsSnap, activeListingsSnap] = await Promise.all([
    db.collection("stats").doc("platformTotals").get(),
    db.collection("listings").where("status", "==", "active").count().get(),
  ]);
  const totalImpressions =
    typeof platformTotalsSnap.data()?.impressionCount === "number"
      ? (platformTotalsSnap.data()!.impressionCount as number)
      : 0;
  const activeListings = activeListingsSnap.data().count;

  const [dealsNow, dealsPrior] = await Promise.all([
    dealsInWindow(db, win),
    dealsInWindow(db, prior),
  ]);

  const conversionNow = visitsNow.total > 0
    ? parseFloat(((dealsNow.count / visitsNow.total) * 100).toFixed(2))
    : 0;
  const conversionPrior = prior.start && visitsPrior.total > 0
    ? parseFloat(((dealsPrior.count / visitsPrior.total) * 100).toFixed(2))
    : null;

  // Daily series — last 30 real days present, for the Traffic line chart
  // and the new revenue bar chart.
  const dayKeys = Array.from(
    new Set([...Object.keys(visitsNow.byDay), ...Object.keys(dealsNow.byDayGross)])
  ).sort().slice(-30);

  const series = {
    days: dayKeys,
    siteVisits: dayKeys.map((k) => visitsNow.byDay[k] || 0),
    revenue: dayKeys.map((k) => parseFloat((dealsNow.byDayGross[k] || 0).toFixed(2))),
    conversionRate: dayKeys.map((k) => {
      const v = visitsNow.byDay[k] || 0;
      const d = dealsNow.byDayCount[k] || 0;
      return v > 0 ? parseFloat(((d / v) * 100).toFixed(2)) : 0;
    }),
  };

  return Response.json({
    ok: true,
    range,
    generatedAt: now.toISOString(),
    users: {
      total: totalNow,
      totalDeltaPct: pctChange(totalNow, totalPrior),
      buyers: buyersNow,
      buyersDeltaPct: pctChange(buyersNow, buyersPrior),
      sellers: sellersNow,
      sellersDeltaPct: pctChange(sellersNow, sellersPrior),
      browsing: browsingNow,
      browsingDeltaPct: pctChange(browsingNow, browsingPrior),
      newInRange: signupsNow ?? totalNow,
      newInRangeDeltaPct: pctChange(signupsNow ?? 0, signupsPrior),
      activeListings,
    },
    traffic: {
      siteVisits: visitsNow.total,
      siteVisitsDeltaPct: pctChange(visitsNow.total, win.start ? visitsPrior.total : null),
      totalImpressions,
    },
    financials: {
      dealsCompleted: dealsNow.count,
      dealsCompletedDeltaPct: pctChange(dealsNow.count, win.start ? dealsPrior.count : null),
      grossVolume: dealsNow.gross,
      grossVolumeDeltaPct: pctChange(dealsNow.gross, win.start ? dealsPrior.gross : null),
      platformFees: dealsNow.fees,
      platformFeesDeltaPct: pctChange(dealsNow.fees, win.start ? dealsPrior.fees : null),
      sellerPayouts: dealsNow.payouts,
      sellerPayoutsDeltaPct: pctChange(dealsNow.payouts, win.start ? dealsPrior.payouts : null),
      byCategory: dealsNow.byCategory,
      conversionRate: conversionNow,
      conversionRateDeltaPct: pctChange(conversionNow, conversionPrior),
    },
    series,
  });
}
