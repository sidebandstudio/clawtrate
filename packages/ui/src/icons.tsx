// Line icons drawn for this app: a 16px grid and a 1.6px round stroke.

import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

function Icon({ children, className, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={className ? `icon ${className}` : "icon"}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

export const PanelIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="2" y="2.75" width="12" height="10.5" rx="2.5" />
    <path d="M10 2.75v10.5" />
  </Icon>
);

export const ChevronIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="m6 3.5 4.5 4.5L6 12.5" />
  </Icon>
);

export const CopyIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="5.25" y="5.25" width="8" height="8" rx="2" />
    <path d="M10.75 5.25V4a1.25 1.25 0 0 0-1.25-1.25H4A1.25 1.25 0 0 0 2.75 4v5.5A1.25 1.25 0 0 0 4 10.75h1.25" />
  </Icon>
);

export const CheckIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="m3.25 8.5 3 3 6.5-7" />
  </Icon>
);

export const EyeIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M1.75 8S4 3.75 8 3.75 14.25 8 14.25 8 12 12.25 8 12.25 1.75 8 1.75 8Z" />
    <circle cx="8" cy="8" r="1.9" />
  </Icon>
);

export const CloseIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="m4 4 8 8M12 4l-8 8" />
  </Icon>
);

export const BackIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M10 3.5 5.5 8l4.5 4.5" />
  </Icon>
);

export const ArrowDownIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M8 3.25v9.25M4.25 8.75 8 12.5l3.75-3.75" />
  </Icon>
);

export const ArrowUpIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M8 12.75V3.5M4.25 7.25 8 3.5l3.75 3.75" />
  </Icon>
);

export const SearchIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="7.1" cy="7.1" r="4.35" />
    <path d="m10.4 10.4 3.1 3.1" />
  </Icon>
);

export const PlusIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M8 3v10M3 8h10" />
  </Icon>
);

export const SettingsIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M2.75 5h5.5M11.75 5h1.5M2.75 11h1.5M7.75 11h5.5" />
    <circle cx="10" cy="5" r="1.75" />
    <circle cx="6" cy="11" r="1.75" />
  </Icon>
);

export const FileIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M4 2.75h5.25L12 5.5v7.75H4V2.75ZM9 2.75V5.5h3" />
  </Icon>
);

export const ScreenIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="2.25" y="3" width="11.5" height="8" rx="1.75" />
    <path d="M6 13.5h4M8 11v2.5" />
  </Icon>
);

export const WarnIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M8 2.5 14 13H2L8 2.5Z" />
    <path d="M8 6.5v3" />
    <path d="M8 11.4v.1" />
  </Icon>
);

export const PinIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M5.75 2.75h4.5M6.75 2.75v3.5L4.5 9.25h7l-2.25-3v-3.5M8 9.25v4" />
  </Icon>
);

export const HideIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M6.4 3.6A6.7 6.7 0 0 1 8 3.4c3.4 0 5.6 3 6 4.6-.2.6-.6 1.4-1.3 2.2M4.3 4.6C3 5.5 2.2 6.9 2 8c.4 1.6 2.6 4.6 6 4.6 1.2 0 2.2-.4 3.1-.9" />
    <path d="M6.6 6.6a2 2 0 0 0 2.8 2.8M2.75 2.75l10.5 10.5" />
  </Icon>
);

export const SortIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M3 4.5h10M3 8h7M3 11.5h4" />
  </Icon>
);

/** A filled five-pointed star, for the primary bot's badge. */
export const StarIcon = (props: IconProps) => (
  <Icon {...props} fill="currentColor" stroke="none">
    <path d="m8 1.9 1.8 3.8 4.1.5-3 2.9.8 4.1L8 11.2l-3.7 2 .8-4.1-3-2.9 4.1-.5L8 1.9Z" />
  </Icon>
);
