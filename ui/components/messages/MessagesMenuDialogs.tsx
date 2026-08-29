import { useCallback, useEffect, useMemo, useState, type JSX, type ReactNode } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import Svg, { Circle, Path } from "react-native-svg";
import { useAppStrings } from "../../../locales/AppStringsContext";
import type { AppLocale, AppStringKey } from "../../../locales/appStrings";
import { openAuthenticatedHomeChatHistory } from "../../authenticatedHomeSelectedChat";
import { useProfileSheet } from "../../profile/ProfileContext";
import { typographyFixedRow30Label, useColors } from "../../theme";
import {
  addTelegramContact,
  createTelegramChannel,
  createTelegramGroup,
  fetchTelegramCallsOverview,
  fetchTelegramContacts,
  type SideMenuActiveVoiceChat,
  type SideMenuCallHistoryRow,
  type SideMenuContact,
  type SideMenuCreatedChat,
} from "../../telegram/fetchTelegramSideMenuDialogs";
import {
  resolveFloatingDialogInsets,
} from "../floatingDialogChrome";
import { FloatingDialogScrollChromeProvider } from "../floatingDialogScrollChrome";
import { FloatingDialogStickyHeader } from "../FloatingDialogStickyHeader";
import {
  FloatingDialogShell,
} from "../FloatingDialogShell";
import { resolveFloatingDialogDefaultSize } from "../floatingDialogGeometry";
import { HspScrollColumn } from "../HspScrollColumn";
import { SCROLL_INDICATOR_OVERLAY_CHROME_BORDER_INSET_PX } from "../../scrollIndicatorPx";
import { useTelegram } from "../Telegram";
import { extractChatAvatarInitials } from "./chatAvatarInitials";
import { formatMessageChatListTime } from "./formatMessageChatTime";
import { formatMessageChatPresenceLabel } from "./formatMessageChatPresence";
import type { MessageChatKind, MessageChatRowData } from "./MessageChatRow";
import { MessageChatAvatarSlot } from "./MessageChatAvatarSlot";
import { resolveTelegramUserAvatarUrl } from "./resolveTelegramUserAvatarUrl";
import { SideMenuCallsIcon } from "./MessagesSideMenuIcons";

const PAD_X = 20;
const AVATAR_BTN_PX = 64;
const ROW_AVATAR_PX = 40;
const CAMERA_BLUE = "#5B9FE8";
const ACTION_BLUE = "#5B9FE8";

export type MessagesMenuDialogKind =
  | "newGroup"
  | "newChannel"
  | "contacts"
  | "calls"
  | "settings"
  | null;

type SettingsProfile = {
  title: string;
  phone?: string | null;
  usernameAt?: string | null;
  avatarUrl?: string | null;
  initials?: string;
};

function CameraGlyph({ color = "#FFFFFF", size = 26 }: { color?: string; size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M4.5 8.5h2.2l1.1-1.8h6.4l1.1 1.8h2.2A1.5 1.5 0 0 1 19 10v7.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 3 17.5V10a1.5 1.5 0 0 1 1.5-1.5Z"
        stroke={color}
        strokeWidth={1.6}
        strokeLinejoin="round"
      />
      <Circle cx="12" cy="13.5" r="3.1" stroke={color} strokeWidth={1.6} />
    </Svg>
  );
}

function DialogCameraButton({ label }: { label: string }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => ({
        width: AVATAR_BTN_PX,
        height: AVATAR_BTN_PX,
        borderRadius: AVATAR_BTN_PX / 2,
        backgroundColor: CAMERA_BLUE,
        alignItems: "center",
        justifyContent: "center",
        opacity: pressed ? 0.85 : 1,
      })}
    >
      <CameraGlyph />
    </Pressable>
  );
}

function UnderlineField({
  value,
  onChangeText,
  placeholder,
  colors,
  multiline = false,
  keyboardType = "default",
  autoCapitalize = "sentences",
}: {
  value: string;
  onChangeText: (next: string) => void;
  placeholder: string;
  colors: ReturnType<typeof useColors>;
  multiline?: boolean;
  keyboardType?: "default" | "phone-pad";
  autoCapitalize?: "none" | "sentences" | "words";
}) {
  return (
    <TextInput
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor={colors.secondary}
      multiline={multiline}
      keyboardType={keyboardType}
      autoCapitalize={autoCapitalize}
      autoCorrect={false}
      style={{
        color: colors.primary,
        fontSize: 16,
        lineHeight: 22,
        paddingVertical: Platform.OS === "web" ? 10 : 8,
        paddingHorizontal: 0,
        borderBottomWidth: 1,
        borderBottomColor: colors.highlight,
        minHeight: multiline ? 72 : 40,
        textAlignVertical: multiline ? "top" : "center",
        ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : null),
      }}
    />
  );
}

