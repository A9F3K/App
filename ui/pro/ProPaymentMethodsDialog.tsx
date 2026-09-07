import * as Clipboard from "expo-clipboard";
import { Image } from "expo-image";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  Platform,
  Pressable,
  Text,
  TextInput,
  useWindowDimensions,
  View,
  type LayoutChangeEvent,
} from "react-native";

import { useAppStrings } from "../../locales/AppStringsContext";
import { FONT_UI_SANS_REGULAR, WEB_UI_MONO_STACK, WEB_UI_SANS_STACK } from "../fonts";
import { useColors } from "../theme";
import { FloatingDialogShell } from "../components/FloatingDialogShell";
import { FloatingDialogBody } from "../components/FloatingDialogBody";
import { FloatingDialogStickyHeader } from "../components/FloatingDialogStickyHeader";
import { resolveFloatingDialogInsets } from "../components/floatingDialogChrome";
import { resolveFloatingDialogDefaultSize } from "../components/floatingDialogGeometry";
import { FloatingDialogScrollChromeProvider } from "../components/floatingDialogScrollChrome";
import { HspScrollColumn } from "../components/HspScrollColumn";
import { HeaderIconCopy } from "../components/icons/HeaderActionIcons";
import { SmartGradientDivider } from "../components/smart/SmartGradientDivider";
import { MusicBackChevronIcon } from "../components/music/MusicControlIcons";
import { useTonConnectSession } from "../ton/TonConnectProvider";
import { buildGetTopUpTransaction } from "../ton/buildGetTopUpTransaction";
import { SWAP_USDT_TOKEN } from "../swap/swapPairTypes";
import {
  creditBuiltinDllrUsd,
  creditProCashbackDllrUsd,
  debitBuiltinDllrUsd,
  getBuiltinDllrBalanceUsd,
  getBuiltinDllrFrozenUsd,
  getBuiltinDllrHotUsd,
  PRO_CASHBACK_DLLR_USD,
  subscribeBuiltinDllrBalance,
} from "./dllrBalanceStore";
import {
  activateProAccess,
  formatUsd,
  getProAccessPlans,
  type ProAccessPlanId,
} from "./proAccessStore";
import { isProFeatureEnabled, subscribeProCatalog } from "./proCatalogStore";
import { resolveProPaymentTonAddress } from "./proPaymentConfig";
import { waitForProUsdtPayment } from "./waitForProUsdtPayment";
import {
  createProPaymentMemo,
  minDllrTopUpForPlanUsd,
  parseDllrUsdFromProPaymentMemo,
  PRO_TOPUP_RESIDUAL_DLLR_USD,
} from "./proPaymentMemo";
import { ProSubscribeButton } from "./ProSubscribeButton";
import { requestOpenSupportChat } from "../support/openSupportChat";

type PaymentMethodId = "builtin" | "direct" | "tonconnect";

type Props = {
  visible: boolean;
  planId: ProAccessPlanId;
  onClose: () => void;
  onBackToTariffs: () => void;
};

const COPY_ICON_PX = 18;

function middleEllipsis(address: string, head = 6, tail = 6): string {
  const trimmed = address.trim();
  if (trimmed.length <= head + tail + 3) return trimmed;
  return `${trimmed.slice(0, head)}…${trimmed.slice(-tail)}`;
}

function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();
}

function parseAmount(raw: string): number {
  const n = Number.parseFloat(raw.replace(",", ".").replace(/[^\d.]/g, ""));
  return Number.isFinite(n) ? n : NaN;
}

function formatUsdtAmount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(2).replace(/\.?0+$/, "");
}

function MethodRadio({ selected, color }: { selected: boolean; color: string }) {
  return (
    <View
      style={{
        width: 20,
        height: 20,
        borderRadius: 10,
        borderWidth: 2,
        borderColor: selected ? color : "rgba(128,128,128,0.45)",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        marginTop: 1,
      }}
    >
      {selected ? (
        <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: color }} />
      ) : null}
    </View>
  );
}

/** Accordion affordance — avoids empty radios before a method is chosen. */
function MethodExpandChevron({
  expanded,
  color,
}: {
  expanded: boolean;
  color: string;
}) {
  return (
    <View
      style={{
        width: 28,
        height: 28,
        borderRadius: 8,
        alignItems: "center",
        justifyContent: "center",
        transform: [{ rotate: expanded ? "90deg" : "0deg" }],
      }}
    >
      <Text style={{ color, fontSize: 22, fontWeight: "700", lineHeight: 24 }}>›</Text>
    </View>
  );
}

