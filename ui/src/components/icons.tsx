import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement> & { size?: number };
const base = (size = 16): SVGProps<SVGSVGElement> => ({
  width: size, height: size, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor",
  strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round",
});
const mk = (d: React.ReactNode) => ({ size, ...p }: P) => <svg {...base(size)} {...p}>{d}</svg>;

export const IconContainers = mk(<><path d="M8 1.8 13.5 4.9v6.2L8 14.2 2.5 11.1V4.9Z" /><path d="M2.6 4.9 8 8l5.4-3.1M8 8v6.1" /></>);
export const IconImages = mk(<><path d="M8 2 14 5 8 8 2 5Z" /><path d="m2 8 6 3 6-3" /><path d="m2 11 6 3 6-3" /></>);
export const IconVolumes = mk(<><ellipse cx="8" cy="3.8" rx="5.2" ry="1.9" /><path d="M2.8 3.8v8.4c0 1 2.3 1.9 5.2 1.9s5.2-.9 5.2-1.9V3.8" /><path d="M2.8 8c0 1 2.3 1.9 5.2 1.9s5.2-.9 5.2-1.9" /></>);
export const IconBuilds = mk(<><path d="M9.6 2.4 13.6 6.4 11.8 8.2 7.8 4.2Z" /><path d="M9.2 6.8 3 13a1.2 1.2 0 0 1-1.7-1.7L7.5 5.1" /></>);
export const IconNetworks = mk(<><circle cx="8" cy="3.2" r="1.7" /><circle cx="3.2" cy="12.4" r="1.7" /><circle cx="12.8" cy="12.4" r="1.7" /><path d="M7.1 4.7 4 10.9M8.9 4.7l3.1 6.2M4.9 12.4h6.2" /></>);
export const IconPlay = mk(<path d="M5 3.2v9.6l7.6-4.8Z" fill="currentColor" stroke="none" />);
export const IconStop = mk(<rect x="4" y="4" width="8" height="8" rx="1.4" fill="currentColor" stroke="none" />);
export const IconPause = mk(<><rect x="4.2" y="3.5" width="2.4" height="9" rx=".8" fill="currentColor" stroke="none" /><rect x="9.4" y="3.5" width="2.4" height="9" rx=".8" fill="currentColor" stroke="none" /></>);
export const IconRestart = mk(<><path d="M13 8a5 5 0 1 1-1.6-3.7" /><path d="M13 2.6v2.8h-2.8" /></>);
export const IconTrash = mk(<><path d="M3 4.3h10M6.4 4.3V2.8h3.2v1.5M4.4 4.3l.6 9h6l.6-9" /></>);
export const IconTerminal = mk(<><rect x="1.8" y="2.8" width="12.4" height="10.4" rx="2" /><path d="m4.6 6.4 2 1.6-2 1.6M8.4 10h3" /></>);
export const IconLogs = mk(<><path d="M3 4h10M3 8h10M3 12h6" /></>);
export const IconExternal = mk(<><path d="M9.5 2.5h4v4M13.5 2.5 7.5 8.5" /><path d="M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3" /></>);
export const IconSearch = mk(<><circle cx="7" cy="7" r="4.2" /><path d="m10.2 10.2 3.3 3.3" /></>);
export const IconPlus = mk(<path d="M8 3v10M3 8h10" />);
export const IconRefresh = IconRestart;
export const IconChevron = mk(<path d="m6 4 4 4-4 4" />);
export const IconChevronDown = mk(<path d="m4 6 4 4 4-4" />);
export const IconFolder = mk(<path d="M2 4.5a1 1 0 0 1 1-1h3.2l1.4 1.6H13a1 1 0 0 1 1 1v6.4a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1Z" />);
export const IconFile = mk(<><path d="M4 1.8h5.2L12.5 5v9.2H4Z" /><path d="M9 1.8V5h3.5" /></>);
export const IconLink = mk(<><path d="M6.5 9.5 9.5 6.5" /><path d="M7 4.5 8.4 3.1a2.6 2.6 0 0 1 3.7 3.7L10.7 8.2M9 11.5l-1.4 1.4a2.6 2.6 0 0 1-3.7-3.7L5.3 7.8" /></>);
export const IconCopy = mk(<><rect x="5.2" y="5.2" width="8" height="8" rx="1.5" /><path d="M10.8 5.2V3.8a1 1 0 0 0-1-1H3.8a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h1.4" /></>);
export const IconX = mk(<path d="m4 4 8 8M12 4l-8 8" />);
export const IconCheck = mk(<path d="m3.5 8.4 3 3 6-6.6" />);
export const IconWarn = mk(<><path d="M8 2.2 14.2 13H1.8Z" /><path d="M8 6.5v3M8 11.4v.1" /></>);
export const IconInfo = mk(<><circle cx="8" cy="8" r="6" /><path d="M8 7.3v3.8M8 5v.1" /></>);
export const IconDownload = mk(<><path d="M8 2.5v8M4.8 7.5 8 10.7l3.2-3.2" /><path d="M2.8 13.3h10.4" /></>);
export const IconTag = mk(<><path d="M2.5 8.6V2.5h6.1l5 5-6.1 6.1Z" /><circle cx="5.3" cy="5.3" r=".8" /></>);
export const IconBroom = mk(<><path d="m9.5 2 4.5 4.5M11.7 4.3 7.5 8.5" /><path d="M7.7 8.3 3 9.5l-1 4.5 4.5-1 1.2-4.7" /></>);
export const IconStats = mk(<><path d="M2 13.5h12" /><path d="M4 11V8M7 11V4.5M10 11V7M13 11V3" /></>);
export const IconCode = mk(<><path d="m5.5 4.5-3 3.5 3 3.5M10.5 4.5l3 3.5-3 3.5" /></>);
export const IconLayers = IconImages;
export const IconMore = mk(<><circle cx="3.5" cy="8" r=".9" fill="currentColor" /><circle cx="8" cy="8" r=".9" fill="currentColor" /><circle cx="12.5" cy="8" r=".9" fill="currentColor" /></>);
export const IconSpinner = ({ size = 14, ...p }: P) => (
  <svg {...base(size)} {...p} className={"spin " + (p.className ?? "")}><path d="M8 2a6 6 0 1 1-6 6" /></svg>
);
export const IconPlug = mk(<><path d="M5.5 2v3M10.5 2v3" /><path d="M3.8 5h8.4v2.5a4.2 4.2 0 0 1-8.4 0Z" /><path d="M8 11.7V14" /></>);
export const IconSave = mk(<><path d="M3 2.5h8l2.5 2.5v8.5h-11Z" /><path d="M5 2.5V6h5V2.5M5 13.5V9.5h6v4" /></>);