function DialogTextAction({
  label,
  onPress,
  disabled,
  emphasized = false,
}: {
  label: string;
  onPress?: () => void;
  disabled?: boolean;
  emphasized?: boolean;
}) {
  const colors = useColors();
  const color = disabled
    ? colors.secondary
    : emphasized
      ? ACTION_BLUE
      : colors.primary;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        paddingVertical: 8,
        paddingHorizontal: 10,
        opacity: disabled ? 0.45 : pressed ? 0.7 : 1,
      })}
    >
      <Text
        style={{
          color,
          fontSize: 15,
          lineHeight: 20,
          fontWeight: emphasized ? "600" : "500",
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function DialogFooterActions({ children }: { children: ReactNode }) {
  return (
    <View
      style={{
        flexDirection: "row",
        justifyContent: "flex-end",
        alignItems: "center",
        gap: 4,
        paddingTop: 12,
        paddingBottom: 4,
      }}
    >
      {children}
    </View>
  );
}

function SectionLabel({ text, colors }: { text: string; colors: ReturnType<typeof useColors> }) {
  return (
    <Text
      style={{
        color: colors.secondary,
        fontSize: 13,
        lineHeight: 18,
        paddingHorizontal: PAD_X,
        paddingTop: 14,
        paddingBottom: 6,
        textTransform: "uppercase",
        letterSpacing: 0.3,
      }}
    >
      {text}
    </Text>
  );
}

function createdChatToRow(chat: SideMenuCreatedChat, fallbackKind: MessageChatKind): MessageChatRowData {
  const kindRaw = chat.chat_kind;
  const chatKind: MessageChatKind =
    kindRaw === "private" ||
    kindRaw === "group" ||
    kindRaw === "supergroup" ||
    kindRaw === "channel"
      ? kindRaw
      : fallbackKind;
  return {
    id: chat.telegram_chat_id,
    telegram_chat_id: chat.telegram_chat_id,
    title: chat.title,
    subtitle: "",
    avatar_url: null,
    last_message_at: null,
    unread_count: 0,
    chat_kind: chatKind,
    peer_user_id: null,
    peer_username: null,
    chat_username: null,
    member_count: null,
    presence_kind: null,
    presence_at: null,
    is_pinned: false,
  };
}

function contactToChatRow(contact: SideMenuContact): MessageChatRowData {
  const chatId = contact.chatId ?? contact.userId;
  return {
    id: chatId,
    telegram_chat_id: chatId,
    title: contact.title,
    subtitle: "",
    avatar_url: resolveTelegramUserAvatarUrl({ user_id: contact.userId, chat_id: contact.chatId }),
    last_message_at: null,
    unread_count: 0,
    peer_user_id: contact.userId,
    peer_username: contact.username,
    chat_username: contact.username,
    chat_kind: "private",
    presence_kind: contact.presenceKind,
    presence_at: contact.presenceAt,
    is_pinned: false,
  };
}

function formatContactPresence(contact: SideMenuContact, locale: AppLocale): string {
  if (contact.presenceKind === "offline" && !contact.presenceAt) {
    return locale === "ru"
      ? "был(а) давно"
      : locale === "zh"
        ? "很久以前在线"
        : "last seen a long time ago";
  }
  return formatMessageChatPresenceLabel(
    {
      id: contact.userId,
      telegram_chat_id: contact.chatId ?? contact.userId,
      title: contact.title,
      subtitle: "",
      avatar_url: null,
      last_message_at: null,
      unread_count: 0,
      presence_kind: contact.presenceKind,
      presence_at: contact.presenceAt,
    },
    locale,
  );
}

function MenuDialogShell({
  visible,
  title,
  onClose,
  sizeKind,
  storageKey,
  children,
  footer,
  fitContentHeight = false,
  hideTitle = false,
}: {
  visible: boolean;
  title: string;
  onClose: () => void;
  sizeKind: "modal" | "picker";
  storageKey: string;
  children: ReactNode;
  footer?: ReactNode;
  fitContentHeight?: boolean;
  /** Match Telegram Desktop create dialogs (avatar + fields, no header title). */
  hideTitle?: boolean;
}) {
  const colors = useColors();
  const { t } = useAppStrings();
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const insets = resolveFloatingDialogInsets(windowHeight);
  const [headerExtendPx, setHeaderExtendPx] = useState(0);
  const defaultSize = useMemo(
    () => resolveFloatingDialogDefaultSize(windowWidth, windowHeight, sizeKind),
    [sizeKind, windowHeight, windowWidth],
  );

  return (
    <FloatingDialogShell
      visible={visible}
      zIndex={10080}
      defaultSize={defaultSize}
      minSize={{ width: 300, height: 240 }}
      sizeStorageKey={`hsp.messagesMenu.${storageKey}.size.v1`}
      offsetStorageKey={`hsp.messagesMenu.${storageKey}.offset.v1`}
      fitContentHeight={fitContentHeight}
      onRequestClose={onClose}
      testId={`messages-menu-${storageKey}`}
      sheetStyle={{ backgroundColor: colors.background }}
    >
      <FloatingDialogScrollChromeProvider headerExtendPx={headerExtendPx}>
        <View style={{ flex: 1, minHeight: 0, backgroundColor: colors.background }}>
          <FloatingDialogStickyHeader
            insets={insets}
            title={title}
            onClose={onClose}
            closeLabel={t("common.close")}
            hideTitle={hideTitle}
            onHeightChange={setHeaderExtendPx}
          />
          <View style={{ flex: 1, minHeight: 0 }}>{children}</View>
          {footer ? (
            <View
              style={{
                paddingHorizontal: insets.padX,
                paddingBottom: insets.bodyPadBottom,
                backgroundColor: colors.background,
              }}
            >
              {footer}
            </View>
          ) : null}
        </View>
      </FloatingDialogScrollChromeProvider>
    </FloatingDialogShell>
  );
}

function NewGroupDialog({ onClose }: { onClose: () => void }) {
  const colors = useColors();
  const { t } = useAppStrings();
  const { colorScheme } = useTelegram();
  const [step, setStep] = useState<"name" | "members">("name");
  const [title, setTitle] = useState("");
  const [contacts, setContacts] = useState<SideMenuContact[]>([]);
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (step !== "members") return;
    const controller = new AbortController();
    setLoading(true);
    void fetchTelegramContacts(controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setLoading(false);
      if (result.ok) setContacts(result.contacts);
      else setError(result.error);
    });
    return () => controller.abort();
  }, [step]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return contacts;
    return contacts.filter((c) => {
      const hay = `${c.title} ${c.username ?? ""} ${c.firstName} ${c.lastName}`.toLowerCase();
      return hay.includes(q);
    });
  }, [contacts, search]);

  const toggleMember = useCallback((userId: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  }, []);

  const onCreate = useCallback(async () => {
    const trimmed = title.trim();
    if (!trimmed || creating) return;
    setCreating(true);
    setError(null);
    const result = await createTelegramGroup({
      title: trimmed,
      userIds: Array.from(selected),
    });
    setCreating(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    openAuthenticatedHomeChatHistory(createdChatToRow(result.chat, "group"));
    onClose();
  }, [creating, onClose, selected, title]);

  if (step === "name") {
    const canNext = title.trim().length > 0;
    return (
      <MenuDialogShell
        visible
        title={t("messages.sideMenu.newGroup")}
        onClose={onClose}
        sizeKind="modal"
        storageKey="newGroup"
        fitContentHeight
        hideTitle
        footer={
          <DialogFooterActions>
            <DialogTextAction
              label={t("common.next")}
              emphasized
              disabled={!canNext}
              onPress={() => setStep("members")}
            />
          </DialogFooterActions>
        }
      >
        <View style={{ paddingHorizontal: PAD_X, paddingTop: 20, gap: 18 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 16 }}>
            <DialogCameraButton label={t("messages.menuDialog.setPhoto")} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <UnderlineField
                value={title}
                onChangeText={setTitle}
                placeholder={t("messages.menuDialog.groupName")}
                colors={colors}
                autoCapitalize="words"
              />
            </View>
          </View>
        </View>
      </MenuDialogShell>
    );
  }

  return (
    <MenuDialogShell
      visible
      title={t("messages.menuDialog.addMembers")}
      onClose={onClose}
      sizeKind="picker"
      storageKey="newGroupMembers"
      footer={
        <DialogFooterActions>
          <DialogTextAction
            label={t("common.create")}
            emphasized
            disabled={creating || title.trim().length === 0}
            onPress={() => void onCreate()}
          />
        </DialogFooterActions>
      }
    >
      <View style={{ paddingHorizontal: PAD_X, paddingTop: 10, paddingBottom: 8 }}>
        <UnderlineField
          value={search}
          onChangeText={setSearch}
          placeholder={t("common.search")}
          colors={colors}
          autoCapitalize="none"
        />
        {error ? (
          <Text style={{ color: "#FF6B6B", marginTop: 8, fontSize: 13 }}>{error}</Text>
        ) : null}
      </View>
      {loading ? (
        <View style={{ padding: 24, alignItems: "center" }}>
          <ActivityIndicator color={colors.secondary} />
        </View>
      ) : (
        <HspScrollColumn
          style={{ flex: 1, minHeight: 0 }}
          contentContainerStyle={{ paddingBottom: 12 }}
          scrollbarRightInsetPx={SCROLL_INDICATOR_OVERLAY_CHROME_BORDER_INSET_PX}
          scrollIndicatorOverlaySeam={false}
          containOverscroll
        >
          {filtered.map((contact) => {
            const checked = selected.has(contact.userId);
            const avatarUrl = resolveTelegramUserAvatarUrl({
              user_id: contact.userId,
              chat_id: contact.chatId,
            });
            return (
              <Pressable
                key={contact.userId}
                accessibilityRole="checkbox"
                accessibilityState={{ checked }}
                onPress={() => toggleMember(contact.userId)}
                style={({ pressed }) => ({
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 12,
                  paddingHorizontal: PAD_X,
                  paddingVertical: 10,
                  opacity: pressed ? 0.75 : 1,
                  backgroundColor: checked ? colors.undercover : "transparent",
                })}
              >
                <MessageChatAvatarSlot
                  iconUrl={avatarUrl}
                  initials={extractChatAvatarInitials(contact.title)}
                  sizePx={ROW_AVATAR_PX}
                  colors={colors}
                  scheme={colorScheme}
                />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={[typographyFixedRow30Label, { color: colors.primary }]} numberOfLines={1}>
                    {contact.title}
                  </Text>
                </View>
                <View
                  style={{
                    width: 20,
                    height: 20,
                    borderRadius: 10,
                    borderWidth: 1.5,
                    borderColor: checked ? ACTION_BLUE : colors.highlight,
                    backgroundColor: checked ? ACTION_BLUE : "transparent",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  {checked ? (
                    <Text style={{ color: "#fff", fontSize: 12, lineHeight: 14, fontWeight: "700" }}>✓</Text>
                  ) : null}
                </View>
              </Pressable>
            );
          })}
        </HspScrollColumn>
      )}
    </MenuDialogShell>
  );
}

function NewChannelDialog({ onClose }: { onClose: () => void }) {
  const colors = useColors();
  const { t } = useAppStrings();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onCreate = useCallback(async () => {
    const trimmed = title.trim();
    if (!trimmed || creating) return;
    setCreating(true);
    setError(null);
    const result = await createTelegramChannel({
      title: trimmed,
      description: description.trim() || undefined,
    });
    setCreating(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    openAuthenticatedHomeChatHistory(createdChatToRow(result.chat, "channel"));
    onClose();
  }, [creating, description, onClose, title]);

  return (
    <MenuDialogShell
      visible
      title={t("messages.sideMenu.newChannel")}
      onClose={onClose}
      sizeKind="modal"
      storageKey="newChannel"
      fitContentHeight
      hideTitle
      footer={
        <DialogFooterActions>
          <DialogTextAction
            label={t("common.create")}
            emphasized
            disabled={creating || title.trim().length === 0}
            onPress={() => void onCreate()}
          />
        </DialogFooterActions>
      }
    >
      <View style={{ paddingHorizontal: PAD_X, paddingTop: 20, gap: 16 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 16 }}>
          <DialogCameraButton label={t("messages.menuDialog.setPhoto")} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <UnderlineField
              value={title}
              onChangeText={setTitle}
              placeholder={t("messages.menuDialog.channelName")}
              colors={colors}
              autoCapitalize="words"
            />
          </View>
        </View>
        <UnderlineField
          value={description}
          onChangeText={setDescription}
          placeholder={t("messages.menuDialog.descriptionOptional")}
          colors={colors}
          multiline
        />
        {error ? <Text style={{ color: "#FF6B6B", fontSize: 13 }}>{error}</Text> : null}
      </View>
    </MenuDialogShell>
  );
}

function ContactsDialog({ onClose }: { onClose: () => void }) {
  const colors = useColors();
  const { t, locale } = useAppStrings();
  const { colorScheme } = useTelegram();
  const [mode, setMode] = useState<"list" | "add">("list");
  const [contacts, setContacts] = useState<SideMenuContact[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [phone, setPhone] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [saving, setSaving] = useState(false);

  const reload = useCallback((signal?: AbortSignal) => {
    setLoading(true);
    void fetchTelegramContacts(signal).then((result) => {
      if (signal?.aborted) return;
      setLoading(false);
      if (result.ok) {
        setContacts(result.contacts);
        setError(null);
      } else {
        setError(result.error);
      }
    });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    reload(controller.signal);
    return () => controller.abort();
  }, [reload]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return contacts;
    return contacts.filter((c) => {
      const hay = `${c.title} ${c.username ?? ""}`.toLowerCase();
      return hay.includes(q);
    });
  }, [contacts, search]);

  const openContact = useCallback(
    (contact: SideMenuContact) => {
      openAuthenticatedHomeChatHistory(contactToChatRow(contact));
      onClose();
    },
    [onClose],
  );

  const onAdd = useCallback(async () => {
    const phoneNumber = phone.trim();
    const first = firstName.trim();
    if (!phoneNumber || !first || saving) return;
    setSaving(true);
    setError(null);
    const result = await addTelegramContact({
      phoneNumber,
      firstName: first,
      lastName: lastName.trim() || undefined,
    });
    setSaving(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    if (result.chatId != null || result.userId != null) {
      const chatId = result.chatId ?? result.userId!;
      openAuthenticatedHomeChatHistory({
        id: chatId,
        telegram_chat_id: chatId,
        title: [first, lastName.trim()].filter(Boolean).join(" ") || first,
        subtitle: "",
        avatar_url: resolveTelegramUserAvatarUrl({
          user_id: result.userId,
          chat_id: result.chatId,
        }),
        last_message_at: null,
        unread_count: 0,
        peer_user_id: result.userId,
        chat_kind: "private",
        is_pinned: false,
      });
      onClose();
      return;
    }
    setMode("list");
    reload();
  }, [firstName, lastName, onClose, phone, reload, saving]);

  if (mode === "add") {
    return (
      <MenuDialogShell
        visible
        title={t("messages.menuDialog.addContact")}
        onClose={onClose}
        sizeKind="modal"
        storageKey="addContact"
        fitContentHeight
        footer={
          <DialogFooterActions>
            <DialogTextAction
              label={t("common.add")}
              emphasized
              disabled={saving || !phone.trim() || !firstName.trim()}
              onPress={() => void onAdd()}
            />
          </DialogFooterActions>
        }
      >
        <View style={{ paddingHorizontal: PAD_X, paddingTop: 16, gap: 14 }}>
          <UnderlineField
            value={phone}
            onChangeText={setPhone}
            placeholder={t("messages.menuDialog.phoneNumber")}
            colors={colors}
            keyboardType="phone-pad"
            autoCapitalize="none"
          />
          <UnderlineField
            value={firstName}
            onChangeText={setFirstName}
            placeholder={t("messages.menuDialog.firstName")}
            colors={colors}
            autoCapitalize="words"
          />
          <UnderlineField
            value={lastName}
            onChangeText={setLastName}
            placeholder={t("messages.menuDialog.lastName")}
            colors={colors}
            autoCapitalize="words"
          />
          {error ? <Text style={{ color: "#FF6B6B", fontSize: 13 }}>{error}</Text> : null}
        </View>
      </MenuDialogShell>
    );
  }

  return (
    <MenuDialogShell
      visible
      title={t("messages.sideMenu.contacts")}
      onClose={onClose}
      sizeKind="picker"
      storageKey="contacts"
      footer={
        <DialogFooterActions>
          <DialogTextAction
            label={t("messages.menuDialog.addContact")}
            emphasized
            onPress={() => setMode("add")}
          />
        </DialogFooterActions>
      }
    >
      <View style={{ paddingHorizontal: PAD_X, paddingTop: 10, paddingBottom: 8 }}>
        <UnderlineField
          value={search}
          onChangeText={setSearch}
          placeholder={t("common.search")}
          colors={colors}
          autoCapitalize="none"
        />
        {error ? (
          <Text style={{ color: "#FF6B6B", marginTop: 8, fontSize: 13 }}>{error}</Text>
        ) : null}
      </View>
      {loading ? (
        <View style={{ padding: 24, alignItems: "center" }}>
          <ActivityIndicator color={colors.secondary} />
        </View>
      ) : (
        <HspScrollColumn
          style={{ flex: 1, minHeight: 0 }}
          contentContainerStyle={{ paddingBottom: 8 }}
          scrollbarRightInsetPx={SCROLL_INDICATOR_OVERLAY_CHROME_BORDER_INSET_PX}
          scrollIndicatorOverlaySeam={false}
          containOverscroll
        >
          {filtered.map((contact) => {
            const avatarUrl = resolveTelegramUserAvatarUrl({
              user_id: contact.userId,
              chat_id: contact.chatId,
            });
            return (
              <Pressable
                key={contact.userId}
                accessibilityRole="button"
                onPress={() => openContact(contact)}
                style={({ pressed }) => ({
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 12,
                  paddingHorizontal: PAD_X,
                  paddingVertical: 10,
                  opacity: pressed ? 0.75 : 1,
                })}
              >
                <MessageChatAvatarSlot
                  iconUrl={avatarUrl}
                  initials={extractChatAvatarInitials(contact.title)}
                  sizePx={ROW_AVATAR_PX}
                  colors={colors}
                  scheme={colorScheme}
                />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={[typographyFixedRow30Label, { color: colors.primary }]} numberOfLines={1}>
                    {contact.title}
                  </Text>
                  <Text style={{ color: colors.secondary, fontSize: 13, lineHeight: 18 }} numberOfLines={1}>
                    {formatContactPresence(contact, locale)}
                  </Text>
                </View>
              </Pressable>
            );
          })}
        </HspScrollColumn>
      )}
    </MenuDialogShell>
  );
}

function CallsDialog({ onClose }: { onClose: () => void }) {
  const colors = useColors();
  const { t, locale } = useAppStrings();
  const { colorScheme } = useTelegram();
  const { startPrivateCall } = useProfileSheet();
  const [activeVoiceChats, setActiveVoiceChats] = useState<SideMenuActiveVoiceChat[]>([]);
  const [history, setHistory] = useState<SideMenuCallHistoryRow[]>([]);
  const [contacts, setContacts] = useState<SideMenuContact[]>([]);
  const [pickingContact, setPickingContact] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetchTelegramCallsOverview(controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setLoading(false);
      if (result.ok) {
        setActiveVoiceChats(result.activeVoiceChats);
        setHistory(result.history);
      } else {
        setError(result.error);
      }
    });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!pickingContact) return;
    const controller = new AbortController();
    void fetchTelegramContacts(controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.ok) setContacts(result.contacts);
    });
    return () => controller.abort();
  }, [pickingContact]);

  const callPeer = useCallback(
    (target: { chatId: number; title: string; peerUserId?: number | null }) => {
      startPrivateCall({
        telegram_chat_id: target.chatId,
        title: target.title,
        peer_user_id: target.peerUserId ?? null,
        chat_kind: "private",
        avatar_url: resolveTelegramUserAvatarUrl({
          user_id: target.peerUserId,
          chat_id: target.chatId,
        }),
      });
      onClose();
    },
    [onClose, startPrivateCall],
  );

  return (
    <MenuDialogShell
      visible
      title={pickingContact ? t("messages.menuDialog.startNewCall") : t("messages.sideMenu.calls")}
      onClose={onClose}
      sizeKind="picker"
      storageKey="calls"
      footer={undefined}
    >
      {loading ? (
        <View style={{ padding: 24, alignItems: "center" }}>
          <ActivityIndicator color={colors.secondary} />
        </View>
      ) : pickingContact ? (
        <HspScrollColumn
          style={{ flex: 1, minHeight: 0 }}
          contentContainerStyle={{ paddingBottom: 8 }}
          scrollbarRightInsetPx={SCROLL_INDICATOR_OVERLAY_CHROME_BORDER_INSET_PX}
          scrollIndicatorOverlaySeam={false}
          containOverscroll
        >
          {contacts.map((contact) => (
            <Pressable
              key={contact.userId}
              accessibilityRole="button"
              onPress={() =>
                callPeer({
                  chatId: contact.chatId ?? contact.userId,
                  title: contact.title,
                  peerUserId: contact.userId,
                })
              }
              style={({ pressed }) => ({
                flexDirection: "row",
                alignItems: "center",
                gap: 12,
                paddingHorizontal: PAD_X,
                paddingVertical: 10,
                opacity: pressed ? 0.75 : 1,
              })}
            >
              <MessageChatAvatarSlot
                iconUrl={resolveTelegramUserAvatarUrl({
                  user_id: contact.userId,
                  chat_id: contact.chatId,
                })}
                initials={extractChatAvatarInitials(contact.title)}
                sizePx={ROW_AVATAR_PX}
                colors={colors}
                scheme={colorScheme}
              />
              <Text style={[typographyFixedRow30Label, { color: colors.primary, flex: 1 }]} numberOfLines={1}>
                {contact.title}
              </Text>
              <SideMenuCallsIcon color={ACTION_BLUE} size={20} />
            </Pressable>
          ))}
        </HspScrollColumn>
      ) : (
        <HspScrollColumn
          style={{ flex: 1, minHeight: 0 }}
          contentContainerStyle={{ paddingBottom: 8 }}
          scrollbarRightInsetPx={SCROLL_INDICATOR_OVERLAY_CHROME_BORDER_INSET_PX}
          scrollIndicatorOverlaySeam={false}
          containOverscroll
        >
          <SectionLabel text={t("messages.menuDialog.activeVideoChats")} colors={colors} />
          {activeVoiceChats.length === 0 ? (
            <Text
              style={{
                color: colors.secondary,
                fontSize: 13,
                lineHeight: 18,
                paddingHorizontal: PAD_X,
                paddingBottom: 8,
              }}
            >
              {t("common.emDash")}
            </Text>
          ) : (
            activeVoiceChats.map((row) => {
              const kindLabel =
                row.chatKind === "channel"
                  ? t("messages.menuDialog.chatKindChannel")
                  : row.chatKind === "private"
                    ? t("messages.menuDialog.chatKindPrivate")
                    : t("messages.menuDialog.chatKindGroup");
              return (
                <Pressable
                  key={row.chatId}
                  accessibilityRole="button"
                  onPress={() => {
                    openAuthenticatedHomeChatHistory({
                      id: row.chatId,
                      telegram_chat_id: row.chatId,
                      title: row.title,
                      subtitle: "",
                      avatar_url: resolveTelegramUserAvatarUrl({ chat_id: row.chatId }),
                      last_message_at: null,
                      unread_count: 0,
                      chat_kind:
                        row.chatKind === "private" ||
                        row.chatKind === "group" ||
                        row.chatKind === "supergroup" ||
                        row.chatKind === "channel"
                          ? row.chatKind
                          : "supergroup",
                      peer_user_id: null,
                      peer_username: null,
                      chat_username: null,
                      member_count: null,
                      presence_kind: null,
                      presence_at: null,
                      is_pinned: false,
                    });
                    onClose();
                  }}
                  style={({ pressed }) => ({
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 12,
                    paddingHorizontal: PAD_X,
                    paddingVertical: 10,
                    opacity: pressed ? 0.75 : 1,
                  })}
                >
                  <MessageChatAvatarSlot
                    iconUrl={resolveTelegramUserAvatarUrl({ chat_id: row.chatId })}
                    initials={extractChatAvatarInitials(row.title)}
                    sizePx={ROW_AVATAR_PX}
                    colors={colors}
                    scheme={colorScheme}
                    activeVoiceRing
                    joinedVoiceRing={row.isJoined}
                  />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text
                      style={[typographyFixedRow30Label, { color: colors.primary }]}
                      numberOfLines={1}
                    >
                      {row.title}
                    </Text>
                    <Text
                      style={{ color: colors.secondary, fontSize: 13, lineHeight: 18 }}
                      numberOfLines={1}
                    >
                      {kindLabel}
                    </Text>
                  </View>
                </Pressable>
              );
            })
          )}

          <Pressable
            accessibilityRole="button"
            onPress={() => setPickingContact(true)}
            style={({ pressed }) => ({
              flexDirection: "row",
              alignItems: "center",
              gap: 12,
              paddingHorizontal: PAD_X,
              paddingVertical: 14,
              opacity: pressed ? 0.75 : 1,
              borderTopWidth: 1,
              borderBottomWidth: 1,
              borderColor: colors.highlight,
              marginTop: 8,
            })}
          >
            <View
              style={{
                width: ROW_AVATAR_PX,
                height: ROW_AVATAR_PX,
                borderRadius: ROW_AVATAR_PX / 2,
                backgroundColor: colors.undercover,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <SideMenuCallsIcon color={ACTION_BLUE} size={20} />
            </View>
            <Text style={[typographyFixedRow30Label, { color: ACTION_BLUE, flex: 1 }]}>
              {t("messages.menuDialog.startNewCall")}
            </Text>
          </Pressable>

          {history.map((row) => {
            const timeLabel = formatMessageChatListTime(row.at, locale);
            const detail = [
              row.isMissed ? t("messages.menuDialog.callMissed") : row.isOutgoing
                ? t("messages.menuDialog.callOutgoing")
                : t("messages.menuDialog.callIncoming"),
              row.callCount > 1 ? `(${row.callCount})` : null,
              timeLabel || null,
            ]
              .filter(Boolean)
              .join(" · ");
            return (
              <View
                key={`${row.chatId}-${row.at ?? ""}-${row.isOutgoing ? "out" : "in"}`}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 12,
                  paddingHorizontal: PAD_X,
                  paddingVertical: 10,
                }}
              >
                <MessageChatAvatarSlot
                  iconUrl={resolveTelegramUserAvatarUrl({
                    user_id: row.peerUserId,
                    chat_id: row.chatId,
                  })}
                  initials={extractChatAvatarInitials(row.title)}
                  sizePx={ROW_AVATAR_PX}
                  colors={colors}
                  scheme={colorScheme}
                />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={[typographyFixedRow30Label, { color: colors.primary }]} numberOfLines={1}>
                    {row.title}
                  </Text>
                  <Text style={{ color: colors.secondary, fontSize: 13, lineHeight: 18 }} numberOfLines={1}>
                    {detail}
                  </Text>
                </View>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t("messages.menuDialog.startNewCall")}
                  hitSlop={8}
                  onPress={() =>
                    callPeer({
                      chatId: row.chatId,
                      title: row.title,
                      peerUserId: row.peerUserId,
                    })
                  }
                  style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1, padding: 4 })}
                >
                  <SideMenuCallsIcon color={ACTION_BLUE} size={20} />
                </Pressable>
              </View>
            );
          })}
          {error ? (
            <Text style={{ color: "#FF6B6B", paddingHorizontal: PAD_X, fontSize: 13 }}>{error}</Text>
          ) : null}
        </HspScrollColumn>
      )}
    </MenuDialogShell>
  );
}