function CopyableValueRow({
  label,
  value,
  copied,
  onCopy,
  copyLabel,
  copiedLabel,
  colors,
  labelFont,
  mono,
  chainBadge,
}: {
  label: string;
  value: string;
  copied: boolean;
  onCopy: () => void;
  copyLabel: string;
  copiedLabel: string;
  colors: { primary: string; secondary: string; highlight: string; background: string; undercover?: string };
  labelFont: string;
  mono?: boolean;
  chainBadge?: string;
}) {
  return (
    <View
      style={{
        borderRadius: 10,
        backgroundColor: colors.background,
        borderWidth: 1,
        borderColor: colors.highlight,
        paddingHorizontal: 12,
        paddingVertical: 11,
        gap: 6,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <Text style={{ color: colors.secondary, fontSize: 12, fontFamily: labelFont, flex: 1 }}>
          {label}
        </Text>
        {chainBadge ? (
          <View
            style={{
              paddingHorizontal: 8,
              paddingVertical: 3,
              borderRadius: 6,
              backgroundColor: colors.undercover ?? colors.highlight,
            }}
          >
            <Text
              style={{
                color: colors.primary,
                fontSize: 11,
                fontWeight: "700",
                fontFamily: labelFont,
                letterSpacing: 0.3,
              }}
            >
              {chainBadge}
            </Text>
          </View>
        ) : null}
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <Text
          selectable
          style={{
            flex: 1,
            minWidth: 0,
            color: colors.primary,
            fontSize: 13,
            lineHeight: 18,
            fontFamily: mono
              ? Platform.OS === "web"
                ? WEB_UI_MONO_STACK
                : FONT_UI_SANS_REGULAR
              : labelFont,
          }}
          numberOfLines={2}
        >
          {value || "—"}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={copied ? copiedLabel : copyLabel}
          onPress={onCopy}
          hitSlop={8}
          style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
        >
          <HeaderIconCopy color={colors.primary} size={COPY_ICON_PX} />
        </Pressable>
      </View>
      {copied ? (
        <Text style={{ color: colors.secondary, fontSize: 11, fontFamily: labelFont }}>
          {copiedLabel}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * Payment ways for Pro Access — built-in DLLR, direct USDT (TON) + memo/check,
 * or TonConnect USDT jetton transfer (same mechanics as Get).
 */
export function ProPaymentMethodsDialog({
  visible,
  planId,
  onClose,
  onBackToTariffs,
}: Props) {
  const colors = useColors();
  const { t, tf } = useAppStrings();
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const ton = useTonConnectSession();
  const dllrBalance = useSyncExternalStore(
    subscribeBuiltinDllrBalance,
    getBuiltinDllrBalanceUsd,
    getBuiltinDllrBalanceUsd,
  );
  const dllrHot = useSyncExternalStore(
    subscribeBuiltinDllrBalance,
    getBuiltinDllrHotUsd,
    getBuiltinDllrHotUsd,
  );
  const dllrFrozen = useSyncExternalStore(
    subscribeBuiltinDllrBalance,
    getBuiltinDllrFrozenUsd,
    getBuiltinDllrFrozenUsd,
  );
  /** No method expanded until the user taps a preview row. */
  const [method, setMethod] = useState<PaymentMethodId | null>(null);
  const [headerExtendPx, setHeaderExtendPx] = useState(0);
  const [footerExtendPx, setFooterExtendPx] = useState(0);
  const [copiedField, setCopiedField] = useState<
    "address" | "memo" | "directMemo" | "amount" | null
  >(null);
  const [connectBusy, setConnectBusy] = useState(false);
  const [selectedWalletKey, setSelectedWalletKey] = useState<string | null>(null);
  const [usdtPayInput, setUsdtPayInput] = useState("");
  const [memo, setMemo] = useState("");
  const [directMemo, setDirectMemo] = useState("");
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [checkBusy, setCheckBusy] = useState(false);

  const onFooterLayout = useCallback((e: LayoutChangeEvent) => {
    const h = e.nativeEvent.layout.height;
    if (h > 0) setFooterExtendPx(h);
  }, []);

  const defaultSize = useMemo(
    () => resolveFloatingDialogDefaultSize(windowWidth, windowHeight, "pro"),
    [windowHeight, windowWidth],
  );
  const dialogInsets = resolveFloatingDialogInsets(windowHeight);
  const plan = useSyncExternalStore(
    subscribeProCatalog,
    () => getProAccessPlans().find((p) => p.id === planId) ?? getProAccessPlans()[0]!,
    () => getProAccessPlans().find((p) => p.id === planId) ?? getProAccessPlans()[0]!,
  );
  const planLabel = t(
    plan.id === "month"
      ? "pro.plan.month"
      : plan.id === "quarter"
        ? "pro.plan.quarter"
        : "pro.plan.year",
  );
  const priceLabel = formatUsd(plan.priceUsd);
  /** Instant pay when total DLLR (hot + frozen) covers the plan. */
  const hasEnoughDllr = dllrBalance + 1e-9 >= plan.priceUsd;
  /** e.g. $20 plan + $1 residual − total balance → buy enough that 1 DLLR remains after subscribe. */
  const minTopUpUsd = hasEnoughDllr
    ? 0.01
    : minDllrTopUpForPlanUsd(plan.priceUsd, dllrBalance);
  const paymentAddress = resolveProPaymentTonAddress();
  const labelFont = Platform.OS === "web" ? WEB_UI_SANS_STACK : FONT_UI_SANS_REGULAR;

  const flashCopied = useCallback((field: "address" | "memo" | "directMemo" | "amount") => {
    setCopiedField(field);
    setTimeout(() => setCopiedField((cur) => (cur === field ? null : cur)), 1200);
  }, []);

  const copyText = useCallback(
    async (value: string, field: "address" | "memo" | "directMemo" | "amount") => {
      await Clipboard.setStringAsync(value);
      flashCopied(field);
    },
    [flashCopied],
  );

  const seedAmountsForMethod = useCallback(
    (id: PaymentMethodId) => {
      // Direct / TonConnect: pay the plan in USDT on TON (1 USDT ≈ 1 DLLR).
      // Built-in wallet: top up only what is still needed for the plan.
      const planUsdt = plan.priceUsd;
      const topUpSeed = hasEnoughDllr ? Math.max(1, minTopUpUsd) : minTopUpUsd;
      const seed = id === "direct" || id === "tonconnect" ? planUsdt : topUpSeed;
      setUsdtPayInput(formatUsdtAmount(seed));
      setMemo(createProPaymentMemo(plan.id, seed));
      setDirectMemo(createProPaymentMemo(plan.id, planUsdt));
    },
    [hasEnoughDllr, minTopUpUsd, plan.id, plan.priceUsd],
  );

  const selectMethod = useCallback(
    (id: PaymentMethodId) => {
      setStatusMsg(null);
      if (method === id) {
        setMethod(null);
        return;
      }
      setMethod(id);
      seedAmountsForMethod(id);
    },
    [method, seedAmountsForMethod],
  );

  useEffect(() => {
    if (!visible) return;
    setMethod(null);
    setStatusMsg(null);
    setCopiedField(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- open/plan only
  }, [visible, planId]);

  // Keep memos in sync with the USDT amount (1 USDT ≈ 1 DLLR).
  useEffect(() => {
    if (!visible) return;
    const usdt = parseAmount(usdtPayInput);
    if (!Number.isFinite(usdt) || usdt <= 0) return;
    const next = createProPaymentMemo(plan.id, usdt);
    const lockedMemo = parseDllrUsdFromProPaymentMemo(memo);
    if (lockedMemo == null || Math.abs(lockedMemo - usdt) >= 0.005) {
      setMemo(next);
    }
    if (method === "direct" || method === "tonconnect") {
      const lockedDirect = parseDllrUsdFromProPaymentMemo(directMemo);
      if (lockedDirect == null || Math.abs(lockedDirect - usdt) >= 0.005) {
        setDirectMemo(next);
      }
    }
  }, [directMemo, memo, method, plan.id, usdtPayInput, visible]);

  const wallets = useMemo(() => {
    const list = [...ton.rememberedWallets];
    const active = ton.friendlyAddress || ton.address;
    if (
      active &&
      !list.some(
        (row) =>
          sameAddress(row.address, active) || sameAddress(row.friendlyAddress, active),
      )
    ) {
      list.unshift({
        address: active,
        friendlyAddress: active,
        name: ton.walletName,
        imageUrl: ton.walletImageUrl,
        lastConnectedAt: Date.now(),
      });
    }
    return list;
  }, [ton.address, ton.friendlyAddress, ton.rememberedWallets, ton.walletImageUrl, ton.walletName]);

  const activeWalletKey = (ton.friendlyAddress || ton.address || "").trim().toLowerCase();
  const effectiveWalletKey =
    selectedWalletKey &&
    wallets.some(
      (w) => (w.friendlyAddress || w.address).trim().toLowerCase() === selectedWalletKey,
    )
      ? selectedWalletKey
      : activeWalletKey ||
        (wallets[0] ? (wallets[0].friendlyAddress || wallets[0].address).trim().toLowerCase() : null);

  const openWalletPicker = useCallback(async () => {
    setConnectBusy(true);
    try {
      if (ton.connected) await ton.disconnect();
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
      await ton.openConnectModal();
      ton.refreshRememberedWallets();
    } finally {
      setConnectBusy(false);
    }
  }, [ton]);

  const selectRememberedWallet = useCallback(
    async (key: string) => {
      setSelectedWalletKey(key);
      if (sameAddress(key, ton.friendlyAddress || ton.address)) return;
      await openWalletPicker();
    },
    [openWalletPicker, ton.address, ton.friendlyAddress],
  );

  const onPayWithDllr = useCallback(() => {
    if (!debitBuiltinDllrUsd(plan.priceUsd)) {
      setStatusMsg(t("pro.pay.builtin.payFailed"));
      return;
    }
    activateProAccess(plan.id);
    if (isProFeatureEnabled("cashback")) {
      creditProCashbackDllrUsd(PRO_CASHBACK_DLLR_USD);
      setStatusMsg(
        tf("pro.pay.builtin.paidCashback", { cashback: formatUsd(PRO_CASHBACK_DLLR_USD) }),
      );
    } else {
      setStatusMsg(t("pro.pay.builtin.paid"));
    }
    setTimeout(() => onClose(), 700);
  }, [onClose, plan.id, plan.priceUsd, t, tf]);

  const resolvedUsdt = parseAmount(usdtPayInput);
  const usdtPayMin =
    method === "direct" || method === "tonconnect"
      ? plan.priceUsd
      : hasEnoughDllr
        ? 0.01
        : minTopUpUsd;
  const usdtPayValid = Number.isFinite(resolvedUsdt) && resolvedUsdt + 1e-9 >= usdtPayMin;

  const runCheckPayment = useCallback(
    async (opts: { memoText: string; activateAfter?: boolean; fallbackDollars?: number }) => {
      const memoText = opts.memoText.trim();
      if (!memoText) {
        setStatusMsg(t("pro.pay.check.memoRequired"));
        return;
      }
      const fromMemo = parseDllrUsdFromProPaymentMemo(memoText);
      const dollars = fromMemo ?? opts.fallbackDollars ?? NaN;
      if (!Number.isFinite(dollars) || dollars <= 0) {
        setStatusMsg(t("pro.pay.check.invalidAmount"));
        return;
      }
      setCheckBusy(true);
      setStatusMsg(t("pro.pay.check.waiting"));
      try {
        // TON finality ~1s; TonAPI index lag usually a few seconds — soft ~8s / hard ~25s.
        const wait = await waitForProUsdtPayment({
          paymentAddress,
          expectedUsd: dollars,
          requireIndexed: false,
          onTick: (elapsedMs) => {
            if (elapsedMs >= 1500) {
              setStatusMsg(t("pro.pay.check.waiting"));
            }
          },
        });
        if (wait.confirmed) {
          setStatusMsg(t("pro.pay.check.confirmed"));
        }
        creditBuiltinDllrUsd(dollars);
        const shouldActivate =
          opts.activateAfter ||
          (!hasEnoughDllr && getBuiltinDllrBalanceUsd() + 1e-9 >= plan.priceUsd);
        if (shouldActivate && getBuiltinDllrBalanceUsd() + 1e-9 >= plan.priceUsd) {
          if (debitBuiltinDllrUsd(plan.priceUsd)) {
            activateProAccess(plan.id);
            if (isProFeatureEnabled("cashback")) {
              creditProCashbackDllrUsd(PRO_CASHBACK_DLLR_USD);
              setStatusMsg(
                tf("pro.pay.check.creditedAndActivatedLeft", {
                  amount: formatUsd(dollars),
                  left: formatUsd(PRO_TOPUP_RESIDUAL_DLLR_USD),
                  cashback: formatUsd(PRO_CASHBACK_DLLR_USD),
                }),
              );
            } else {
              setStatusMsg(t("pro.pay.check.creditedAndActivated"));
            }
            setTimeout(() => onClose(), 700);
            return;
          }
        }
        setStatusMsg(tf("pro.pay.check.credited", { amount: formatUsd(dollars) }));
      } finally {
        setCheckBusy(false);
      }
    },
    [hasEnoughDllr, onClose, paymentAddress, plan.id, plan.priceUsd, t, tf],
  );

  const sendUsdtViaTonConnect = useCallback(
    async (opts: { amountUsd: number; memoText: string; activateAfter: boolean }) => {
      if (!Number.isFinite(opts.amountUsd) || opts.amountUsd <= 0) {
        setStatusMsg(t("pro.pay.topup.buyInvalid"));
        return;
      }
      if (!ton.connected || !ton.address) {
        await openWalletPicker();
        return;
      }
      if (!paymentAddress.trim()) {
        setStatusMsg(t("pro.pay.direct.addressPending"));
        return;
      }
      setConnectBusy(true);
      setStatusMsg(null);
      try {
        const request = await buildGetTopUpTransaction({
          amount: formatUsdtAmount(opts.amountUsd),
          token: SWAP_USDT_TOKEN,
          fromWalletAddress: ton.address,
          toBuiltInWalletAddress: paymentAddress,
        });
        await ton.sendTransaction(request);
        await runCheckPayment({
          memoText: opts.memoText,
          activateAfter: opts.activateAfter,
          fallbackDollars: opts.amountUsd,
        });
      } catch {
        setStatusMsg(t("pro.pay.topup.buyCancelled"));
      } finally {
        setConnectBusy(false);
      }
    },
    [openWalletPicker, paymentAddress, runCheckPayment, t, ton],
  );

  const payUsdtAmount = useMemo(() => {
    const fromInput = parseAmount(usdtPayInput);
    if (Number.isFinite(fromInput) && fromInput > 0) return formatUsdtAmount(fromInput);
    return formatUsdtAmount(plan.priceUsd);
  }, [plan.priceUsd, usdtPayInput]);

  const finalCta = useMemo(() => {
    if (method == null) {
      return {
        kind: "pick" as const,
        label: t("pro.pay.final.chooseMethod"),
        disabled: true,
      };
    }
    if (method === "builtin" && hasEnoughDllr) {
      return {
        kind: "pay_dllr" as const,
        label: tf("pro.pay.final.payDllr", { amount: String(plan.priceUsd) }),
        disabled: false,
      };
    }
    if (method === "tonconnect") {
      return {
        kind: "pay_usdt" as const,
        label:
          checkBusy || connectBusy
            ? t("pro.pay.check.busy")
            : tf("pro.pay.final.payUsdt", { amount: formatUsdtAmount(plan.priceUsd) }),
        disabled: checkBusy || connectBusy || !paymentAddress.trim(),
      };
    }
    if (method === "builtin" && !hasEnoughDllr) {
      return {
        kind: "pay_usdt" as const,
        label:
          checkBusy || connectBusy
            ? t("pro.pay.check.busy")
            : tf("pro.pay.final.payUsdt", { amount: payUsdtAmount }),
        disabled: checkBusy || connectBusy || !usdtPayValid,
      };
    }
    return {
      kind: "check" as const,
      label: checkBusy ? t("pro.pay.check.busy") : t("pro.pay.check.button"),
      disabled: checkBusy,
    };
  }, [
    checkBusy,
    connectBusy,
    hasEnoughDllr,
    method,
    payUsdtAmount,
    plan.priceUsd,
    t,
    tf,
    usdtPayValid,
  ]);

  const onFinalCta = useCallback(async () => {
    if (finalCta.kind === "pick" || method == null) return;
    if (finalCta.kind === "pay_dllr") {
      onPayWithDllr();
      return;
    }
    if (finalCta.kind === "pay_usdt") {
      const amount =
        method === "tonconnect" ? plan.priceUsd : parseAmount(payUsdtAmount);
      await sendUsdtViaTonConnect({
        amountUsd: amount,
        memoText: method === "tonconnect" ? directMemo : memo,
        activateAfter: method === "tonconnect" || !hasEnoughDllr,
      });
      return;
    }
    await runCheckPayment({
      memoText: method === "direct" ? directMemo : memo,
      activateAfter: method === "direct",
      fallbackDollars: method === "direct" ? plan.priceUsd : resolvedUsdt,
    });
  }, [
    directMemo,
    finalCta.kind,
    hasEnoughDllr,
    memo,
    method,
    onPayWithDllr,
    payUsdtAmount,
    plan.priceUsd,
    resolvedUsdt,
    runCheckPayment,
    sendUsdtViaTonConnect,
  ]);

  const subRowStyle = {
    borderRadius: 10,
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.highlight,
    paddingHorizontal: 12,
    paddingVertical: 11,
  } as const;

  const inputStyle = {
    ...subRowStyle,
    color: colors.primary,
    fontSize: 15,
    fontFamily: labelFont,
    paddingVertical: 10,
  } as const;

  const addressMemoBlock = (
    memoValue: string,
    memoField: "memo" | "directMemo",
    opts?: { showAmount?: boolean },
  ) => (
    <View style={{ gap: 8 }}>
      <CopyableValueRow
        label={t("pro.pay.direct.addressLabel")}
        value={paymentAddress}
        copied={copiedField === "address"}
        onCopy={() => void copyText(paymentAddress, "address")}
        copyLabel={t("get.copyAddressButton")}
        copiedLabel={t("pro.pay.direct.copied")}
        colors={colors}
        labelFont={labelFont}
        mono
        chainBadge={t("pro.pay.direct.chain")}
      />
      {opts?.showAmount !== false ? (
        <CopyableValueRow
          label={t("pro.pay.direct.amountLabel")}
          value={formatUsdtAmount(plan.priceUsd)}
          copied={copiedField === "amount"}
          onCopy={() => void copyText(formatUsdtAmount(plan.priceUsd), "amount")}
          copyLabel={t("pro.pay.direct.amountCopy")}
          copiedLabel={t("pro.pay.direct.copied")}
          colors={colors}
          labelFont={labelFont}
          mono
          chainBadge="USDT"
        />
      ) : null}
      <CopyableValueRow
        label={t("pro.pay.memo.label")}
        value={memoValue}
        copied={copiedField === memoField}
        onCopy={() => void copyText(memoValue, memoField)}
        copyLabel={t("pro.pay.memo.copy")}
        copiedLabel={t("pro.pay.direct.copied")}
        colors={colors}
        labelFont={labelFont}
        mono
      />
      <Text style={{ color: colors.secondary, fontSize: 11, lineHeight: 15, fontFamily: labelFont }}>
        {t("pro.pay.memo.lockHint")}
      </Text>
    </View>
  );

  const topUpPanel = (
    <View style={{ gap: 10 }}>
      <Text style={{ color: colors.secondary, fontSize: 13, lineHeight: 18, fontFamily: labelFont }}>
        {hasEnoughDllr
          ? t("pro.pay.topup.anyAmountHint")
          : tf("pro.pay.topup.minHintResidual", {
              min: formatUsd(minTopUpUsd),
              plan: priceLabel,
              left: formatUsd(PRO_TOPUP_RESIDUAL_DLLR_USD),
            })}
      </Text>
      <View style={{ gap: 4 }}>
        <Text style={{ color: colors.secondary, fontSize: 12, fontFamily: labelFont }}>
          {t("pro.pay.topup.usdtLabel")}
        </Text>
        <TextInput
          value={usdtPayInput}
          onChangeText={setUsdtPayInput}
          keyboardType="decimal-pad"
          placeholder={String(minTopUpUsd)}
          placeholderTextColor={colors.secondary}
          style={inputStyle}
        />
      </View>
      <Text style={{ color: colors.secondary, fontSize: 11, fontFamily: labelFont }}>
        {t("pro.pay.topup.usdtHint")}
      </Text>
      {addressMemoBlock(memo, "memo", { showAmount: false })}
    </View>
  );

  const methodTile = (
    id: PaymentMethodId,
    title: string,
    shortHint: string,
    body: ReactNode,
  ) => {
    const expanded = method === id;
    return (
      <View
        style={{
          borderRadius: 14,
          borderWidth: expanded ? 2 : 1,
          borderColor: expanded ? colors.primary : colors.highlight,
          backgroundColor: colors.undercover,
          overflow: "hidden",
        }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          onPress={() => selectMethod(id)}
          style={({ pressed }) => ({
            flexDirection: "row",
            alignItems: "center",
            gap: 12,
            paddingHorizontal: 16,
            paddingVertical: 16,
            opacity: pressed ? 0.88 : 1,
            backgroundColor: expanded ? colors.background : "transparent",
          })}
        >
          <View style={{ flex: 1, gap: 4, minWidth: 0 }}>
            <Text
              style={{
                color: colors.primary,
                fontSize: 16,
                fontWeight: "700",
                fontFamily: labelFont,
              }}
            >
              {title}
            </Text>
            <Text
              style={{
                color: colors.secondary,
                fontSize: 13,
                lineHeight: 18,
                fontFamily: labelFont,
              }}
              numberOfLines={expanded ? 4 : 2}
            >
              {shortHint}
            </Text>
          </View>
          <MethodExpandChevron expanded={expanded} color={colors.secondary} />
        </Pressable>
        {expanded ? (
          <View
            style={{
              gap: 12,
              paddingHorizontal: 16,
              paddingBottom: 16,
              paddingTop: 4,
              borderTopWidth: 1,
              borderTopColor: colors.highlight,
            }}
          >
            {body}
          </View>
        ) : null}
      </View>
    );
  };

  return (
    <FloatingDialogShell
      visible={visible}
      zIndex={12060}
      defaultSize={defaultSize}
      minSize={{ width: 340, height: 420 }}
      sizeStorageKey="hsp.proPayment.size.v2"
      onRequestClose={onClose}
      testId="pro-payment"
    >
      <FloatingDialogScrollChromeProvider
        headerExtendPx={headerExtendPx}
        footerExtendPx={footerExtendPx}
      >
        <FloatingDialogBody>
          <FloatingDialogStickyHeader
            insets={dialogInsets}
            onClose={onClose}
            closeLabel={t("common.close")}
            title={method != null ? t("pro.pay.titlePay") : t("pro.pay.title")}
            subtitle={tf("pro.pay.subtitle", { plan: planLabel, price: priceLabel })}
            onHeightChange={setHeaderExtendPx}
            leading={
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("pro.pay.backToTariffs")}
                onPress={onBackToTariffs}
                hitSlop={8}
                style={{
                  width: 32,
                  height: 32,
                  alignItems: "center",
                  justifyContent: "center",
                  marginRight: 4,
                }}
              >
                <MusicBackChevronIcon color={colors.primary} size={16} />
              </Pressable>
            }
          />

          <HspScrollColumn
            style={{ flex: 1, minHeight: 0 }}
            containOverscroll
            scrollbarRightInsetPx={2}
            scrollIndicatorOverlaySeam={false}
            contentContainerStyle={{
              paddingTop: 14,
              paddingBottom: 18,
              gap: 12,
              paddingHorizontal: dialogInsets.padX,
            }}
            indicatorColor={colors.scrollIndicator}
          >
            {methodTile(
              "builtin",
              t("pro.pay.method.builtin"),
              tf("pro.pay.method.builtinShort", {
                balance: formatUsd(dllrBalance),
                price: priceLabel,
              }),
              hasEnoughDllr ? (
                <View style={{ gap: 8 }}>
                  <Text
                    style={{
                      color: colors.secondary,
                      fontSize: 13,
                      lineHeight: 18,
                      fontFamily: labelFont,
                    }}
                  >
                    {tf("pro.pay.method.builtinHint", {
                      balance: formatUsd(dllrBalance),
                      hot: formatUsd(dllrHot),
                      frozen: formatUsd(dllrFrozen),
                      price: priceLabel,
                    })}
                  </Text>
                  <Text
                    style={{
                      color: colors.secondary,
                      fontSize: 13,
                      lineHeight: 18,
                      fontFamily: labelFont,
                    }}
                  >
                    {t("pro.pay.builtin.ready")}
                  </Text>
                  <Text
                    style={{
                      color: colors.secondary,
                      fontSize: 12,
                      lineHeight: 16,
                      fontFamily: labelFont,
                    }}
                  >
                    {t("pro.pay.topup.optionalMore")}
                  </Text>
                  {topUpPanel}
                </View>
              ) : (
                <View style={{ gap: 8 }}>
                  <Text
                    style={{
                      color: colors.secondary,
                      fontSize: 13,
                      lineHeight: 18,
                      fontFamily: labelFont,
                    }}
                  >
                    {tf("pro.pay.method.builtinHint", {
                      balance: formatUsd(dllrBalance),
                      hot: formatUsd(dllrHot),
                      frozen: formatUsd(dllrFrozen),
                      price: priceLabel,
                    })}
                  </Text>
                  {topUpPanel}
                </View>
              ),
            )}

            {methodTile(
              "direct",
              t("pro.pay.method.direct"),
              tf("pro.pay.method.directShort", { price: priceLabel }),
              <View style={{ gap: 8 }}>
                <Text
                  style={{
                    color: colors.secondary,
                    fontSize: 13,
                    lineHeight: 18,
                    fontFamily: labelFont,
                  }}
                >
                  {tf("pro.pay.method.directHint", { price: priceLabel })}
                </Text>
                {addressMemoBlock(directMemo, "directMemo")}
              </View>,
            )}

            {methodTile(
              "tonconnect",
              t("pro.pay.method.tonconnect"),
              t("pro.pay.method.tonconnectShort"),
              <View style={{ gap: 10 }}>
                <Text
                  style={{
                    color: colors.secondary,
                    fontSize: 13,
                    lineHeight: 18,
                    fontFamily: labelFont,
                  }}
                >
                  {t("pro.pay.method.tonconnectHint")}
                </Text>
                <CopyableValueRow
                  label={t("pro.pay.direct.amountLabel")}
                  value={formatUsdtAmount(plan.priceUsd)}
                  copied={copiedField === "amount"}
                  onCopy={() => void copyText(formatUsdtAmount(plan.priceUsd), "amount")}
                  copyLabel={t("pro.pay.direct.amountCopy")}
                  copiedLabel={t("pro.pay.direct.copied")}
                  colors={colors}
                  labelFont={labelFont}
                  mono
                  chainBadge="USDT"
                />
                <Text style={{ color: colors.secondary, fontSize: 11, fontFamily: labelFont }}>
                  {t("pro.pay.topup.usdtHint")}
                </Text>
                {wallets.length === 0 ? (
                  <Text
                    style={{
                      color: colors.secondary,
                      fontSize: 13,
                      lineHeight: 18,
                      fontFamily: labelFont,
                    }}
                  >
                    {t("pro.pay.tonconnect.empty")}
                  </Text>
                ) : (
                  wallets.map((wallet) => {
                    const key = (wallet.friendlyAddress || wallet.address).trim();
                    const keyNorm = key.toLowerCase();
                    const selected = effectiveWalletKey === keyNorm;
                    const label =
                      wallet.name?.trim() ||
                      middleEllipsis(wallet.friendlyAddress || wallet.address);
                    return (
                      <Pressable
                        key={keyNorm}
                        accessibilityRole="button"
                        onPress={() => void selectRememberedWallet(keyNorm)}
                        style={{
                          ...subRowStyle,
                          flexDirection: "row",
                          alignItems: "center",
                          gap: 10,
                          borderColor: selected ? colors.primary : colors.highlight,
                        }}
                      >
                        {wallet.imageUrl ? (
                          <Image
                            source={{ uri: wallet.imageUrl }}
                            style={{ width: 22, height: 22, borderRadius: 6 }}
                          />
                        ) : (
                          <View
                            style={{
                              width: 22,
                              height: 22,
                              borderRadius: 6,
                              backgroundColor: colors.highlight,
                            }}
                          />
                        )}
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <Text
                            numberOfLines={1}
                            style={{
                              color: colors.primary,
                              fontSize: 13,
                              fontWeight: "600",
                              fontFamily: labelFont,
                            }}
                          >
                            {label}
                          </Text>
                          <Text
                            numberOfLines={1}
                            style={{
                              color: colors.secondary,
                              fontSize: 11,
                              fontFamily:
                                Platform.OS === "web" ? WEB_UI_MONO_STACK : FONT_UI_SANS_REGULAR,
                            }}
                          >
                            {middleEllipsis(wallet.friendlyAddress || wallet.address)}
                          </Text>
                        </View>
                        <MethodRadio selected={selected} color={colors.primary} />
                      </Pressable>
                    );
                  })
                )}
                <Pressable
                  accessibilityRole="button"
                  disabled={connectBusy}
                  onPress={() => void openWalletPicker()}
                  style={({ pressed }) => ({
                    ...subRowStyle,
                    opacity: connectBusy ? 0.55 : pressed ? 0.85 : 1,
                    alignItems: "center",
                  })}
                >
                  <Text
                    style={{
                      color: colors.primary,
                      fontSize: 14,
                      fontWeight: "700",
                      fontFamily: labelFont,
                    }}
                  >
                    {ton.connected
                      ? t("get.connectAnotherWallet")
                      : t("pro.pay.topup.connectToBuy")}
                  </Text>
                </Pressable>
              </View>,
            )}

            {statusMsg ? (
              <Text
                style={{
                  color: colors.primary,
                  fontSize: 13,
                  lineHeight: 18,
                  fontFamily: labelFont,
                  textAlign: "center",
                }}
              >
                {statusMsg}
              </Text>
            ) : null}
          </HspScrollColumn>

          <View
            onLayout={onFooterLayout}
            style={{
              flexShrink: 0,
              backgroundColor: colors.background,
              zIndex: 4,
            }}
          >
            <SmartGradientDivider bleedPastContentInset={false} horizontalPaddingPx={0} />
            <View
              style={{
                paddingHorizontal: dialogInsets.padX,
                paddingTop: 14,
                paddingBottom: dialogInsets.headerPadBottom + 6,
                gap: 10,
                alignItems: "center",
              }}
            >
              <ProSubscribeButton
                label={finalCta.label}
                disabled={finalCta.disabled}
                onPress={() => void onFinalCta()}
              />
              <Text
                style={{
                  color: colors.secondary,
                  fontSize: 12,
                  lineHeight: 17,
                  textAlign: "center",
                  alignSelf: "stretch",
                  fontFamily: labelFont,
                }}
              >
                {t("pro.pay.footer")}
              </Text>
              <View
                style={{
                  flexDirection: "row",
                  flexWrap: "wrap",
                  alignItems: "center",
                  justifyContent: "center",
                  alignSelf: "stretch",
                  gap: 4,
                }}
              >
                <Text
                  style={{
                    color: colors.secondary,
                    fontSize: 12,
                    lineHeight: 16,
                    fontFamily: labelFont,
                  }}
                >
                  {t("pro.pay.support.before")}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t("pro.pay.support.link")}
                  hitSlop={4}
                  onPress={() => {
                    onClose();
                    requestOpenSupportChat();
                  }}
                  style={({ pressed }) => ({
                    height: 16,
                    paddingHorizontal: 6,
                    borderRadius: 8,
                    alignItems: "center",
                    justifyContent: "center",
                    backgroundColor: pressed
                      ? colors.highlight
                      : colors.undercover,
                    flexShrink: 0,
                  })}
                >
                  <Text
                    style={{
                      color: colors.primary,
                      fontSize: 10,
                      lineHeight: 12,
                      fontWeight: "400",
                      fontFamily: labelFont,
                      ...(Platform.OS === "android"
                        ? { includeFontPadding: false }
                        : null),
                    }}
                    numberOfLines={1}
                  >
                    {t("pro.pay.support.link")}
                  </Text>
                </Pressable>
                <Text
                  style={{
                    color: colors.secondary,
                    fontSize: 12,
                    lineHeight: 16,
                    fontFamily: labelFont,
                  }}
                >
                  {t("pro.pay.support.after")}
                </Text>
              </View>
            </View>
          </View>
        </FloatingDialogBody>
      </FloatingDialogScrollChromeProvider>
    </FloatingDialogShell>
  );
}
