import { Image } from "expo-image";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Modal,
  Platform,
  Pressable,
  Text,
  View,
  type LayoutRectangle,
} from "react-native";
import Svg, { Path } from "react-native-svg";

import { useAppStrings } from "../../../locales/AppStringsContext";
import { WEB_UI_MONO_STACK } from "../../fonts";
import { useTonConnectSession } from "../../ton/TonConnectProvider";
import { typographyAeroport15, useColors } from "../../theme";
import { ConnectedWalletNameplate } from "./ConnectedWalletNameplate";

const WALLET_ICON_PX = 18;
const PLUS_ICON_PX = 14;

function middleEllipsisAddress(address: string, head = 6, tail = 6): string {
  const trimmed = address.trim();
  if (trimmed.length <= head + tail + 3) return trimmed;
  return `${trimmed.slice(0, head)}...${trimmed.slice(-tail)}`;
}

function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();
}

function PlusGlyph({ color, size = PLUS_ICON_PX }: { color: string; size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <Path
        d="M8 3v10M3 8h10"
        stroke={color}
        strokeWidth={1.5}
        strokeLinecap="round"
      />
    </Svg>
  );
}

export type SwitchWalletMenuAnchor = LayoutRectangle;

type WalletRow = {
  key: string;
  address: string;
  displayAddress: string;
  name: string | null;
  imageUrl: string | null;
  connected: boolean;
  builtin: boolean;
};

type Props = {
  visible: boolean;
  anchor: SwitchWalletMenuAnchor | null;
  /** App registration / built-in wallet address shown in the header. */
  builtinAddress: string;
  onClose: () => void;
};

/** Popover: available wallets (built-in + TonConnect) with CONNECTED plates + add. */
export function SwitchWalletMenu({ visible, anchor, builtinAddress, onClose }: Props) {
  const colors = useColors();
  const { t } = useAppStrings();
  const ton = useTonConnectSession();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (visible) ton.refreshRememberedWallets();
  }, [ton, visible]);

  const activeTon = ton.friendlyAddress || ton.address;
  const builtin = builtinAddress.trim();

  const wallets = useMemo((): WalletRow[] => {
    const rows: WalletRow[] = [];
    if (builtin) {
      rows.push({
        key: `builtin:${builtin}`,
        address: builtin,
        displayAddress: builtin,
        name: t("home.header.builtinWallet"),
        imageUrl: null,
        connected: false,
        builtin: true,
      });
    }
    const list = [...ton.rememberedWallets];
    if (
      activeTon &&
      !list.some(
        (row) =>
          sameAddress(row.address, activeTon) || sameAddress(row.friendlyAddress, activeTon),
      )
    ) {
      list.unshift({
        address: activeTon,
        friendlyAddress: activeTon,
        name: ton.walletName,
        imageUrl: ton.walletImageUrl,
        lastConnectedAt: Date.now(),
      });
    }
    for (const row of list) {
      const display = (row.friendlyAddress || row.address).trim();
      if (!display) continue;
      if (sameAddress(display, builtin) || sameAddress(row.address, builtin)) continue;
      const connected =
        Boolean(ton.connected) &&
        (sameAddress(display, activeTon) || sameAddress(row.address, activeTon));
      rows.push({
        key: `ton:${row.address}`,
        address: row.address,
        displayAddress: display,
        name: row.name,
        imageUrl: row.imageUrl,
        connected,
        builtin: false,
      });
    }
    return rows;
  }, [
    activeTon,
    builtin,
    t,
    ton.connected,
    ton.rememberedWallets,
    ton.walletImageUrl,
    ton.walletName,
  ]);

  const openWalletPicker = useCallback(async () => {
    setBusy(true);
    onClose();
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
  }, [onClose, ton]);

  const onSelectWallet = useCallback(
    async (row: WalletRow) => {
      if (row.builtin) {
        onClose();
        return;
      }
      if (row.connected) {
        onClose();
        return;
      }
      await openWalletPicker();
    },
    [onClose, openWalletPicker],
  );

  if (!visible) return null;

  const menuTop = anchor ? anchor.y + anchor.height + 8 : 64;
  const menuLeft = anchor
    ? Math.max(8, Math.min(anchor.x, (typeof window !== "undefined" ? window.innerWidth : 400) - 280))
    : 16;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={{ flex: 1 }} onPress={onClose}>
        <Pressable
          style={{
            position: "absolute",
            top: menuTop,
            left: menuLeft,
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
          {wallets.map((row) => (
            <Pressable
              key={row.key}
              accessibilityRole="button"
              accessibilityState={{ selected: row.connected || row.builtin }}
              disabled={busy}
              onPress={() => void onSelectWallet(row)}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 10,
                paddingVertical: 10,
                paddingHorizontal: 14,
                backgroundColor: row.connected ? colors.undercover : "transparent",
              }}
            >
              {row.imageUrl ? (
                <Image
                  source={{ uri: row.imageUrl }}
                  style={{ width: WALLET_ICON_PX, height: WALLET_ICON_PX, borderRadius: 4 }}
                />
              ) : (
                <View
                  style={{
                    width: WALLET_ICON_PX,
                    height: WALLET_ICON_PX,
                    borderRadius: 4,
                    backgroundColor: row.builtin ? colors.undercover : "#0098EA",
                  }}
                />
              )}
              <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 6,
                    minWidth: 0,
                  }}
                >
                  {row.name ? (
                    <Text
                      style={[
                        typographyAeroport15,
                        { color: colors.primary, fontWeight: "400", flexShrink: 1, minWidth: 0 },
                      ]}
                      numberOfLines={1}
                    >
                      {row.name}
                    </Text>
                  ) : null}
                  {row.connected ? <ConnectedWalletNameplate /> : null}
                </View>
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
                  {middleEllipsisAddress(row.displayAddress)}
                </Text>
              </View>
            </Pressable>
          ))}

          <View style={{ height: 1, backgroundColor: colors.highlight, marginHorizontal: 10 }} />

          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("home.header.addWallet")}
            disabled={busy}
            onPress={() => void openWalletPicker()}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 10,
              paddingVertical: 12,
              paddingHorizontal: 14,
            }}
          >
            <View
              style={{
                width: WALLET_ICON_PX,
                height: WALLET_ICON_PX,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <PlusGlyph color={colors.primary} />
            </View>
            <Text style={[typographyAeroport15, { color: colors.primary, fontWeight: "400" }]}>
              {t("home.header.addWallet")}
            </Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
