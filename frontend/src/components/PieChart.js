/**
 * MoodSentinel — src/components/PieChart.js
 * Simple SVG pie chart using react-native-svg.
 * No external chart library needed.
 */
import React, { useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Svg, { Path, Circle } from 'react-native-svg';
import { safeFloat } from '../utils/helpers';

function polarToCartesian(cx, cy, r, angleDeg) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return {
    x: cx + r * Math.cos(rad),
    y: cy + r * Math.sin(rad),
  };
}

function slicePath(cx, cy, r, startAngle, endAngle) {
  const start = polarToCartesian(cx, cy, r, endAngle);
  const end   = polarToCartesian(cx, cy, r, startAngle);
  const large = endAngle - startAngle > 180 ? 1 : 0;
  return `M ${cx} ${cy} L ${start.x} ${start.y} A ${r} ${r} 0 ${large} 0 ${end.x} ${end.y} Z`;
}

export default function PieChart({ data, size = 180 }) {
  /**
   * data: [{ label, value, color }]
   * value is a percentage (0–100)
   */
  const cx = size / 2;
  const cy = size / 2;
  const r  = size / 2 - 8;

  const slices = useMemo(() => {
    const total = data.reduce((sum, d) => sum + safeFloat(d.value), 0);
    if (total === 0) return [];

    let currentAngle = 0;
    return data
      .filter(d => safeFloat(d.value) > 0)
      .map(d => {
        const val        = safeFloat(d.value);
        const sweep      = (val / total) * 360;
        const startAngle = currentAngle;
        const endAngle   = currentAngle + sweep;
        currentAngle     = endAngle;
        return {
          ...d,
          path: slicePath(cx, cy, r, startAngle, endAngle),
          midAngle: startAngle + sweep / 2,
          pct: Math.round((val / total) * 100),
        };
      });
  }, [data, cx, cy, r]);

  if (slices.length === 0) {
    return (
      <View style={[s.container, { width: size, height: size }]}>
        <Circle cx={cx} cy={cy} r={r} fill="#E4E6EA" />
        <Text style={s.empty}>No data</Text>
      </View>
    );
  }

  // Handle single slice (full circle)
  if (slices.length === 1) {
    return (
      <Svg width={size} height={size}>
        <Circle cx={cx} cy={cy} r={r} fill={slices[0].color} />
        <Circle cx={cx} cy={cy} r={r * 0.55} fill="#fff" />
      </Svg>
    );
  }

  return (
    <Svg width={size} height={size}>
      {slices.map((slice, i) => (
        <Path key={i} d={slice.path} fill={slice.color} stroke="#fff" strokeWidth={2} />
      ))}
      {/* Donut hole */}
      <Circle cx={cx} cy={cy} r={r * 0.52} fill="#fff" />
    </Svg>
  );
}

const s = StyleSheet.create({
  container: { alignItems: 'center', justifyContent: 'center' },
  empty:     { position: 'absolute', fontSize: 12, color: '#94A3B8' },
});
