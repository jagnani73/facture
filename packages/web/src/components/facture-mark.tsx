import { CURVE, LINE_WIDTH, NODE, PAR_LINE, RULE_WIDTH, RULES, VIEW_BOX } from '@/lib/mark';

/**
 * The Facture mark, inline.
 *
 * Inline rather than an `<img>` because the app has a manual theme toggle: an external
 * SVG can only follow the operating system, so a reader who forces light on a dark
 * desktop would get a mark in the wrong ink. Drawn here, it takes ink from
 * `currentColor` and the accent from `--accent`, which both follow `data-theme`.
 *
 * Decorative by default. The wordmark it sits beside is the accessible name, and a
 * second one would make every link announce the company twice.
 */
export function FactureMark({ className, title }: { className?: string; title?: string }) {
  return (
    <svg
      viewBox={VIEW_BOX}
      className={className}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      <g fill="none" stroke="currentColor" strokeLinecap="butt">
        <path d={CURVE} strokeWidth={LINE_WIDTH} />
        {RULES.map((rule) => (
          <path
            key={rule.y}
            d={`M ${rule.x1} ${rule.y} H ${rule.x2}`}
            strokeWidth={RULE_WIDTH}
          />
        ))}
      </g>
      <path d={PAR_LINE} fill="none" stroke="var(--accent)" strokeWidth={LINE_WIDTH} />
      <circle cx={NODE.cx} cy={NODE.cy} r={NODE.r} fill="var(--accent)" />
    </svg>
  );
}
