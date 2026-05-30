/**
 * MoodSentinel — src/components/FilterBar.js
 * Horizontal scrollable filter pill bar.
 */
import React from 'react';
import { ScrollView, TouchableOpacity, Text, StyleSheet, View } from 'react-native';
import { COLORS } from '../constants';

export default function FilterBar({ filters, active, onSelect, style }) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={[s.row, style]}
    >
      {filters.map((f) => {
        const isActive = active === f.key;
        return (
          <TouchableOpacity
            key={f.key}
            onPress={() => onSelect(f.key)}
            style={[
              s.pill,
              isActive && { backgroundColor: f.color || COLORS.fbBlue, borderColor: f.color || COLORS.fbBlue },
            ]}
            activeOpacity={0.7}
          >
            {f.icon ? <Text style={s.pillIcon}>{f.icon}</Text> : null}
            <Text style={[s.pillText, isActive && s.pillTextActive]}>
              {f.label}
            </Text>
            {f.count != null && (
              <View style={[s.badge, isActive && s.badgeActive]}>
                <Text style={[s.badgeText, isActive && s.badgeTextActive]}>
                  {f.count}
                </Text>
              </View>
            )}
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  row:           { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingVertical: 4 },
  pill:          { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, borderWidth: 1.5, borderColor: COLORS.border, backgroundColor: '#fff' },
  pillIcon:      { fontSize: 14 },
  pillText:      { fontSize: 13, fontWeight: '600', color: COLORS.textSecondary },
  pillTextActive:{ color: '#fff' },
  badge:         { backgroundColor: COLORS.bg, borderRadius: 10, paddingHorizontal: 6, paddingVertical: 1, minWidth: 20, alignItems: 'center' },
  badgeActive:   { backgroundColor: 'rgba(255,255,255,0.25)' },
  badgeText:     { fontSize: 11, fontWeight: '700', color: COLORS.textSecondary },
  badgeTextActive: { color: '#fff' },
});
