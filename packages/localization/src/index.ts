/**
 * T119 — iPhone localization catalog (UI-17): English/Chinese/Spanish/
 * French/German/Russian resources with follow-system selection, plus
 * the string/contrast audit helpers the accessibility work reuses
 * (UI-10, UI-18).
 */
import { z } from "zod";

export const LOCALES = ["en", "zh", "es", "fr", "de", "ru"] as const;
export type Locale = (typeof LOCALES)[number];

export const LocaleSchema = z.enum(LOCALES);

/** The audit key set: every locale must cover every key (step 3
 * long-string audit is only meaningful over a complete catalog). */
export const UI_STRING_KEYS = [
  "tab.chat",
  "tab.tools",
  "tab.settings",
  "action.send",
  "action.stop",
  "action.new_chat",
  "label.search_field",
  "label.mic_permission",
  "status.model_ready",
  "status.model_downloading",
  "status.offline",
  "notice.empty_chat",
] as const;
export type UiStringKey = (typeof UI_STRING_KEYS)[number];

type Catalog = Record<UiStringKey, string>;

const en: Catalog = {
  "tab.chat": "Chat",
  "tab.tools": "Tools",
  "tab.settings": "Settings",
  "action.send": "Send",
  "action.stop": "Stop",
  "action.new_chat": "New chat",
  "label.search_field": "Search chats",
  "label.mic_permission": "Allow microphone to talk to the model",
  "status.model_ready": "Model ready",
  "status.model_downloading": "Downloading model",
  "status.offline": "Offline",
  "notice.empty_chat": "No messages yet. Start below.",
};

const zh: Catalog = {
  "tab.chat": "聊天",
  "tab.tools": "工具",
  "tab.settings": "设置",
  "action.send": "发送",
  "action.stop": "停止",
  "action.new_chat": "新对话",
  "label.search_field": "搜索对话",
  "label.mic_permission": "允许麦克风与模型对话",
  "status.model_ready": "模型就绪",
  "status.model_downloading": "正在下载模型",
  "status.offline": "离线",
  "notice.empty_chat": "还没有消息。请在下方开始。",
};

const es: Catalog = {
  "tab.chat": "Chat",
  "tab.tools": "Herramientas",
  "tab.settings": "Ajustes",
  "action.send": "Enviar",
  "action.stop": "Detener",
  "action.new_chat": "Nuevo chat",
  "label.search_field": "Buscar chats",
  "label.mic_permission": "Permite el micrófono para hablar con el modelo",
  "status.model_ready": "Modelo listo",
  "status.model_downloading": "Descargando modelo",
  "status.offline": "Sin conexión",
  "notice.empty_chat": "Aún no hay mensajes. Empieza abajo.",
};

const fr: Catalog = {
  "tab.chat": "Discussion",
  "tab.tools": "Outils",
  "tab.settings": "Réglages",
  "action.send": "Envoyer",
  "action.stop": "Arrêter",
  "action.new_chat": "Nouvelle discussion",
  "label.search_field": "Rechercher des discussions",
  "label.mic_permission": "Autorisez le microphone pour parler au modèle",
  "status.model_ready": "Modèle prêt",
  "status.model_downloading": "Téléchargement du modèle",
  "status.offline": "Hors ligne",
  "notice.empty_chat": "Aucun message pour l’instant. Commencez ci-dessous.",
};

const de: Catalog = {
  "tab.chat": "Chat",
  "tab.tools": "Werkzeuge",
  "tab.settings": "Einstellungen",
  "action.send": "Senden",
  "action.stop": "Stopp",
  "action.new_chat": "Neuer Chat",
  "label.search_field": "Chats durchsuchen",
  "label.mic_permission": "Mikrofon erlauben, um mit dem Modell zu sprechen",
  "status.model_ready": "Modell bereit",
  "status.model_downloading": "Modell wird heruntergeladen",
  "status.offline": "Offline",
  "notice.empty_chat": "Noch keine Nachrichten. Unten beginnen.",
};

const ru: Catalog = {
  "tab.chat": "Чат",
  "tab.tools": "Инструменты",
  "tab.settings": "Настройки",
  "action.send": "Отправить",
  "action.stop": "Стоп",
  "action.new_chat": "Новый чат",
  "label.search_field": "Поиск по чатам",
  "label.mic_permission": "Разрешите микрофон, чтобы говорить с моделью",
  "status.model_ready": "Модель готова",
  "status.model_downloading": "Загрузка модели",
  "status.offline": "Офлайн",
  "notice.empty_chat": "Сообщений пока нет. Начните ниже.",
};

export const UI_CATALOGS: Record<Locale, Catalog> = { en, zh, es, fr, de, ru };

/** Follow-system selection: an explicit user pick wins; otherwise the
 * system locale's language prefix selects the catalog, defaulting to
 * English for languages without one. */
export function resolveLocalePreference(
  userPreference: unknown,
  systemLocale: string,
): Locale {
  const picked = LocaleSchema.safeParse(userPreference);
  if (picked.success) return picked.data;
  const prefix = systemLocale.toLowerCase().split(/[-_]/)[0] ?? "";
  const match = LOCALES.find((locale) => locale === prefix);
  return match ?? "en";
}

export function translate(locale: Locale, key: UiStringKey): string {
  return UI_CATALOGS[locale][key] ?? en[key];
}

/** Step 3 audit: keys in a locale that still fall back to English. */
export function missingKeys(locale: Locale): UiStringKey[] {
  return UI_STRING_KEYS.filter((key) => !(key in UI_CATALOGS[locale]));
}

/** Step 3 long-string audit: budget = 2.5x the English length (labels
 * that would push layout past that must be shortened, not clipped). */
export function overlongLabels(locale: Locale): UiStringKey[] {
  return UI_STRING_KEYS.filter(
    (key) => UI_CATALOGS[locale][key].length > en[key].length * 2.5,
  );
}

const RTL_LANGUAGES = ["ar", "he", "fa", "ur"] as const;

/** None of the six shipped languages is RTL; the audit keeps the
 * mirroring rule honest for future languages. */
export function isRtl(locale: Locale): boolean {
  return (RTL_LANGUAGES as readonly string[]).includes(locale);
}

/** UI-18 contrast math: WCAG 2.x ratio between two sRGB hex colors. */
export function contrastRatio(fgHex: string, bgHex: string): number {
  const lum = (hex: string): number => {
    const m = /^#?([0-9a-fA-F]{6})$/.exec(hex);
    if (m === null) throw new Error(`bad color: ${hex}`);
    const digits = m[1] ?? "";
    const chan = (i: number): number => {
      const v = parseInt(digits.slice(i, i + 2), 16) / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * chan(0) + 0.7152 * chan(2) + 0.0722 * chan(4);
  };
  const a = lum(fgHex);
  const b = lum(bgHex);
  const [hi, lo] = a >= b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}
