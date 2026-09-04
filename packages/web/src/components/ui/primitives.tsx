import type { ComponentPropsWithoutRef, ReactNode } from 'react';

/* -------------------------------------------------------------------------- */
/* Surfaces                                                                    */
/* -------------------------------------------------------------------------- */

export function Card({ className = '', ...rest }: ComponentPropsWithoutRef<'section'>) {
  return <section className={`card ${className}`} {...rest} />;
}

export function CardHead({
  title,
  hint,
  right,
}: {
  title: ReactNode;
  hint?: ReactNode | undefined;
  right?: ReactNode | undefined;
}) {
  return (
    <header className="flex items-start justify-between gap-4 border-b border-rule px-5 py-3.5">
      <div className="min-w-0">
        <h2 className="text-[0.95rem] leading-tight font-medium">{title}</h2>
        {hint ? <p className="mt-1 text-xs text-muted">{hint}</p> : null}
      </div>
      {right ? <div className="shrink-0">{right}</div> : null}
    </header>
  );
}

/** The small uppercase caption that labels a figure. */
export function Label({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <span className={`label-micro block ${className}`}>{children}</span>;
}

/** A labelled figure. The label is quiet; the number is not. */
export function Stat({
  label,
  value,
  sub,
  align = 'left',
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode | undefined;
  align?: 'left' | 'right' | undefined;
}) {
  return (
    <div className={align === 'right' ? 'text-right' : ''}>
      <Label>{label}</Label>
      <div className="num mt-1 text-lg leading-none">{value}</div>
      {sub ? <div className="mt-1.5 text-xs text-muted">{sub}</div> : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Actions                                                                     */
/* -------------------------------------------------------------------------- */

export type ButtonVariant = 'primary' | 'secondary' | 'quiet' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-accent text-paper border-accent hover:bg-accent-ink hover:border-accent-ink disabled:bg-idle disabled:border-idle',
  secondary: 'bg-raised text-ink border-rule-strong hover:border-accent hover:text-accent',
  quiet: 'bg-transparent text-muted border-transparent hover:text-ink hover:border-rule',
  danger: 'bg-raised text-neg border-neg/40 hover:border-neg',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-xs',
  md: 'h-10 px-4 text-sm',
  lg: 'h-12 px-6 text-[0.95rem]',
};

export function buttonClasses(variant: ButtonVariant = 'secondary', size: ButtonSize = 'md') {
  return [
    'inline-flex items-center justify-center gap-2 rounded-sm border font-medium',
    'transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-60',
    VARIANTS[variant],
    SIZES[size],
  ].join(' ');
}

export function Button({
  variant = 'secondary',
  size = 'md',
  className = '',
  ...rest
}: ComponentPropsWithoutRef<'button'> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return <button className={`${buttonClasses(variant, size)} ${className}`} {...rest} />;
}

/* -------------------------------------------------------------------------- */
/* Form fields                                                                 */
/* -------------------------------------------------------------------------- */

const CONTROL =
  'w-full rounded-sm border border-rule-strong bg-paper px-3 py-2 text-sm text-ink ' +
  'placeholder:text-faint focus:border-accent focus:outline-none';

export function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode | undefined;
  htmlFor?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div>
      <label className="label-micro mb-1.5 block" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint ? <p className="mt-1.5 text-xs text-muted">{hint}</p> : null}
    </div>
  );
}

export function TextInput({ className = '', ...rest }: ComponentPropsWithoutRef<'input'>) {
  return <input className={`${CONTROL} ${className}`} {...rest} />;
}

export function Select({ className = '', ...rest }: ComponentPropsWithoutRef<'select'>) {
  return <select className={`${CONTROL} ${className}`} {...rest} />;
}

export function TextArea({ className = '', ...rest }: ComponentPropsWithoutRef<'textarea'>) {
  return <textarea className={`${CONTROL} font-mono text-xs ${className}`} {...rest} />;
}

/* -------------------------------------------------------------------------- */
/* Layout helpers                                                              */
/* -------------------------------------------------------------------------- */

export function PageHeader({
  eyebrow,
  title,
  lede,
  actions,
}: {
  eyebrow?: ReactNode | undefined;
  title: ReactNode;
  lede?: ReactNode | undefined;
  actions?: ReactNode | undefined;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-6 border-b border-rule pb-6">
      <div className="max-w-2xl">
        {eyebrow ? <Label className="mb-2">{eyebrow}</Label> : null}
        <h1 className="text-3xl leading-tight">{title}</h1>
        {lede ? <p className="mt-2 text-sm text-muted">{lede}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/** A definition row: term on the left, figure hard right, hairline between. */
export function Row({
  term,
  value,
  emphasis = false,
}: {
  term: ReactNode;
  value: ReactNode;
  emphasis?: boolean;
}) {
  return (
    <div className="ledger-row flex items-baseline justify-between gap-6 py-2.5">
      <span className={`text-sm ${emphasis ? 'text-ink' : 'text-muted'}`}>{term}</span>
      <span className={`num text-sm ${emphasis ? 'font-medium text-ink' : 'text-ink'}`}>
        {value}
      </span>
    </div>
  );
}
