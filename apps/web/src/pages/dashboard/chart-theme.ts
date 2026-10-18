/*
 * Chart colours for SVG attributes (Recharts). They mirror the CSS tokens in
 * styles/tokens.css. The series colour was validated with the dataviz palette checker
 * against the chart surface (#17181c, dark mode): lightness band, chroma and >= 3:1
 * contrast pass. Every chart plots a single series, so one series colour is used.
 */
export const CHART = {
  surface: '#17181c',
  series: '#1f9fb0',
  /** Area wash under the line (~10 % of the series colour). */
  seriesFillOpacity: 0.1,
  grid: '#2a2c33',
  axis: '#3b3e48',
  tickText: '#8f8e9c',
  reference: '#5a5d6a',
  referenceText: '#a9a8b6',
  cursor: '#8f8e9c',
} as const;
