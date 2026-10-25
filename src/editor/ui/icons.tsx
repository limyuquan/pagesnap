/**
 * Page Snap's own icon set (owner: C). Drawn on a 20 px grid with a 1.5 px stroke, round caps and
 * joins, so every glyph shares one weight. No icon packs: they cost bundle size and never quite
 * match each other.
 */
import type { SVGProps } from 'react';
import type { Tool } from '@/editor/engine';

type IconProps = SVGProps<SVGSVGElement>;

function Svg({ children, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

export const SelectIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5.5 3.5v11.8l3.1-2.9 2.2 4.5 2-.95-2.2-4.45 4.3-.2z" />
  </Svg>
);

export const ArrowIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4.5 15.5 15 5" />
    <path d="M8.3 4.75H15.25V11.7" />
  </Svg>
);

export const RectIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3.25" y="4.75" width="13.5" height="10.5" rx="2" />
  </Svg>
);

export const UnderlineIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6.25 3.75v5.5a3.75 3.75 0 0 0 7.5 0v-5.5" />
    <path d="M4.25 16.5h11.5" strokeWidth={1.75} />
  </Svg>
);

export const HighlightIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.25 17h7" strokeWidth={2.5} strokeLinecap="butt" opacity={0.45} />
    <path d="m12.4 3.4 4.2 4.2-6.9 6.9H5.5v-4.2z" />
    <path d="m10.3 5.5 4.2 4.2" />
  </Svg>
);

export const PenIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.25 14.25c1.6-3.4 3.1-6.9 4.6-6.9 1.9 0-.1 7.1 1.9 7.1 1.8 0 2.7-6.95 4.6-6.95 1.2 0 1.25 2.15 2.4 2.15" />
  </Svg>
);

export const TextIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4.75 4.75h10.5" />
    <path d="M10 4.75v11" />
    <path d="M7.75 15.75h4.5" />
  </Svg>
);

export const UndoIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M7.25 5.25 4.25 8.25l3 3" />
    <path d="M4.5 8.25h7.25a4 4 0 0 1 0 8H9" />
  </Svg>
);

export const RedoIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="m12.75 5.25 3 3-3 3" />
    <path d="M15.5 8.25H8.25a4 4 0 0 0 0 8H11" />
  </Svg>
);

export const DownloadIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M10 3.5v9" />
    <path d="m6.5 9.25 3.5 3.5 3.5-3.5" />
    <path d="M4.25 13.75v1.5a1 1 0 0 0 1 1h9.5a1 1 0 0 0 1-1v-1.5" />
  </Svg>
);

export const CheckIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="m4.75 10.5 3.4 3.4 7.1-7.4" strokeWidth={1.75} />
  </Svg>
);

export const NoticeIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="10" cy="10" r="7.25" />
    <path d="M10 6.5v4.25" />
    <circle cx="10" cy="13.6" r=".4" fill="currentColor" />
  </Svg>
);

export const InfoIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="10" cy="10" r="7.25" />
    <path d="M10 9.25v4.25" />
    <circle cx="10" cy="6.4" r=".4" fill="currentColor" />
  </Svg>
);

export const CloseIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="m5.5 5.5 9 9M14.5 5.5l-9 9" />
  </Svg>
);

export const SpinnerIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M10 3.25a6.75 6.75 0 1 1-6.75 6.75" />
  </Svg>
);

export const ChevronIcon = (p: IconProps) => (
  <svg
    viewBox="0 0 10 10"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.4}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
    {...p}
  >
    <path d="m2.5 4 2.5 2.5L7.5 4" />
  </svg>
);

export const TOOL_ICONS: Readonly<Record<Tool, (p: IconProps) => React.JSX.Element>> = {
  select: SelectIcon,
  arrow: ArrowIcon,
  rect: RectIcon,
  underline: UnderlineIcon,
  highlight: HighlightIcon,
  pen: PenIcon,
  text: TextIcon,
};
