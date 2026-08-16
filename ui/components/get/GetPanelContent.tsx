import * as Clipboard from "expo-clipboard";
import { Image } from "expo-image";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FlatList,
  Modal,
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
  type LayoutChangeEvent,
} from "react-native";
import { useAppStrings } from "../../../locales/AppStringsContext";
import { WEB_UI_MONO_STACK } from "../../fonts";
import { fetchAccountSwapJettons } from "../../swap/fetchSwapJettons";
import {
  SWAP_GRAM_TOKEN,
  type SwapPairToken,
  swapTokenDisplaySymbol,
} from "../../swap/swapPairTypes";
import { getTonBalance } from "../../ton/getTonBalance";
import { useTonConnectSession } from "../../ton/TonConnectProvider";
import { trimWalletAddress } from "../../wallet/walletAddressFormat";
import {
  layout,
  typographyAeroport15,
  typographyAeroport20,
  typographyFixedRow30Label,
  useColors,
} from "../../theme";
import { appModalSheetStyles } from "../AppModalSheet";
import { VoiceWindowCrossIcon } from "../messages/MessageChatVoiceControlIcons";
import { SwapSelectChevron } from "../swap/SwapFormIcons";
import { swapTonTokenImage } from "../swap/swapFormAssets";
import { GetConnectedWalletChip } from "./GetConnectedWalletChip";

const TOP_INSET_PX = 15;
const SECTION_GAP_PX = 30;
const BLOCK_GAP_PX = 15;
const TITLE_SIZE_PX = 40;
const METHODS_SIZE_PX = 30;
const LABEL_SIZE_PX = 20;
const MULTI_LINE_HEIGHT_PX = 30;
const CHIP_HEIGHT_PX = 30;
const CHIP_PAD_H_PX = 30;
const CURRENCY_ICON_PX = 20;
const COPIED_HIDE_MS = 1000;
const ROW_GAP_PX = layout.bottomBar.textToSendIconGapPx;
/** Below this column width, amount+currency share a row; balance + Top Up stack full-width. */
const TRIPLE_CONTROLS_MIN_WIDTH_PX = 420;

type Props = {
  walletAddress: string;
  displayName: string;
  /** Narrow layout only; wide split chrome already shows wallet in the header. */
  showTitleRow: boolean;
};

type GetCurrencyOption = {
  token: SwapPairToken;
  balanceLabel: string;
  balanceText: string;
};

