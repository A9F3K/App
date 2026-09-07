/**
 * Founder financial model — password gate at /founder.
 * Data from /api/founder (screen time, tariffs, costs, scenarios, strategy).
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";

import { buildApiUrl } from "../api/_base";
import {
  fetchStaffSupportThread,
  fetchStaffSupportThreads,
  sendStaffSupportReply,
  type SupportMessageDto,
  type SupportThreadDto,
} from "../api/supportClient";
import {
  DEFAULT_PRO_FEATURE_WEIGHTS,
  PRO_FEATURE_IDS,
  normalizeFeatureWeights,
  profitMarginFraction,
  sumFeatureWeights,
  type ProFeatureId,
  type ProFeatureWeightMap,
} from "../shared/proCatalog";
import { FONT_UI_SANS_REGULAR, WEB_UI_SANS_STACK } from "../ui/fonts";
import { useColors } from "../ui/theme";
import { saveFounderPdf } from "../ui/founder/exportFounderPdf";

type FounderPayload = {
  ok: true;
  generatedAt: string;
  screenTime: {
    tablesExist: boolean;
    usersWithScreenTime: number;
    totalActiveHours: number;
    avgActiveHoursPerUser: number;
    totalSessions: number;
    avgHoursPerActiveUserPerDay7d: number;
    last7d: {
      activeHours: number;
      sessions: number;
      distinctUsers: number;
    };
    last30d: {
      activeHours: number;
      sessions: number;
      distinctUsers: number;
    };
    topUsers: Array<{
      telegramUsername: string;
      totalActiveMs: number;
      sessionCount: number;
      lastActiveAt: string | null;
    }>;
    recentSessions: Array<{
      telegramUsername: string;
      clientSessionId: string;
      startedAt: string;
      lastHeartbeatAt: string;
      endedAt: string | null;
      activeMs: number;
      platform: string | null;
    }>;
    dailyLast14d: Array<{
      day: string;
      activeMs: number;
      distinctUsers: number;
      sessions: number;
      avgActiveMsPerUser?: number;
    }>;
    dailyLast30d?: Array<{
      day: string;
      activeMs: number;
      distinctUsers: number;
      sessions: number;
      avgActiveMsPerUser: number;
    }>;
  };
  dailyUsage?: Array<{
    day: string;
    activeMs: number;
    activeHours: number;
    distinctUsers: number;
    sessions: number;
    avgActiveMsPerUser: number;
    avgActiveHoursPerUser: number;
    vercelUsd?: number | null;
    railwayUsd?: number | null;
    gcpUsd?: number | null;
    providerTotalUsd?: number | null;
    vercelSource?: string | null;
    railwaySource?: string | null;
    gcpSource?: string | null;
    estimatedOnDemandUsd: number;
    estimatedFixedUsd: number;
    estimatedTotalUsd: number;
    snapshotOnDemandUsd: number | null;
    snapshotFixedUsd: number | null;
    snapshotUpdatedAt: string | null;
  }>;
  railwayUsage?: {
    source: string;
    detail: string;
    usageUsdMonth: number;
    fixedPlanUsdMonth: number;
    totalUsdMonth: number;
  };
  gcpUsage?: {
    source: string;
    detail: string;
    usdMonth: number;
  };
  users: { totalUsers: number; telegramConnected: number };
  providers: Array<{
    source: string;
    label: string;
    usdMonthEstimate: number | null;
    detail?: string;
  }>;
  screenTimeHealth: {
    tablesExist: boolean;
    hasSessions: boolean;
    hasTotals: boolean;
    note: string;
  };
  model: {
    tariffs: {
      monthUsd: number;
      quarterTotalUsd: number;
      yearTotalUsd: number;
      blendedArpuMonthlyUsd: number;
      mix: { month: number; quarter: number; year: number };
    };
    infraTotalUsdMonth: number;
    personalTotalUsdMonth: number;
    burnTotalUsdMonth: number;
    observedOnDemandUsdMonth?: number;
    costs: {
      infra: Record<string, number>;
      personal: Record<string, number>;
      variablePerActiveHourUsd: number;
      tdlibFixedUntilUsers: number;
    };
    breakeven: {
      payingUsersInfraOnly: number;
      payingUsersWithPersonalBurn: number;
      assumptions: string;
    };
    launchExperiment: {
      windowNote: string;
      estimatedFixedInfraUsdMonth: number;
      estimatedVariablePerActiveHourUsd: number;
      costIfOneUserOneHourUsd: number;
      costIfOneUserObservedDayUsd: number;
      costIfOneUserMonthAtObservedHoursUsd: number;
      onDemandMonthAt2hUsd?: number;
      onDemandMonthAt3hUsd?: number;
      explanation: string;
    };
    calibration?: {
      onDemandUsdPerActiveHour: number;
      source: string;
      confidence?: number;
      priorUsdPerActiveHour?: number;
      liveUsdPerActiveHour?: number | null;
      regressionUsdPerActiveHour?: number | null;
      vercelOnDemandUsdMonth: number | null;
      vercelFixedUsdMonth: number | null;
      screenActiveHoursMonth: number;
      evidence?: {
        screenActiveHours30d: number;
        screenActiveHours7d: number;
        distinctUsers30d: number;
        distinctUsers7d: number;
        activeDays30d: number;
        sessionCount30d: number;
        snapshotDays: number;
        pairedSnapshotDays: number;
      } | null;
      avgUser?: {
        hoursPerDay7d: number;
        onDemandUsdMonthAtObserved: number;
        onDemandUsdMonthAt2h: number;
        onDemandUsdMonthAt3h: number;
      };
      notes?: string[];
    };
    consumptionProbe?: {
      durationMinutes: number;
      requests: number;
      estimatedOnDemandUsd: number;
      onDemandUsdPerActiveHour: number;
      monthlyAtHoursPerDay: {
        h2: { activeHoursMonth: number; onDemandUsdMonth: number };
        h2_5: { activeHoursMonth: number; onDemandUsdMonth: number };
        h3: { activeHoursMonth: number; onDemandUsdMonth: number };
      };
      method: string;
    } | null;
    scenarios: Array<{
      id: string;
      label: string;
      payingUsers: number;
      avgScreenHoursPerDay: number;
      paidMixArpuMonthlyUsd: number;
      revenueMonthlyUsd: number;
      fixedInfraMonthlyUsd?: number;
      onDemandMonthlyUsd?: number;
      infraMonthlyUsd: number;
      variableMonthlyUsd: number;
      personalMonthlyUsd: number;
      totalCostMonthlyUsd: number;
      profitMonthlyUsd: number;
      profitAnnualUsd: number;
      notes: string;
    }>;
    strategy: {
      sales: string[];
      hiring: string[];
      milestones: Array<{ when: string; what: string }>;
    };
  };
  vercelUsage?: {
    source: string;
    detail: string;
    periodDays?: number;
    fixedUsdMonth: number;
    onDemandUsdMonth: number;
    totalUsd: number;
    byService: Array<{ name: string; usd: number; kind: string }>;
  };
  aiLimits?: {
    freeTokenLimit: number;
    proMonthlyTokenLimit: number;
    onDemandUsdPer1kTokens: number;
  } | null;
  proCatalog?: {
    targetProfitMargin: number;
    profitMarginUsd: number;
    quarterDiscountPct: number;
    yearDiscountPct: number;
    featureWeights: Record<string, number>;
    featureEnabled: Record<string, boolean>;
    fullMonthListUsd: number;
  } | null;
  catalogPlans?: Array<{
    id: string;
    months: number;
    priceUsd: number;
    monthlyUsd: number;
    listPriceUsd?: number;
  }> | null;
  consumptionEconomics?: {
    targetProfitMargin: number;
    profitMarginUsd?: number;
    monthPriceUsd: number;
    launchDiscountUsd: number;
    fullMonthListUsd: number;
    screenTimeCogsPerActiveHourUsd: number;
    screenTimeRetailPerActiveHourUsd: number;
    aiCogsPer1kTokensUsd: number;
    aiRetailPer1kTokensUsd: number;
    note: string;
  } | null;
};

function money(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs >= 1000) return `${sign}$${abs.toFixed(0)}`;
  return `${sign}$${abs.toFixed(2)}`;
}

function hoursFromMs(ms: number): string {
  return `${(ms / 3_600_000).toFixed(2)}h`;
}

function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function Card({
  title,
  children,
  colors,
}: {
  title: string;
  children: ReactNode;
  colors: ReturnType<typeof useColors>;
}) {
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: colors.highlight,
        backgroundColor: colors.undercover,
        borderRadius: 14,
        padding: 16,
        gap: 10,
      }}
    >
      <Text
        style={{
          color: colors.primary,
          fontSize: 15,
          fontWeight: "800",
          fontFamily: Platform.OS === "web" ? WEB_UI_SANS_STACK : FONT_UI_SANS_REGULAR,
        }}
      >
        {title}
      </Text>
      {children}
    </View>
  );
}

function Metric({
  label,
  value,
  colors,
  emphasize,
}: {
  label: string;
  value: string;
  colors: ReturnType<typeof useColors>;
  emphasize?: boolean;
}) {
  return (
    <View style={{ minWidth: 140, flexGrow: 1, gap: 2 }}>
      <Text style={{ color: colors.secondary, fontSize: 12 }}>{label}</Text>
      <Text
        style={{
          color: emphasize ? "#00E05A" : colors.primary,
          fontSize: emphasize ? 22 : 18,
          fontWeight: "800",
          fontFamily: Platform.OS === "web" ? WEB_UI_SANS_STACK : FONT_UI_SANS_REGULAR,
        }}
      >
        {value}
      </Text>
    </View>
  );
}

export default function FounderScreen() {
  const colors = useColors();
  const { width } = useWindowDimensions();
  const narrow = width < 720;
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [probeBusy, setProbeBusy] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [aiFreeLimitDraft, setAiFreeLimitDraft] = useState("");
  const [aiProMonthlyDraft, setAiProMonthlyDraft] = useState("");
  const [aiOnDemandRateDraft, setAiOnDemandRateDraft] = useState("");
  const [aiLimitsBusy, setAiLimitsBusy] = useState(false);
  const [catalogBusy, setCatalogBusy] = useState(false);
  const [marginDraft, setMarginDraft] = useState("0");
  const [quarterDiscDraft, setQuarterDiscDraft] = useState("10");
  const [yearDiscDraft, setYearDiscDraft] = useState("20");
  const [featureEnabledDraft, setFeatureEnabledDraft] = useState<Record<string, boolean>>({});
  const [featureWeightsDraft, setFeatureWeightsDraft] = useState<ProFeatureWeightMap>({
    ...DEFAULT_PRO_FEATURE_WEIGHTS,
  });
  const [revokeWalletDraft, setRevokeWalletDraft] = useState("");
  const [revokeBusy, setRevokeBusy] = useState(false);
  const [revokeMsg, setRevokeMsg] = useState<string | null>(null);
  const [data, setData] = useState<FounderPayload | null>(null);
  const [supportThreads, setSupportThreads] = useState<SupportThreadDto[]>([]);
  const [supportThreadId, setSupportThreadId] = useState<string | null>(null);
  const [supportMessages, setSupportMessages] = useState<SupportMessageDto[]>([]);
  const [supportReply, setSupportReply] = useState("");
  const [supportBusy, setSupportBusy] = useState(false);

  const font = Platform.OS === "web" ? WEB_UI_SANS_STACK : FONT_UI_SANS_REGULAR;

  const loadSession = useCallback(async (opts?: { soft?: boolean }) => {
    if (!opts?.soft) setLoading(true);
    if (!opts?.soft) setError(null);
    try {
      const res = await fetch(buildApiUrl("/api/founder"), {
        method: "GET",
        credentials: "include",
      });
      // Only a real auth failure should clear the dashboard (avoid soft-refresh 5xx → logout).
      if (res.status === 401) {
        setData(null);
        return;
      }
      const json = (await res.json()) as FounderPayload | { ok: false; error?: string };
      if (!res.ok || !json.ok) {
        setError("error" in json ? String(json.error) : "Failed to load");
        return;
      }
      setData(json);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "network_error");
    } finally {
      if (!opts?.soft) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSession();
  }, [loadSession]);

  // Soft real-time refresh while the dashboard is open (screen time + live provider rates).
  useEffect(() => {
    if (!data) return;
    const id = setInterval(() => {
      void loadSession({ soft: true });
    }, 60_000);
    return () => clearInterval(id);
  }, [data, loadSession]);

  const onLogin = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(buildApiUrl("/api/founder"), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const json = (await res.json()) as FounderPayload | { ok: false; error?: string };
      if (!res.ok || !json.ok) {
        setError("Wrong password");
        setData(null);
        return;
      }
      setPassword("");
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : "network_error");
    } finally {
      setLoading(false);
    }
  }, [password]);

  const onLogout = useCallback(async () => {
    await fetch(buildApiUrl("/api/founder"), {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "logout" }),
    });
    setData(null);
  }, []);

  const loadSupport = useCallback(async () => {
    const res = await fetchStaffSupportThreads();
    if (res.ok && res.threads) setSupportThreads(res.threads);
  }, []);

  const openSupportThread = useCallback(async (threadId: string) => {
    setSupportThreadId(threadId);
    setSupportBusy(true);
    try {
      const res = await fetchStaffSupportThread(threadId);
      if (res.ok && res.messages) setSupportMessages(res.messages);
      void loadSupport();
    } finally {
      setSupportBusy(false);
    }
  }, [loadSupport]);

  const onSupportReply = useCallback(async () => {
    if (!supportThreadId || !supportReply.trim()) return;
    setSupportBusy(true);
    try {
      const res = await sendStaffSupportReply(supportThreadId, supportReply.trim());
      if (res.ok && res.message) {
        setSupportMessages((prev) => [...prev, res.message!]);
        setSupportReply("");
        void loadSupport();
      }
    } finally {
      setSupportBusy(false);
    }
  }, [loadSupport, supportReply, supportThreadId]);

  useEffect(() => {
    if (!data) return;
    void loadSupport();
    const id = setInterval(() => void loadSupport(), 20_000);
    return () => clearInterval(id);
  }, [data, loadSupport]);

  const onRunProbe = useCallback(async () => {
    setProbeBusy(true);
    setError(null);
    try {
      const res = await fetch(buildApiUrl("/api/founder"), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "run_probe", minutes: 5 }),
      });
      const json = (await res.json()) as FounderPayload | { ok: false; error?: string };
      if (!res.ok || !json.ok) {
        setError("error" in json ? String(json.error) : "probe_failed");
        return;
      }
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : "probe_failed");
    } finally {
      setProbeBusy(false);
    }
  }, []);

  const onSaveAiLimits = useCallback(async () => {
    setAiLimitsBusy(true);
    setError(null);
    try {
      const freeTokenLimit = Number(aiFreeLimitDraft);
      const proMonthlyTokenLimit = Number(aiProMonthlyDraft);
      const onDemandUsdPer1kTokens = Number(aiOnDemandRateDraft);
      const res = await fetch(buildApiUrl("/api/founder"), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "save_ai_limits",
          freeTokenLimit,
          proMonthlyTokenLimit,
          onDemandUsdPer1kTokens,
        }),
      });
      const json = (await res.json()) as
        | { ok: true; aiLimits: NonNullable<FounderPayload["aiLimits"]> }
        | { ok: false; error?: string };
      if (!res.ok || !json.ok) {
        setError("error" in json ? String(json.error) : "save_ai_limits_failed");
        return;
      }
      setData((prev) => (prev ? { ...prev, aiLimits: json.aiLimits } : prev));
      setAiFreeLimitDraft(String(json.aiLimits.freeTokenLimit));
      setAiProMonthlyDraft(String(json.aiLimits.proMonthlyTokenLimit));
      setAiOnDemandRateDraft(String(json.aiLimits.onDemandUsdPer1kTokens));
    } catch (e) {
      setError(e instanceof Error ? e.message : "save_ai_limits_failed");
    } finally {
      setAiLimitsBusy(false);
    }
  }, [aiFreeLimitDraft, aiOnDemandRateDraft, aiProMonthlyDraft]);

  useEffect(() => {
    if (!data?.aiLimits) return;
    setAiFreeLimitDraft(String(data.aiLimits.freeTokenLimit));
    setAiProMonthlyDraft(String(data.aiLimits.proMonthlyTokenLimit));
    setAiOnDemandRateDraft(String(data.aiLimits.onDemandUsdPer1kTokens));
  }, [data?.aiLimits]);

  useEffect(() => {
    if (!data?.proCatalog) return;
    setMarginDraft(String(data.proCatalog.profitMarginUsd ?? 0));
    setQuarterDiscDraft(String(data.proCatalog.quarterDiscountPct));
    setYearDiscDraft(String(data.proCatalog.yearDiscountPct));
    setFeatureEnabledDraft({ ...data.proCatalog.featureEnabled });
    setFeatureWeightsDraft(normalizeFeatureWeights(data.proCatalog.featureWeights));
  }, [data?.proCatalog]);

  const onChangeFeatureWeight = useCallback((id: ProFeatureId, raw: string) => {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return;
    setFeatureWeightsDraft((prev) => normalizeFeatureWeights({ ...prev, [id]: n }));
  }, []);

  const catalogPreview = useMemo(() => {
    const weights = normalizeFeatureWeights(featureWeightsDraft);
    const enabledSum = sumFeatureWeights(
      weights,
      featureEnabledDraft as Record<ProFeatureId, boolean>,
    );
    const allSum = sumFeatureWeights(weights);
    const marginUsd = Math.max(0, Number(marginDraft) || 0);
    const monthCharge = Math.round((enabledSum + marginUsd) * 100) / 100;
    const fullList = Math.round((allSum + marginUsd) * 100) / 100;
    const marginPct = profitMarginFraction(enabledSum, marginUsd) * 100;
    return { enabledSum, allSum, marginUsd, monthCharge, fullList, marginPct };
  }, [featureEnabledDraft, featureWeightsDraft, marginDraft]);

  const onSaveProCatalog = useCallback(
    async (opts?: { applyMarginToOnDemand?: boolean }) => {
      setCatalogBusy(true);
      setError(null);
      try {
        const marginUsd = Number(marginDraft);
        const weights = normalizeFeatureWeights(featureWeightsDraft);
        const res = await fetch(buildApiUrl("/api/founder"), {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "save_pro_catalog",
            profitMarginUsd: Number.isFinite(marginUsd) ? Math.max(0, marginUsd) : undefined,
            quarterDiscountPct: Number(quarterDiscDraft),
            yearDiscountPct: Number(yearDiscDraft),
            featureEnabled: featureEnabledDraft,
            featureWeights: weights,
            applyMarginToOnDemand: opts?.applyMarginToOnDemand === true,
          }),
        });
        const json = (await res.json()) as
          | {
              ok: true;
              proCatalog: NonNullable<FounderPayload["proCatalog"]>;
              catalogPlans: NonNullable<FounderPayload["catalogPlans"]>;
              aiLimits?: FounderPayload["aiLimits"];
            }
          | { ok: false; error?: string };
        if (!res.ok || !json.ok) {
          setError("error" in json ? String(json.error) : "save_pro_catalog_failed");
          return;
        }
        setData((prev) =>
          prev
            ? {
                ...prev,
                proCatalog: json.proCatalog,
                catalogPlans: json.catalogPlans,
                ...(json.aiLimits ? { aiLimits: json.aiLimits } : {}),
              }
            : prev,
        );
        // Refresh full payload so tariffs / consumption economics stay in sync.
        void loadSession({ soft: true });
      } catch (e) {
        setError(e instanceof Error ? e.message : "save_pro_catalog_failed");
      } finally {
        setCatalogBusy(false);
      }
    },
    [
      featureEnabledDraft,
      featureWeightsDraft,
      loadSession,
      marginDraft,
      quarterDiscDraft,
      yearDiscDraft,
    ],
  );

  const onRevokeProByWallet = useCallback(async () => {
    const walletAddress = revokeWalletDraft.trim();
    if (!walletAddress) {
      setRevokeMsg("Enter a registration wallet address.");
      return;
    }
    setRevokeBusy(true);
    setRevokeMsg(null);
    setError(null);
    try {
      const res = await fetch(buildApiUrl("/api/founder"), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "revoke_pro_by_wallet",
          walletAddress,
        }),
      });
      const json = (await res.json()) as
        | { ok: true; revokedUsernames: string[]; count: number }
        | { ok: false; error?: string };
      if (!res.ok || !json.ok) {
        setRevokeMsg(
          "error" in json ? String(json.error ?? "revoke_failed") : "revoke_failed",
        );
        return;
      }
      setRevokeMsg(
        `Revoked Pro for ${json.count} user(s): ${json.revokedUsernames.join(", ")}`,
      );
    } catch (e) {
      setRevokeMsg(e instanceof Error ? e.message : "revoke_failed");
    } finally {
      setRevokeBusy(false);
    }
  }, [revokeWalletDraft]);

  const onSavePdf = useCallback(() => {
    if (!data) return;
    setPdfBusy(true);
    setError(null);
    try {
      saveFounderPdf(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "pdf_failed");
    } finally {
      setTimeout(() => setPdfBusy(false), 400);
    }
  }, [data]);

  const maxDailyMs = useMemo(() => {
    if (!data) return 1;
    const series = data.dailyUsage ?? data.screenTime.dailyLast14d;
    return Math.max(1, ...series.map((d) => d.activeMs));
  }, [data]);

  const dailyRollup = useMemo(() => {
    const rows = data?.dailyUsage ?? [];
    if (rows.length === 0) return null;
    const sum = (slice: typeof rows) => {
      const activeMs = slice.reduce((a, r) => a + r.activeMs, 0);
      const provider = slice.reduce((a, r) => a + (r.providerTotalUsd ?? 0), 0);
      const vercel = slice.reduce((a, r) => a + (r.vercelUsd ?? 0), 0);
      const sessions = slice.reduce((a, r) => a + r.sessions, 0);
      const userSet = new Set<number>();
      // distinctUsers is per-day; use max as lower bound display + sum of hours avg
      const daysWithUsers = slice.filter((r) => r.distinctUsers > 0);
      const avgUserHours =
        daysWithUsers.length > 0
          ? daysWithUsers.reduce((a, r) => a + r.avgActiveHoursPerUser, 0) /
            daysWithUsers.length
          : 0;
      const usersPeak = daysWithUsers.reduce((a, r) => Math.max(a, r.distinctUsers), 0);
      void userSet;
      return { activeMs, provider, vercel, sessions, usersPeak, avgUserHours };
    };
    return {
      d7: sum(rows.slice(-7)),
      d30: sum(rows),
      today: rows[rows.length - 1] ?? null,
    };
  }, [data]);

  if (loading && !data) {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: colors.background,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  if (!data) {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: colors.background,
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
        }}
      >
        <View style={{ width: "100%", maxWidth: 420, gap: 14 }}>
          <Text style={{ color: colors.primary, fontSize: 28, fontWeight: "800", fontFamily: font }}>
            Founder's
          </Text>
          <Text style={{ color: colors.secondary, fontSize: 14, lineHeight: 20, fontFamily: font }}>
            Financial model, screen-time telemetry, and scale plan. Password from
            FOUNDER_DASHBOARD_PASSWORD.
          </Text>
          <TextInput
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            placeholder="Password"
            placeholderTextColor={colors.secondary}
            onSubmitEditing={() => void onLogin()}
            style={{
              borderWidth: 1,
              borderColor: colors.highlight,
              borderRadius: 12,
              paddingHorizontal: 14,
              paddingVertical: 12,
              color: colors.primary,
              fontFamily: font,
              backgroundColor: colors.undercover,
            }}
          />
          {error ? (
            <Text style={{ color: "#FF5555", fontSize: 13, fontFamily: font }}>{error}</Text>
          ) : null}
          <Pressable
            onPress={() => void onLogin()}
            style={({ pressed }) => ({
              opacity: pressed ? 0.85 : 1,
              backgroundColor: "#00E05A",
              borderRadius: 12,
              paddingVertical: 14,
              alignItems: "center",
            })}
          >
            <Text style={{ color: "#04140A", fontWeight: "800", fontSize: 15, fontFamily: font }}>
              Unlock
            </Text>
          </Pressable>
        </View>
      </View>
    );
  }

  const { model, screenTime, users, providers, screenTimeHealth, vercelUsage, dailyUsage, railwayUsage, gcpUsage, aiLimits } =
    data;
  const probe = model.consumptionProbe;
  const calibration = model.calibration;
  const dailyRows = dailyUsage ?? [];

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.background }}
      contentContainerStyle={{
        paddingHorizontal: narrow ? 14 : 28,
        paddingTop: 12,
        paddingBottom: 48,
        gap: 16,
        maxWidth: 1100,
        width: "100%",
        alignSelf: "center",
      }}
    >
      <View
        style={{
          flexDirection: narrow ? "column" : "row",
          justifyContent: "space-between",
          gap: 12,
          alignItems: narrow ? "flex-start" : "center",
        }}
      >
        <View style={{ gap: 4 }}>
          <Text style={{ color: colors.primary, fontSize: 28, fontWeight: "800", fontFamily: font }}>
            Founder's
          </Text>
          <Text style={{ color: colors.secondary, fontSize: 12, fontFamily: font }}>
            Updated {new Date(data.generatedAt).toLocaleString()}
          </Text>
        </View>
        <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
          <Pressable
            onPress={() => void onRunProbe()}
            disabled={probeBusy}
            style={{
              borderWidth: 1,
              borderColor: colors.highlight,
              borderRadius: 10,
              paddingHorizontal: 14,
              paddingVertical: 10,
              opacity: probeBusy ? 0.55 : 1,
            }}
          >
            <Text style={{ color: "#00E05A", fontWeight: "700", fontFamily: font }}>
              {probeBusy ? "Probing…" : "Run 5-min probe"}
            </Text>
          </Pressable>
          <Pressable
            onPress={onSavePdf}
            disabled={pdfBusy}
            style={{
              borderWidth: 1,
              borderColor: colors.highlight,
              borderRadius: 10,
              paddingHorizontal: 14,
              paddingVertical: 10,
              backgroundColor: colors.undercover,
              opacity: pdfBusy ? 0.55 : 1,
            }}
          >
            <Text style={{ color: colors.primary, fontWeight: "700", fontFamily: font }}>
              {pdfBusy ? "Preparing…" : "Save PDF"}
            </Text>
          </Pressable>
          <Pressable
            onPress={() => void loadSession()}
            style={{
              borderWidth: 1,
              borderColor: colors.highlight,
              borderRadius: 10,
              paddingHorizontal: 14,
              paddingVertical: 10,
            }}
          >
            <Text style={{ color: colors.primary, fontWeight: "700", fontFamily: font }}>Refresh</Text>
          </Pressable>
          <Pressable
            onPress={() => void onLogout()}
            style={{
              borderWidth: 1,
              borderColor: colors.highlight,
              borderRadius: 10,
              paddingHorizontal: 14,
              paddingVertical: 10,
            }}
          >
            <Text style={{ color: colors.secondary, fontWeight: "700", fontFamily: font }}>Lock</Text>
          </Pressable>
        </View>
      </View>

      {error ? (
        <Text style={{ color: "#FF5555", fontSize: 13, fontFamily: font }}>{error}</Text>
      ) : null}

      <Card title="AI DLLR limits (overall consumption)" colors={colors}>
        <Text style={{ color: colors.secondary, fontSize: 13, lineHeight: 18, fontFamily: font, marginBottom: 12 }}>
          Free lifetime DLLR budget, Pro monthly included DLLR, and on-demand rate after the Pro cap
          (tokens × rate). Users see overall consumption in DLLR; Pro can continue from the built-in wallet.
        </Text>
        <View style={{ flexDirection: narrow ? "column" : "row", gap: 12, marginBottom: 12 }}>
          <View style={{ flex: 1, gap: 6 }}>
            <Text style={{ color: colors.secondary, fontSize: 12, fontFamily: font }}>
              Free DLLR (token units)
            </Text>
            <TextInput
              value={aiFreeLimitDraft || String(aiLimits?.freeTokenLimit ?? "")}
              onChangeText={setAiFreeLimitDraft}
              keyboardType="numeric"
              style={{
                borderWidth: 1,
                borderColor: colors.highlight,
                color: colors.primary,
                paddingHorizontal: 10,
                paddingVertical: 8,
                fontFamily: font,
                fontSize: 14,
              }}
            />
            <Text style={{ color: colors.secondary, fontSize: 11, fontFamily: font }}>
              ≈ $
              {(
                ((Number(aiFreeLimitDraft || aiLimits?.freeTokenLimit || 0) || 0) / 1000) *
                (Number(aiOnDemandRateDraft || aiLimits?.onDemandUsdPer1kTokens || 0.002) || 0.002)
              ).toFixed(4)}{" "}
              DLLR
            </Text>
          </View>
          <View style={{ flex: 1, gap: 6 }}>
            <Text style={{ color: colors.secondary, fontSize: 12, fontFamily: font }}>
              Pro monthly DLLR (token units)
            </Text>
            <TextInput
              value={aiProMonthlyDraft || String(aiLimits?.proMonthlyTokenLimit ?? "")}
              onChangeText={setAiProMonthlyDraft}
              keyboardType="numeric"
              style={{
                borderWidth: 1,
                borderColor: colors.highlight,
                color: colors.primary,
                paddingHorizontal: 10,
                paddingVertical: 8,
                fontFamily: font,
                fontSize: 14,
              }}
            />
            <Text style={{ color: colors.secondary, fontSize: 11, fontFamily: font }}>
              ≈ $
              {(
                ((Number(aiProMonthlyDraft || aiLimits?.proMonthlyTokenLimit || 0) || 0) / 1000) *
                (Number(aiOnDemandRateDraft || aiLimits?.onDemandUsdPer1kTokens || 0.002) || 0.002)
              ).toFixed(4)}{" "}
              DLLR
            </Text>
          </View>
          <View style={{ flex: 1, gap: 6 }}>
            <Text style={{ color: colors.secondary, fontSize: 12, fontFamily: font }}>$ / 1k on-demand</Text>
            <TextInput
              value={aiOnDemandRateDraft || String(aiLimits?.onDemandUsdPer1kTokens ?? "")}
              onChangeText={setAiOnDemandRateDraft}
              keyboardType="decimal-pad"
              style={{
                borderWidth: 1,
                borderColor: colors.highlight,
                color: colors.primary,
                paddingHorizontal: 10,
                paddingVertical: 8,
                fontFamily: font,
                fontSize: 14,
              }}
            />
          </View>
        </View>
        <Pressable
          onPress={() => void onSaveAiLimits()}
          disabled={aiLimitsBusy}
          style={({ pressed }) => ({
            alignSelf: "flex-start",
            opacity: aiLimitsBusy ? 0.6 : pressed ? 0.85 : 1,
            backgroundColor: colors.primary,
            paddingHorizontal: 14,
            paddingVertical: 10,
          })}
        >
          <Text style={{ color: colors.background, fontWeight: "700", fontSize: 13, fontFamily: font }}>
            {aiLimitsBusy ? "Saving…" : "Save AI limits"}
          </Text>
        </Pressable>
      </Card>

      <Card title="Pro catalog · feature launch & pricing" colors={colors}>
        <Text style={{ color: colors.secondary, fontSize: 13, lineHeight: 18, fontFamily: font, marginBottom: 12 }}>
          Set each feature price in dollars (cent precision, min $0.01). AI models alone is the launch
          price. Month charge = sum of checked features + profit margin ($). Enabling more features raises
          the charged price.
        </Text>
        <View style={{ gap: 8, marginBottom: 14 }}>
          {(
            [
              ["aiModels", "AI models"],
              ["proxyVpn", "Proxy & VPN"],
              ["blockchainChat", "Blockchain chat"],
              ["unlimitedAccounts", "Unlimited messenger accounts"],
              ["cashback", "DLLR cashback"],
              ["nftCollection", "NFT collection"],
              ["menuCustomization", "Menu customization"],
            ] as const
          ).map(([id, label]) => {
            const weight = featureWeightsDraft[id] ?? 0;
            const checked = featureEnabledDraft[id] === true;
            return (
              <View
                key={id}
                style={{ flexDirection: "row", alignItems: "center", gap: 10 }}
              >
                <Pressable
                  onPress={() =>
                    setFeatureEnabledDraft((prev) => ({
                      ...prev,
                      [id]: !prev[id],
                      ...(id === "aiModels" ? { aiModels: true } : null),
                    }))
                  }
                  style={{ flexDirection: "row", alignItems: "center", gap: 10, flex: 1, minWidth: 0 }}
                >
                  <View
                    style={{
                      width: 18,
                      height: 18,
                      borderWidth: 1,
                      borderColor: colors.highlight,
                      alignItems: "center",
                      justifyContent: "center",
                      backgroundColor: checked ? colors.undercover : "transparent",
                    }}
                  >
                    {checked ? (
                      <Text style={{ color: colors.primary, fontSize: 12, lineHeight: 14 }}>✓</Text>
                    ) : null}
                  </View>
                  <Text style={{ color: colors.primary, fontSize: 14, fontFamily: font, flex: 1 }}>
                    {label}
                  </Text>
                </Pressable>
                <Text style={{ color: colors.secondary, fontSize: 12, fontFamily: font }}>$</Text>
                <TextInput
                  value={String(weight)}
                  onChangeText={(raw) => onChangeFeatureWeight(id, raw)}
                  keyboardType="numeric"
                  style={{
                    width: 72,
                    borderWidth: 1,
                    borderColor: colors.highlight,
                    color: colors.primary,
                    paddingHorizontal: 8,
                    paddingVertical: 6,
                    fontFamily: font,
                    fontSize: 14,
                    textAlign: "center",
                  }}
                />
              </View>
            );
          })}
          <Text style={{ color: colors.secondary, fontSize: 11, fontFamily: font, marginTop: 4 }}>
            Checked features: ${catalogPreview.enabledSum.toFixed(2)} · All features: $
            {catalogPreview.allSum.toFixed(2)} · Month charge: ${catalogPreview.monthCharge.toFixed(2)}
          </Text>
        </View>
        <View style={{ flexDirection: narrow ? "column" : "row", gap: 12, marginBottom: 12 }}>
          <View style={{ flex: 1, gap: 6 }}>
            <Text style={{ color: colors.secondary, fontSize: 12, fontFamily: font }}>
              Profit margin ($)
            </Text>
            <TextInput
              value={marginDraft}
              onChangeText={setMarginDraft}
              keyboardType="numeric"
              style={{
                borderWidth: 1,
                borderColor: colors.highlight,
                color: colors.primary,
                paddingHorizontal: 10,
                paddingVertical: 8,
                fontFamily: font,
                fontSize: 14,
              }}
            />
            <Text style={{ color: colors.secondary, fontSize: 11, fontFamily: font }}>
              ≈ {catalogPreview.marginPct.toFixed(1)}% of month charge (profit ÷ price)
            </Text>
          </View>
          <View style={{ flex: 1, gap: 6 }}>
            <Text style={{ color: colors.secondary, fontSize: 12, fontFamily: font }}>
              Quarter discount %
            </Text>
            <TextInput
              value={quarterDiscDraft}
              onChangeText={setQuarterDiscDraft}
              keyboardType="numeric"
              style={{
                borderWidth: 1,
                borderColor: colors.highlight,
                color: colors.primary,
                paddingHorizontal: 10,
                paddingVertical: 8,
                fontFamily: font,
                fontSize: 14,
              }}
            />
          </View>
          <View style={{ flex: 1, gap: 6 }}>
            <Text style={{ color: colors.secondary, fontSize: 12, fontFamily: font }}>
              Year discount %
            </Text>
            <TextInput
              value={yearDiscDraft}
              onChangeText={setYearDiscDraft}
              keyboardType="numeric"
              style={{
                borderWidth: 1,
                borderColor: colors.highlight,
                color: colors.primary,
                paddingHorizontal: 10,
                paddingVertical: 8,
                fontFamily: font,
                fontSize: 14,
              }}
            />
          </View>
        </View>
        {data?.catalogPlans || data?.consumptionEconomics ? (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 16, marginBottom: 12 }}>
            <Metric
              label="Month charge"
              value={money(data.consumptionEconomics?.monthPriceUsd ?? data.catalogPlans?.[0]?.priceUsd ?? catalogPreview.monthCharge)}
              colors={colors}
              emphasize
            />
            <Metric
              label="Profit margin"
              value={`${money(data.proCatalog?.profitMarginUsd ?? catalogPreview.marginUsd)} · ${((data.proCatalog?.targetProfitMargin ?? catalogPreview.marginPct / 100) * 100).toFixed(1)}%`}
              colors={colors}
            />
            <Metric
              label="List (all features)"
              value={money(data.consumptionEconomics?.fullMonthListUsd ?? catalogPreview.fullList)}
              colors={colors}
            />
            <Metric
              label="Quarter / Year"
              value={`${money(data.catalogPlans?.[1]?.priceUsd ?? 0)} / ${money(data.catalogPlans?.[2]?.priceUsd ?? 0)}`}
              colors={colors}
            />
          </View>
        ) : null}
        {data?.consumptionEconomics ? (
          <Text style={{ color: colors.secondary, fontSize: 12, lineHeight: 17, fontFamily: font, marginBottom: 12 }}>
            {data.consumptionEconomics.note} Screen-time COGS{" "}
            {money(data.consumptionEconomics.screenTimeCogsPerActiveHourUsd)}/h → retail{" "}
            {money(data.consumptionEconomics.screenTimeRetailPerActiveHourUsd)}/h. AI COGS{" "}
            {money(data.consumptionEconomics.aiCogsPer1kTokensUsd)}/1k → retail{" "}
            {money(data.consumptionEconomics.aiRetailPer1kTokensUsd)}/1k.
          </Text>
        ) : null}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
          <Pressable
            onPress={() => void onSaveProCatalog()}
            disabled={catalogBusy}
            style={({ pressed }) => ({
              opacity: catalogBusy ? 0.6 : pressed ? 0.85 : 1,
              backgroundColor: colors.primary,
              paddingHorizontal: 14,
              paddingVertical: 10,
            })}
          >
            <Text style={{ color: colors.background, fontWeight: "700", fontSize: 13, fontFamily: font }}>
              {catalogBusy ? "Saving…" : "Save catalog & tariffs"}
            </Text>
          </Pressable>
          <Pressable
            onPress={() => void onSaveProCatalog({ applyMarginToOnDemand: true })}
            disabled={catalogBusy}
            style={({ pressed }) => ({
              opacity: catalogBusy ? 0.6 : pressed ? 0.85 : 1,
              borderWidth: 1,
              borderColor: colors.highlight,
              paddingHorizontal: 14,
              paddingVertical: 10,
            })}
          >
            <Text style={{ color: colors.primary, fontWeight: "700", fontSize: 13, fontFamily: font }}>
              Save + apply margin to AI on-demand rate
            </Text>
          </Pressable>
        </View>
      </Card>

      <Card title="Revoke Pro Access (test)" colors={colors}>
        <Text style={{ color: colors.secondary, fontSize: 13, lineHeight: 18, fontFamily: font, marginBottom: 12 }}>
          Clear server-side Pro for the account that registered the given built-in wallet address.
          The user’s next quota refresh drops local Pro entitlement.
        </Text>
        <View style={{ gap: 6, marginBottom: 12, maxWidth: narrow ? undefined : 480 }}>
          <Text style={{ color: colors.secondary, fontSize: 12, fontFamily: font }}>
            Registration wallet address
          </Text>
          <TextInput
            value={revokeWalletDraft}
            onChangeText={setRevokeWalletDraft}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="UQ…"
            placeholderTextColor={colors.secondary}
            style={{
              borderWidth: 1,
              borderColor: colors.highlight,
              color: colors.primary,
              paddingHorizontal: 10,
              paddingVertical: 8,
              fontFamily: font,
              fontSize: 13,
            }}
          />
        </View>
        <Pressable
          onPress={() => void onRevokeProByWallet()}
          disabled={revokeBusy}
          style={({ pressed }) => ({
            alignSelf: "flex-start",
            opacity: revokeBusy ? 0.6 : pressed ? 0.85 : 1,
            backgroundColor: colors.primary,
            paddingHorizontal: 14,
            paddingVertical: 10,
          })}
        >
          <Text style={{ color: colors.background, fontWeight: "700", fontSize: 13, fontFamily: font }}>
            {revokeBusy ? "Revoking…" : "Revoke Pro by wallet"}
          </Text>
        </Pressable>
        {revokeMsg ? (
          <Text style={{ color: colors.secondary, fontSize: 12, fontFamily: font, marginTop: 10 }}>
            {revokeMsg}
          </Text>
        ) : null}
      </Card>

      <Card title="Support inbox" colors={colors}>
        {supportThreads.length === 0 ? (
          <Text style={{ color: colors.secondary, fontSize: 13, fontFamily: font }}>
            No support threads yet.
          </Text>
        ) : (
          <View style={{ gap: 10 }}>
            <View style={{ gap: 6 }}>
              {supportThreads.map((thread) => {
                const active = thread.id === supportThreadId;
                return (
                  <Pressable
                    key={thread.id}
                    onPress={() => void openSupportThread(thread.id)}
                    style={{
                      borderWidth: 1,
                      borderColor: active ? colors.primary : colors.highlight,
                      borderRadius: 10,
                      padding: 10,
                      backgroundColor: active ? colors.undercover : "transparent",
                      gap: 4,
                    }}
                  >
                    <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
                      <Text style={{ color: colors.primary, fontWeight: "700", fontFamily: font }}>
                        @{thread.username}
                      </Text>
                      {thread.unread_for_staff ? (
                        <Text style={{ color: "#00E05A", fontSize: 11, fontWeight: "700", fontFamily: font }}>
                          Unread
                        </Text>
                      ) : null}
                    </View>
                    <Text
                      numberOfLines={1}
                      style={{ color: colors.secondary, fontSize: 12, fontFamily: font }}
                    >
                      {thread.last_preview || "—"}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            {supportThreadId ? (
              <View style={{ gap: 8, marginTop: 4 }}>
                <View
                  style={{
                    maxHeight: 220,
                    borderWidth: 1,
                    borderColor: colors.highlight,
                    borderRadius: 10,
                    padding: 10,
                    gap: 8,
                  }}
                >
                  <ScrollView nestedScrollEnabled style={{ maxHeight: 200 }}>
                    {supportMessages.map((m) => (
                      <View
                        key={m.id}
                        style={{
                          alignSelf: m.role === "user" ? "flex-end" : "flex-start",
                          maxWidth: "92%",
                          marginBottom: 8,
                          paddingHorizontal: 10,
                          paddingVertical: 8,
                          borderRadius: 10,
                          backgroundColor:
                            m.role === "user" ? colors.undercover : "transparent",
                          borderWidth: m.role === "staff" ? 1 : 0,
                          borderColor: colors.highlight,
                        }}
                      >
                        <Text style={{ color: colors.secondary, fontSize: 10, fontFamily: font }}>
                          {m.role === "user" ? "User" : "Staff"}
                        </Text>
                        <Text style={{ color: colors.primary, fontSize: 13, fontFamily: font }}>
                          {m.content}
                        </Text>
                      </View>
                    ))}
                  </ScrollView>
                </View>
                <TextInput
                  value={supportReply}
                  onChangeText={setSupportReply}
                  placeholder="Reply to user…"
                  placeholderTextColor={colors.secondary}
                  multiline
                  style={{
                    borderWidth: 1,
                    borderColor: colors.highlight,
                    borderRadius: 10,
                    padding: 10,
                    minHeight: 64,
                    color: colors.primary,
                    fontFamily: font,
                    textAlignVertical: "top",
                  }}
                />
                <Pressable
                  onPress={() => void onSupportReply()}
                  disabled={supportBusy || !supportReply.trim()}
                  style={{
                    alignSelf: "flex-start",
                    borderWidth: 1,
                    borderColor: colors.highlight,
                    borderRadius: 10,
                    paddingHorizontal: 14,
                    paddingVertical: 10,
                    backgroundColor: colors.undercover,
                    opacity: supportBusy || !supportReply.trim() ? 0.5 : 1,
                  }}
                >
                  <Text style={{ color: "#00E05A", fontWeight: "700", fontFamily: font }}>
                    {supportBusy ? "Sending…" : "Reply"}
                  </Text>
                </Pressable>
              </View>
            ) : null}
          </View>
        )}
      </Card>

      <Card title="Breakeven" colors={colors}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 16 }}>
          <Metric
            label="Paying users · infra only"
            value={String(model.breakeven.payingUsersInfraOnly)}
            colors={colors}
            emphasize
          />
          <Metric
            label="Paying users · life burn"
            value={String(model.breakeven.payingUsersWithPersonalBurn)}
            colors={colors}
            emphasize
          />
          <Metric
            label="Blended ARPU / mo"
            value={money(model.tariffs.blendedArpuMonthlyUsd)}
            colors={colors}
          />
          <Metric
            label="Observed on-demand / mo"
            value={money(model.observedOnDemandUsdMonth ?? 0)}
            colors={colors}
          />
          <Metric
            label="Monthly burn (fixed+life+usage)"
            value={money(model.burnTotalUsdMonth)}
            colors={colors}
          />
        </View>
        <Text style={{ color: colors.secondary, fontSize: 12, lineHeight: 17, fontFamily: font }}>
          {model.breakeven.assumptions}
        </Text>
      </Card>

      {dailyRollup ? (
        <Card title="Live consumption rollup" colors={colors}>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 16 }}>
            <Metric
              label="Today · users"
              value={String(dailyRollup.today?.distinctUsers ?? 0)}
              colors={colors}
            />
            <Metric
              label="Today · avg ST"
              value={fmtDuration(dailyRollup.today?.avgActiveMsPerUser ?? 0)}
              colors={colors}
            />
            <Metric
              label="Today · Vercel"
              value={money(dailyRollup.today?.vercelUsd ?? 0)}
              colors={colors}
              emphasize
            />
            <Metric
              label="Today · providers"
              value={money(dailyRollup.today?.providerTotalUsd ?? 0)}
              colors={colors}
              emphasize
            />
            <Metric
              label="7d · screen hours"
              value={hoursFromMs(dailyRollup.d7.activeMs)}
              colors={colors}
            />
            <Metric label="7d · Vercel" value={money(dailyRollup.d7.vercel)} colors={colors} />
            <Metric label="7d · providers" value={money(dailyRollup.d7.provider)} colors={colors} />
            <Metric
              label="7d · avg ST / user-day"
              value={`${dailyRollup.d7.avgUserHours.toFixed(2)}h`}
              colors={colors}
            />
            <Metric label="30d · providers" value={money(dailyRollup.d30.provider)} colors={colors} />
            <Metric label="30d · Vercel" value={money(dailyRollup.d30.vercel)} colors={colors} />
          </View>
          <Text style={{ color: colors.secondary, fontSize: 11, lineHeight: 15, fontFamily: font }}>
            Provider $ is real billed usage by day (Vercel FOCUS; Railway/GCP when tokens/envs are set).
            Users = distinct accounts with screen sessions that day.
          </Text>
        </Card>
      ) : null}

      <Card title="1-user launch experiment (Telegram connected)" colors={colors}>
        <Text style={{ color: colors.secondary, fontSize: 13, lineHeight: 18, fontFamily: font }}>
          {model.launchExperiment.windowNote}
        </Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 16 }}>
          <Metric
            label="Fixed infra / mo"
            value={money(model.launchExperiment.estimatedFixedInfraUsdMonth)}
            colors={colors}
          />
          <Metric
            label="Variable / active hour"
            value={money(model.launchExperiment.estimatedVariablePerActiveHourUsd)}
            colors={colors}
          />
          <Metric
            label="≈ cost · 1 user · 1 hour"
            value={money(model.launchExperiment.costIfOneUserOneHourUsd)}
            colors={colors}
          />
          <Metric
            label="≈ cost · 1 user · 1 day"
            value={money(model.launchExperiment.costIfOneUserObservedDayUsd)}
            colors={colors}
          />
          <Metric
            label="≈ cost · 1 user · month"
            value={money(model.launchExperiment.costIfOneUserMonthAtObservedHoursUsd)}
            colors={colors}
          />
          <Metric
            label="On-demand only · 2h/day · mo"
            value={money(model.launchExperiment.onDemandMonthAt2hUsd ?? 0)}
            colors={colors}
            emphasize
          />
          <Metric
            label="On-demand only · 3h/day · mo"
            value={money(model.launchExperiment.onDemandMonthAt3hUsd ?? 0)}
            colors={colors}
            emphasize
          />
        </View>
        <Text style={{ color: colors.secondary, fontSize: 12, lineHeight: 17, fontFamily: font }}>
          {model.launchExperiment.explanation}
        </Text>
      </Card>

      <Card title="On-demand consumption (grows with users)" colors={colors}>
        {calibration ? (
          <>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 16 }}>
              <Metric
                label="$ / active hour (live estimate)"
                value={money(calibration.onDemandUsdPerActiveHour)}
                colors={colors}
                emphasize
              />
              <Metric
                label="Confidence"
                value={`${Math.round((calibration.confidence ?? 0) * 100)}%`}
                colors={colors}
                emphasize
              />
              <Metric
                label="Prior (probe)"
                value={money(calibration.priorUsdPerActiveHour ?? 0)}
                colors={colors}
              />
              <Metric
                label="Live $/hour"
                value={
                  calibration.liveUsdPerActiveHour != null
                    ? money(calibration.liveUsdPerActiveHour)
                    : "—"
                }
                colors={colors}
              />
              <Metric
                label="Vercel on-demand / mo"
                value={money(calibration.vercelOnDemandUsdMonth ?? 0)}
                colors={colors}
              />
              <Metric
                label="Screen hours (30d)"
                value={`${calibration.screenActiveHoursMonth.toFixed(2)}h`}
                colors={colors}
              />
            </View>
            {calibration.avgUser ? (
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 16 }}>
                <Metric
                  label="Avg user h/day (7d)"
                  value={`${calibration.avgUser.hoursPerDay7d.toFixed(2)}h`}
                  colors={colors}
                />
                <Metric
                  label="Avg user on-demand @ observed"
                  value={money(calibration.avgUser.onDemandUsdMonthAtObserved)}
                  colors={colors}
                />
                <Metric
                  label="Avg user on-demand @ 2h/day"
                  value={money(calibration.avgUser.onDemandUsdMonthAt2h)}
                  colors={colors}
                  emphasize
                />
                <Metric
                  label="Avg user on-demand @ 3h/day"
                  value={money(calibration.avgUser.onDemandUsdMonthAt3h)}
                  colors={colors}
                  emphasize
                />
              </View>
            ) : null}
            {calibration.evidence ? (
              <Text style={{ color: colors.secondary, fontSize: 12, fontFamily: font }}>
                Evidence · {calibration.evidence.distinctUsers30d} users ·{" "}
                {calibration.evidence.sessionCount30d} sessions ·{" "}
                {calibration.evidence.activeDays30d} active days ·{" "}
                {calibration.evidence.pairedSnapshotDays}/{calibration.evidence.snapshotDays}{" "}
                cost snapshots paired
              </Text>
            ) : null}
            <Text style={{ color: colors.secondary, fontSize: 11, fontFamily: font }}>
              {calibration.source}
            </Text>
            {(calibration.notes ?? []).map((n) => (
              <Text key={n} style={{ color: colors.secondary, fontSize: 12, fontFamily: font }}>
                · {n}
              </Text>
            ))}
          </>
        ) : null}
        {probe ? (
          <>
            <Text style={{ color: colors.secondary, fontSize: 12, lineHeight: 17, fontFamily: font }}>
              Last probe · {probe.durationMinutes} min · {probe.requests} requests · est.{" "}
              {money(probe.estimatedOnDemandUsd)} → {money(probe.onDemandUsdPerActiveHour)}/active-hour
              (raw, before intensity)
            </Text>
            <Text style={{ color: colors.secondary, fontSize: 11, fontFamily: font }}>
              {probe.method}
            </Text>
          </>
        ) : (
          <Text style={{ color: colors.secondary, fontSize: 13, fontFamily: font }}>
            No probe yet — click “Run 5-min probe” (or wait for the offline probe JSON env).
          </Text>
        )}
        {vercelUsage?.source === "live" ? (
          <View style={{ gap: 4, marginTop: 4 }}>
            <Text style={{ color: colors.secondary, fontSize: 12, fontFamily: font }}>
              Live Vercel FOCUS · {vercelUsage.periodDays ?? "?"}d window · period total{" "}
              {money(vercelUsage.totalUsd)} · fixed {money(vercelUsage.fixedUsdMonth)}/mo · on-demand{" "}
              {money(vercelUsage.onDemandUsdMonth)}/mo
            </Text>
            {vercelUsage.byService.slice(0, 8).map((s) => (
              <Text key={s.name} style={{ color: colors.secondary, fontSize: 11, fontFamily: font }}>
                {s.kind}: {s.name} · {money(s.usd)}
              </Text>
            ))}
          </View>
        ) : null}
        {railwayUsage ? (
          <Text style={{ color: colors.secondary, fontSize: 12, fontFamily: font }}>
            Railway · {railwayUsage.source}: {money(railwayUsage.totalUsdMonth)}/mo — {railwayUsage.detail}
          </Text>
        ) : null}
        {gcpUsage ? (
          <Text style={{ color: colors.secondary, fontSize: 12, fontFamily: font }}>
            GCP · {gcpUsage.source}: {money(gcpUsage.usdMonth)}/mo — {gcpUsage.detail}
          </Text>
        ) : null}
      </Card>

      <Card title="Screen time health" colors={colors}>
        <Text
          style={{
            color: screenTimeHealth.hasSessions ? "#00E05A" : "#FFB020",
            fontSize: 13,
            lineHeight: 18,
            fontFamily: font,
          }}
        >
          {screenTimeHealth.note}
        </Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 16 }}>
          <Metric label="Users w/ totals" value={String(screenTime.usersWithScreenTime)} colors={colors} />
          <Metric label="Sessions (all)" value={String(screenTime.totalSessions)} colors={colors} />
          <Metric
            label="Avg h / active user / day (7d)"
            value={`${screenTime.avgHoursPerActiveUserPerDay7d.toFixed(2)}h`}
            colors={colors}
          />
          <Metric
            label="7d active hours"
            value={`${screenTime.last7d.activeHours.toFixed(2)}h`}
            colors={colors}
          />
          <Metric label="App users" value={String(users.totalUsers)} colors={colors} />
          <Metric label="Telegram connected" value={String(users.telegramConnected)} colors={colors} />
        </View>

        {dailyRows.length > 0 ? (
          <View style={{ gap: 8, marginTop: 8 }}>
            <Text style={{ color: colors.secondary, fontSize: 12, fontFamily: font }}>
              Daily provider spend (UTC) — real billed usage + users with sessions
            </Text>
            <Text style={{ color: colors.secondary, fontSize: 11, lineHeight: 15, fontFamily: font }}>
              Vercel = FOCUS ChargePeriodStart day totals. Railway/GCP = live API or env until tokens are
              set. Users = distinct accounts with active screen time that day.
            </Text>
            <ScrollView horizontal showsHorizontalScrollIndicator>
              <View style={{ gap: 6, minWidth: 720 }}>
                <View
                  style={{
                    flexDirection: "row",
                    gap: 6,
                    paddingBottom: 4,
                    borderBottomWidth: 1,
                    borderBottomColor: colors.highlight,
                  }}
                >
                  {(
                    [
                      ["Day", 88],
                      ["Users", 48],
                      ["Avg ST", 64],
                      ["Sessions", 56],
                      ["Vercel", 64],
                      ["Railway", 64],
                      ["GCP", 56],
                      ["Total $", 64],
                    ] as const
                  ).map(([label, w]) => (
                    <Text
                      key={label}
                      style={{
                        width: w,
                        color: colors.secondary,
                        fontSize: 10,
                        fontWeight: "700",
                        fontFamily: font,
                      }}
                    >
                      {label}
                    </Text>
                  ))}
                </View>
                {[...dailyRows].reverse().map((d) => (
                  <View key={d.day} style={{ gap: 4 }}>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                      <Text style={{ width: 88, color: colors.primary, fontSize: 11, fontFamily: font }}>
                        {d.day}
                      </Text>
                      <Text style={{ width: 48, color: colors.primary, fontSize: 11, fontFamily: font }}>
                        {d.distinctUsers}
                      </Text>
                      <Text style={{ width: 64, color: colors.primary, fontSize: 11, fontFamily: font }}>
                        {fmtDuration(d.avgActiveMsPerUser)}
                      </Text>
                      <Text style={{ width: 56, color: colors.primary, fontSize: 11, fontFamily: font }}>
                        {d.sessions}
                      </Text>
                      <Text style={{ width: 64, color: colors.primary, fontSize: 11, fontFamily: font }}>
                        {d.vercelUsd != null ? money(d.vercelUsd) : "—"}
                      </Text>
                      <Text style={{ width: 64, color: colors.primary, fontSize: 11, fontFamily: font }}>
                        {d.railwayUsd != null ? money(d.railwayUsd) : "—"}
                      </Text>
                      <Text style={{ width: 56, color: colors.primary, fontSize: 11, fontFamily: font }}>
                        {d.gcpUsd != null ? money(d.gcpUsd) : "—"}
                      </Text>
                      <Text
                        style={{
                          width: 64,
                          color: "#00E05A",
                          fontSize: 11,
                          fontWeight: "700",
                          fontFamily: font,
                        }}
                      >
                        {d.providerTotalUsd != null ? money(d.providerTotalUsd) : "—"}
                      </Text>
                    </View>
                    <View
                      style={{
                        height: 6,
                        borderRadius: 3,
                        backgroundColor: colors.background,
                        overflow: "hidden",
                        marginLeft: 88,
                      }}
                    >
                      <View
                        style={{
                          width: `${Math.max(d.activeMs > 0 ? 4 : 0, (d.activeMs / maxDailyMs) * 100)}%`,
                          height: "100%",
                          backgroundColor: "#00E05A",
                        }}
                      />
                    </View>
                  </View>
                ))}
              </View>
            </ScrollView>
          </View>
        ) : screenTime.dailyLast14d.length > 0 ? (
          <View style={{ gap: 6, marginTop: 4 }}>
            <Text style={{ color: colors.secondary, fontSize: 12, fontFamily: font }}>
              Daily active ms (14d)
            </Text>
            {screenTime.dailyLast14d.map((d) => (
              <View key={d.day} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Text style={{ width: 88, color: colors.secondary, fontSize: 11, fontFamily: font }}>
                  {d.day}
                </Text>
                <View
                  style={{
                    flex: 1,
                    height: 10,
                    borderRadius: 5,
                    backgroundColor: colors.background,
                    overflow: "hidden",
                  }}
                >
                  <View
                    style={{
                      width: `${Math.max(4, (d.activeMs / maxDailyMs) * 100)}%`,
                      height: "100%",
                      backgroundColor: "#00E05A",
                    }}
                  />
                </View>
                <Text style={{ width: 72, color: colors.primary, fontSize: 11, fontFamily: font }}>
                  {hoursFromMs(d.activeMs)}
                </Text>
              </View>
            ))}
          </View>
        ) : null}

        {screenTime.recentSessions.length > 0 ? (
          <View style={{ gap: 6, marginTop: 8 }}>
            <Text style={{ color: colors.secondary, fontSize: 12, fontFamily: font }}>
              Recent sessions
            </Text>
            {screenTime.recentSessions.slice(0, 8).map((s) => (
              <Text
                key={`${s.clientSessionId}-${s.startedAt}`}
                style={{ color: colors.primary, fontSize: 12, fontFamily: font }}
              >
                @{s.telegramUsername} · {fmtDuration(s.activeMs)} · {s.platform ?? "?"} ·{" "}
                {s.endedAt ? "ended" : "open"} · {new Date(s.startedAt).toLocaleString()}
              </Text>
            ))}
          </View>
        ) : null}
      </Card>

      <Card title="Tariffs (from Pro catalog)" colors={colors}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 16 }}>
          <Metric label="Month" value={money(model.tariffs.monthUsd)} colors={colors} emphasize />
          <Metric label="Quarter total" value={money(model.tariffs.quarterTotalUsd)} colors={colors} />
          <Metric label="Year total" value={money(model.tariffs.yearTotalUsd)} colors={colors} />
          <Metric
            label="Mix M/Q/Y"
            value={`${Math.round(model.tariffs.mix.month * 100)}/${Math.round(model.tariffs.mix.quarter * 100)}/${Math.round(model.tariffs.mix.year * 100)}`}
            colors={colors}
          />
        </View>
      </Card>

      <Card title="Costs (providers + life)" colors={colors}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 16 }}>
          <Metric label="Fixed infra" value={money(model.infraTotalUsdMonth)} colors={colors} />
          <Metric label="Personal total" value={money(model.personalTotalUsdMonth)} colors={colors} />
          <Metric
            label="Observed on-demand"
            value={money(model.observedOnDemandUsdMonth ?? 0)}
            colors={colors}
          />
          <Metric
            label="$ / active hour"
            value={money(model.costs.variablePerActiveHourUsd)}
            colors={colors}
            emphasize
          />
        </View>
        <View style={{ gap: 6 }}>
          {providers.map((p) => (
            <Text key={p.label} style={{ color: colors.secondary, fontSize: 12, fontFamily: font }}>
              {p.label}: {money(p.usdMonthEstimate ?? 0)} · {p.source}
              {p.detail ? ` — ${p.detail}` : ""}
            </Text>
          ))}
        </View>
        <Text style={{ color: colors.secondary, fontSize: 12, fontFamily: font }}>
          Life: Cursor {money(model.costs.personal.cursorUsdMonth)}, rent{" "}
          {money(model.costs.personal.rentUsdMonth)}, food {money(model.costs.personal.foodUsdMonth)},
          electricity {money(model.costs.personal.electricityUsdMonth)}, SIM{" "}
          {money(model.costs.personal.simUsdMonth)}, electronics{" "}
          {money(model.costs.personal.electronicsUsdMonth)}, other{" "}
          {money(model.costs.personal.otherPersonalUsdMonth)}
        </Text>
      </Card>

      <Card title="Scale scenarios" colors={colors}>
        <ScrollView horizontal showsHorizontalScrollIndicator>
          <View style={{ gap: 8, minWidth: narrow ? 720 : 900 }}>
            <View style={{ flexDirection: "row", gap: 8 }}>
              {[
                "Scenario",
                "Users",
                "h/day",
                "Revenue",
                "Fixed",
                "On-demand",
                "Life",
                "Profit/mo",
                "Profit/yr",
              ].map((h) => (
                <Text
                  key={h}
                  style={{
                    width: h === "Scenario" ? 160 : 72,
                    color: colors.secondary,
                    fontSize: 11,
                    fontWeight: "700",
                    fontFamily: font,
                  }}
                >
                  {h}
                </Text>
              ))}
            </View>
            {model.scenarios.map((s) => (
              <View key={s.id} style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
                <Text style={{ width: 160, color: colors.primary, fontSize: 12, fontFamily: font }}>
                  {s.label}
                </Text>
                <Text style={{ width: 72, color: colors.primary, fontSize: 12 }}>{s.payingUsers}</Text>
                <Text style={{ width: 72, color: colors.primary, fontSize: 12 }}>
                  {s.avgScreenHoursPerDay}
                </Text>
                <Text style={{ width: 72, color: colors.primary, fontSize: 12 }}>
                  {money(s.revenueMonthlyUsd)}
                </Text>
                <Text style={{ width: 72, color: colors.primary, fontSize: 12 }}>
                  {money(s.fixedInfraMonthlyUsd ?? s.infraMonthlyUsd - s.variableMonthlyUsd)}
                </Text>
                <Text style={{ width: 72, color: colors.primary, fontSize: 12 }}>
                  {money(s.onDemandMonthlyUsd ?? s.variableMonthlyUsd)}
                </Text>
                <Text style={{ width: 72, color: colors.primary, fontSize: 12 }}>
                  {money(s.personalMonthlyUsd)}
                </Text>
                <Text
                  style={{
                    width: 72,
                    color: s.profitMonthlyUsd >= 0 ? "#00E05A" : "#FF5555",
                    fontSize: 12,
                    fontWeight: "700",
                  }}
                >
                  {money(s.profitMonthlyUsd)}
                </Text>
                <Text
                  style={{
                    width: 72,
                    color: s.profitAnnualUsd >= 0 ? "#00E05A" : "#FF5555",
                    fontSize: 12,
                    fontWeight: "700",
                  }}
                >
                  {money(s.profitAnnualUsd)}
                </Text>
              </View>
            ))}
          </View>
        </ScrollView>
      </Card>

      <Card title="Sales strategy" colors={colors}>
        {model.strategy.sales.map((line) => (
          <Text
            key={line}
            style={{ color: colors.primary, fontSize: 13, lineHeight: 19, fontFamily: font }}
          >
            · {line}
          </Text>
        ))}
      </Card>

      <Card title="Hiring plan" colors={colors}>
        {model.strategy.hiring.map((line) => (
          <Text
            key={line}
            style={{ color: colors.primary, fontSize: 13, lineHeight: 19, fontFamily: font }}
          >
            · {line}
          </Text>
        ))}
      </Card>

      <Card title="Milestones" colors={colors}>
        {model.strategy.milestones.map((m) => (
          <View key={m.when} style={{ gap: 2 }}>
            <Text style={{ color: "#00E05A", fontSize: 13, fontWeight: "700", fontFamily: font }}>
              {m.when}
            </Text>
            <Text style={{ color: colors.primary, fontSize: 13, lineHeight: 18, fontFamily: font }}>
              {m.what}
            </Text>
          </View>
        ))}
      </Card>
    </ScrollView>
  );
}
