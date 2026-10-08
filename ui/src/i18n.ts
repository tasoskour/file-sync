import { computed, ref } from 'vue';
import { el, elPatterns } from './locales/el';

export type Lang = 'en' | 'el';

function initial(): Lang {
  try {
    const stored = localStorage.getItem('filesync-lang');
    if (stored === 'en' || stored === 'el') return stored;
  } catch { /* storage can be unavailable; fall back to the browser language */ }
  return (navigator.language || '').toLowerCase().startsWith('el') ? 'el' : 'en';
}

export const lang = ref<Lang>(initial());
export const locale = computed(() => (lang.value === 'el' ? 'el-GR' : undefined));
document.documentElement.lang = lang.value;

export function setLang(value: Lang): void {
  lang.value = value;
  document.documentElement.lang = value;
  try { localStorage.setItem('filesync-lang', value); } catch { /* the choice just will not persist */ }
}

function fill(text: string, params?: Record<string, string | number>): string {
  return params ? text.replace(/\{(\w+)\}/g, (_, key: string) => String(params[key] ?? '')) : text;
}

/** English text is the key. Anything without a Greek entry is shown in English. */
export function t(key: string, params?: Record<string, string | number>): string {
  return fill(lang.value === 'el' ? (el[key] ?? key) : key, params);
}

/** Translates status text produced by the service, which is always written in English. */
export function tMessage(message: string | undefined): string {
  if (!message || lang.value !== 'el') return message || '';
  if (el[message]) return el[message];
  for (const [pattern, translated] of elPatterns) {
    const match = pattern.exec(message);
    if (match) return fill(translated, Object.fromEntries(match.slice(1).map((value, index) => [String(index + 1), value])));
  }
  return message;
}