function groupWholeDigits(whole: string): string {
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function formatNativeBalance(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  const fixed = value.toFixed(7).replace(/\.?0+$/, "");
  const [whole, frac] = fixed.split(".");
  const wholeGrouped = groupWholeDigits(whole);
  return frac ? `${wholeGrouped}.${frac}` : wholeGrouped;
}

function formatRawTokenBalance(balanceRaw: string, decimals: number): string {
  try {
    const raw = BigInt(balanceRaw);
    if (raw === 0n) return "0";
    const scale = 10n ** BigInt(Math.max(0, decimals));
    const whole = raw / scale;
    const frac = raw % scale;
    const wholeGrouped = groupWholeDigits(whole.toString());
    if (frac === 0n) return wholeGrouped;
    const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
    return fracStr ? `${wholeGrouped}.${fracStr}` : wholeGrouped;
  } catch {
    return "—";
  }
}

function tokenIconSource(token: SwapPairToken) {
  if (token.icon) return token.icon as never;
  if (token.imageUrl) return { uri: token.imageUrl };
  return swapTonTokenImage;
}

/** Get panel — CONNECT (TonConnect) + TRANSFER (copy app deposit address). */
export function GetPanelContent({ walletAddress, displayName, showTitleRow }: Props) {
  const colors = useColors();
  const { t, tf } = useAppStrings();
  const ton = useTonConnectSession();

  const [showCopied, setShowCopied] = useState(false);
  const hideCopiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [amount, setAmount] = useState("1");
  const [selected, setSelected] = useState<GetCurrencyOption>(() => ({
    token: SWAP_GRAM_TOKEN,
    balanceLabel: "0",
    balanceText: "0",
  }));
  const [pickerOpen, setPickerOpen] = useState(false);
  const [options, setOptions] = useState<GetCurrencyOption[]>([]);
  const [balancesLoading, setBalancesLoading] = useState(false);
  const [formWidthPx, setFormWidthPx] = useState(0);

  const trimmedDeposit = useMemo(() => trimWalletAddress(walletAddress), [walletAddress]);
  const depositDisplay = trimmedDeposit || "—";
  const tripleControlsFit =
    formWidthPx <= 0 || formWidthPx >= TRIPLE_CONTROLS_MIN_WIDTH_PX;

  const walletSubtitle = useMemo(() => {
    const name = displayName.trim() || t("common.emDash");
    return tf("get.walletOnTon", { name });
  }, [displayName, t, tf]);

  useEffect(() => {
    return () => {
      if (hideCopiedTimerRef.current) clearTimeout(hideCopiedTimerRef.current);
    };
  }, []);

  const refreshBalances = useCallback(async (connectedAddress: string) => {
    setBalancesLoading(true);
    try {
      const native = await getTonBalance(connectedAddress);
      const nativeText = formatNativeBalance(native);
      const nativeOption: GetCurrencyOption = {
        token: SWAP_GRAM_TOKEN,
        balanceLabel: nativeText,
        balanceText: nativeText,
      };

      let jettonOptions: GetCurrencyOption[] = [];
      try {
        const account = await fetchAccountSwapJettons(connectedAddress);
        jettonOptions = (account.items ?? [])
          .map((item) => {
            const jetton = item.jetton;
            if (!jetton?.address) return null;
            const symbol = (jetton.symbol ?? "").trim() || "TOKEN";
            const decimals = typeof jetton.decimals === "number" ? jetton.decimals : 9;
            const balanceText = formatRawTokenBalance(item.balance, decimals);
            const token: SwapPairToken = {
              address: jetton.address,
              symbol,
              name: (jetton.name ?? symbol).trim() || symbol,
              decimals,
              imageUrl: jetton.image_url ?? null,
              isNative: false,
            };
            return { token, balanceLabel: balanceText, balanceText } satisfies GetCurrencyOption;
          })
          .filter((row): row is GetCurrencyOption => row != null);
      } catch {
        jettonOptions = [];
      }

      const next = [nativeOption, ...jettonOptions];
      setOptions(next);
      setSelected((prev) => {
        const match = next.find(
          (row) => row.token.address.toLowerCase() === prev.token.address.toLowerCase(),
        );
        return match ?? nativeOption;
      });
    } finally {
      setBalancesLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!ton.connected || !ton.address) {
      setOptions([]);
      setSelected({
        token: SWAP_GRAM_TOKEN,
        balanceLabel: "0",
        balanceText: "0",
      });
      return;
    }
    void refreshBalances(ton.address);
    const id = setInterval(() => void refreshBalances(ton.address!), 30_000);
    return () => clearInterval(id);
  }, [refreshBalances, ton.address, ton.connected]);

  const onCopyAddress = useCallback(async () => {
    if (!trimmedDeposit) return;
    await Clipboard.setStringAsync(trimmedDeposit);
    setShowCopied(true);
    if (hideCopiedTimerRef.current) clearTimeout(hideCopiedTimerRef.current);
    hideCopiedTimerRef.current = setTimeout(() => {
      setShowCopied(false);
      hideCopiedTimerRef.current = null;
    }, COPIED_HIDE_MS);
  }, [trimmedDeposit]);

  const onConnectPress = useCallback(() => {
    void ton.openConnectModal();
  }, [ton]);

  const onFormLayout = useCallback((event: LayoutChangeEvent) => {
    const width = Math.round(event.nativeEvent.layout.width);
    setFormWidthPx((current) => (current === width ? current : width));
  }, []);

  const selectedSymbol = swapTokenDisplaySymbol(selected.token);
  const balanceLine = balancesLoading
    ? t("get.balanceLoading")
    : tf("get.balanceLine", {
        amount: selected.balanceText,
        symbol: selectedSymbol,
      });

  const multiLineBody = [
    typographyAeroport15,
    { lineHeight: MULTI_LINE_HEIGHT_PX, fontWeight: "400" as const },
  ];

  const chipStyle = {
    height: CHIP_HEIGHT_PX,
    paddingHorizontal: CHIP_PAD_H_PX,
    backgroundColor: colors.undercover,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    flexDirection: "row" as const,
    gap: 8,
    borderRadius: 0,
  };

  const amountInputStyle = [
    typographyAeroport20,
    {
      fontWeight: "400" as const,
      lineHeight: 30,
      color: colors.primary,
      flex: 1,
      minWidth: 0,
      padding: 0,
      margin: 0,
      ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : null),
    },
  ];

  const currencyChip = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t("get.chooseCurrencyA11y")}
      onPress={() => setPickerOpen(true)}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        flexShrink: 0,
        height: CHIP_HEIGHT_PX,
      }}
    >
      <Image
        source={tokenIconSource(selected.token)}
        style={{
          width: CURRENCY_ICON_PX,
          height: CURRENCY_ICON_PX,
          borderRadius: CURRENCY_ICON_PX / 2,
        }}
      />
      <Text style={[typographyAeroport20, { color: colors.primary, fontWeight: "400" }]}>
        {selectedSymbol}
      </Text>
      <SwapSelectChevron />
    </Pressable>
  );

  const topUpButton = (fullWidth: boolean) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t("get.topUpButton")}
      onPress={() => undefined}
      style={[
        chipStyle,
        fullWidth ? { alignSelf: "stretch", width: "100%" } : { flexShrink: 0 },
      ]}
    >
      <Text style={[typographyFixedRow30Label, { color: colors.primary, textAlign: "center" }]}>
        {t("get.topUpButton")}
      </Text>
    </Pressable>
  );

  return (
    <View
      style={{
        flex: 1,
        width: "100%",
        alignSelf: "stretch",
        minHeight: 0,
        paddingTop: TOP_INSET_PX,
      }}
    >
      <Text
        style={{
          fontSize: TITLE_SIZE_PX,
          lineHeight: TITLE_SIZE_PX,
          fontWeight: "400",
          color: colors.primary,
        }}
      >
        {t("get.title")}
      </Text>
      {(showTitleRow || Boolean(displayName.trim())) && (
        <Text
          style={[
            ...multiLineBody,
            {
              color: colors.secondary,
              marginTop: 8,
              fontFamily: Platform.OS === "web" ? WEB_UI_MONO_STACK : undefined,
            },
          ]}
        >
          {walletSubtitle}
        </Text>
      )}

      <View style={{ height: SECTION_GAP_PX }} />

      <Text
        style={{
          fontSize: METHODS_SIZE_PX,
          lineHeight: METHODS_SIZE_PX,
          fontWeight: "400",
          color: colors.primary,
        }}
      >
        {t("get.methodsTitle")}
      </Text>
      <Text style={[...multiLineBody, { color: colors.primary, marginTop: 8 }]}>
        {t("get.methodsBody")}
      </Text>

      <View style={{ height: SECTION_GAP_PX }} />

      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <Text
          style={{
            fontSize: LABEL_SIZE_PX,
            lineHeight: LABEL_SIZE_PX,
            fontWeight: "400",
            color: colors.primary,
            letterSpacing: 1,
            textTransform: "uppercase",
          }}
        >
          {t("get.connectLabel")}
        </Text>
        {ton.connected ? (
          <GetConnectedWalletChip />
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("get.tonConnectButton")}
            onPress={onConnectPress}
            style={chipStyle}
          >
            <Text style={[typographyFixedRow30Label, { color: colors.primary }]}>
              {t("get.tonConnectButton")}
            </Text>
          </Pressable>
        )}
      </View>

      {ton.connected ? (
        <View style={{ marginTop: BLOCK_GAP_PX, gap: 10 }} onLayout={onFormLayout}>
          <Text style={[...multiLineBody, { color: colors.primary }]}>
            {t("get.amountLabel")}
          </Text>

          {tripleControlsFit ? (
            <>
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: ROW_GAP_PX,
                  width: "100%",
                }}
              >
                <TextInput
                  value={amount}
                  onChangeText={setAmount}
                  keyboardType="decimal-pad"
                  placeholder="0"
                  placeholderTextColor={colors.secondary}
                  cursorColor={colors.primary}
                  style={amountInputStyle}
                />
                {currencyChip}
                {topUpButton(false)}
              </View>
              <Text style={[...multiLineBody, { color: colors.secondary }]}>{balanceLine}</Text>
            </>
          ) : (
            <>
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: ROW_GAP_PX,
                  width: "100%",
                }}
              >
                <TextInput
                  value={amount}
                  onChangeText={setAmount}
                  keyboardType="decimal-pad"
                  placeholder="0"
                  placeholderTextColor={colors.secondary}
                  cursorColor={colors.primary}
                  style={amountInputStyle}
                />
                {currencyChip}
              </View>
              <Text style={[...multiLineBody, { color: colors.secondary }]}>{balanceLine}</Text>
              {topUpButton(true)}
            </>
          )}
        </View>
      ) : (
        <Text style={[...multiLineBody, { color: colors.secondary, marginTop: 10 }]}>
          {t("get.connectHint")}
        </Text>
      )}

      <View style={{ height: SECTION_GAP_PX }} />

      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <Text
          style={{
            fontSize: LABEL_SIZE_PX,
            lineHeight: LABEL_SIZE_PX,
            fontWeight: "400",
            color: colors.primary,
            letterSpacing: 1,
            textTransform: "uppercase",
          }}
        >
          {t("get.transferLabel")}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("get.copyAddressButton")}
          disabled={!trimmedDeposit}
          onPress={() => void onCopyAddress()}
          style={chipStyle}
        >
          <Text style={[typographyFixedRow30Label, { color: colors.primary }]}>
            {showCopied ? t("get.copied") : t("get.copyAddressButton")}
          </Text>
        </Pressable>
      </View>
      <Text
        style={[
          ...multiLineBody,
          {
            color: colors.primary,
            marginTop: 10,
            fontFamily: Platform.OS === "web" ? WEB_UI_MONO_STACK : undefined,
          },
        ]}
        selectable
      >
        {depositDisplay}
      </Text>

      <Modal
        visible={pickerOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setPickerOpen(false)}
      >
        <View style={[appModalSheetStyles.overlayBlock, { flex: 1 }]}>
          <Pressable
            style={appModalSheetStyles.backdropFill}
            onPress={() => setPickerOpen(false)}
            accessibilityRole="button"
            accessibilityLabel={t("common.close")}
          />
          <View
            style={[
              appModalSheetStyles.sheet,
              {
                backgroundColor: colors.background,
                borderColor: colors.highlight,
                maxHeight: "70%",
                paddingTop: 20,
                paddingBottom: 12,
              },
            ]}
            {...(Platform.OS === "web"
              ? ({
                  onClick: (e: { stopPropagation?: () => void }) => e.stopPropagation?.(),
                } as object)
              : {})}
            onStartShouldSetResponder={() => true}
          >
            <View
              style={{
                paddingHorizontal: 20,
                paddingBottom: 12,
                flexDirection: "row",
                alignItems: "center",
              }}
            >
              <Text
                style={[
                  typographyAeroport20,
                  { color: colors.primary, fontWeight: "400", flex: 1, minWidth: 0, paddingRight: 36 },
                ]}
              >
                {t("get.chooseCurrencyTitle")}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("common.close")}
                onPress={() => setPickerOpen(false)}
                hitSlop={8}
                style={{
                  position: "absolute",
                  top: 0,
                  right: 12,
                  width: 32,
                  height: 32,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <VoiceWindowCrossIcon color={colors.primary} size={15} />
              </Pressable>
            </View>
            <FlatList
              data={options.length > 0 ? options : [selected]}
              keyExtractor={(item) => item.token.address}
              keyboardShouldPersistTaps="handled"
              style={{ flexGrow: 0 }}
              renderItem={({ item }) => {
                const symbol = swapTokenDisplaySymbol(item.token);
                const active =
                  item.token.address.toLowerCase() === selected.token.address.toLowerCase();
                return (
                  <Pressable
                    onPress={() => {
                      setSelected(item);
                      setPickerOpen(false);
                    }}
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 12,
                      paddingHorizontal: 20,
                      paddingVertical: 12,
                      backgroundColor: active ? colors.undercover : "transparent",
                    }}
                  >
                    <Image
                      source={tokenIconSource(item.token)}
                      style={{
                        width: CURRENCY_ICON_PX,
                        height: CURRENCY_ICON_PX,
                        borderRadius: CURRENCY_ICON_PX / 2,
                      }}
                    />
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text
                        style={[typographyAeroport20, { color: colors.primary, fontWeight: "400" }]}
                      >
                        {symbol}
                      </Text>
                      <Text
                        style={[
                          typographyAeroport15,
                          { color: colors.secondary, lineHeight: MULTI_LINE_HEIGHT_PX },
                        ]}
                        numberOfLines={1}
                      >
                        {item.balanceText}
                      </Text>
                    </View>
                  </Pressable>
                );
              }}
            />
          </View>
        </View>
      </Modal>
    </View>
  );
}
