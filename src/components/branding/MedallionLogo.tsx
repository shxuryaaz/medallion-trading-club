import React from "react";

type Props = {
  className?: string;
  size?: number;
};

/**
 * Medallion Club mark — rimmed medal + “M”. Uses `currentColor` for strokes and fill.
 */
export function MedallionLogo({ className = "", size = 40 }: Props) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 48 48"
      width={size}
      height={size}
      className={className}
      fill="none"
      aria-hidden
    >
      <circle cx="24" cy="24" r="22" stroke="currentColor" strokeWidth="1.25" opacity={0.95} />
      <circle cx="24" cy="24" r="18.5" stroke="currentColor" strokeWidth="0.5" opacity={0.25} />
      <circle cx="24" cy="24" r="15" stroke="currentColor" strokeWidth="1" opacity={0.45} />
      <g stroke="currentColor" strokeWidth="1" strokeLinecap="round" opacity={0.35}>
        <path d="M24 5v2.2M24 40.8V43M5 24h2.2M40.8 24H43M9.9 9.9l1.55 1.55M36.55 36.55l1.55 1.55M9.9 38.1l1.55-1.55M36.55 11.45l1.55-1.55" />
      </g>
      <path
        fill="currentColor"
        d="M14 34V14h3.6l6.4 12.2L30.4 14H34v20h-3.5V19.2L24 30.8 17.5 19.2V34H14z"
      />
    </svg>
  );
}
