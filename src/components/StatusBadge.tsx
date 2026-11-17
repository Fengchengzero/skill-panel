import type { ReactNode } from "react";
import { Loader2, type LucideIcon } from "lucide-react";
import { cn } from "../lib/cn";

export type StatusKind =
  | "pinned"
  | "modified"
  | "update"
  | "generating"
  | "dupes"
  | "native"
  | "select";

const STYLES: Record<StatusKind, string> = {
  pinned: "bg-panel-ink text-white",
  modified: "bg-amber-500 text-white",
  update: "bg-slate-500 text-white",
  generating: "bg-white/90 text-panel-ink ring-1 ring-panel-line",
  dupes: "bg-amber-50 text-amber-900 ring-1 ring-amber-200/80",
  native: "bg-white text-panel-ink shadow-inset",
  select: "bg-panel-accent text-white shadow-soft",
};

const CHIP_STYLES: Record<"modified" | "native" | "select" | "dupes" | "neutral", string> = {
  modified: "bg-amber-50 text-amber-900 shadow-inset",
  native: "bg-white text-panel-ink shadow-inset",
  select: "bg-panel-accent text-white shadow-soft",
  dupes: "bg-white text-panel-ink shadow-inset",
  neutral: "text-panel-muted hover:bg-white/80",
};

interface BadgeProps {
  kind: StatusKind;
  children: ReactNode;
  className?: string;
  icon?: LucideIcon;
  spinning?: boolean;
  onClick?: () => void;
  title?: string;
}

export function StatusBadge({
  kind,
  children,
  className,
  icon: Icon,
  spinning,
  onClick,
  title,
}: BadgeProps) {
  const classNames = cn(
    "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold",
    STYLES[kind],
    onClick && "transition hover:brightness-105",
    className
  );
  const content = (
    <>
      {spinning ? (
        <Loader2 size={10} className="animate-spin" aria-hidden="true" />
      ) : Icon ? (
        <Icon size={10} aria-hidden="true" />
      ) : null}
      {children}
    </>
  );
  if (onClick) {
    return (
      <button type="button" onClick={onClick} title={title} className={classNames}>
        {content}
      </button>
    );
  }
  return (
    <span title={title} className={classNames}>
      {content}
    </span>
  );
}

interface ChipProps {
  kind?: keyof typeof CHIP_STYLES;
  active?: boolean;
  children: ReactNode;
  className?: string;
  onClick?: () => void;
  title?: string;
  "aria-pressed"?: boolean;
}

/** Sidebar filter chips — shares semantic colors with StatusBadge. */
export function StatusChip({
  kind = "neutral",
  active = false,
  children,
  className,
  onClick,
  title,
  "aria-pressed": ariaPressed,
}: ChipProps) {
  const tone = active
    ? kind === "neutral"
      ? CHIP_STYLES.native
      : (CHIP_STYLES[kind] ?? CHIP_STYLES.native)
    : CHIP_STYLES.neutral;

  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={ariaPressed}
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-1 text-[10px] font-medium transition",
        tone,
        className
      )}
    >
      {children}
    </button>
  );
}
