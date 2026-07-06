/**
 * Central UI copy: English and Russian in one module.
 * Keys: `feature.area.name`. Use {@link getAppString} / {@link formatAppString} / `useAppStrings().t`.
 */

export type AppLocale = "en" | "ru";

export const APP_LOCALES: readonly AppLocale[] = ["en", "ru"] as const;

export const APP_LOCALE_DEFAULT: AppLocale = "en";

const en = {
  "ai.noPrompt": "No prompt",
  "ai.promptPrefix": "Prompt:",
  "ai.title": "AI",
  "ai.thinking": "Thinking…",
  "ai.errorGeneric": "Something went wrong. Try again.",
  "ai.you": "You",
  "ai.assistant": "Assistant",
  "ai.search.emptyTitle": "Make things done",
  "ai.search.emptyIntro": "AI and search will help you in everything you do in the program.",
  "ai.search.emptyList":
    "1. Analise messages and social messages\n2. Conduct smart decisions while trading or swaping\n3.Delegate actions to the program",
  "ai.search.emptyTryPrompts": "Try this prompts:",

  "common.back": "Back",
  "common.debug": "Debug",
  "common.emDash": "—",
  "common.loading": "Loading…",

  "settings.sheetTitle": "Settings",

  "debug.api": "api:",
  "debug.fetchMs": "fetchMs:",
  "debug.hasWebAppLine": "hasWebAppApi: {{has}} · inTelegram: {{in}}",
  "debug.initData": "initData:",
  "debug.initDataPoll": "initDataPoll:",
  "debug.initDataPollNoteError":
    "initDataPoll only runs when Telegram launch or real WebApp platform is detected; otherwise we stop (no infinite polling outside Telegram).",
  "debug.initDataPollNoteLoading":
    "initDataPoll only runs when a Telegram launch or real WebApp platform is detected; otherwise we stop (no infinite poll outside Telegram).",
  "debug.lastLog": "lastLog:",
  "debug.url": "url:",
  "debug.webAppInitLine": "webAppApiPoll: {{web}} · initDataPoll: {{init}}",
  "debug.webAppPollLine": "webAppApiPoll: {{count}}",

  "feed.empty": "No feed items yet.",
  "feed.manualWelcomeTranslation": "Translate welcome feed with UI language",
  "feed.manualWelcomeTranslationA11y": "When on, welcome feed messages follow the interface language toggle",
  "feed.offlinePreview": "(offline preview)",
  "feed.placeholder.creatorSubtitle": "Press to access creators page",
  "feed.placeholder.creatorTitle": "You are likely a creator",
  "feed.placeholder.nftSubtitle": "$24",
  "feed.placeholder.nftTitle": "NFT recieved",
  "feed.placeholder.nftTrailing": "NFT recieved",
  "feed.placeholder.taskSubtitle": "$24",
  "feed.placeholder.taskTitle": "Incoming task",
  "feed.placeholder.tokenSubtitle": "$1",
  "feed.placeholder.tokenTitle": "Token granted",
  "feed.placeholder.tokenTrailing": "+1 DLLR",
  "feed.placeholder.walletSubtitle": "Press to save 24 words",
  "feed.placeholder.walletTitle": "Wallet created",
  "feed.timePending": "--:--",

  "floating.shield.label": "Shield",

  "global.bottomBar.placeholderNative": "AI & Search",
  "global.bottomBar.placeholderWeb": "AI and search",
  "global.bottomBar.premade1": "What tokens people are talking about now?",
  "global.bottomBar.premade2": "What famous artist has recently launched digital goods?",
  "global.bottomBar.premade3": "Buy eth for my 10 ton at the current rate",

  "home.mainColumnFooter.telegramMessages": "Connect Telegram",
  "home.mainColumnFooter.telegramMessagesDisconnect": "Disconnect Telegram",

  "messages.connectConfirm": "Connect",
  "messages.connectError": "Could not connect Telegram messages.",
  "messages.connectErrorGatewayLocal":
    "TDLib gateway is not running on your machine. In a separate terminal run: npm run tdlib:gateway (with TELEGRAM_API_ID and TELEGRAM_API_HASH in .env). Use npm run web so the API is localhost, not hsbexpo.vercel.app.",
  "messages.connectErrorGatewayUrlMissing":
    "TDLIB_GATEWAY_URL is not reaching the Vercel API (server tried 127.0.0.1). Add or link the shared variable TDLIB_GATEWAY_URL to hsbexpo for Production, set it to your tunnel URL (https://….trycloudflare.com), then redeploy.",
  "messages.connectErrorGatewayProduction":
    "Vercel cannot reach your TDLib gateway. Keep npm run tdlib:gateway and the tunnel running; update TDLIB_GATEWAY_URL if the tunnel URL changed, then redeploy.",
  "messages.connectErrorNotConfigured":
    "Telegram API credentials or TDLib gateway are not configured on the server.",
  "messages.connectErrorTelegramNetwork":
    "TDLib cannot reach Telegram servers from your gateway (stuck connecting). Turn off VPN or use a network where Telegram works, restart npm run tdlib:gateway, then try again.",
  "messages.connectErrorPasswordRejected":
    "Incorrect cloud password. Use the password from Telegram → Settings → Privacy → Two-Step Verification, then try again.",
  "messages.connectErrorPasswordRequest":
    "Could not send your password to the server. Close the sheet, open Connect again, and retry.",
  "messages.connectErrorNetwork":
    "Network error while submitting your password. Check your connection and try again.",
  "messages.connectErrorGatewayTimeout":
    "Telegram login took too long to start. Tap Try again — the QR code should appear within a few seconds.",
  "messages.connectErrorSessionExpired":
    "Login session expired or conflicted with another attempt. Tap Try again to scan a fresh QR code.",
  "messages.connectPrompt": "Connect Telegram to see your chats here.",
  "messages.connectRetry": "Try again",
  "messages.connectSheetBody":
    "You can connect Telegram from any device and access the account with the connected Telegram on any device. QR code connection is now the most reliable.",
  "messages.connectSheetMethodsTitle": "Connection methods",
  "messages.connectSheetOneTouchConnect": "1 Touch Connect",
  "messages.connectSheetPassToTelegramApp": "Pass to Telegram App",
  "messages.connectSheetEnterNumber": "Enter number",
  "messages.connectSheetLoading": "Preparing QR code…",
  "messages.connectSheetLoadingPhone": "Preparing phone login…",
  "messages.connectSheetScanQr": "Scan QR",
  "messages.connectSheetOrPhone": "Or enter the phone number",
  "messages.connectSheetPhoneTitle": "Enter your phone number",
  "messages.connectSheetPhoneMobileHint":
    "Phone login on a cloud server often cannot deliver SMS. Prefer scanning the QR code (Settings → Devices → Link Desktop Device).",
  "messages.connectSheetPhoneCloudWarning":
    "Phone codes from cloud servers usually arrive only in the official Telegram chat on another device — not by SMS. QR scan is more reliable.",
  "messages.connectSheetUseQrInstead": "Use QR code instead",
  "messages.connectSheetOpenInTelegram": "Open in Telegram",
  "messages.connectSheetPhoneBody":
    "Enter your phone number in international format (e.g. +1 234 567 8900). Telegram will send a login code to your Telegram app or SMS.",
  "messages.connectSheetPhonePlaceholder": "Phone number",
  "messages.connectSheetPhoneSubmit": "Send code",
  "messages.connectSheetCodeTitle": "Enter login code",
  "messages.connectSheetCodeBody":
    "Check SMS on your phone or a Telegram message from Telegram with your login code, then enter it below.",
  "messages.connectSheetCodeBodyDesktop":
    "Login runs on a cloud server, not in this browser. Telegram usually sends the code by SMS to your phone — check text messages first. You may also see it in the Telegram app under Settings → Devices. Do not resubmit your phone number (that cancels the code).",
  "messages.connectSheetCodeSentTelegram":
    "Telegram accepted {phone}. The code is sent only inside the Telegram app (not SMS) — open the official Telegram chat (verified account, often 42777) on a device already logged into that number, or Settings → Devices → active login attempt.",
  "messages.connectSheetCodeSentSms": "Telegram sent a login code by SMS to {phone}.",
  "messages.connectSheetCodeSentCall": "Telegram is sending a login code by phone call to {phone}.",
  "messages.connectSheetCodeSentGeneric":
    "Telegram accepted {phone}. Check SMS or the Telegram app (official Telegram chat / Settings → Devices).",
  "messages.connectSheetCodePhoneUnknown": "your number",
  "messages.connectSheetCodeResend": "Resend code",
  "messages.connectSheetCodePlaceholder": "Login code",
  "messages.connectSheetCodeSubmit": "Continue",
  "messages.connectErrorGatewayPhoneEndpoint":
    "Phone login is unavailable on the TDLib gateway. Restart it: stop npm run tdlib:gateway, then start it again.",
  "messages.connectErrorInvalidPhone": "Enter a valid phone number with country code (e.g. +1234567890).",
  "messages.connectErrorCodeRejected": "Incorrect login code. Check Telegram and try again.",
  "messages.connectSheetPasswordTitle": "Two-step verification password",
  "messages.connectSheetPasswordBody":
    "QR scan succeeded. Telegram does not send a second code for two-step verification — enter the cloud password you set under Settings → Privacy → Two-Step Verification, then tap Continue.",
  "messages.connectSheetPasswordPlaceholder": "Password",
  "messages.connectSheetPasswordSubmit": "Continue",
  "messages.connectSheetQrAlt": "Telegram login QR code",
  "messages.connectSheetQrBody":
    "Open Telegram on your phone → Settings → Devices → Link Desktop Device → scan this QR code.",
  "messages.connectSheetTitle": "Connect Telegram messages",
  "messages.empty": "No chats yet.",
  "messages.moreChats": "More chats",
  "messages.loadError": "Could not load chats.",
  "messages.historyLoadError": "Could not load messages.",
  "messages.chatPresence.online": "online",
  "messages.chatPresence.recently": "last seen recently",
  "messages.chatPresence.lastWeek": "last seen within a week",
  "messages.chatPresence.lastMonth": "last seen within a month",
  "messages.chatPresence.lastSeen": "last seen at {{time}}",
  "messages.chatPresence.unknown": "last seen recently",
  "messages.chatMemberCount": "{{count}} participants",
  "messages.chatAction.typing": "typing…",
  "messages.chatAction.typingNamed": "{{name}} writing…",
  "messages.chatAction.recordingVoice": "recording voice message…",
  "messages.chatAction.recordingVoiceNamed": "{{name}} is recording voice message…",
  "messages.chatAction.recordingVideo": "recording video message…",
  "messages.chatAction.recordingVideoNamed": "{{name}} is recording video message…",
  "messages.chatAction.uploadingPhoto": "sending photo…",
  "messages.chatAction.uploadingPhotoNamed": "{{name}} is sending photo…",
  "messages.chatAction.uploadingVideo": "sending video…",
  "messages.chatAction.uploadingVideoNamed": "{{name}} is sending video…",
  "messages.chatAction.uploadingFile": "sending file…",
  "messages.chatAction.uploadingFileNamed": "{{name}} is sending file…",
  "messages.chatWrite.placeholder": "Write",
  "messages.chatWrite.send": "Write",
  "messages.publicGroupsBan.body":
    "Unfortunately, you are banned from participating in public groups.",
  "messages.publicGroupsBan.learnMore": "Learn more »",
  "messages.publicGroupsBan.ok": "OK",
  "messages.action.reply": "Reply",
  "messages.action.edit": "Edit",
  "messages.compose.replyTo": "Reply to {{name}}",
  "messages.compose.editing": "Edit message",
  "messages.chatEmpty": "No messages yet.",
  "messages.channelBadge": "Channel",
  "messages.call.outgoing": "Outgoing Call",
  "messages.call.incoming": "Incoming Call",

  "swap.footer.insufficientAmount": "Insufficient amount",
  "swap.action.summary": "Buy 1 ton",
  "swap.action.summaryWithAmount": "Buy 1 ton for {{amount}} dllr",
  "swap.action.button": "Swap",
  "swap.chooseCurrency.title": "Choose currency",
  "swap.chooseCurrency.filterA11y": "Filter currencies",
  "swap.chooseCurrency.col.rank": "#",
  "swap.chooseCurrency.col.currency": "Currency",
  "swap.chooseCurrency.col.balance": "Balance",
  "swap.chooseCurrency.col.rate": "Rate",
  "swap.chooseCurrency.col.networks": "Networks",
  "swap.chooseCurrency.col.marketCap": "Market Cap",
  "swap.chooseCurrency.col.volume": "Volume",
  "swap.chooseCurrency.col.lastYear": "Last Year",
  "swap.chooseCurrency.loading": "Loading tokens…",
  "swap.chooseCurrency.loadingMore": "{count} tokens loaded",

  "send.footer.submit": "N / A",
  "send.action.summary": "Send 1 dollar",
  "send.action.summaryWithAddress": "Send 1 dollar to {{address}}",
  "send.action.button": "Send",

  "global.logoBar.about": "About",
  "global.logoBar.aboutHint": "Opens the Hyperlinks Space Program landing page in the browser",
  "global.logoBar.wordmarkA11y": "Hyperlinks Space",

  "home.dev.outsideTelegram": "Outside Telegram, authentication abandoned.",
  "home.dev.productTitle": "Hyperlinks Space Program",

  "home.errors.telegramRegistrationFailed": "Telegram registration failed",

  "home.header.iconCopy": "Copy wallet address",
  "home.header.iconEdit": "Edit",
  "home.header.iconExit": "Exit",
  "home.header.iconKey": "Key",
  "home.header.iconLanguage": "Language",
  "home.header.languageIconSwitchToEn": "Switch interface to English",
  "home.header.languageIconSwitchToRu": "Switch interface to Russian",
  "home.header.balanceA11y": "Balance",
  "home.header.copyWalletHint": "Copies the full wallet address",
  "home.header.walletAddressA11y": "Wallet address {{snippet}}",

  "home.menu.smart": "Smart",
  "home.menu.get": "Get",
  "home.menu.send": "Send",
  "home.menu.swap": "Swap",
  "home.menu.trade": "Trade",

  "smart.deployTitle": "Create smart in 1 min",
  "smart.intro":
    "Blockchain secure deals provide for the real protection of its terms. Counterparties now really have no chance to break the agreement.",
  "smart.purposeSubtitle": "Smart Contract Purpose",
  "smart.purpose.company": "Company",
  "smart.purpose.agreement": "Agreement",
  "smart.purpose.investment": "Investment",
  "smart.purpose.revenue": "Revenue",
  "smart.purpose.partners": "Partners",
  "smart.purposeDescLead.company": "Company Smart Contract",
  "smart.purposeDescBody.company":
    " provides for launching a company secured by blockchain without signing any paper. The contract stipulates the counterparties, their shares and secures the distribution of the incoming amount accordingly to this shares.",
  "smart.purposeDescLead.agreement": "Agreement Smart Contract",
  "smart.purposeDescBody.agreement":
    " records mutual obligations between parties on-chain so every term is enforceable without paper. It defines deliverables, deadlines, and penalties when either side fails to perform.",
  "smart.purposeDescLead.investment": "Investment Smart Contract",
  "smart.purposeDescBody.investment":
    " channels capital into a project with transparent milestones and automatic release of funds as conditions are met. Investors see exactly how proceeds are allocated and when payouts occur.",
  "smart.purposeDescLead.revenue": "Revenue Smart Contract",
  "smart.purposeDescBody.revenue":
    " splits incoming payments among stakeholders according to pre-set rules. Each sale or royalty event is accounted for on-chain so shares are distributed without manual reconciliation.",
  "smart.purposeDescLead.partners": "Partners Smart Contract",
  "smart.purposeDescBody.partners":
    " formalizes a joint venture with shared roles, contributions, and profit splits on blockchain. Partner exits, buyouts, and dispute resolution follow the same immutable rules for everyone.",
  "smart.standardSubtitle": "Standart",
  "smart.standardHelp.a11y": "About this standard",
  "smart.dealVersion.company": "Company Smart Deal v.1",
  "smart.dealVersion.agreement": "Agreement Smart Deal v.1",
  "smart.dealVersion.investment": "Investment Smart Deal v.1",
  "smart.dealVersion.revenue": "Revenue Smart Deal v.1",
  "smart.dealVersion.partners": "Partners Smart Deal v.1",
  "smart.company.titleLabel": "Title*",
  "smart.company.titleDefault": "Company Smart Deal v.1 №123",
  "smart.agreement.titleDefault": "Agreement Smart Deal v.1 №123",
  "smart.investment.titleDefault": "Investment Smart Deal v.1 №123",
  "smart.revenue.titleDefault": "Revenue Smart Deal v.1 №123",
  "smart.partners.titleDefault": "Partners Smart Deal v.1 №123",
  "smart.company.textLabel": "Text",
  "smart.company.textPlaceholder":
    "e.g. Hyperlinks.Space: The core for a multi-planetary future\nHerewith we agree to create a company on the following terms...",
  "smart.company.logoLabel": "Image",
  "smart.company.addImageButton": "Add image",
  "smart.company.foundersTitle": "Founders",
  "smart.company.foundersSubtitle": "Stipulate people participating in the deal",
  "smart.company.foundersCountLabel": "Number of founders",
  "smart.company.founderOrdinal": "{{n}}{{suffix}} founder",
  "smart.company.founderNameLabel": "NAME OR NICKNAME",
  "smart.company.founderWalletLabel": "WALLET*",
  "smart.company.founderShareLabel": "% SHARE*",
  "smart.company.founderWalletPlaceholder": "e.g. UQDFuzKogL4d5VYZxkFGeIcCwTprgzJWZ5PsqCmRJ9F1iUv3",
  "smart.footer.deployCost": "Deploy the Smart for 10 TON",
  "smart.footer.deployCostShort": "10 TON",
  "smart.footer.deployButton": "Deploy Smart",

  "home.nav.coins": "Coins",
  "home.nav.feed": "Feed",
  "home.nav.items": "Items",
  "home.nav.messages": "Messages",
  "home.nav.tasks": "Tasks",

  "home.wallet.backupKmsNote":
    "Wallet backup is stored encrypted on the server (wrapped key in Google Cloud KMS).",
  "home.wallet.errorMissingInitData": "Missing Telegram initData.",
  "home.wallet.errorRegistrationFailed": "Wallet registration failed",
  "home.wallet.errorRegistrationPollTimeout":
    "Wallet registration: could not reach the app or the server in time. Try again, or open the app once more (your wallet may already be saved).",
  "home.wallet.errorRegistrationRequestFailed": "Wallet registration request failed",
  "home.wallet.errorRegistrationRequestTimedOut": "Wallet registration request timed out",
  "home.wallet.errorServerBusy":
    "Wallet server timed out (busy or cold). Tap Retry, or try again in a few seconds.",
  "home.wallet.errorSetupBudget":
    "Wallet setup is taking too long. Check your connection, update Telegram, or try again.",
  "home.wallet.errorWalletKeyGenerationSlow":
    "Wallet key generation is taking too long. Update Telegram, try a different client, or tap Retry.",
  "home.wallet.finishingServer":
    "Finishing on the server (saving the row). You can wait or close the app; your address is already shown.",
  "home.wallet.generatingKeys": "Generating your wallet keys…",
  "home.wallet.loggedInAs": "You are logged in via Telegram as @{{username}}.",
  "home.wallet.retryServerRegistration": "Retry server registration",
  "home.wallet.retryWalletCreation": "Retry wallet creation",

  "key.header.goHomeA11y": "Go to home",

  "ota.later": "Later",
  "ota.message": "A new version has been downloaded. Restart now to apply it?",
  "ota.restart": "Restart",
  "ota.title": "Update ready",

  "welcome.auth.emailInvalid": "Invalid email",
  "welcome.auth.emailPlaceholder": "Your email address",
  "welcome.auth.emailCodePlaceholder": "6-digit code",
  "welcome.auth.emailCodeInvalid": "Enter the 6-digit code from your email",
  "welcome.auth.emailCodeTitle": "Check your email",
  "welcome.auth.emailCodeHint": "We sent a sign-in code to {{email}}",
  "welcome.auth.emailStartError": "Could not send a sign-in code. Try again.",
  "welcome.auth.emailVerifyError": "Sign-in code did not work. Try again.",
  "welcome.auth.emailBrowserAlertTitle": "Sign in with email",
  "welcome.auth.emailUseDifferent": "Use a different email",
  "welcome.auth.signInApple": "Sign in with Apple",
  "welcome.auth.signInButton": "Sign in",
  "welcome.auth.signInEmailTitle": "Sign in with email",
  "welcome.auth.signInGithub": "Sign in with GitHub",
  "welcome.auth.signInGoogle": "Sign in with Google",
  "welcome.auth.signInTelegram": "Sign in with Telegram",
  "welcome.auth.googleStartError": "Could not start Google sign-in. Try again.",
  "welcome.auth.googleCallbackError": "Google sign-in failed ({{reason}}). Try again.",
  "welcome.auth.googleBrowserAlertTitle": "Sign in with Google",
  "welcome.auth.githubStartError": "Could not start GitHub sign-in. Try again.",
  "welcome.auth.githubCallbackError": "GitHub sign-in failed ({{reason}}). Try again.",
  "welcome.auth.githubAccessDenied": "GitHub sign-in was cancelled.",
  "welcome.auth.githubBrowserAlertTitle": "Sign in with GitHub",
  "welcome.auth.appleStartError": "Could not start Apple sign-in. Try again.",
  "welcome.auth.appleCallbackError": "Apple sign-in failed ({{reason}}). Try again.",
  "welcome.auth.appleBrowserAlertTitle": "Sign in with Apple",
  "welcome.auth.appleAccessDenied": "Apple sign-in was cancelled.",
  "welcome.auth.telegramBrowserAlertMessage":
    "Open this page inside the Telegram app to continue, or use a normal web browser (not an in-app preview that mimics Telegram).",
  "welcome.auth.telegramBrowserAlertTitle": "Sign in with Telegram",
  "welcome.auth.telegramStartError": "Could not start Telegram sign-in. Try again.",
  "welcome.auth.telegramCallbackError": "Telegram sign-in failed ({{reason}}). Try again.",

  "welcome.subtitle": "This is the best way to earn and spend",
  "welcome.title": "Welcome to our program",
} as const;

