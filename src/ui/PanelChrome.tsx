import type { ReactNode } from "react";

/**
 * Shared panel chrome — the V2 control-kit building blocks
 * (ROADMAP-UI-2027, Vlna 2).
 *
 * One header/section language for every dock panel: a slim header identifies
 * the surface (kicker + title) and hosts its panel-level ACTIONS, and content
 * groups into raised cards (PanelSection) instead of flat button soup.
 *
 * The dock tab row already says WHICH panel is open — these headers carry the
 * panel's context (track, mode) and its primary actions, not a redundant name
 * banner.
 */

interface PanelHeaderProps {
  /** Tiny mono kicker above/next to the title — the surface name (MIXER, DEVICES). */
  kicker: string;
  /** Contextual title — what the panel currently acts on (track name, mode). */
  title?: string;
  /** One-line usage hint, right of the title. */
  hint?: string;
  /** Right-aligned actions (selects, primary buttons). */
  actions?: ReactNode;
  children?: ReactNode;
}

export function PanelHeader({ kicker, title, hint, actions, children }: PanelHeaderProps) {
  return (
    <header className="panel-header">
      <div className="panel-header-id">
        <span className="panel-kicker">{kicker}</span>
        {title && <span className="panel-title-line">{title}</span>}
        {hint && <span className="panel-hint">{hint}</span>}
      </div>
      {actions && (
        <div className="panel-actions" role="group" aria-label={`${kicker} actions`}>
          {actions}
        </div>
      )}
      {children}
    </header>
  );
}

interface PanelSectionProps {
  /** Card caption (mono, uppercase). */
  title?: string;
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}

export function PanelSection({ title, actions, className, children }: PanelSectionProps) {
  return (
    <section className={"panel-section" + (className ? ` ${className}` : "")}>
      {(title || actions) && (
        <div className="panel-section-head">
          {title && <span className="panel-section-title">{title}</span>}
          {actions && <div className="panel-section-actions">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

interface EmptyStateProps {
  /** Single glyph — an emoji or symbol, sized by the CSS. */
  icon: string;
  title: string;
  hint?: string;
  children?: ReactNode;
}

/**
 * Shared empty state (Vlna 4): an empty panel explains ITSELF — what is
 * missing and the first move to fill it — instead of a bare one-liner.
 */
export function EmptyState({ icon, title, hint, children }: EmptyStateProps) {
  return (
    <div className="empty-state" role="note">
      <span className="empty-state-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="empty-state-title">{title}</span>
      {hint && <span className="empty-state-hint">{hint}</span>}
      {children}
    </div>
  );
}
