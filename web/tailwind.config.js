/** @type {import("tailwindcss").Config} */
// Cobblr brand palette — see docs/BRAND.md §6.
//   slate   #3D4451  primary text, dark backgrounds
//   cobble  #8B7355  warm earth-brown accent, evokes worn stone
//   mortar  #E8E2D5  light cream/beige, surfaces
//   moss    #6B8E4E  success / growth (sparingly)
//   ember   #C7593E  critical actions / errors (very sparingly)
export default {
  // Scan the web app's own sources + every first-party module's UI
  // source so module-only classnames make it into the final CSS.
  // As more modules ship, add them here.
  content: [
    "./index.html",
    "./src/**/*.{ts,tsx}",
    "../modules/inventory/src/ui/**/*.{ts,tsx}",
    "../modules/labels/src/ui/**/*.{ts,tsx}",
    "../modules/projects/src/ui/**/*.{ts,tsx}",
    "../packages/platform-web/src/**/*.{ts,tsx}",
  ],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        slate: {
          DEFAULT: "#3D4451",
          50: "#F4F5F6",
          100: "#E5E7EA",
          200: "#C8CCD2",
          300: "#9CA2AC",
          400: "#6B7280",
          500: "#3D4451",
          600: "#323843",
          700: "#262B33",
          800: "#1B1E23",
          900: "#0F1114",
        },
        cobble: {
          DEFAULT: "#8B7355",
          50: "#F6F2EC",
          100: "#EAE0D0",
          200: "#D5BFA0",
          300: "#BD9F77",
          400: "#A48663",
          500: "#8B7355",
          600: "#6F5C44",
          700: "#544533",
          800: "#382E22",
          900: "#1C1711",
        },
        mortar: {
          DEFAULT: "#E8E2D5",
          50: "#FBF9F4",
          100: "#F4EFE5",
          200: "#E8E2D5",
          300: "#D5CBB4",
          400: "#BFB293",
          500: "#A89875",
        },
        moss: {
          DEFAULT: "#6B8E4E",
          50: "#F1F5EB",
          100: "#DBE7C9",
          200: "#B6CF92",
          300: "#92B65C",
          400: "#7A9F47",
          500: "#6B8E4E",
          600: "#54713E",
          700: "#3F542F",
          800: "#29381F",
          900: "#141C0F",
        },
        ember: {
          DEFAULT: "#C7593E",
          50: "#FBEEEA",
          100: "#F4D1C7",
          200: "#EAA590",
          300: "#DD7959",
          400: "#C7593E",
          500: "#A14530",
          600: "#7B3525",
          700: "#54241A",
          800: "#2D140E",
        },
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
        display: ["Inter", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "monospace"],
      },
    },
  },
  plugins: [],
};