const ru = {
  "ai.noPrompt": "Нет запроса",
  "ai.promptPrefix": "Запрос:",
  "ai.title": "ИИ",
  "ai.thinking": "Думаю…",
  "ai.errorGeneric": "Что-то пошло не так. Попробуйте снова.",
  "ai.you": "Вы",
  "ai.assistant": "Ассистент",
  "ai.search.emptyTitle": "Сделай умнее",
  "ai.search.emptyIntro": "ИИ и поиск охватывают весь функционал программы и станут вашими верными спутниками во всех делах.",
  "ai.search.emptyList":
    "1. Анализируй сообщения и посты в соцсетях\n2. Принимай умные решения при торговле и обмене\n3. Автоматизируй действия в программе",
  "ai.search.emptyTryPrompts": "Попробуй эти промпты:",

  "common.back": "Назад",
  "common.debug": "Отладка",
  "common.emDash": "—",
  "common.loading": "Загрузка…",

  "settings.sheetTitle": "Настройки",

  "debug.api": "api:",
  "debug.fetchMs": "fetchMs:",
  "debug.hasWebAppLine": "hasWebAppApi: {{has}} · inTelegram: {{in}}",
  "debug.initData": "initData:",
  "debug.initDataPoll": "initDataPoll:",
  "debug.initDataPollNoteError":
    "initDataPoll запускается только при запуске из Telegram или реальной платформе WebApp; иначе опрос останавливается (бесконечного опроса вне Telegram нет).",
  "debug.initDataPollNoteLoading":
    "initDataPoll запускается только при запуске из Telegram или реальной платформе WebApp; иначе опрос останавливается (бесконечного опроса вне Telegram нет).",
  "debug.lastLog": "lastLog:",
  "debug.url": "url:",
  "debug.webAppInitLine": "webAppApiPoll: {{web}} · initDataPoll: {{init}}",
  "debug.webAppPollLine": "webAppApiPoll: {{count}}",

  "feed.empty": "Пока нет записей в ленте.",
  "feed.manualWelcomeTranslation": "Переводить приветственную ленту по языку интерфейса",
  "feed.manualWelcomeTranslationA11y":
    "Если включено, приветственные сообщения в ленте следуют выбранному языку интерфейса",
  "feed.offlinePreview": "(просмотр без сети)",
  "feed.placeholder.creatorSubtitle": "Нажмите, чтобы открыть страницу для авторов",
  "feed.placeholder.creatorTitle": "Вероятно, вы автор",
  "feed.placeholder.nftSubtitle": "$24",
  "feed.placeholder.nftTitle": "NFT получен",
  "feed.placeholder.nftTrailing": "NFT получен",
  "feed.placeholder.taskSubtitle": "$24",
  "feed.placeholder.taskTitle": "Входящее задание",
  "feed.placeholder.tokenSubtitle": "$1",
  "feed.placeholder.tokenTitle": "Выдан токен",
  "feed.placeholder.tokenTrailing": "+1 DLLR",
  "feed.placeholder.walletSubtitle": "Нажмите, чтобы сохранить 24 слова",
  "feed.placeholder.walletTitle": "Кошелёк создан",
  "feed.timePending": "--:--",

  "floating.shield.label": "Щит",

  "global.bottomBar.placeholderNative": "ИИ и поиск",
  "global.bottomBar.placeholderWeb": "ИИ и поиск",
  "global.bottomBar.premade1": "О каких токенах сейчас говорят люди?",
  "global.bottomBar.premade2": "Какой известный артист недавно выпустил цифровые товары?",
  "global.bottomBar.premade3": "Купи eth на мои 10 ton по текущему курсу",

  "home.mainColumnFooter.telegramMessages": "Подключить Telegram",
  "home.mainColumnFooter.telegramMessagesDisconnect": "Отключить Telegram",

  "messages.connectConfirm": "Подключить",
  "messages.connectError": "Не удалось подключить сообщения Telegram.",
  "messages.connectErrorGatewayLocal":
    "TDLib gateway не запущен на вашем компьютере. В отдельном терминале: npm run tdlib:gateway (нужны TELEGRAM_API_ID и TELEGRAM_API_HASH в .env). API должен быть локальным — npm run web, не задеплоенный сайт.",
  "messages.connectErrorGatewayUrlMissing":
    "TDLIB_GATEWAY_URL не доходит до API на Vercel (сервер пробовал 127.0.0.1). Добавьте или привяжите shared variable TDLIB_GATEWAY_URL к hsbexpo для Production, укажите URL туннеля (https://….trycloudflare.com), затем redeploy.",
  "messages.connectErrorGatewayProduction":
    "Vercel не может достучаться до TDLib gateway. Держите npm run tdlib:gateway и туннель запущенными; обновите TDLIB_GATEWAY_URL при смене URL туннеля и redeploy.",
  "messages.connectErrorNotConfigured":
    "На сервере не настроены Telegram API или TDLib gateway.",
  "messages.connectErrorTelegramNetwork":
    "TDLib не может достучаться до серверов Telegram с вашего gateway (зависает на подключении). Отключите VPN или используйте сеть, где Telegram доступен, перезапустите npm run tdlib:gateway и попробуйте снова.",
  "messages.connectErrorPasswordRejected":
    "Неверный облачный пароль. Введите пароль из Telegram → Настройки → Конфиденциальность → Двухэтапная аутентификация и попробуйте снова.",
  "messages.connectErrorPasswordRequest":
    "Не удалось отправить пароль на сервер. Закройте окно, снова нажмите «Подключить Telegram» и повторите.",
  "messages.connectErrorNetwork":
    "Ошибка сети при отправке пароля. Проверьте подключение и попробуйте снова.",
  "messages.connectErrorGatewayTimeout":
    "Запуск входа в Telegram занял слишком много времени. Нажмите «Повторить» — QR-код должен появиться через несколько секунд.",
  "messages.connectErrorSessionExpired":
    "Сессия входа истекла или конфликтует с другой попыткой. Нажмите «Повторить», чтобы отсканировать новый QR-код.",
  "messages.connectPrompt": "Подключите Telegram, чтобы видеть чаты здесь.",
  "messages.connectRetry": "Повторить",
  "messages.connectSheetBody":
    "Подключить Telegram можно с любого устройства — после привязки аккаунт с подключённым Telegram доступен на любом устройстве. Сейчас самый надёжный способ — вход по QR-коду.",
  "messages.connectSheetMethodsTitle": "Способы подключения",
  "messages.connectSheetOneTouchConnect": "Подключение в один клик",
  "messages.connectSheetPassToTelegramApp": "Передать в приложение Telegram",
  "messages.connectSheetEnterNumber": "Ввести номер",
  "messages.connectSheetLoading": "Готовим QR-код…",
  "messages.connectSheetLoadingPhone": "Готовим вход по номеру…",
  "messages.connectSheetScanQr": "Сканировать QR",
  "messages.connectSheetOrPhone": "Или введите номер телефона",
  "messages.connectSheetPhoneTitle": "Введите номер телефона",
  "messages.connectSheetPhoneMobileHint":
    "При облачном сервере SMS часто не приходит. Надёжнее — QR: Настройки → Устройства → Подключить устройство.",
  "messages.connectSheetPhoneCloudWarning":
    "Код с облачного сервера обычно приходит только в официальный чат Telegram на другом устройстве, не по SMS. QR надёжнее.",
  "messages.connectSheetUseQrInstead": "Войти по QR-коду",
  "messages.connectSheetOpenInTelegram": "Открыть в Telegram",
  "messages.connectSheetPhoneBody":
    "Введите номер в международном формате (например, +7 900 123 45 67). Код придёт в Telegram или по SMS.",
  "messages.connectSheetPhonePlaceholder": "Номер телефона",
  "messages.connectSheetPhoneSubmit": "Отправить код",
  "messages.connectSheetCodeTitle": "Код входа",
  "messages.connectSheetCodeBody":
    "Проверьте SMS на телефоне или сообщение от Telegram с кодом входа и введите его ниже.",
  "messages.connectSheetCodeBodyDesktop":
    "Вход идёт через облачный сервер, а не в этом браузере. Обычно код приходит по SMS на телефон — сначала проверьте SMS. Также код может появиться в Telegram: Настройки → Устройства. Не отправляйте номер повторно — это отменяет код.",
  "messages.connectSheetCodeSentTelegram":
    "Telegram принял номер {phone}. Код приходит только в приложении Telegram (не SMS) — откройте официальный чат Telegram (верифицированный аккаунт, часто 42777) на устройстве с этим номером или Настройки → Устройства → активная попытка входа.",
  "messages.connectSheetCodeSentSms": "Telegram отправил код входа по SMS на {phone}.",
  "messages.connectSheetCodeSentCall": "Telegram отправляет код входа звонком на {phone}.",
  "messages.connectSheetCodeSentGeneric":
    "Telegram принял номер {phone}. Проверьте SMS или приложение Telegram (чат Telegram / Настройки → Устройства).",
  "messages.connectSheetCodePhoneUnknown": "ваш номер",
  "messages.connectSheetCodeResend": "Отправить код снова",
  "messages.connectSheetCodePlaceholder": "Код входа",
  "messages.connectSheetCodeSubmit": "Продолжить",
  "messages.connectErrorGatewayPhoneEndpoint":
    "Вход по номеру недоступен на шлюзе TDLib. Перезапустите: остановите npm run tdlib:gateway и запустите снова.",
  "messages.connectErrorInvalidPhone": "Введите корректный номер с кодом страны (например, +79001234567).",
  "messages.connectErrorCodeRejected": "Неверный код входа. Проверьте Telegram и попробуйте снова.",
  "messages.connectSheetPasswordTitle": "Пароль двухэтапной проверки",
  "messages.connectSheetPasswordBody":
    "QR-код принят. Telegram не присылает второй код для двухэтапной проверки — введите облачный пароль из Настройки → Конфиденциальность → Двухэтапная аутентификация и нажмите «Продолжить».",
  "messages.connectSheetPasswordPlaceholder": "Пароль",
  "messages.connectSheetPasswordSubmit": "Продолжить",
  "messages.connectSheetQrAlt": "QR-код входа в Telegram",
  "messages.connectSheetQrBody":
    "Telegram на телефоне → Настройки → Устройства → Подключить устройство → отсканируйте QR.",
  "messages.connectSheetTitle": "Подключить сообщения Telegram",
  "messages.empty": "Чатов пока нет.",
  "messages.moreChats": "Другие чаты",
  "messages.loadError": "Не удалось загрузить чаты.",
  "messages.historyLoadError": "Не удалось загрузить сообщения.",
  "messages.chatPresence.online": "в сети",
  "messages.chatPresence.recently": "был(а) недавно",
  "messages.chatPresence.lastWeek": "был(а) на этой неделе",
  "messages.chatPresence.lastMonth": "был(а) в этом месяце",
  "messages.chatPresence.lastSeen": "был(а) в {{time}}",
  "messages.chatPresence.unknown": "был(а) недавно",
  "messages.chatMemberCount": "{{count}} участников",
  "messages.chatAction.typing": "печатает…",
  "messages.chatAction.typingNamed": "{{name}} печатает…",
  "messages.chatAction.recordingVoice": "записывает голосовое…",
  "messages.chatAction.recordingVoiceNamed": "{{name}} записывает голосовое…",
  "messages.chatAction.recordingVideo": "записывает видеосообщение…",
  "messages.chatAction.recordingVideoNamed": "{{name}} записывает видеосообщение…",
  "messages.chatAction.uploadingPhoto": "отправляет фото…",
  "messages.chatAction.uploadingPhotoNamed": "{{name}} отправляет фото…",
  "messages.chatAction.uploadingVideo": "отправляет видео…",
  "messages.chatAction.uploadingVideoNamed": "{{name}} отправляет видео…",
  "messages.chatAction.uploadingFile": "отправляет файл…",
  "messages.chatAction.uploadingFileNamed": "{{name}} отправляет файл…",
  "messages.chatWrite.placeholder": "Написать",
  "messages.chatWrite.send": "Написать",
  "messages.publicGroupsBan.body":
    "К сожалению, вам запрещено участвовать в публичных группах.",
  "messages.publicGroupsBan.learnMore": "Подробнее »",
  "messages.publicGroupsBan.ok": "OK",
  "messages.action.reply": "Ответить",
  "messages.action.edit": "Изменить",
  "messages.compose.replyTo": "Ответ {{name}}",
  "messages.compose.editing": "Редактирование",
  "messages.chatEmpty": "Сообщений пока нет.",
  "messages.channelBadge": "Канал",
  "messages.call.outgoing": "Исходящий звонок",
  "messages.call.incoming": "Входящий звонок",

  "swap.footer.insufficientAmount": "Недостаточная сумма",
  "swap.action.summary": "Купить 1 ton",
  "swap.action.summaryWithAmount": "Купить 1 ton за {{amount}} dllr",
  "swap.action.button": "Обмен",
  "swap.chooseCurrency.title": "Выберите валюту",
  "swap.chooseCurrency.filterA11y": "Фильтр валют",
  "swap.chooseCurrency.col.rank": "#",
  "swap.chooseCurrency.col.currency": "Валюта",
  "swap.chooseCurrency.col.balance": "Баланс",
  "swap.chooseCurrency.col.rate": "Курс",
  "swap.chooseCurrency.col.networks": "Сети",
  "swap.chooseCurrency.col.marketCap": "Капитализация",
  "swap.chooseCurrency.col.volume": "Объём",
  "swap.chooseCurrency.col.lastYear": "Год",
  "swap.chooseCurrency.loading": "Загрузка токенов…",
  "swap.chooseCurrency.loadingMore": "Загружено {count} токенов",

  "send.footer.submit": "N / A",
  "send.action.summary": "Отправить 1 доллар",
  "send.action.summaryWithAddress": "Отправить 1 доллар на {{address}}",
  "send.action.button": "Отправить",

  "global.logoBar.about": "О программе",
  "global.logoBar.aboutHint": "Откроет сайт программы Hyperlinks Space в браузере",
  "global.logoBar.wordmarkA11y": "Hyperlinks Space",

  "home.dev.outsideTelegram": "Вне Telegram вход недоступен.",
  "home.dev.productTitle": "Hyperlinks Space Program",

  "home.errors.telegramRegistrationFailed": "Ошибка регистрации в Telegram",

  "home.header.iconCopy": "Скопировать адрес кошелька",
  "home.header.iconEdit": "Изменить",
  "home.header.iconExit": "Выход",
  "home.header.iconKey": "Ключ",
  "home.header.iconLanguage": "Язык",
  "home.header.languageIconSwitchToEn": "Переключить интерфейс на английский",
  "home.header.languageIconSwitchToRu": "Переключить интерфейс на русский",
  "home.header.balanceA11y": "Баланс",
  "home.header.copyWalletHint": "Копирует полный адрес кошелька",
  "home.header.walletAddressA11y": "Адрес кошелька {{snippet}}",

  "home.menu.get": "Получить",
  "home.menu.swap": "Обмен",
  "home.menu.smart": "Смарт",
  "home.menu.trade": "Рынок",
  "home.menu.send": "Отправка",

  "smart.deployTitle": "Создай Смарт за 1 мин",
  "smart.intro":
    "Защищённые блокчейном сделки обеспечивают реальную охрану их условий. Контрагенты теперь действительно не могут нарушить соглашение.",
  "smart.purposeSubtitle": "Назначение смарт-контракта",
  "smart.purpose.company": "Компания",
  "smart.purpose.agreement": "Соглашение",
  "smart.purpose.investment": "Инвестиции",
  "smart.purpose.revenue": "Доход",
  "smart.purpose.partners": "Партнёры",
  "smart.purposeDescLead.company": "Смарт-контракт компании",
  "smart.purposeDescBody.company":
    " позволяет запустить компанию, защищённую блокчейном, без подписания бумажных документов. Контракт фиксирует контрагентов, их доли и обеспечивает распределение поступающих сумм в соответствии с этими долями.",
  "smart.purposeDescLead.agreement": "Смарт-контракт соглашения",
  "smart.purposeDescBody.agreement":
    " фиксирует взаимные обязательства сторон в блокчейне, делая каждый пункт исполнимым без бумаги. Определяет результаты, сроки и санкции при невыполнении любой из сторон.",
  "smart.purposeDescLead.investment": "Смарт-контракт инвестиций",
  "smart.purposeDescBody.investment":
    " направляет капитал в проект с прозрачными этапами и автоматическим высвобождением средств по мере выполнения условий. Инвесторы видят, как распределяются средства и когда наступают выплаты.",
  "smart.purposeDescLead.revenue": "Смарт-контракт дохода",
  "smart.purposeDescBody.revenue":
    " делит входящие платежи между участниками по заранее заданным правилам. Каждая продажа или роялти учитываются в блокчейне, доли распределяются без ручной сверки.",
  "smart.purposeDescLead.partners": "Смарт-контракт партнёров",
  "smart.purposeDescBody.partners":
    " оформляет совместное предприятие с общими ролями, вкладами и распределением прибыли в блокчейне. Выход партнёра, выкуп и разрешение споров следуют одним неизменным правилам для всех.",
  "smart.standardSubtitle": "Standart",
  "smart.standardHelp.a11y": "О стандарте",
  "smart.dealVersion.company": "Company Smart Deal v.1",
  "smart.dealVersion.agreement": "Agreement Smart Deal v.1",
  "smart.dealVersion.investment": "Investment Smart Deal v.1",
  "smart.dealVersion.revenue": "Revenue Smart Deal v.1",
  "smart.dealVersion.partners": "Partners Smart Deal v.1",
  "smart.company.titleLabel": "Title*",
  "smart.company.titleDefault": "Company Smart Deal v.1 №123",
  "smart.agreement.titleDefault": "Agreement Smart Deal v.1 №123",
  "smart.investment.titleDefault": "Investment Smart Deal v.1 №123",
  "smart.revenue.titleDefault": "Revenue Smart Deal v.1 №123",
  "smart.partners.titleDefault": "Partners Smart Deal v.1 №123",
  "smart.company.textLabel": "Text",
  "smart.company.textPlaceholder":
    "e.g. Hyperlinks.Space: The core for a multi-planetary future\nHerewith we agree to create a company on the following terms...",
  "smart.company.logoLabel": "Визуал",
  "smart.company.addImageButton": "Добавить визуал",
  "smart.company.foundersTitle": "Фаундеры",
  "smart.company.foundersSubtitle": "Укажите участников сделки",
  "smart.company.foundersCountLabel": "Количество фаундеров",
  "smart.company.founderOrdinal": "{{n}}-й фаундер",
  "smart.company.founderNameLabel": "ИМЯ ИЛИ НИКНЕЙМ",
  "smart.company.founderWalletLabel": "КОШЕЛЁК*",
  "smart.company.founderShareLabel": "% ДОЛЯ*",
  "smart.company.founderWalletPlaceholder": "напр. UQDFuzKogL4d5VYZxkFGeIcCwTprgzJWZ5PsqCmRJ9F1iUv3",
  "smart.footer.deployCost": "Задеплой Смарт за 10 TON",
  "smart.footer.deployCostShort": "10 TON",
  "smart.footer.deployButton": "Задеплоить Смарт",

  "home.nav.coins": "Монеты",
  "home.nav.feed": "Лента",
  "home.nav.items": "Предметы",
  "home.nav.messages": "Сообщения",
  "home.nav.tasks": "Задачи",

  "home.wallet.backupKmsNote":
    "Резервная копия кошелька хранится на сервере в зашифрованном виде (ключ в обёртке Google Cloud KMS).",
  "home.wallet.errorMissingInitData": "Отсутствуют данные initData Telegram.",
  "home.wallet.errorRegistrationFailed": "Не удалось зарегистрировать кошелёк",
  "home.wallet.errorRegistrationPollTimeout":
    "Не удалось связаться с приложением или сервером в отведённое время. Попробуйте снова или откройте приложение ещё раз (кошелёк мог уже сохраниться).",
  "home.wallet.errorRegistrationRequestFailed": "Запрос регистрации кошелька не выполнен",
  "home.wallet.errorRegistrationRequestTimedOut": "Истекло время запроса регистрации кошелька",
  "home.wallet.errorServerBusy":
    "Сервер кошелька не ответил вовремя (перегрузка или холодный старт). Нажмите «Повторить» или подождите несколько секунд.",
  "home.wallet.errorSetupBudget":
    "Настройка кошелька занимает слишком много времени. Проверьте соединение, обновите Telegram и попробуйте снова.",
  "home.wallet.errorWalletKeyGenerationSlow":
    "Генерация ключей кошелька занимает слишком много времени. Обновите Telegram, смените клиент или нажмите «Повторить».",
  "home.wallet.finishingServer":
    "Завершение на сервере (сохранение записи). Можно подождать или закрыть приложение — адрес уже показан.",
  "home.wallet.generatingKeys": "Генерация ключей кошелька…",
  "home.wallet.loggedInAs": "Вы вошли через Telegram как @{{username}}.",
  "home.wallet.retryServerRegistration": "Повторить регистрацию на сервере",
  "home.wallet.retryWalletCreation": "Повторить создание кошелька",

  "key.header.goHomeA11y": "На главную",

  "ota.later": "Позже",
  "ota.message": "Новая версия загружена. Перезапустить сейчас?",
  "ota.restart": "Перезапуск",
  "ota.title": "Обновление готово",

  "welcome.auth.emailInvalid": "Некорректный адрес",
  "welcome.auth.emailPlaceholder": "Ваш адрес электронной почты",
  "welcome.auth.emailCodePlaceholder": "6-значный код",
  "welcome.auth.emailCodeInvalid": "Введите 6-значный код из письма",
  "welcome.auth.emailCodeTitle": "Проверьте почту",
  "welcome.auth.emailCodeHint": "Мы отправили код для входа на {{email}}",
  "welcome.auth.emailStartError": "Не удалось отправить код для входа. Попробуйте снова.",
  "welcome.auth.emailVerifyError": "Код для входа не подошёл. Попробуйте снова.",
  "welcome.auth.emailBrowserAlertTitle": "Вход по электронной почте",
  "welcome.auth.emailUseDifferent": "Другой адрес",
  "welcome.auth.signInApple": "Войти через Apple",
  "welcome.auth.signInButton": "Войти",
  "welcome.auth.signInEmailTitle": "Войти по электронной почте",
  "welcome.auth.signInGithub": "Войти через GitHub",
  "welcome.auth.signInGoogle": "Войти через Google",
  "welcome.auth.signInTelegram": "Войти через Telegram",
  "welcome.auth.googleStartError": "Не удалось начать вход через Google. Попробуйте снова.",
  "welcome.auth.googleCallbackError": "Вход через Google не удался ({{reason}}). Попробуйте снова.",
  "welcome.auth.googleBrowserAlertTitle": "Вход через Google",
  "welcome.auth.githubStartError": "Не удалось начать вход через GitHub. Попробуйте снова.",
  "welcome.auth.githubCallbackError": "Вход через GitHub не удался ({{reason}}). Попробуйте снова.",
  "welcome.auth.githubAccessDenied": "Вход через GitHub отменён.",
  "welcome.auth.githubBrowserAlertTitle": "Вход через GitHub",
  "welcome.auth.appleStartError": "Не удалось начать вход через Apple. Попробуйте снова.",
  "welcome.auth.appleCallbackError": "Вход через Apple не удался ({{reason}}). Попробуйте снова.",
  "welcome.auth.appleBrowserAlertTitle": "Вход через Apple",
  "welcome.auth.appleAccessDenied": "Вход через Apple отменён.",
  "welcome.auth.telegramBrowserAlertMessage":
    "Откройте эту страницу в приложении Telegram или в обычном браузере (не во встроенном предпросмотре, который имитирует Telegram).",
  "welcome.auth.telegramBrowserAlertTitle": "Вход через Telegram",
  "welcome.auth.telegramStartError": "Не удалось начать вход через Telegram. Попробуйте снова.",
  "welcome.auth.telegramCallbackError": "Вход через Telegram не удался ({{reason}}). Попробуйте снова.",

  "welcome.subtitle": "Лучший способ заработать и потратить",
  "welcome.title": "Добро пожаловать в нашу программу",
} satisfies { [K in keyof typeof en]: string };