type SettingsItem =
  | { type: "row"; key: AppStringKey; trailing?: string; toggleOff?: boolean }
  | { type: "sep" };

const SETTINGS_ITEMS: SettingsItem[] = [
  { type: "row", key: "messages.menuDialog.settings.myAccount" },
  { type: "row", key: "messages.menuDialog.settings.notificationsAndSounds" },
  { type: "row", key: "messages.menuDialog.settings.privacyAndSecurity" },
  { type: "row", key: "messages.menuDialog.settings.chatSettings" },
  { type: "row", key: "messages.menuDialog.settings.folders" },
  { type: "row", key: "messages.menuDialog.settings.advanced" },
  { type: "row", key: "messages.menuDialog.settings.speakersAndCamera" },
  { type: "row", key: "messages.menuDialog.settings.batteryAndAnimations" },
  { type: "row", key: "messages.menuDialog.settings.language", trailing: "English" },
  {
    type: "row",
    key: "messages.menuDialog.settings.defaultInterfaceScale",
    trailing: "125%",
    toggleOff: true,
  },
  { type: "sep" },
  { type: "row", key: "messages.menuDialog.settings.telegramPremium" },
  { type: "row", key: "messages.menuDialog.settings.myStars" },
  { type: "row", key: "messages.menuDialog.settings.telegramBusiness" },
  { type: "row", key: "messages.menuDialog.settings.sendAGift" },
  { type: "sep" },
  { type: "row", key: "messages.menuDialog.settings.telegramFaq" },
  { type: "row", key: "messages.menuDialog.settings.telegramFeatures" },
  { type: "row", key: "messages.menuDialog.settings.askAQuestion" },
];

