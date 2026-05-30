/**
 * MoodSentinel — src/components/CommentCard.js
 * Displays a single analyzed comment with sentiment + emotion + aspects.
 *
 * FIX: confidence display
 *   - sentiment_conf → shown as "X% sent" (from ABSA/roberta)
 *   - emotion_conf   → shown as "X% emo"  (from fine-tuned emotion model)
 *   - Both badges are hidden when Math.round(conf * 100) === 0
 *   - Sentiment/emotion labels are never changed based on confidence
 */
import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import {
  COLORS,
  SENTIMENT_COLORS, SENTIMENT_ICONS,
  EMOTION_COLORS,   EMOTION_ICONS,
  LANG_FLAGS,
} from '../constants';

const ASPECT_SENTIMENT_COLORS = {
  Positive: '#22C55E',
  Negative: '#EF4444',
  Neutral:  '#94A3B8',
};

export default function CommentCard({ item, index }) {
  const [expanded, setExpanded] = useState(false);

  const sentColor = SENTIMENT_COLORS[item.sentiment] || COLORS.textSecondary;
  const emoColor  = EMOTION_COLORS[item.emotion]     || COLORS.textSecondary;
  const lang      = (item.language || 'english').toLowerCase();

  const aspects = item.aspects || [];
  const hasAspects = aspects.length > 0 && aspects.some(
    a => a.aspect && a.aspect !== 'general' && a.aspect.trim() !== ''
  );

  // ── Confidence display helpers ─────────────────────────────────────────────
  // Hide badge entirely when value rounds to 0% — do NOT change sentiment/emotion
  const sentConfPct  = item.sentiment_conf != null
    ? Math.round(item.sentiment_conf * 100)
    : null;
  const emoConfPct   = item.emotion_conf != null
    ? Math.round(item.emotion_conf * 100)
    : null;

  const showSentConf = sentConfPct != null && sentConfPct > 0;
  const showEmoConf  = emoConfPct  != null && emoConfPct  > 0;

  return (
    <View style={s.card}>
      {/* ── Header ── */}
      <View style={s.header}>
        <Text style={s.num}>#{index + 1}</Text>
        <Text style={s.lang}>{LANG_FLAGS[lang] || '🌐'} {lang}</Text>
      </View>

      {/* ── Comment text ── */}
      <Text style={s.text} numberOfLines={5}>{item.text}</Text>

      {/* ── Sentiment / Emotion / Confidence tags ── */}
      <View style={s.tags}>

        {/* Sentiment label */}
        <View style={[s.tag, { borderColor: sentColor, backgroundColor: sentColor + '18' }]}>
          <Text style={[s.tagText, { color: sentColor }]}>
            {SENTIMENT_ICONS[item.sentiment] || ''} {item.sentiment}
          </Text>
        </View>

        {/* Emotion label — hidden when Neutral or N/A */}
        {item.emotion && item.emotion !== 'Neutral' && item.emotion !== 'N/A' && (
          <View style={[s.tag, { borderColor: emoColor, backgroundColor: emoColor + '18' }]}>
            <Text style={[s.tagText, { color: emoColor }]}>
              {EMOTION_ICONS[item.emotion] || ''} {item.emotion}
            </Text>
          </View>
        )}

        {/* Sentiment confidence badge — hidden when rounds to 0 */}
        {/* {showSentConf && (
          <View style={[s.tag, { borderColor: COLORS.border, backgroundColor: COLORS.bg }]}>
            <Text style={[s.tagText, { color: COLORS.textSecondary }]}>
              {sentConfPct}% sent
            </Text>
          </View>
        )} */}

        {/* Emotion confidence badge — hidden when rounds to 0 */}
        {/* {showEmoConf && (
          <View style={[s.tag, { borderColor: COLORS.border, backgroundColor: COLORS.bg }]}>
            <Text style={[s.tagText, { color: COLORS.textSecondary }]}>
              {emoConfPct}% emo
            </Text>
          </View>
        )} */}

      </View>

      {/* ── Aspects section ── */}
      {hasAspects && (
        <View style={s.aspectsWrapper}>
          <TouchableOpacity
            style={s.aspectsToggle}
            onPress={() => setExpanded(v => !v)}
            activeOpacity={0.7}
          >
            <Text style={s.aspectsToggleText}>
              🔍 {aspects.length} aspect{aspects.length > 1 ? 's' : ''} detected{' '}
              <Text style={s.chevron}>{expanded ? '▲' : '▼'}</Text>
            </Text>
          </TouchableOpacity>

          {expanded && (
            <View style={s.aspectsList}>
              {aspects
                .filter(a => a?.aspect && a.aspect.trim() !== '')
                .map((a, i) => {
                  const aColor = ASPECT_SENTIMENT_COLORS[a.sentiment] || COLORS.textSecondary;

                  // Per-aspect confidence badges (same hide logic)
                  const asentConfPct = a.confidence != null
                    ? Math.round(a.confidence * 100) : null;
                  const aEmoConfPct  = a.emotion_conf != null
                    ? Math.round(a.emotion_conf * 100) : null;

                  return (
                    <View key={i} style={s.aspectRow}>
                      <Text style={s.aspectName}>• {a.aspect}</Text>

                      <View style={[s.aspectBadge, { backgroundColor: aColor + '22', borderColor: aColor }]}>
                        <Text style={[s.aspectBadgeText, { color: aColor }]}>
                          {a.sentiment}
                        </Text>
                      </View>

                      {a.emotion && a.emotion !== 'Neutral' && (
                        <Text style={s.aspectEmotion}>
                          {EMOTION_ICONS[a.emotion] || ''} {a.emotion}
                        </Text>
                      )}

                      {/* Per-aspect sentiment confidence */}
                      {/* {asentConfPct != null && asentConfPct > 0 && (
                        <Text style={s.aspectConf}>{asentConfPct}% sent</Text>
                      )} */}

                      {/* Per-aspect emotion confidence */}
                      {/* {aEmoConfPct != null && aEmoConfPct > 0 && (
                        <Text style={s.aspectConf}>{aEmoConfPct}% emo</Text>
                      )} */}
                    </View>
                  );
                })}
            </View>
          )}
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  card: {
    backgroundColor: '#fff',
    borderRadius: 14,
    padding: 14,
    marginBottom: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 4,
    elevation: 2,
  },
  header:             { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  num:                { fontSize: 11, fontWeight: '700', color: COLORS.textMuted },
  lang:               { fontSize: 11, color: COLORS.textSecondary, fontWeight: '500' },
  text:               { fontSize: 14, color: COLORS.textPrimary, lineHeight: 20, marginBottom: 10 },
  tags:               { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  tag:                { paddingHorizontal: 9, paddingVertical: 4, borderRadius: 10, borderWidth: 1.5 },
  tagText:            { fontSize: 11, fontWeight: '700' },
  aspectsWrapper:     { marginTop: 10, borderTopWidth: 1, borderTopColor: COLORS.divider, paddingTop: 8 },
  aspectsToggle:      { flexDirection: 'row', alignItems: 'center' },
  aspectsToggleText:  { fontSize: 11, color: COLORS.textSecondary, fontWeight: '600' },
  chevron:            { fontSize: 10 },
  aspectsList:        { marginTop: 6, gap: 5 },
  aspectRow:          { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6, marginBottom: 3 },
  aspectName:         { fontSize: 12, color: COLORS.textPrimary, fontWeight: '500', flex: 1 },
  aspectBadge:        { paddingHorizontal: 7, paddingVertical: 2, borderRadius: 8, borderWidth: 1 },
  aspectBadgeText:    { fontSize: 10, fontWeight: '700' },
  aspectEmotion:      { fontSize: 11, color: COLORS.textSecondary },
  aspectConf:         { fontSize: 10, color: COLORS.textMuted },
});