export const appStrings = {
  en,
  ru,
} as const;

export type AppStringKey = keyof typeof en;

export function getAppString(locale: AppLocale, key: AppStringKey): string {
  const table = appStrings[locale] ?? appStrings[APP_LOCALE_DEFAULT];
  return table[key] ?? appStrings.en[key];
}

export function formatAppString(
  locale: AppLocale,
  key: AppStringKey,
  vars?: Record<string, string | number | boolean>,
): string {
  let s = getAppString(locale, key);
  if (!vars) return s;
  for (const [k, v] of Object.entries(vars)) {
    s = s.split(`{{${k}}}`).join(String(v));
  }
  return s;
}

/** Known English error copy from wallet flow → localized for display (state may stay English for logic). */
export function translateFlowErrorForDisplay(locale: AppLocale, message: string): string {
  const exact: Partial<Record<string, AppStringKey>> = {
    "Missing Telegram initData.": "home.wallet.errorMissingInitData",
    "Wallet registration failed": "home.wallet.errorRegistrationFailed",
    "Wallet registration request timed out": "home.wallet.errorRegistrationRequestTimedOut",
    "Wallet registration request failed": "home.wallet.errorRegistrationRequestFailed",
    "Wallet registration: could not reach the app or the server in time. Try again, or open the app once more (your wallet may already be saved).":
      "home.wallet.errorRegistrationPollTimeout",
    "Wallet server timed out (busy or cold). Tap Retry, or try again in a few seconds.":
      "home.wallet.errorServerBusy",
    "Wallet setup is taking too long. Check your connection, update Telegram, or try again.":
      "home.wallet.errorSetupBudget",
    "Wallet key generation is taking too long. Update Telegram, try a different client, or tap Retry.":
      "home.wallet.errorWalletKeyGenerationSlow",
  };
  const key = exact[message];
  if (key) return getAppString(locale, key);
  return message;
}
