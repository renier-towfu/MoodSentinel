/**
 * MoodSentinel — src/constants/index.js
 * ⚠️  Change API_BASE_URL to your current ngrok URL before running.
 */

// ── API ────────────────────────────────────────────────────────────────────
// 👇 CHANGE THIS to your ngrok URL every time you restart ngrok
export const API_BASE_URL =
  process.env.EXPO_PUBLIC_API_BASE_URL || 'http://localhost:8000';

export const FACEBOOK_URL = 'https://www.facebook.com';
export const MAX_COMMENTS = 1000;

// ── Brand Colors ───────────────────────────────────────────────────────────
export const COLORS = {
  // Facebook blue palette
  fbBlue:        '#1877F2',
  fbBlueDark:    '#1558B0',
  fbBlueMid:     '#2D88FF',
  fbBlueLight:   '#E7F3FF',

  // Backgrounds
  bg:            '#F0F2F5',
  card:          '#FFFFFF',
  overlay:       'rgba(0,0,0,0.45)',

  // Text
  textPrimary:   '#1C1E21',
  textSecondary: '#65676B',
  textMuted:     '#BCC0C4',

  // UI
  border:        '#E4E6EA',
  divider:       '#F2F3F5',

  // Status
  success:       '#22C55E',
  error:         '#EF4444',
  warning:       '#F59E0B',
  info:          '#3B82F6',
};

// ── Sentiment ──────────────────────────────────────────────────────────────
export const SENTIMENT_COLORS = {
  Positive: '#22C55E',
  Negative: '#EF4444',
  Neutral:  '#94A3B8',
};

export const SENTIMENT_BG = {
  Positive: '#F0FDF4',
  Negative: '#FEF2F2',
  Neutral:  '#F8FAFC',
};

export const SENTIMENT_ICONS = {
  Positive: '😊',
  Negative: '😞',
  Neutral:  '😐',
};

// ── Emotion ────────────────────────────────────────────────────────────────
export const EMOTION_COLORS = {
  Happiness: '#F59E0B',
  Surprise:  '#8B5CF6',
  Anger:     '#EF4444',
  Disgust:   '#84CC16',
  Fear:      '#F97316',
  Sadness:   '#3B82F6',
  Neutral:   '#94A3B8',
};

export const EMOTION_ICONS = {
  Happiness: '😄',
  Surprise:  '😲',
  Anger:     '😠',
  Disgust:   '🤢',
  Fear:      '😨',
  Sadness:   '😢',
  Neutral:   '😐',
};

export const EMOTION_ORDER = [
  'Happiness', 'Surprise', 'Anger', 'Disgust', 'Fear', 'Sadness',
];

export const SENTIMENT_ORDER = ['Positive', 'Negative', 'Neutral'];

// ── Language ───────────────────────────────────────────────────────────────
export const LANG_FLAGS = {
  tagalog: '🇵🇭',
  english: '🇺🇸',
  taglish: '🌐',
};
