import * as Clipboard from "expo-clipboard";
import { Image } from "expo-image";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Modal,
  Platform,
  Pressable,
  Text,
  View,
  type LayoutRectangle,
} from "react-native";
import { useAppStrings } from "../../../locales/AppStringsContext";
import { WEB_UI_MONO_STACK } from "../../fonts";
import { useTonConnectSession } from "../../ton/TonConnectProvider";
import { typographyAeroport15, typographyFixedRow30Label, useColors } from "../../theme";
import { HeaderIconCopy, HeaderIconExit } from "../icons/HeaderActionIcons";
import { SwapSelectChevron } from "../swap/SwapFormIcons";

const CHIP_HEIGHT_PX = 30;
const CHIP_PAD_H_PX = 10;
const WALLET_ICON_PX = 18;
const MENU_ICON_PX = 18;
const COPIED_HIDE_MS = 1200;

function middleEllipsisAddress(address: string, head = 5, tail = 5): string {
  const trimmed = address.trim();
  if (trimmed.length <= head + tail + 3) return trimmed;
  return `${trimmed.slice(0, head)}...${trimmed.slice(-tail)}`;
}

function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();
}

type Props = {
  chipStyle?: object;
};

/** Connected wallet chip + gamebuy-style popover (copy / switch / add / disconnect). */
export function GetConnectedWalletChip({ chipStyle }: Props) {
  const colors = useColors();
  const { t } = useAppStrings();
  const ton = useTonConnectSession();
  const chipRef = useRef<View>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [anchor, setAnchor] = useState<LayoutRectangle | null>(null);
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const activeAddress = ton.friendlyAddress || ton.address;
  const wallets = useMemo(() => {
    const list = [...ton.rememberedWallets];
    if (activeAddress && !list.some((row) => sameAddress(row.address, activeAddress) || sameAddress(row.friendlyAddress, activeAddress))) {
      list.unshift({
        address: activeAddress,
        friendlyAddress: activeAddress,
        name: ton.walletName,
        imageUrl: ton.walletImageUrl,
        lastConnectedAt: Date.now(),
      });
    }
    return list;
  }, [activeAddress, ton.rememberedWallets, ton.walletImageUrl, ton.walletName]);

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    };
  }, []);

  const measureAndOpen = useCallback(() => {
    ton.refreshRememberedWallets();
    chipRef.current?.measureInWindow((x, y, width, height) => {
      setAnchor({ x, y, width, height });
      setOpen(true);
    });
  }, [ton]);

  const onCopyAddress = useCallback(async () => {
    if (!activeAddress) return;
    await Clipboard.setStringAsync(activeAddress);
    setCopied(true);
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = setTimeout(() => {
      setCopied(false);
      copiedTimerRef.current = null;
    }, COPIED_HIDE_MS);
  }, [activeAddress]);

  const onDisconnect = useCallback(async () => {
    setBusy(true);
    setOpen(false);
    try {
      await ton.disconnect();
    } finally {
      setBusy(false);
    }
  }, [ton]);

  /** TonConnect only shows the wallet picker when disconnected; RN Modal must unmount first on web. */
  const openWalletPicker = useCallback(async () => {
    setBusy(true);
    setOpen(false);
    try {
      if (ton.connected) {
        await ton.disconnect();
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 200);
      });
      await ton.openConnectModal();
    } finally {
      setBusy(false);
    }
  }, [ton]);

  const onConnectAnother = useCallback(async () => {
    await openWalletPicker();
  }, [openWalletPicker]);

  const onSelectWallet = useCallback(
    async (address: string) => {
      if (sameAddress(address, activeAddress)) {
        setOpen(false);
        return;
      }
      await openWalletPicker();
    },
    [activeAddress, openWalletPicker],
  );

  if (!ton.connected || !activeAddress) return null;

  const menuTop = anchor ? anchor.y + anchor.height + 8 : 64;
  const menuRight =
    anchor && typeof window !== "undefined"
      ? Math.max(8, window.innerWidth - (anchor.x + anchor.width))
      : 16;

  const defaultChipStyle = {
    height: CHIP_HEIGHT_PX,
    paddingHorizontal: CHIP_PAD_H_PX,
    backgroundColor: "transparent",
    alignItems: "center" as const,
    justifyContent: "center" as const,
    flexDirection: "row" as const,
    gap: 8,
    borderRadius: CHIP_HEIGHT_PX / 2,
    borderWidth: 1,
    borderColor: colors.highlight,
  };

  return (
    <>
      <View ref={chipRef} collapsable={false}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("get.connectedWalletA11y")}
          disabled={busy}
          onPress={measureAndOpen}
          style={[defaultChipStyle, chipStyle]}
        >
          {ton.walletImageUrl ? (
            <Image
              source={{ uri: ton.walletImageUrl }}
              style={{
                width: WALLET_ICON_PX,
                height: WALLET_ICON_PX,
                borderRadius: 4,
              }}
            />
          ) : (
            <View
              style={{
                width: WALLET_ICON_PX,
                height: WALLET_ICON_PX,
                borderRadius: 4,
                backgroundColor: "#0098EA",
              }}
            />
          )}
          <Text
            style={[typographyAeroport15, { color: colors.primary, fontWeight: "400" }]}
            numberOfLines={1}
          >
            {middleEllipsisAddress(activeAddress)}
          </Text>
          <SwapSelectChevron />
        </Pressable>
      </View>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={{ flex: 1 }} onPress={() => setOpen(false)}>
          <Pressable
            style={{
              position: "absolute",
              top: menuTop,
              right: menuRight,
              minWidth: 260,
              maxWidth: 340,
              backgroundColor: colors.background,
              borderWidth: 1,
              borderColor: colors.highlight,
              borderRadius: 0,
              paddingVertical: 6,
            }}
            onPress={(e) => e.stopPropagation?.()}
          >
            {/* Active address + copy */}
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 10,
                paddingVertical: 12,
                paddingHorizontal: 14,
              }}
            >
              <Text
                style={[
                  typographyAeroport15,
                  {
                    color: colors.primary,
                    flex: 1,
                    minWidth: 0,
                    fontFamily: Platform.OS === "web" ? WEB_UI_MONO_STACK : undefined,
                    lineHeight: 20,
                  },
                ]}
                selectable
              >
                {activeAddress}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={copied ? t("get.copied") : t("get.copyAddressButton")}
                onPress={() => void onCopyAddress()}
                hitSlop={8}
                style={{ width: 28, height: 28, alignItems: "center", justifyContent: "center" }}
              >
                <HeaderIconCopy color={copied ? colors.primary : colors.secondary} size={MENU_ICON_PX} />
              </Pressable>
            </View>

            <View style={{ height: 1, backgroundColor: colors.highlight, marginHorizontal: 10 }} />

            {/* Remembered wallets */}
            {wallets.map((row) => {
              const display = row.friendlyAddress || row.address;
              const active = sameAddress(display, activeAddress) || sameAddress(row.address, activeAddress);
              return (
                <Pressable
                  key={row.address}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  disabled={busy}
                  onPress={() => void onSelectWallet(display)}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 10,
                    paddingVertical: 10,
                    paddingHorizontal: 14,
                    backgroundColor: active ? colors.undercover : "transparent",
                  }}
                >
                  {row.imageUrl ? (
                    <Image
                      source={{ uri: row.imageUrl }}
                      style={{ width: WALLET_ICON_PX, height: WALLET_ICON_PX }}
                    />
                  ) : (
                    <View
                      style={{
                        width: WALLET_ICON_PX,
                        height: WALLET_ICON_PX,
                        backgroundColor: "#0098EA",
                      }}
                    />
                  )}
                  <View style={{ flex: 1, minWidth: 0 }}>
                    {row.name ? (
                      <Text
                        style={[typographyAeroport15, { color: colors.primary, fontWeight: "400" }]}
                        numberOfLines={1}
                      >
                        {row.name}
                      </Text>
                    ) : null}
                    <Text
                      style={[
                        typographyAeroport15,
                        {
                          color: colors.secondary,
                          fontFamily: Platform.OS === "web" ? WEB_UI_MONO_STACK : undefined,
                        },
                      ]}
                      numberOfLines={1}
                    >
                      {middleEllipsisAddress(display, 6, 6)}
                    </Text>
                  </View>
                  {active ? (
                    <Text style={[typographyAeroport15, { color: colors.primary }]}>✓</Text>
                  ) : null}
                </Pressable>
              );
            })}

            <View style={{ height: 1, backgroundColor: colors.highlight, marginHorizontal: 10 }} />

            <Pressable
              accessibilityRole="button"
              disabled={busy}
              onPress={() => void onConnectAnother()}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 10,
                paddingVertical: 12,
                paddingHorizontal: 14,
              }}
            >
              <Text style={[typographyFixedRow30Label, { color: colors.primary, fontSize: 18, lineHeight: 18 }]}>
                +
              </Text>
              <Text style={[typographyAeroport15, { color: colors.primary, fontWeight: "400" }]}>
                {t("get.connectAnotherWallet")}
              </Text>
            </Pressable>

            <View style={{ height: 1, backgroundColor: colors.highlight, marginHorizontal: 10 }} />

            <Pressable
              accessibilityRole="button"
              disabled={busy}
              onPress={() => void onDisconnect()}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 10,
                paddingVertical: 12,
                paddingHorizontal: 14,
              }}
            >
              <HeaderIconExit color={colors.secondary} size={MENU_ICON_PX} />
              <Text style={[typographyAeroport15, { color: colors.secondary, fontWeight: "400" }]}>
                {t("get.disconnectWallet")}
              </Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}
