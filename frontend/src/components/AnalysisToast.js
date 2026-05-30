import React, { useEffect, useRef } from 'react';
import { Animated, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { COLORS } from '../constants';

export default function AnalysisToast({ visible, onView, onDismiss, error }) {
  const translateY = useRef(new Animated.Value(120)).current;
  const opacity    = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) {
      Animated.parallel([
        Animated.spring(translateY, { toValue: 0, friction: 8, tension: 60, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: 200, useNativeDriver: true }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(translateY, { toValue: 120, duration: 250, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0, duration: 200, useNativeDriver: true }),
      ]).start();
    }
  }, [visible]);

  if (!visible) return null;
  const isError = !!error;

  return (
    <Animated.View style={[s.wrapper, { opacity, transform: [{ translateY }] }]}>
      <View style={[s.toast, isError ? s.toastError : s.toastSuccess]}>
        <Text style={s.icon}>{isError ? 'X' : 'OK'}</Text>
        <View style={s.textCol}>
          <Text style={s.title}>{isError ? 'Analysis Failed' : 'Analysis Complete!'}</Text>
          <Text style={s.subtitle} numberOfLines={1}>
            {isError ? error : 'Tap to view the mood report'}
          </Text>
        </View>
        <View style={s.actions}>
          {!isError && (
            <TouchableOpacity style={s.viewBtn} onPress={onView} activeOpacity={0.8}>
              <Text style={s.viewBtnText}>View</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity style={s.dismissBtn} onPress={onDismiss} activeOpacity={0.8}>
            <Text style={s.dismissText}>X</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Animated.View>
  );
}

const s = StyleSheet.create({
  wrapper: {
    position: 'absolute',
    bottom: 70,
    left: 12,
    right: 12,
    zIndex: 1000,
  },
  toast: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 14,
    paddingVertical: 12,
    paddingHorizontal: 14,
    gap: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 10,
    elevation: 8,
  },
  toastSuccess: { backgroundColor: '#fff', borderLeftWidth: 4, borderLeftColor: '#22C55E' },
  toastError:   { backgroundColor: '#fff', borderLeftWidth: 4, borderLeftColor: '#EF4444' },
  icon:         { fontSize: 22 },
  textCol:      { flex: 1 },
  title:        { fontSize: 13, fontWeight: '700', color: '#1C1E21' },
  subtitle:     { fontSize: 11, color: '#65676B', marginTop: 2 },
  actions:      { flexDirection: 'row', alignItems: 'center', gap: 6 },
  viewBtn:      { backgroundColor: '#1877F2', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6 },
  viewBtnText:  { color: '#fff', fontSize: 12, fontWeight: '700' },
  dismissBtn:   { padding: 4 },
  dismissText:  { fontSize: 14, color: '#BCC0C4', fontWeight: '600' },
});