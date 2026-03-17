/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./views/**/*.{ejs,html,js,jsx,ts,tsx}",   // ← must include .ejs !
    "./public/**/*.{html,js,jsx,ts,tsx}",
    // Add any other folders where you write Tailwind classes
  ],
  theme: {
    extend: {
      // your custom colors/fonts/etc. can go here later
    },
  },
  plugins: [],
}