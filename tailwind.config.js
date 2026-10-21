/** @type {import('tailwindcss').Config} */
export default {
  content: ['./sidecar/public/**/*.html'],
  safelist: [
    'fixed', 'top-3', 'right-3', 'z-50', 'transform', 'transition-all', 'duration-300',
    'opacity-100', 'opacity-0', 'translate-y-0', 'pointer-events-none',
    'bg-emerald-950/90', 'border-emerald-500/30', 'text-emerald-300', 'text-emerald-400', 'bg-emerald-500/10', 'border-emerald-500/20',
    'bg-rose-950/90', 'border-rose-500/30', 'text-rose-300', 'text-rose-400', 'bg-rose-500/10', 'border-rose-500/20',
    'text-amber-400', 'bg-amber-400/10', 'border-amber-400/20',
    'w-1.5', 'h-1.5', 'rounded-full', 'bg-emerald-400', 'bg-slate-500', 'animate-pulse'
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        brand: {
          500: '#0284c7',
          600: '#0369a1',
        }
      }
    }
  }
};
