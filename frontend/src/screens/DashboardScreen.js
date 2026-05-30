/**
 * MoodSentinel — src/screens/DashboardScreen.js
 * Full analysis results screen.
 *
 * Features:
 * - Pie chart (toggle: sentiment / emotion)
 * - Sentiment filter tabs
 * - Emotion filter tabs
 * - Comment list with per-comment sentiment + emotion
 * - Summary cards
 * - CSV export button (expo-file-system + expo-sharing)
 * - Analysis metadata
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity,
  StyleSheet, Alert,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { getLastReport } from '../services/api';
import PieChart from '../components/PieChart';
import CommentCard from '../components/CommentCard';
import FilterBar from '../components/FilterBar';
import {
  COLORS,
  SENTIMENT_COLORS, SENTIMENT_ICONS, SENTIMENT_ORDER,
  EMOTION_COLORS, EMOTION_ICONS, EMOTION_ORDER,
  LANG_FLAGS,
} from '../constants';
import { safeFloat, shortUrl, formatMs } from '../utils/helpers';

const PAGE_SIZE_OPTIONS = [10, 25, 50];

// ── Helpers ────────────────────────────────────────────────────────────────
function getReport(params) {
  try {
    if (params?.report) {
      return typeof params.report === 'string'
        ? JSON.parse(params.report)
        : params.report;
    }
  } catch (e) {}
  return getLastReport();
}

/**
 * Escape a single CSV cell value.
 * Wraps in quotes and escapes internal quotes.
 */
