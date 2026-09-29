/** @type {import('tailwindcss').Config} */
// "Cinema": light ground, white sheets, near-black type, one vermilion accent. Nothing else.
export default {
  content: ['./index.html', './*.tsx', './components/**/*.tsx', './hooks/**/*.{ts,tsx}', './utils/**/*.ts', './pro/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        paper: '#FAFAFA',   // app background
        page: '#FFFFFF',    // raised surfaces: sheets, dialogs, menus
        shade: '#F4F4F3',   // quiet fills: inputs, pills, hover
        line: '#E7E5E4',    // hairlines
        faint: '#D6D3D1',   // placeholders, empty word slots
        mute: '#78716C',    // secondary text
        ink: '#1C1917',     // primary text
        accent: '#E8492B',  // the one colour: caret, current word, wrong word, primary action
        'accent-soft': '#FDECE8',
      },
      fontFamily: {
        sans: ['"Instrument Sans"', '"PingFang SC"', '"Microsoft YaHei"', 'system-ui', 'sans-serif'],
        // Only the lines being learned are serif; Chinese falls back to PingFang, never Songti.
        serif: ['"Source Serif 4"', '"PingFang SC"', 'Georgia', 'serif'],
        mono: ['"Instrument Sans"', '"PingFang SC"', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        card: '0 1px 3px rgba(0,0,0,.08)',
        lift: '0 16px 40px rgba(0,0,0,.14)',
      },
    },
  },
}
