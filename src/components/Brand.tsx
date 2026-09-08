import { useId } from 'react';
import { cn } from '@/lib/utils';

/**
 * MasteringPro brand mark — the "MP" waveform monogram, simplified to five
 * bars so it stays legible from favicon size up. Colour follows the logo
 * (white → brand blue gradient). Size it with `className` (w-* h-*).
 */
export function BrandMark({ className }: { className?: string }) {
  const id = useId();
  return (
    <svg
      viewBox="0 0 64 64"
      className={cn('h-7 w-7', className)}
      role="img"
      aria-label="MasteringPro"
    >
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#f4f7fb" />
          <stop offset="0.55" stopColor="#8fd0f7" />
          <stop offset="1" stopColor="hsl(205 90% 54%)" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="14" fill="hsl(240 6% 4%)" />
      <rect
        x="0.75"
        y="0.75"
        width="62.5"
        height="62.5"
        rx="13.25"
        fill="none"
        stroke="hsl(0 0% 100% / 0.08)"
        strokeWidth="1.5"
      />
      <g fill={`url(#${id})`}>
        <rect x="14" y="27" width="5" height="10" rx="2.5" />
        <rect x="23" y="20" width="5" height="24" rx="2.5" />
        <rect x="32" y="12" width="5" height="40" rx="2.5" />
        <rect x="41" y="18" width="5" height="28" rx="2.5" />
        <rect x="50" y="25" width="5" height="14" rx="2.5" />
      </g>
    </svg>
  );
}

/** Wordmark: "Mastering" in the foreground colour, "Pro" in brand blue. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn('font-display font-bold tracking-tight text-foreground', className)}>
      Mastering<span className="text-primary">Pro</span>
    </span>
  );
}

/** Mark + wordmark lockup, used in headers and footers. */
export function BrandLockup({
  className,
  markClassName,
  wordmarkClassName,
}: {
  className?: string;
  markClassName?: string;
  wordmarkClassName?: string;
}) {
  return (
    <span className={cn('flex items-center gap-2.5', className)}>
      <BrandMark className={markClassName} />
      <Wordmark className={wordmarkClassName} />
    </span>
  );
}
