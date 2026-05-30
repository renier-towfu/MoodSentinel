/**
 * MoodSentinel — src/screens/BrowserScreen.js
 * Embedded Facebook WebView browser.
 * - Polls window.location every 500ms (handles FB SPA navigation)
 * - Extracts cookies before analysis
 * - Shows "Analyze This Post" button on valid post URLs
 */
import React, { useCallback, useRef, useState } from 'react';
import {
  Alert, Platform, StyleSheet, Text,
  TouchableOpacity, View, ActivityIndicator,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import { useRouter } from 'expo-router';
import { COLORS, FACEBOOK_URL } from '../constants';
import { useAnalysis } from '../hooks/useAnalysis';
import { setLastReport } from '../services/api';
import AnalysisToast from '../components/AnalysisToast';
import AnalyzingOverlay from '../components/AnalyzingOverlay';
import { isPostUrl, shortUrl } from '../utils/helpers';

// ── User agent ────────────────────────────────────────────────────────────
const MOBILE_UA = Platform.OS === 'ios'
  ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/124.0.0.0 Mobile/15E148 Safari/604.1'
  : 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';

// ── Injected JS: polls URL + cookies every 500ms ──────────────────────────
const INJECTED_JS = `
(function() {
  var lastUrl = window.location.href;
  function postState() {
    try {
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'STATE',
        url: window.location.href,
        cookies: document.cookie
      }));
    } catch(e) {}
  }
  setInterval(function() {
    var cur = window.location.href;
    if (cur !== lastUrl) { lastUrl = cur; postState(); }
  }, 500);
  postState();
  true;
})();
`;

// ── Cookie extractor: called just before analyze ──────────────────────────
const COOKIE_EXTRACT_SCRIPT = `
(function() {
  try {
    window.ReactNativeWebView.postMessage(JSON.stringify({
      type: 'COOKIES',
      cookies: document.cookie,
      url: window.location.href
    }));
  } catch(e) {}
})();
true;
`;

export default function BrowserScreen() {
  const router     = useRouter();
  const insets     = useSafeAreaInsets();
  const webviewRef = useRef(null);
  const { isLoading, isDone, result, error, runInBackground, reset } = useAnalysis();

  const [currentUrl,  setCurrentUrl]  = useState(FACEBOOK_URL);
  const [canGoBack,   setCanGoBack]   = useState(false);
  const [pageLoading, setPageLoading] = useState(true);
  const [pendingUrl,  setPendingUrl]  = useState(null);

  // Refs stay up-to-date without re-render
  const cookiesRef    = useRef('');
  const currentUrlRef = useRef(FACEBOOK_URL);
  const onNavigationStateChange = useCallback((state) => {
    setCanGoBack(state.canGoBack);
    setCurrentUrl(state.url);
    currentUrlRef.current = state.url;
  }, []);

  // ── WebView message handler ──────────────────────────────────────────────
  
  const onMessage = useCallback(async (event) => {
    let payload;
    try { payload = JSON.parse(event.nativeEvent.data); } catch { return; }
    if (payload.type !== 'ANALYZE_POST') return;

    const { post_url, btn_id } = payload;
    activeBtnId.current = btn_id;
    setPendingUrl(post_url);

    const resetBtn = () =>
      webviewRef.current?.injectJavaScript(
        `window.__moodSentinelReset&&window.__moodSentinelReset('${btn_id}');true;`
      );

    const started = await runInBackground(post_url);
    if (!started) {
      Alert.alert(
        'Analysis In Progress',
        'Please wait for the current analysis to finish before starting a new one.',
        [{ text: 'OK' }]
      );
      return;
    }
    resetBtn();
  }, [runInBackground]);


  // ── Analyze handler ──────────────────────────────────────────────────────
  const handleAnalyze = useCallback(async () => {
    // Extract fresh cookies
    webviewRef.current?.injectJavaScript(COOKIE_EXTRACT_SCRIPT);
    await new Promise(r => setTimeout(r, 400));

    const url     = currentUrlRef.current;
    const cookies = cookiesRef.current;

    if (!isPostUrl(url)) {
      Alert.alert(
        'Navigate to a Post',
        `Please tap into a Facebook post first.\n\nCurrent URL:\n${url}`
      );
      return;
    }

    setPendingUrl(url);
    const started = await runInBackground(url, cookies);
    if (!started) {
      Alert.alert(
        'Analysis In Progress',
        'Please wait for the current analysis to finish before starting a new one.',
        [{ text: 'OK' }]
      );
      setPendingUrl(null);
    }
  }, [runInBackground]);

  const showAnalyzeBtn = isPostUrl(currentUrl) && !isLoading;

  return (
    <View style={[s.container, { paddingTop: insets.top }]}>

      {/* ── Navbar ── */}
      <View style={s.navbar}>
        <TouchableOpacity
          onPress={() => webviewRef.current?.goBack()}
          disabled={!canGoBack}
          style={[s.navBtn, !canGoBack && s.navBtnDisabled]}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Text style={s.navBtnText}>‹</Text>
        </TouchableOpacity>

        <View style={s.addressBar}>
          <Text style={s.lockIcon}>🔒</Text>
          <Text style={s.urlText} numberOfLines={1}>
            {shortUrl(currentUrl)}
          </Text>
        </View>

        <TouchableOpacity
          onPress={() => webviewRef.current?.reload()}
          style={s.navBtn}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Text style={s.navBtnText}>↺</Text>
        </TouchableOpacity>
      </View>

      {/* ── Page loading bar ── */}
      {pageLoading && (
        <View style={s.loadBar}>
          <View style={s.loadBarFill} />
        </View>
      )}

      {/* ── WebView ── */}
      <WebView
        ref={webviewRef}
        source={{ uri: FACEBOOK_URL }}
        style={s.webview}
        onNavigationStateChange={onNavigationStateChange}
        onLoadStart={() => setPageLoading(true)}
        onLoadEnd={() => setPageLoading(false)}
        onMessage={onMessage}
        injectedJavaScript={INJECTED_JS}
        userAgent={MOBILE_UA}
        javaScriptEnabled
        domStorageEnabled
        sharedCookiesEnabled
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        decelerationRate={0.998}
        scrollEnabled
        androidLayerType="hardware"
      />

      {/* ── Analyze button ── */}
      {showAnalyzeBtn && (
        <TouchableOpacity
          style={[s.analyzeBtn, { bottom: insets.bottom + 72 }]}
          onPress={handleAnalyze}
          activeOpacity={0.88}
        >
          <Text style={s.analyzeBtnText}>🧠 Analyze This Post</Text>
        </TouchableOpacity>
      )}

      {/* ── Analyzing banner (non-blocking) ── */}
            <AnalyzingOverlay visible={isLoading} postUrl={pendingUrl} />

            {/* ── Analysis complete toast ── */}
            <AnalysisToast
              visible={isDone || (!!error && !isLoading)}
              error={error}
                onView={() => {
                  if (result) {
                    setLastReport(result);
                    reset();
                    setPendingUrl(null);
                    router.push({ pathname: '/dashboard', params: { report: JSON.stringify(result) } });
                  }
                }}
              onDismiss={() => {
                reset();
                setPendingUrl(null);
              }}
            />

      {/* ── Bottom badge ── */}
      <View style={[s.badge, { paddingBottom: insets.bottom + 4 }]}>
        <Text style={s.badgeText}>🧠 MoodSentinel Active</Text>
      </View>

    </View>
  );
}

const s = StyleSheet.create({
  container:       { flex: 1, backgroundColor: '#fff' },

  // Navbar
  navbar:          { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingVertical: 6, backgroundColor: '#fff', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: COLORS.border, gap: 6 },
  navBtn:          { width: 36, height: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 8 },
  navBtnDisabled:  { opacity: 0.3 },
  navBtnText:      { fontSize: 24, color: COLORS.textPrimary, lineHeight: 30 },
  addressBar:      { flex: 1, flexDirection: 'row', alignItems: 'center', backgroundColor: COLORS.bg, borderRadius: 20, paddingHorizontal: 12, paddingVertical: 7, gap: 6 },
  lockIcon:        { fontSize: 12 },
  urlText:         { flex: 1, fontSize: 13, color: COLORS.textSecondary, fontWeight: '500' },

  // Loading bar
  loadBar:         { height: 2, backgroundColor: COLORS.fbBlueLight },
  loadBarFill:     { width: '60%', height: 2, backgroundColor: COLORS.fbBlue },

  // WebView
  webview:         { flex: 1 },

  // Analyze button
  analyzeBtn:      { position: 'absolute', alignSelf: 'center', left: 20, right: 20, backgroundColor: COLORS.fbBlue, borderRadius: 28, paddingVertical: 16, alignItems: 'center', shadowColor: COLORS.fbBlue, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.35, shadowRadius: 12, elevation: 10 },
  analyzeBtnText:  { color: '#fff', fontSize: 16, fontWeight: '700', letterSpacing: 0.2 },

  // Overlay
  overlay:         { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'center', alignItems: 'center', zIndex: 99 },
  overlayCard:     { backgroundColor: '#fff', borderRadius: 20, padding: 32, alignItems: 'center', marginHorizontal: 32, gap: 12 },
  overlayTitle:    { fontSize: 18, fontWeight: '700', color: COLORS.textPrimary, marginTop: 8 },
  overlayUrl:      { fontSize: 12, color: COLORS.textSecondary, textAlign: 'center', maxWidth: 240 },
  overlayHint:     { fontSize: 12, color: COLORS.textMuted, textAlign: 'center', lineHeight: 18 },

  // Badge
  badge:           { alignItems: 'center', paddingTop: 6, backgroundColor: '#fff', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: COLORS.border },
  badgeText:       { fontSize: 11, color: COLORS.textSecondary, fontWeight: '500', letterSpacing: 0.3 },
});
