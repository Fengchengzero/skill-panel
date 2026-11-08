/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        panel: {
          bg: "#e8ebf0",
          shell: "rgba(255,255,255,0.78)",
          surface: "#f7f8fb",
          card: "#ffffff",
          ink: "#1c1f27",
          muted: "#8a90a0",
          soft: "#eceff4",
          line: "rgba(28,31,39,0.06)",
          accent: "#2b303b",
          mint: "#d9efe6",
          peach: "#f3e4d8",
          lilac: "#e4e0f2",
        },
      },
      boxShadow: {
        shell: "0 30px 80px rgba(70, 82, 110, 0.12)",
        soft: "0 12px 28px rgba(70, 82, 110, 0.08)",
        float: "0 18px 40px rgba(70, 82, 110, 0.12)",
        inset: "inset 0 1px 0 rgba(255,255,255,0.85)",
        neo: "10px 10px 24px rgba(170,180,200,0.28), -8px -8px 22px rgba(255,255,255,0.95)",
        press: "inset 4px 4px 10px rgba(170,180,200,0.25), inset -4px -4px 10px rgba(255,255,255,0.9)",
      },
      borderRadius: {
        shell: "36px",
        panel: "28px",
        card: "24px",
        tile: "22px",
      },
      fontFamily: {
        // 英文：DM Sans；中文：Noto Sans SC（全站仅此两套）
        sans: ['"DM Sans"', '"Noto Sans SC"', "sans-serif"],
        en: ['"DM Sans"', "sans-serif"],
        zh: ['"Noto Sans SC"', "sans-serif"],
        display: ['"DM Sans"', '"Noto Sans SC"', "sans-serif"],
        body: ['"DM Sans"', '"Noto Sans SC"', "sans-serif"],
        mono: ['"DM Sans"', '"Noto Sans SC"', "sans-serif"],
      },
      backdropBlur: {
        glass: "22px",
      },
    },
  },
  plugins: [],
};