function SettingsDialog({
  onClose,
  settingsProfile,
}: {
  onClose: () => void;
  settingsProfile?: SettingsProfile | null;
}) {
  const colors = useColors();
  const { t } = useAppStrings();
  const { colorScheme } = useTelegram();
  const title = settingsProfile?.title?.trim() || t("messages.sideMenu.myProfile");
  const initials = settingsProfile?.initials
    ? Array.from(settingsProfile.initials).slice(0, 2)
    : extractChatAvatarInitials(title);

  return (
    <MenuDialogShell
      visible
      title={t("settings.sheetTitle")}
      onClose={onClose}
      sizeKind="picker"
      storageKey="settings"
      footer={undefined}
    >
      <HspScrollColumn
        style={{ flex: 1, minHeight: 0 }}
        contentContainerStyle={{ paddingBottom: 8 }}
        scrollbarRightInsetPx={SCROLL_INDICATOR_OVERLAY_CHROME_BORDER_INSET_PX}
        scrollIndicatorOverlaySeam={false}
        containOverscroll
      >
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 14,
            paddingHorizontal: PAD_X,
            paddingTop: 16,
            paddingBottom: 16,
          }}
        >
          <MessageChatAvatarSlot
            iconUrl={settingsProfile?.avatarUrl ?? null}
            initials={initials}
            sizePx={54}
            colors={colors}
            scheme={colorScheme}
          />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text
              style={[typographySansSemibold, { color: colors.primary, fontSize: 16, lineHeight: 22 }]}
              numberOfLines={1}
            >
              {title}
            </Text>
            {settingsProfile?.phone ? (
              <Text style={{ color: colors.secondary, fontSize: 13, lineHeight: 18 }} numberOfLines={1}>
                {settingsProfile.phone}
              </Text>
            ) : null}
            {settingsProfile?.usernameAt ? (
              <Text style={{ color: colors.secondary, fontSize: 13, lineHeight: 18 }} numberOfLines={1}>
                {settingsProfile.usernameAt}
              </Text>
            ) : null}
          </View>
        </View>

        <View style={{ height: 1, backgroundColor: colors.highlight, alignSelf: "stretch" }} />

        {SETTINGS_ITEMS.map((item, index) => {
          if (item.type === "sep") {
            return (
              <View
                key={`sep-${index}`}
                style={{
                  height: 1,
                  backgroundColor: colors.highlight,
                  marginVertical: 6,
                  alignSelf: "stretch",
                }}
              />
            );
          }
          return (
            <View
              key={item.key}
              accessibilityState={{ disabled: true }}
              style={{
                flexDirection: "row",
                alignItems: "center",
                minHeight: 44,
                paddingHorizontal: PAD_X,
                gap: 12,
                opacity: 0.92,
              }}
            >
              <Text
                style={[typographyFixedRow30Label, { color: colors.primary, flex: 1, minWidth: 0 }]}
                numberOfLines={1}
              >
                {t(item.key)}
              </Text>
              {item.toggleOff ? (
                <View
                  style={{
                    width: 36,
                    height: 20,
                    borderRadius: 10,
                    backgroundColor: colors.undercover,
                    borderWidth: 1,
                    borderColor: colors.highlight,
                    justifyContent: "center",
                    paddingHorizontal: 2,
                  }}
                >
                  <View
                    style={{
                      width: 14,
                      height: 14,
                      borderRadius: 7,
                      backgroundColor: colors.secondary,
                    }}
                  />
                </View>
              ) : null}
              {item.trailing ? (
                <Text style={{ color: colors.secondary, fontSize: 14, lineHeight: 18 }}>
                  {item.trailing}
                </Text>
              ) : null}
            </View>
          );
        })}
      </HspScrollColumn>
    </MenuDialogShell>
  );
}

export function MessagesMenuDialogs(props: {
  kind: MessagesMenuDialogKind;
  onClose: () => void;
  settingsProfile?: SettingsProfile | null;
}): JSX.Element | null {
  const { kind, onClose, settingsProfile } = props;
  if (kind == null) return null;
  if (kind === "newGroup") return <NewGroupDialog onClose={onClose} />;
  if (kind === "newChannel") return <NewChannelDialog onClose={onClose} />;
  if (kind === "contacts") return <ContactsDialog onClose={onClose} />;
  if (kind === "calls") return <CallsDialog onClose={onClose} />;
  if (kind === "settings") {
    return <SettingsDialog onClose={onClose} settingsProfile={settingsProfile} />;
  }
  return null;
}
