import * as Clipboard from "expo-clipboard";
import { Image } from "expo-image";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  Platform,
  Pressable,
  Text,
  TextInput,
  useWindowDimensions,
  View,
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
import { fetchTonapiAccountHoldings } from "../ton/fetchTonapiAccountHoldings";
import {
  creditBuiltinDllrUsd,
  debitBuiltinDllrUsd,
  getBuiltinDllrBalanceUsd,
  subscribeBuiltinDllrBalance,
} from "./dllrBalanceStore";
import {
  activateProAccess,
  formatUsd,
  PRO_ACCESS_PLANS,
  type ProAccessPlanId,
} from "./proAccessStore";
import { resolveProPaymentTonAddress } from "./proPaymentConfig";
import {
  createProPaymentMemo,
  minDllrTopUpForPlanUsd,
  parseDllrUsdFromProPaymentMemo,
  PRO_PAYMENT_TON_RATE_BUFFER,
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

const FALLBACK_TON_USD = 5;
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

function formatTonAmount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 100) return n.toFixed(2);
  if (n >= 1) return n.toFixed(3).replace(/\.?0+$/, "");
  return n.toFixed(4).replace(/\.?0+$/, "");
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
}: {
  label: string;
  value: string;
  copied: boolean;
  onCopy: () => void;
  copyLabel: string;
  copiedLabel: string;
  colors: { primary: string; secondary: string; highlight: string; background: string };
  labelFont: string;
  mono?: boolean;
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
      <Text style={{ color: colors.secondary, fontSize: 12, fontFamily: labelFont }}>{label}</Text>
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
        >
          {value}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={copied ? copiedLabel : copyLabel}
          onPress={onCopy}
          hitSlop={8}
          style={{ width: 28, height: 28, alignItems: "center", justifyContent: "center" }}
        >
          <HeaderIconCopy
            color={copied ? colors.primary : colors.secondary}
            size={COPY_ICON_PX}
          />
        </Pressable>
      </View>
    </View>
  );
}

