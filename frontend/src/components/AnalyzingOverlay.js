import React, { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';
import { COLORS } from '../constants';

export default function AnalyzingOverlay({ visible, postUrl }) {
  const translateY = useRef(new Animated.Value(-80)).current;
  const spin       = useRef(new Animated.Value(0)).current;
  const spinLoop   = useRef(null);

  useEffect(() => {
    if (visible) {
      Animated.spring(translateY, {
        toValue: 0, friction: 8, tension: 60, useNativeDriver: true,
      }).start();
      spinLoop.current = Animated.loop(
        Animated.timing(spin, {
          toValue: 1, duration: 1200,
          easing: Easing.linear, useNativeDriver: true,
        })
      );
      spinLoop.current.start();
    } else {
      spinLoop.current?.stop();
      spin.setValue(0);
      Animated.timing(translateY, {
        toValue: -80, duration: 200, useNativeDriver: true,
      }).start();
    }
  }, [visible]);

  const rotate = spin.interpolate({
    inputRange: [0, 1], outputRange: ['0deg', '360deg'],
  });

  const displayUrl = postUrl
    ? postUrl.replace('https://www.facebook.com', 'fb.com').substring(0, 32) + '...'
    : 'Analyzing post...';

  return (
    <Animated.View style={[s.banner, { transform: [{ translateY }] }]}>
      <Animated.Text style={[s.spinner, { transform: [{ rotate }] }]}>
        ⏳
      </Animated.Text>
      <View style={s.textCol}>
        <Text style={s.title}>Analyzing in background</Text>
        <Text style={s.url} numberOfLines={1}>{displayUrl}</Text>
      </View>
      <View style={s.dot} />
    </Animated.View>
  );
}

const s = StyleSheet.create({
  banner: {
    position:          'absolute',
    top:               0,
    left:              0,
    right:             0,
    zIndex:            999,
    flexDirection:     'row',
    alignItems:        'center',
    backgroundColor:   COLORS.fbBlue,
    paddingVertical:   10,
    paddingHorizontal: 14,
    gap:               10,
    shadowColor:       '#000',
    shadowOffset:      { width: 0, height: 2 },
    shadowOpacity:     0.2,
    shadowRadius:      6,
    elevation:         6,
  },
  spinner: { fontSize: 18 },
  textCol: { flex: 1 },
  title:   { fontSize: 12, fontWeight: '700', color: '#fff' },
  url:     { fontSize: 10, color: 'rgba(255,255,255,0.8)', marginTop: 1 },
  dot:     { width: 8, height: 8, borderRadius: 4, backgroundColor: '#4ADE80' },
});