function csvCell(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('\n') || str.includes('"')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Build CSV string from breakdown array.
 *
 * Each breakdown item may contain multiple aspects.
 * A comment with 2 aspects produces 2 rows with the same comment number.
 *
 * Columns: #, Comment, Aspect, Sentiment, Emotion, Language
 */
function buildCsv(breakdown, report) {
  const headers = ['#', 'Comment', 'Aspect', 'Sentiment', 'Emotion', 'Language'];
  const rows = [headers.map(csvCell).join(',')];

  breakdown.forEach((item, idx) => {
    const commentNum  = idx + 1;
    const commentText = item.comment  || item.text || '';
    const sentiment   = item.sentiment || '';
    const emotion     = item.emotion   || '';
    const language    = item.language  || '';

    const aspects = item.aspects && item.aspects.length > 0
      ? item.aspects
      : [{ aspect: item.aspect || null }];

    aspects.forEach(a => {
      const aspect = a.aspect || '';
      rows.push([
        csvCell(commentNum),
        csvCell(commentText),
        csvCell(aspect),
        csvCell(sentiment),
        csvCell(emotion),
        csvCell(language),
      ].join(','));
    });
  });

  // Summary section at the bottom
  rows.push('');
  rows.push('');
  rows.push(['Summary'].map(csvCell).join(','));
  rows.push([csvCell('Dominant Sentiment'), csvCell(report.dominant_sentiment || '')].join(','));
  rows.push([csvCell('Dominant Emotion'),   csvCell(report.dominant_emotion   || '')].join(','));
  rows.push([csvCell('Comments Analysed'),  csvCell(report.comments_analysed  ?? '')].join(','));
  rows.push([csvCell('Comments Skipped'),   csvCell(report.comments_skipped   ?? '')].join(','));
  rows.push([csvCell('Post URL'),           csvCell(report.post_url           || '')].join(','));
  rows.push([csvCell('Analysed At'),        csvCell(report.processed_at       || '')].join(','));

  return rows.join('\n');
}

/**
 * Generate a timestamped filename.
 * e.g. MoodSentinel_Report_2026-05-17_14-30-00.csv
 */
function generateFilename() {
  const now  = new Date();
  const date = now.toISOString().slice(0, 10);
  const time = now.toTimeString().slice(0, 8).replace(/:/g, '-');
  return `MoodSentinel_Report_${date}_${time}.csv`;
}


// ── Component ──────────────────────────────────────────────────────────────
export default function DashboardScreen() {
  const params = useLocalSearchParams();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const report = getReport(params);

  const [chartMode,    setChartMode]    = useState('sentiment');
  const [sentFilter,   setSentFilter]   = useState('All');
  const [emoFilter,    setEmoFilter]    = useState('All');
  const [commentPage,  setCommentPage]  = useState(1);
  const [pageSize,     setPageSize]     = useState(10);
  const [pageSizeOpen, setPageSizeOpen] = useState(false);
  const [exporting,    setExporting]    = useState(false);

  // ── No report fallback ───────────────────────────────────────────────────
  if (!report) {
    return (
      <View style={[s.center, { paddingTop: insets.top }]}>
        <Text style={s.noReportText}>No report available.</Text>
        <TouchableOpacity style={s.backBtn} onPress={() => router.replace('/')}>
          <Text style={s.backBtnText}>← Go Back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // ── CSV export handler ─────────────────────────────────────────────────
  const handleExportCsv = async () => {
    const breakdown = report.breakdown || [];

    if (breakdown.length === 0) {
      Alert.alert('Nothing to Export', 'No comment data is available to export.');
      return;
    }

    setExporting(true);

    try {
      // 1. Build CSV content
      const csvContent = buildCsv(breakdown, report);
      const filename   = generateFilename();

      // 2. Write to app cache directory — always writable, no permissions needed
      const filePath = `${FileSystem.cacheDirectory}${filename}`;
      await FileSystem.writeAsStringAsync(filePath, csvContent, {
        encoding: FileSystem.EncodingType.UTF8,
      });

      // 3. Check sharing is available on this device
      const canShare = await Sharing.isAvailableAsync();
      if (!canShare) {
        Alert.alert(
          'Sharing Not Available',
          'Your device does not support file sharing.',
        );
        return;
      }

      // 4. Open native share sheet — user can save to Files, Drive, Gmail, etc.
      await Sharing.shareAsync(filePath, {
        mimeType: 'text/csv',
        dialogTitle: 'Save MoodSentinel Report',
        UTI: 'public.comma-separated-values-text', // iOS only, ignored on Android
      });

    } catch (err) {
      console.error('[Export] CSV export failed:', err);
      Alert.alert(
        'Export Failed',
        `Could not export the file.\n\n${err?.message || 'Unknown error'}`,
      );
    } finally {
      setExporting(false);
    }
  };

  // ── Derived data ──────────────────────────────────────────────────────────
  const sentimentData = useMemo(() =>
    SENTIMENT_ORDER.map(k => ({
      label: k,
      value: safeFloat(report.sentiment_distribution?.[k]),
      color: SENTIMENT_COLORS[k],
    })).filter(d => d.value > 0),
  [report]);

  const emotionData = useMemo(() =>
    EMOTION_ORDER.map(k => ({
      label: k,
      value: safeFloat(report.emotion_distribution?.[k]),
      color: EMOTION_COLORS[k],
    })).filter(d => d.value > 0),
  [report]);

  const langEntries = useMemo(() =>
    Object.entries(report.language_distribution || {})
      .map(([k, v]) => [k, safeFloat(v)])
      .filter(([, v]) => v > 0)
      .sort(([, a], [, b]) => b - a),
  [report]);

  const breakdown = report.breakdown || [];

  const sentCounts = useMemo(() => {
    const c = { All: breakdown.length };
    breakdown.forEach(item => {
      c[item.sentiment] = (c[item.sentiment] || 0) + 1;
    });
    return c;
  }, [breakdown]);

  const sentFiltered = useMemo(() =>
    sentFilter === 'All'
      ? breakdown
      : breakdown.filter(item => item.sentiment === sentFilter),
  [breakdown, sentFilter]);

  const emoCounts = useMemo(() => {
    const c = { All: sentFiltered.length };
    sentFiltered.forEach(item => {
      if (item.emotion && item.emotion !== 'N/A' && item.emotion !== 'Neutral') {
        c[item.emotion] = (c[item.emotion] || 0) + 1;
      }
    });
    return c;
  }, [sentFiltered]);

  const filteredComments = useMemo(() => {
    let items = sentFiltered;
    if (emoFilter !== 'All') {
      items = items.filter(item => item.emotion === emoFilter);
    }
    return items;
  }, [sentFiltered, emoFilter]);

  const totalCommentPages = Math.max(1, Math.ceil(filteredComments.length / pageSize));
  const activeCommentPage = Math.min(commentPage, totalCommentPages);
  const commentStart      = filteredComments.length === 0 ? 0 : (activeCommentPage - 1) * pageSize + 1;
  const commentEnd        = Math.min(activeCommentPage * pageSize, filteredComments.length);

  const paginatedComments = useMemo(() => {
    const start = (activeCommentPage - 1) * pageSize;
    return filteredComments.slice(start, start + pageSize);
  }, [filteredComments, activeCommentPage, pageSize]);

  useEffect(() => {
    setCommentPage(1);
    setPageSizeOpen(false);
  }, [sentFilter, emoFilter, pageSize]);

  useEffect(() => {
    if (commentPage > totalCommentPages) setCommentPage(totalCommentPages);
  }, [commentPage, totalCommentPages]);

  // ── Filter config ─────────────────────────────────────────────────────────
  const sentFilters = [
    { key: 'All',      label: 'All',      icon: '📋', color: COLORS.fbBlue,             count: sentCounts.All           },
    { key: 'Positive', label: 'Positive', icon: '😊', color: SENTIMENT_COLORS.Positive, count: sentCounts.Positive || 0 },
    { key: 'Neutral',  label: 'Neutral',  icon: '😐', color: SENTIMENT_COLORS.Neutral,  count: sentCounts.Neutral  || 0 },
    { key: 'Negative', label: 'Negative', icon: '😞', color: SENTIMENT_COLORS.Negative, count: sentCounts.Negative || 0 },
  ];

  const availableEmotions = EMOTION_ORDER.filter(e => (emoCounts[e] || 0) > 0);
  const emoFilters = [
    { key: 'All', label: 'All Emotions', icon: '🎭', color: COLORS.fbBlue, count: emoCounts.All },
    ...availableEmotions.map(e => ({
      key: e, label: e, icon: EMOTION_ICONS[e], color: EMOTION_COLORS[e], count: emoCounts[e] || 0,
    })),
  ];

  const chartData = chartMode === 'sentiment' ? sentimentData : emotionData;
  const domSent   = report.dominant_sentiment || 'N/A';
  const domEmo    = report.dominant_emotion   || 'N/A';

  return (
    <View style={[s.container, { paddingTop: insets.top }]}>

      {/* ── Header ── */}
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.replace('/')} style={s.headerBack} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Text style={s.headerBackText}>‹</Text>
        </TouchableOpacity>
        <View style={s.headerCenter}>
          <Text style={s.headerTitle}>MoodSentinel Report</Text>
          <Text style={s.headerSub} numberOfLines={1}>{shortUrl(report.post_url)}</Text>
        </View>
        <View style={{ width: 36 }} />
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}
      >

        {/* ── Summary cards ── */}
        <View style={s.summaryRow}>
          <View style={[s.summaryCard, { borderTopColor: SENTIMENT_COLORS[domSent] || COLORS.fbBlue }]}>
            <Text style={s.summaryIcon}>{SENTIMENT_ICONS[domSent] || '😐'}</Text>
            <Text style={[s.summaryValue, { color: SENTIMENT_COLORS[domSent] || COLORS.fbBlue }]}>{domSent}</Text>
            <Text style={s.summaryLabel}>Dominant Mood</Text>
            <Text style={s.summaryPct}>{safeFloat(report.sentiment_distribution?.[domSent]).toFixed(1)}%</Text>
          </View>

          <View style={[s.summaryCard, { borderTopColor: EMOTION_COLORS[domEmo] || COLORS.fbBlue }]}>
            <Text style={s.summaryIcon}>{EMOTION_ICONS[domEmo] || '😐'}</Text>
            <Text style={[s.summaryValue, { color: EMOTION_COLORS[domEmo] || COLORS.fbBlue }]}>
              {domEmo === 'N/A' ? 'Neutral' : domEmo}
            </Text>
            <Text style={s.summaryLabel}>Top Emotion</Text>
            <Text style={s.summaryPct}>
              {domEmo !== 'N/A'
                ? `${safeFloat(report.emotion_distribution?.[domEmo]).toFixed(1)}%`
                : 'Neutral post'}
            </Text>
          </View>
        </View>

        {/* ── Pie chart ── */}
        <View style={s.chartCard}>
          <View style={s.chartHeader}>
            <Text style={s.chartTitle}>Distribution</Text>
            <View style={s.chartToggle}>
              <TouchableOpacity
                onPress={() => setChartMode('sentiment')}
                style={[s.toggleBtn, chartMode === 'sentiment' && s.toggleBtnActive]}
              >
                <Text style={[s.toggleText, chartMode === 'sentiment' && s.toggleTextActive]}>Sentiment</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => setChartMode('emotion')}
                style={[s.toggleBtn, chartMode === 'emotion' && s.toggleBtnActive]}
              >
                <Text style={[s.toggleText, chartMode === 'emotion' && s.toggleTextActive]}>Emotion</Text>
              </TouchableOpacity>
            </View>
          </View>

          <View style={s.chartBody}>
            <PieChart data={chartData} size={180} />
            <View style={s.legend}>
              {chartData.map(d => (
                <View key={d.label} style={s.legendItem}>
                  <View style={[s.legendDot, { backgroundColor: d.color }]} />
                  <Text style={s.legendLabel}>{d.label}</Text>
                  <Text style={[s.legendPct, { color: d.color }]}>{safeFloat(d.value).toFixed(1)}%</Text>
                </View>
              ))}
            </View>
          </View>
        </View>

        {/* ── Language mix ── */}
        {langEntries.length > 0 && (
          <View style={s.langCard}>
            <Text style={s.sectionTitle}>Language Mix</Text>
            <View style={s.langRow}>
              {langEntries.map(([lang, pct]) => (
                <View key={lang} style={s.langPill}>
                  <Text style={s.langFlag}>{LANG_FLAGS[lang] || '🌐'}</Text>
                  <Text style={s.langName}>{lang.charAt(0).toUpperCase() + lang.slice(1)}</Text>
                  <Text style={[s.langPct, { color: COLORS.fbBlue }]}>{pct.toFixed(1)}%</Text>
                </View>
              ))}
            </View>
          </View>
        )}

        {/* ── Comment explorer ── */}
        {breakdown.length > 0 && (
          <View style={s.commentsSection}>
            <Text style={s.sectionTitle}>
              💬 Comment Explorer ({filteredComments.length} matched)
            </Text>

            <Text style={s.filterLabel}>Filter by Sentiment</Text>
            <FilterBar
              filters={sentFilters}
              active={sentFilter}
              onSelect={(key) => { setSentFilter(key); setEmoFilter('All'); }}
              style={{ paddingHorizontal: 0 }}
            />

            {emoFilters.length > 1 && (
              <>
                <Text style={[s.filterLabel, { marginTop: 10 }]}>Filter by Emotion</Text>
                <FilterBar
                  filters={emoFilters}
                  active={emoFilter}
                  onSelect={setEmoFilter}
                  style={{ paddingHorizontal: 0 }}
                />
              </>
            )}

            <View style={s.commentsList}>
              {filteredComments.length === 0 ? (
                <View style={s.emptyState}>
                  <Text style={s.emptyIcon}>🔍</Text>
                  <Text style={s.emptyText}>No comments match this filter</Text>
                </View>
              ) : (
                <>
                  <View style={s.paginationHeader}>
                    <View>
                      <Text style={s.pageLabel}>
                        Showing {commentStart}-{commentEnd} of {filteredComments.length}
                      </Text>
                      <Text style={s.pageSubLabel}>
                        Page {activeCommentPage} of {totalCommentPages}
                      </Text>
                    </View>

                    <View style={s.pageSizeWrap}>
                      <TouchableOpacity
                        style={s.pageSizeButton}
                        onPress={() => setPageSizeOpen(open => !open)}
                        activeOpacity={0.75}
                      >
                        <Text style={s.pageSizeText}>{pageSize} / page</Text>
                        <Text style={s.pageSizeChevron}>{pageSizeOpen ? '▲' : '▼'}</Text>
                      </TouchableOpacity>
                      {pageSizeOpen && (
                        <View style={s.pageSizeMenu}>
                          {PAGE_SIZE_OPTIONS.map(size => (
                            <TouchableOpacity
                              key={size}
                              style={[s.pageSizeOption, size === pageSize && s.pageSizeOptionActive]}
                              onPress={() => { setPageSize(size); setPageSizeOpen(false); }}
                            >
                              <Text style={[s.pageSizeOptionText, size === pageSize && s.pageSizeOptionTextActive]}>
                                {size} comments
                              </Text>
                            </TouchableOpacity>
                          ))}
                        </View>
                      )}
                    </View>
                  </View>

                  {paginatedComments.map((item, idx) => (
                    <CommentCard
                      key={`${activeCommentPage}-${idx}`}
                      item={item}
                      index={(activeCommentPage - 1) * pageSize + idx}
                    />
                  ))}

                  <View style={s.paginationFooter}>
                    <TouchableOpacity
                      style={[s.pageButton, activeCommentPage === 1 && s.pageButtonDisabled]}
                      onPress={() => setCommentPage(page => Math.max(1, page - 1))}
                      disabled={activeCommentPage === 1}
                      activeOpacity={0.75}
                    >
                      <Text style={[s.pageButtonText, activeCommentPage === 1 && s.pageButtonTextDisabled]}>
                        Previous
                      </Text>
                    </TouchableOpacity>

                    <Text style={s.pageIndicator}>{activeCommentPage} / {totalCommentPages}</Text>

                    <TouchableOpacity
                      style={[s.pageButton, activeCommentPage === totalCommentPages && s.pageButtonDisabled]}
                      onPress={() => setCommentPage(page => Math.min(totalCommentPages, page + 1))}
                      disabled={activeCommentPage === totalCommentPages}
                      activeOpacity={0.75}
                    >
                      <Text style={[s.pageButtonText, activeCommentPage === totalCommentPages && s.pageButtonTextDisabled]}>
                        Next
                      </Text>
                    </TouchableOpacity>
                  </View>
                </>
              )}
            </View>
          </View>
        )}

        {/* ── CSV Export Button ── */}
        {breakdown.length > 0 && (
          <View style={s.exportCard}>
            <View style={s.exportInfo}>
              <Text style={s.exportTitle}>📄 Export Report</Text>
              <Text style={s.exportSub}>
                Save all {breakdown.length} comment{breakdown.length !== 1 ? 's' : ''} with sentiment & emotion to a CSV file
              </Text>
            </View>
            <TouchableOpacity
              style={[s.exportBtn, exporting && s.exportBtnDisabled]}
              onPress={handleExportCsv}
              disabled={exporting}
              activeOpacity={0.8}
            >
              <Text style={s.exportBtnText}>
                {exporting ? 'Saving…' : '⬇ Download CSV'}
              </Text>
            </TouchableOpacity>
          </View>
        )}

        {/* ── Metadata ── */}
        <View style={s.metaCard}>
          <Text style={s.sectionTitle}>Analysis Metadata</Text>
          {[
            ['Comments Analysed', report.comments_analysed],
            ['Comments Skipped',  report.comments_skipped],
            ['Processing Time',   formatMs(safeFloat(report.processing_time_ms))],
            ['Analysed At',       new Date(report.processed_at).toLocaleString()],
            ['Request ID',        (report.request_id || '').substring(0, 18) + '…'],
          ].map(([k, v]) => (
            <View key={k} style={s.metaRow}>
              <Text style={s.metaKey}>{k}</Text>
              <Text style={s.metaVal} numberOfLines={1}>{String(v)}</Text>
            </View>
          ))}
        </View>

      </ScrollView>
    </View>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────
const s = StyleSheet.create({
  container:       { flex: 1, backgroundColor: COLORS.bg },
  center:          { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: COLORS.bg },
  noReportText:    { fontSize: 16, color: COLORS.textSecondary, marginBottom: 16 },
  backBtn:         { backgroundColor: COLORS.fbBlue, paddingHorizontal: 20, paddingVertical: 10, borderRadius: 10 },
  backBtnText:     { color: '#fff', fontWeight: '700', fontSize: 14 },

  header:          { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 12, backgroundColor: COLORS.fbBlue },
  headerBack:      { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  headerBackText:  { fontSize: 28, color: '#fff', lineHeight: 34 },
  headerCenter:    { flex: 1, alignItems: 'center' },
  headerTitle:     { fontSize: 16, fontWeight: '700', color: '#fff' },
  headerSub:       { fontSize: 11, color: 'rgba(255,255,255,0.7)', marginTop: 1 },

  summaryRow:      { flexDirection: 'row', gap: 12, margin: 16 },
  summaryCard:     { flex: 1, backgroundColor: '#fff', borderRadius: 16, padding: 16, alignItems: 'center', borderTopWidth: 3, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.07, shadowRadius: 6, elevation: 3 },
  summaryIcon:     { fontSize: 28, marginBottom: 6 },
  summaryValue:    { fontSize: 17, fontWeight: '800', marginBottom: 2 },
  summaryLabel:    { fontSize: 11, color: COLORS.textSecondary, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 4 },
  summaryPct:      { fontSize: 13, color: COLORS.textMuted, fontWeight: '600' },

  chartCard:       { backgroundColor: '#fff', borderRadius: 16, marginHorizontal: 16, marginBottom: 12, padding: 18, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.07, shadowRadius: 6, elevation: 3 },
  chartHeader:     { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  chartTitle:      { fontSize: 17, fontWeight: '700', color: COLORS.textPrimary },
  chartToggle:     { flexDirection: 'row', backgroundColor: COLORS.bg, borderRadius: 20, padding: 3 },
  toggleBtn:       { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 17 },
  toggleBtnActive: { backgroundColor: COLORS.fbBlue },
  toggleText:      { fontSize: 12, fontWeight: '600', color: COLORS.textSecondary },
  toggleTextActive:{ color: '#fff' },
  chartBody:       { flexDirection: 'row', alignItems: 'center', gap: 16 },
  legend:          { flex: 1, gap: 8 },
  legendItem:      { flexDirection: 'row', alignItems: 'center', gap: 8 },
  legendDot:       { width: 10, height: 10, borderRadius: 5 },
  legendLabel:     { flex: 1, fontSize: 12, color: COLORS.textPrimary, fontWeight: '600' },
  legendPct:       { fontSize: 12, fontWeight: '700', minWidth: 38, textAlign: 'right' },

  langCard:        { backgroundColor: '#fff', borderRadius: 16, marginHorizontal: 16, marginBottom: 12, padding: 18, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.07, shadowRadius: 6, elevation: 3 },
  langRow:         { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  langPill:        { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: COLORS.bg, borderRadius: 20, paddingHorizontal: 12, paddingVertical: 8, borderWidth: 1, borderColor: COLORS.border },
  langFlag:        { fontSize: 16 },
  langName:        { fontSize: 13, fontWeight: '600', color: COLORS.textPrimary },
  langPct:         { fontSize: 13, fontWeight: '700' },

  commentsSection: { backgroundColor: '#fff', borderRadius: 16, marginHorizontal: 16, marginBottom: 12, padding: 18, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.07, shadowRadius: 6, elevation: 3 },
  filterLabel:     { fontSize: 12, fontWeight: '700', color: COLORS.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8, marginTop: 4 },
  commentsList:    { marginTop: 14 },
  paginationHeader:{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 12, zIndex: 2 },
  pageLabel:       { fontSize: 13, fontWeight: '700', color: COLORS.textPrimary },
  pageSubLabel:    { fontSize: 11, color: COLORS.textSecondary, marginTop: 2 },
  pageSizeWrap:    { position: 'relative', alignItems: 'flex-end', zIndex: 3 },
  pageSizeButton:  { minWidth: 112, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 6, borderWidth: 1, borderColor: COLORS.border, borderRadius: 10, backgroundColor: COLORS.bg, paddingHorizontal: 10, paddingVertical: 8 },
  pageSizeText:    { fontSize: 12, fontWeight: '700', color: COLORS.textPrimary },
  pageSizeChevron: { fontSize: 10, color: COLORS.textSecondary },
  pageSizeMenu:    { position: 'absolute', top: 38, right: 0, width: 132, backgroundColor: '#fff', borderWidth: 1, borderColor: COLORS.border, borderRadius: 10, overflow: 'hidden', shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.12, shadowRadius: 8, elevation: 5 },
  pageSizeOption:  { paddingHorizontal: 12, paddingVertical: 10, backgroundColor: '#fff' },
  pageSizeOptionActive:     { backgroundColor: COLORS.fbBlue },
  pageSizeOptionText:       { fontSize: 12, fontWeight: '600', color: COLORS.textPrimary },
  pageSizeOptionTextActive: { color: '#fff' },
  paginationFooter:    { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginTop: 12 },
  pageButton:          { flex: 1, alignItems: 'center', borderRadius: 10, backgroundColor: COLORS.fbBlue, paddingVertical: 10 },
  pageButtonDisabled:  { backgroundColor: COLORS.bg, borderWidth: 1, borderColor: COLORS.border },
  pageButtonText:      { fontSize: 13, fontWeight: '700', color: '#fff' },
  pageButtonTextDisabled: { color: COLORS.textMuted },
  pageIndicator:       { minWidth: 58, textAlign: 'center', fontSize: 13, fontWeight: '700', color: COLORS.textSecondary },
  emptyState:      { alignItems: 'center', paddingVertical: 24 },
  emptyIcon:       { fontSize: 28, marginBottom: 8 },
  emptyText:       { fontSize: 14, color: COLORS.textSecondary },

  sectionTitle:    { fontSize: 15, fontWeight: '700', color: COLORS.textPrimary, marginBottom: 4 },

  // CSV Export card
  exportCard:      { backgroundColor: '#fff', borderRadius: 16, marginHorizontal: 16, marginBottom: 12, padding: 18, flexDirection: 'row', alignItems: 'center', gap: 12, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.07, shadowRadius: 6, elevation: 3, borderLeftWidth: 4, borderLeftColor: COLORS.fbBlue },
  exportInfo:      { flex: 1 },
  exportTitle:     { fontSize: 14, fontWeight: '700', color: COLORS.textPrimary, marginBottom: 3 },
  exportSub:       { fontSize: 12, color: COLORS.textSecondary, lineHeight: 17 },
  exportBtn:       { backgroundColor: COLORS.fbBlue, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 10, alignItems: 'center', minWidth: 120 },
  exportBtnDisabled: { opacity: 0.5 },
  exportBtnText:   { fontSize: 13, fontWeight: '700', color: '#fff' },

  metaCard:        { backgroundColor: '#fff', borderRadius: 16, marginHorizontal: 16, marginBottom: 12, padding: 18, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.07, shadowRadius: 6, elevation: 3 },
  metaRow:         { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: COLORS.divider },
  metaKey:         { fontSize: 13, color: COLORS.textSecondary, fontWeight: '500' },
  metaVal:         { fontSize: 13, color: COLORS.textPrimary, fontWeight: '600', maxWidth: '55%', textAlign: 'right' },
});