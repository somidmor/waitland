import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

const common = {
  "aria-hidden": true,
  focusable: false,
  viewBox: "0 0 24 24",
} as const;

export function PeopleIcon(props: IconProps) {
  return (
    <svg {...common} {...props}>
      <path
        d="M8.1 11.2a3.55 3.55 0 1 0 0-7.1 3.55 3.55 0 0 0 0 7.1Zm7.45.3a2.9 2.9 0 1 0 0-5.8 2.9 2.9 0 0 0 0 5.8ZM2.4 19.7c0-3.65 2.18-6 5.7-6s5.7 2.35 5.7 6v.2H2.4v-.2Zm11.9.2c.03-.3.05-.6.05-.9 0-1.82-.52-3.32-1.5-4.45.78-.48 1.72-.72 2.8-.72 3.13 0 5.05 2.1 5.05 5.35v.72h-6.4Z"
        fill="currentColor"
      />
    </svg>
  );
}

export function SendIcon(props: IconProps) {
  return (
    <svg {...common} {...props}>
      <path
        d="m3.05 4.16 17.03 7.1a.8.8 0 0 1 0 1.48L3.05 19.83a.8.8 0 0 1-1.08-.86l.78-5.2 10.28-1.77L2.75 10.23l-.78-5.2a.8.8 0 0 1 1.08-.87Z"
        fill="currentColor"
      />
    </svg>
  );
}

export function CompassIcon(props: IconProps) {
  return (
    <svg {...common} {...props}>
      <circle cx="12" cy="12" r="8.65" fill="none" stroke="currentColor" strokeWidth="1.7" />
      <path d="m15.82 8.18-2.34 5.3-5.3 2.34 2.34-5.3 5.3-2.34Z" fill="currentColor" />
    </svg>
  );
}

export function EditIcon(props: IconProps) {
  return (
    <svg {...common} {...props}>
      <path
        d="m14.7 4.3 5 5M4.1 19.9l3.25-.72L19 7.52a1.58 1.58 0 0 0 0-2.23l-.3-.3a1.58 1.58 0 0 0-2.23 0L4.82 16.65 4.1 19.9Z"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.75"
      />
    </svg>
  );
}

export function StoneIcon(props: IconProps) {
  return (
    <svg {...common} {...props}>
      <path
        d="M4.25 16.1 6.4 8.35l4.85-3.05 5.9 2.08 2.6 6.7-3.2 4.62H8.18L4.25 16.1Z"
        fill="currentColor"
      />
      <path
        d="m6.4 8.35 5.05 2.1 5.7-3.07m-5.7 3.07-.38 5.42m.38-5.42 3.62 3.24 4.68.39m-8.68 1.79L8.18 18.7m2.89-2.83 4 1.03 1.48 1.8"
        fill="none"
        opacity=".28"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1"
      />
    </svg>
  );
}
