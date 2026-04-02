import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#f0f4ff',
          100: '#e0eaff',
          500: '#4361ee',
          600: '#3451d1',
          700: '#2741b0',
          900: '#1a2a7a',
        },
        surface: '#f8fafc',
      },
    },
  },
  plugins: [],
}
export default config
