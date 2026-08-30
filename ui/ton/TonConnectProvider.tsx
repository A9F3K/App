import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import { Platform } from "react-native";
import {
  readRememberedTonWallets,
  rememberTonWallet,
  type RememberedTonWallet,
} from "./rememberedTonWallets";
import { resolveTonConnectActionsConfiguration } from "./resolveTonConnectActionsConfiguration";

export type TonConnectTransactionRequest = {
  validUntil: number;
  network: string;
  messages: Array<{
    address: string;
    amount: string;
    payload?: string;
    stateInit?: string;
  }>;
};

export type TonConnectSendTransactionResult = {
  boc: string;
};

export type TonConnectSession = {
  ready: boolean;
  connected: boolean;
  address: string | null;
  /** Friendly bounceable address for copy / display when available. */
  friendlyAddress: string | null;
  walletName: string | null;
  /** Wallet app icon (TonConnect wallet info), if any. */
  walletImageUrl: string | null;
  rememberedWallets: RememberedTonWallet[];
  refreshRememberedWallets: () => void;
  openConnectModal: () => Promise<void>;
  disconnect: () => Promise<void>;
  /** Opens the connected wallet for confirmation; resolves with signed BOC on success. */
  sendTransaction: (request: TonConnectTransactionRequest) => Promise<TonConnectSendTransactionResult>;
};

const EMPTY_SESSION: TonConnectSession = {
  ready: false,
  connected: false,
  address: null,
  friendlyAddress: null,
  walletName: null,
  walletImageUrl: null,
  rememberedWallets: [],
  refreshRememberedWallets: () => {},
  openConnectModal: async () => {},
  disconnect: async () => {},
  sendTransaction: async () => ({ boc: "" }),
};

const TonConnectSessionContext = createContext<TonConnectSession>(EMPTY_SESSION);

export function useTonConnectSession(): TonConnectSession {
  return useContext(TonConnectSessionContext);
}

type Props = { children: ReactNode };

/**
 * Mount TonConnect only after client hydration so SSR HTML matches the first
 * client paint (same pattern as gamebuy `TonProvider`).
 */
export function TonConnectProvider({ children }: Props) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (Platform.OS === "web") setReady(true);
  }, []);

  if (Platform.OS !== "web" || !ready) {
    return (
      <TonConnectSessionContext.Provider value={EMPTY_SESSION}>{children}</TonConnectSessionContext.Provider>
    );
  }

  return <WebTonConnectTree>{children}</WebTonConnectTree>;
}

function WebTonConnectTree({ children }: { children: ReactNode }) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { TonConnectUIProvider } = require("@tonconnect/ui-react") as {
    TonConnectUIProvider: ComponentType<{
      manifestUrl: string;
      actionsConfiguration?: ReturnType<typeof resolveTonConnectActionsConfiguration>;
      children: ReactNode;
    }>;
  };

  const origin =
    typeof window !== "undefined" && window.location?.origin
      ? window.location.origin
      : "https://program.hyperlinks.space";
  const actionsConfiguration = resolveTonConnectActionsConfiguration();

  return (
    <TonConnectUIProvider
      manifestUrl={`${origin}/tonconnect-manifest.json`}
      actionsConfiguration={actionsConfiguration}
    >
      <WebTonConnectSessionBridge>{children}</WebTonConnectSessionBridge>
    </TonConnectUIProvider>
  );
}

function WebTonConnectSessionBridge({ children }: { children: ReactNode }) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const tonconnect = require("@tonconnect/ui-react") as {
    useTonConnectUI: () => [
      {
        openModal: () => Promise<void>;
        disconnect: () => Promise<void>;
        sendTransaction: (
          request: TonConnectTransactionRequest,
          options?: ReturnType<typeof resolveTonConnectActionsConfiguration>,
        ) => Promise<{ boc: string }>;
      },
    ];
    useTonAddress: (friendly?: boolean) => string;
    useTonWallet: () =>
      | {
          imageUrl?: string;
          name?: string;
          account?: { address?: string };
        }
      | null;
  };

  const [tonConnectUI] = tonconnect.useTonConnectUI();
  const rawAddress = tonconnect.useTonAddress();
  const friendlyAddress = tonconnect.useTonAddress(true);
  const wallet = tonconnect.useTonWallet();
  const [rememberedWallets, setRememberedWallets] = useState<RememberedTonWallet[]>(() =>
    readRememberedTonWallets(),
  );

  const refreshRememberedWallets = useCallback(() => {
    setRememberedWallets(readRememberedTonWallets());
  }, []);

  useEffect(() => {
    const address = (friendlyAddress || rawAddress || "").trim();
    if (!address) return;
    setRememberedWallets(
      rememberTonWallet({
        address,
        friendlyAddress: friendlyAddress || address,
        name: wallet?.name ?? null,
        imageUrl: wallet?.imageUrl ?? null,
      }),
    );
  }, [friendlyAddress, rawAddress, wallet?.imageUrl, wallet?.name]);

  const openConnectModal = useCallback(async () => {
    await tonConnectUI.openModal();
  }, [tonConnectUI]);

  const disconnect = useCallback(async () => {
    await tonConnectUI.disconnect();
    refreshRememberedWallets();
  }, [refreshRememberedWallets, tonConnectUI]);

  const sendTransaction = useCallback(
    async (request: TonConnectTransactionRequest) => {
      const actionsConfiguration = resolveTonConnectActionsConfiguration();
      return tonConnectUI.sendTransaction(request, actionsConfiguration);
    },
    [tonConnectUI],
  );

  const address = (friendlyAddress || rawAddress || "").trim() || null;

  const value = useMemo<TonConnectSession>(
    () => ({
      ready: true,
      connected: Boolean(address),
      address,
      friendlyAddress: friendlyAddress?.trim() || address,
      walletName: wallet?.name?.trim() || null,
      walletImageUrl: wallet?.imageUrl?.trim() || null,
      rememberedWallets,
      refreshRememberedWallets,
      openConnectModal,
      disconnect,
      sendTransaction,
    }),
    [
      address,
      disconnect,
      friendlyAddress,
      openConnectModal,
      refreshRememberedWallets,
      rememberedWallets,
      sendTransaction,
      wallet?.imageUrl,
      wallet?.name,
    ],
  );

  return (
    <TonConnectSessionContext.Provider value={value}>{children}</TonConnectSessionContext.Provider>
  );
}
