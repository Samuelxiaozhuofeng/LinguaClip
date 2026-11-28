/** @type {import('tailwindcss').Config} */
// "Cinema": light ground, white sheets, near-black type, one vermilion accent. Nothing else.
export default {
  darkMode: 'class', // utils/theme.ts puts `dark` on <html>
  content: ['./index.html', './*.tsx', './components/**/*.tsx', './hooks/**/*.{ts,tsx}', './utils/**/*.ts', './pro/**/*.{ts,tsx}', './mobile/**/*.{html,ts,tsx}'],
  theme: {
    extend: {
      // Each colour reads a CSS variable (space-separated RGB) that index.css sets for light
      // (:root) and dark (html.dark), so `bg-ink/40`-style opacity keeps working.
      colors: {
        paper: 'rgb(var(--c-paper) / <alpha-value>)',   // app background
        page: 'rgb(var(--c-page) / <alpha-value>)',     // raised surfaces: sheets, dialogs, menus
        shade: 'rgb(var(--c-shade) / <alpha-value>)',   // quiet fills: inputs, pills, hover
        line: 'rgb(var(--c-line) / <alpha-value>)',     // hairlines
        faint: 'rgb(var(--c-faint) / <alpha-value>)',   // placeholders, empty word slots
        mute: 'rgb(var(--c-mute) / <alpha-value>)',     // secondary text
        ink: 'rgb(var(--c-ink) / <alpha-value>)',       // primary text
        inverse: 'rgb(var(--c-inverse) / <alpha-value>)', // text on a bg-ink fill (white in light, dark in dark)
        accent: 'rgb(var(--c-accent) / <alpha-value>)', // the one colour: caret, current word, wrong word, primary action
        'accent-soft': 'rgb(var(--c-accent-soft) / <alpha-value>)',
      },
      fontFamily: {
        sans: ['"Instrument Sans"', '"PingFang SC"', '"Microsoft YaHei"', 'system-ui', 'sans-serif'],
        // Only the lines being learned are serif; Chinese falls back to PingFang, never Songti.
        serif: ['"Source Serif 4"', '"PingFang SC"', 'Georgia', 'serif'],
        mono: ['"Instrument Sans"', '"PingFang SC"', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        card: 'var(--shadow-card)',
        lift: 'var(--shadow-lift)',
      },
    },
  },
}