/**
 * Payment ways for Pro Access — built-in DLLR (with inline top-up), direct TON + memo/check,
 * or TonConnect. Does not grant entitlement until DLLR pay or confirmed transfer.
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
  const [method, setMethod] = useState<PaymentMethodId>("builtin");
  const [headerExtendPx, setHeaderExtendPx] = useState(0);
  const [copiedField, setCopiedField] = useState<"address" | "memo" | "directMemo" | null>(null);
  const [connectBusy, setConnectBusy] = useState(false);
  const [selectedWalletKey, setSelectedWalletKey] = useState<string | null>(null);
  const [tonUsd, setTonUsd] = useState(FALLBACK_TON_USD);
  const [dllrBuyInput, setDllrBuyInput] = useState("");
  const [tonPayInput, setTonPayInput] = useState("");
  const [editingField, setEditingField] = useState<"dllr" | "ton" | null>(null);
  const [memo, setMemo] = useState("");
  const [directMemo, setDirectMemo] = useState("");
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [checkBusy, setCheckBusy] = useState(false);

  const defaultSize = useMemo(
    () => resolveFloatingDialogDefaultSize(windowWidth, windowHeight, "pro"),
    [windowHeight, windowWidth],
  );
  const dialogInsets = resolveFloatingDialogInsets(windowHeight);
  const plan = PRO_ACCESS_PLANS.find((p) => p.id === planId) ?? PRO_ACCESS_PLANS[0]!;
  const planLabel = t(
    plan.id === "month"
      ? "pro.plan.month"
      : plan.id === "quarter"
        ? "pro.plan.quarter"
        : "pro.plan.year",
  );
  const priceLabel = formatUsd(plan.priceUsd);
  const hasEnoughDllr = dllrBalance + 1e-9 >= plan.priceUsd;
  /** e.g. $20 plan + $1 residual − balance → buy enough that 1 DLLR remains after subscribe. */
  const minTopUpUsd = hasEnoughDllr
    ? 0.01
    : minDllrTopUpForPlanUsd(plan.priceUsd, dllrBalance);
  const paymentAddress = resolveProPaymentTonAddress();
  const labelFont = Platform.OS === "web" ? WEB_UI_SANS_STACK : FONT_UI_SANS_REGULAR;

  const flashCopied = useCallback((field: "address" | "memo" | "directMemo") => {
    setCopiedField(field);
    setTimeout(() => setCopiedField((cur) => (cur === field ? null : cur)), 1200);
  }, []);

  const copyText = useCallback(
    async (value: string, field: "address" | "memo" | "directMemo") => {
      await Clipboard.setStringAsync(value);
      flashCopied(field);
    },
    [flashCopied],
  );

  useEffect(() => {
    if (!visible) return;
    const seed = hasEnoughDllr
      ? Math.max(1, minTopUpUsd)
      : minTopUpUsd;
    setDllrBuyInput(String(seed));
    setEditingField(null);
    setStatusMsg(null);
    setMemo(createProPaymentMemo(plan.id, seed));
    setDirectMemo(
      createProPaymentMemo(
        plan.id,
        minDllrTopUpForPlanUsd(plan.priceUsd, dllrBalance),
      ),
    );
  }, [visible, planId, hasEnoughDllr, minTopUpUsd, plan.id, plan.priceUsd, dllrBalance]);

  // Keep memo DLLR cents in sync with the buy amount (new nonce when amount changes).
  useEffect(() => {
    if (!visible || editingField === "ton") return;
    const dllr = parseAmount(dllrBuyInput);
    if (!Number.isFinite(dllr) || dllr <= 0) return;
    const locked = parseDllrUsdFromProPaymentMemo(memo);
    if (locked != null && Math.abs(locked - dllr) < 0.005) return;
    setMemo(createProPaymentMemo(plan.id, dllr));
  }, [dllrBuyInput, editingField, memo, plan.id, visible]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    void (async () => {
      try {
        const holdings = await fetchTonapiAccountHoldings(
          ton.friendlyAddress || ton.address || "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c",
        );
        const px = holdings.tonPriceUsd;
        if (!cancelled && px != null && px > 0) setTonUsd(px);
      } catch {
        /* keep fallback */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ton.address, ton.friendlyAddress, visible]);

  useEffect(() => {
    if (editingField === "ton") return;
    const dllr = parseAmount(dllrBuyInput);
    if (!Number.isFinite(dllr) || dllr <= 0 || tonUsd <= 0) {
      if (editingField !== "dllr") setTonPayInput("");
      return;
    }
    // Buffer TON so a brief rate dip cannot under-credit the locked DLLR.
    setTonPayInput(formatTonAmount((dllr / tonUsd) * PRO_PAYMENT_TON_RATE_BUFFER));
  }, [dllrBuyInput, tonUsd, editingField]);

  useEffect(() => {
    if (editingField !== "ton") return;
    const tonAmt = parseAmount(tonPayInput);
    if (!Number.isFinite(tonAmt) || tonAmt <= 0 || tonUsd <= 0) return;
    // Invert buffer: DLLR locked = TON sent / buffer * rate.
    const dllr =
      Math.round(((tonAmt / PRO_PAYMENT_TON_RATE_BUFFER) * tonUsd) * 100) / 100;
    setDllrBuyInput(String(dllr));
  }, [tonPayInput, tonUsd, editingField]);

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
    setStatusMsg(t("pro.pay.builtin.paid"));
    setTimeout(() => onClose(), 600);
  }, [onClose, plan.id, plan.priceUsd, t]);

  const resolvedBuyDllr = parseAmount(dllrBuyInput);
  const buyDllrValid =
    Number.isFinite(resolvedBuyDllr) && resolvedBuyDllr + 1e-9 >= minTopUpUsd;

  const runCheckPayment = useCallback(
    async (opts: { memoText: string; activateAfter?: boolean; fallbackDollars?: number }) => {
      const memoText = opts.memoText.trim();
      if (!memoText) {
        setStatusMsg(t("pro.pay.check.memoRequired"));
        return;
      }
      // Credit the DLLR locked in the memo — rate moves cannot shrink the top-up.
      const fromMemo = parseDllrUsdFromProPaymentMemo(memoText);
      const dollars = fromMemo ?? opts.fallbackDollars ?? NaN;
      if (!Number.isFinite(dollars) || dollars <= 0) {
        setStatusMsg(t("pro.pay.check.invalidAmount"));
        return;
      }
      setCheckBusy(true);
      setStatusMsg(null);
      try {
        await new Promise((r) => setTimeout(r, 400));
        creditBuiltinDllrUsd(dollars);
        const shouldActivate =
          opts.activateAfter ||
          (!hasEnoughDllr && getBuiltinDllrBalanceUsd() + 1e-9 >= plan.priceUsd);
        if (shouldActivate && getBuiltinDllrBalanceUsd() + 1e-9 >= plan.priceUsd) {
          if (debitBuiltinDllrUsd(plan.priceUsd)) {
            activateProAccess(plan.id);
            setStatusMsg(
              tf("pro.pay.check.creditedAndActivatedLeft", {
                amount: formatUsd(dollars),
                left: formatUsd(PRO_TOPUP_RESIDUAL_DLLR_USD),
              }),
            );
            setTimeout(() => onClose(), 700);
            return;
          }
        }
        setStatusMsg(tf("pro.pay.check.credited", { amount: formatUsd(dollars) }));
      } finally {
        setCheckBusy(false);
      }
    },
    [hasEnoughDllr, onClose, plan.id, plan.priceUsd, t, tf],
  );

  const onBuyDllrViaTonConnect = useCallback(async () => {
    if (!buyDllrValid) {
      setStatusMsg(t("pro.pay.topup.buyInvalid"));
      return;
    }
    const tonAmt = parseAmount(tonPayInput);
    if (!Number.isFinite(tonAmt) || tonAmt <= 0) {
      setStatusMsg(t("pro.pay.topup.buyInvalid"));
      return;
    }
    if (!ton.connected) {
      await openWalletPicker();
      return;
    }
    setConnectBusy(true);
    setStatusMsg(null);
    try {
      const nano = BigInt(Math.round(tonAmt * 1e9));
      await ton.sendTransaction({
        validUntil: Math.floor(Date.now() / 1000) + 600,
        network: "-239",
        messages: [{ address: paymentAddress, amount: nano.toString() }],
      });
      // Credit locked memo amount (not live rate).
      await runCheckPayment({
        memoText: memo,
        activateAfter: !hasEnoughDllr,
        fallbackDollars: resolvedBuyDllr,
      });
    } catch {
      setStatusMsg(t("pro.pay.topup.buyCancelled"));
    } finally {
      setConnectBusy(false);
    }
  }, [
    buyDllrValid,
    hasEnoughDllr,
    memo,
    openWalletPicker,
    paymentAddress,
    resolvedBuyDllr,
    runCheckPayment,
    t,
    ton,
    tonPayInput,
  ]);

  const planTonAmount = useMemo(() => {
    if (!(tonUsd > 0)) return formatTonAmount((plan.priceUsd / FALLBACK_TON_USD) * PRO_PAYMENT_TON_RATE_BUFFER);
    return formatTonAmount((plan.priceUsd / tonUsd) * PRO_PAYMENT_TON_RATE_BUFFER);
  }, [plan.priceUsd, tonUsd]);

  const topUpTonAmount = useMemo(() => {
    const fromInput = parseAmount(tonPayInput);
    if (Number.isFinite(fromInput) && fromInput > 0) return formatTonAmount(fromInput);
    return planTonAmount;
  }, [planTonAmount, tonPayInput]);

  const finalCta = useMemo(() => {
    if (method === "builtin" && hasEnoughDllr) {
      return {
        kind: "pay_dllr" as const,
        label: tf("pro.pay.final.payDllr", { amount: String(plan.priceUsd) }),
      };
    }
    if (method === "tonconnect") {
      return {
        kind: "pay_ton" as const,
        label: checkBusy || connectBusy
          ? t("pro.pay.check.busy")
          : tf("pro.pay.final.payTon", { amount: planTonAmount }),
      };
    }
    // direct, or builtin top-up / check path
    return {
      kind: "check" as const,
      label: checkBusy ? t("pro.pay.check.busy") : t("pro.pay.check.button"),
    };
  }, [
    checkBusy,
    connectBusy,
    hasEnoughDllr,
    method,
    plan.priceUsd,
    planTonAmount,
    t,
    tf,
  ]);

  const onFinalCta = useCallback(async () => {
    if (finalCta.kind === "pay_dllr") {
      onPayWithDllr();
      return;
    }
    if (finalCta.kind === "pay_ton") {
      // Prefer top-up amount when buying DLLR into built-in; else plan TON.
      const tonAmt = parseAmount(topUpTonAmount);
      if (!Number.isFinite(tonAmt) || tonAmt <= 0) {
        setStatusMsg(t("pro.pay.topup.buyInvalid"));
        return;
      }
      if (!ton.connected && !effectiveWalletKey) {
        await openWalletPicker();
        return;
      }
      if (!ton.connected) {
        await openWalletPicker();
        return;
      }
      setConnectBusy(true);
      setStatusMsg(null);
      try {
        const nano = BigInt(Math.round(tonAmt * 1e9));
        await ton.sendTransaction({
          validUntil: Math.floor(Date.now() / 1000) + 600,
          network: "-239",
          messages: [{ address: paymentAddress, amount: nano.toString() }],
        });
        await runCheckPayment({
          memoText: method === "tonconnect" ? directMemo : memo,
          activateAfter: true,
          fallbackDollars: plan.priceUsd,
        });
      } catch {
        setStatusMsg(t("pro.pay.topup.buyCancelled"));
      } finally {
        setConnectBusy(false);
      }
      return;
    }
    // Check payment
    if (method === "direct" || method === "tonconnect") {
      await runCheckPayment({
        memoText: directMemo,
        activateAfter: true,
        fallbackDollars: minDllrTopUpForPlanUsd(plan.priceUsd, dllrBalance),
      });
      return;
    }
    await runCheckPayment({
      memoText: memo,
      activateAfter: !hasEnoughDllr,
      fallbackDollars: resolvedBuyDllr,
    });
  }, [
    directMemo,
    dllrBalance,
    effectiveWalletKey,
    finalCta.kind,
    hasEnoughDllr,
    memo,
    method,
    onPayWithDllr,
    openWalletPicker,
    paymentAddress,
    plan.priceUsd,
    resolvedBuyDllr,
    runCheckPayment,
    t,
    ton,
    topUpTonAmount,
  ]);

  const rowStyle = {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.highlight,
    backgroundColor: colors.undercover,
    padding: 14,
    gap: 10,
  } as const;

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

  const addressMemoBlock = (memoValue: string, memoField: "memo" | "directMemo") => (
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
      />
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
    <View style={{ gap: 10, marginLeft: 32 }}>
      <Text style={{ color: colors.secondary, fontSize: 13, lineHeight: 18, fontFamily: labelFont }}>
        {hasEnoughDllr
          ? t("pro.pay.topup.anyAmountHint")
          : tf("pro.pay.topup.minHintResidual", {
              min: formatUsd(minTopUpUsd),
              plan: priceLabel,
              left: formatUsd(PRO_TOPUP_RESIDUAL_DLLR_USD),
            })}
      </Text>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <View style={{ flex: 1, gap: 4 }}>
          <Text style={{ color: colors.secondary, fontSize: 12, fontFamily: labelFont }}>
            {t("pro.pay.topup.dllrLabel")}
          </Text>
          <TextInput
            value={dllrBuyInput}
            onChangeText={(v) => {
              setEditingField("dllr");
              setDllrBuyInput(v);
            }}
            onFocus={() => setEditingField("dllr")}
            keyboardType="decimal-pad"
            placeholder={String(minTopUpUsd)}
            placeholderTextColor={colors.secondary}
            style={inputStyle}
          />
        </View>
        <View style={{ flex: 1, gap: 4 }}>
          <Text style={{ color: colors.secondary, fontSize: 12, fontFamily: labelFont }}>
            {t("pro.pay.topup.tonLabel")}
          </Text>
          <TextInput
            value={tonPayInput}
            onChangeText={(v) => {
              setEditingField("ton");
              setTonPayInput(v);
            }}
            onFocus={() => setEditingField("ton")}
            keyboardType="decimal-pad"
            placeholder="0"
            placeholderTextColor={colors.secondary}
            style={inputStyle}
          />
        </View>
      </View>
      <Text style={{ color: colors.secondary, fontSize: 11, fontFamily: labelFont }}>
        {tf("pro.pay.topup.rateHintBuffered", {
          rate: formatUsd(tonUsd),
          buffer: `${Math.round((PRO_PAYMENT_TON_RATE_BUFFER - 1) * 100)}%`,
        })}
      </Text>

      {addressMemoBlock(memo, "memo")}

    </View>
  );

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
      <FloatingDialogScrollChromeProvider headerExtendPx={headerExtendPx}>
        <FloatingDialogBody>
          <FloatingDialogStickyHeader
            insets={dialogInsets}
            onClose={onClose}
            closeLabel={t("common.close")}
            title={t("pro.pay.title")}
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
            // Keep thumb inside the shell so FloatingDialogBody overflow:hidden does not clip it.
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
            <View style={rowStyle}>
              <Pressable
                accessibilityRole="button"
                onPress={() => setMethod("builtin")}
                style={{ flexDirection: "row", alignItems: "flex-start", gap: 12 }}
              >
                <MethodRadio selected={method === "builtin"} color={colors.primary} />
                <View style={{ flex: 1, gap: 4, minWidth: 0 }}>
                  <Text
                    style={{
                      color: colors.primary,
                      fontSize: 15,
                      fontWeight: "700",
                      fontFamily: labelFont,
                    }}
                  >
                    {t("pro.pay.method.builtin")}
                  </Text>
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
                      price: priceLabel,
                    })}
                  </Text>
                </View>
              </Pressable>

              {method === "builtin" ? (
                hasEnoughDllr ? (
                  <View style={{ gap: 8, marginLeft: 32 }}>
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
                  topUpPanel
                )
              ) : null}
            </View>

            <View style={rowStyle}>
              <Pressable
                accessibilityRole="button"
                onPress={() => setMethod("direct")}
                style={{ flexDirection: "row", alignItems: "flex-start", gap: 12 }}
              >
                <MethodRadio selected={method === "direct"} color={colors.primary} />
                <View style={{ flex: 1, gap: 4, minWidth: 0 }}>
                  <Text
                    style={{
                      color: colors.primary,
                      fontSize: 15,
                      fontWeight: "700",
                      fontFamily: labelFont,
                    }}
                  >
                    {t("pro.pay.method.direct")}
                  </Text>
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
                </View>
              </Pressable>

              {method === "direct" ? (
                <View style={{ gap: 8, marginLeft: 32 }}>
                  {addressMemoBlock(directMemo, "directMemo")}
                </View>
              ) : null}
            </View>

            <View style={rowStyle}>
              <Pressable
                accessibilityRole="button"
                onPress={() => setMethod("tonconnect")}
                style={{ flexDirection: "row", alignItems: "flex-start", gap: 12 }}
              >
                <MethodRadio selected={method === "tonconnect"} color={colors.primary} />
                <View style={{ flex: 1, gap: 4, minWidth: 0 }}>
                  <Text
                    style={{
                      color: colors.primary,
                      fontSize: 15,
                      fontWeight: "700",
                      fontFamily: labelFont,
                    }}
                  >
                    {t("pro.pay.method.tonconnect")}
                  </Text>
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
                </View>
              </Pressable>

              {method === "tonconnect" ? (
                <View style={{ gap: 8, marginLeft: 32 }}>
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
                  {addressMemoBlock(directMemo, "directMemo")}
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
                      {t("get.connectAnotherWallet")}
                    </Text>
                  </Pressable>
                </View>
              ) : null}
            </View>

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
                {t("pro.pay.support.before")}
                <Text
                  onPress={() => {
                    onClose();
                    requestOpenSupportChat();
                  }}
                  style={{
                    color: colors.primary,
                    textDecorationLine: "underline",
                    fontFamily: labelFont,
                  }}
                >
                  {t("pro.pay.support.link")}
                </Text>
                {t("pro.pay.support.after")}
              </Text>
            </View>
          </View>
        </FloatingDialogBody>
      </FloatingDialogScrollChromeProvider>
    </FloatingDialogShell>
  );
}
