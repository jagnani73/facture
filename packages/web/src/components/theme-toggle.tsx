'use client';

import { useEffect, useState } from 'react';

type Choice = 'system' | 'light' | 'dark';

const NEXT: Record<Choice, Choice> = { system: 'light', light: 'dark', dark: 'system' };
const LABEL: Record<Choice, string> = { system: 'Auto', light: 'Day', dark: 'Night' };

/**
 * Light and dark are the same layout on different stock, so this only ever sets
 * a `data-theme` attribute and every colour follows from the tokens.
 */
export function ThemeToggle() {
  const [choice, setChoice] = useState<Choice>('system');

  useEffect(() => {
    const stored = window.localStorage.getItem('facture-theme');
    if (stored === 'light' || stored === 'dark') setChoice(stored);
  }, []);

  function apply(next: Choice) {
    setChoice(next);
    const root = document.documentElement;
    if (next === 'system') {
      root.removeAttribute('data-theme');
      window.localStorage.removeItem('facture-theme');
    } else {
      root.setAttribute('data-theme', next);
      window.localStorage.setItem('facture-theme', next);
    }
  }

  return (
    <button
      type="button"
      onClick={() => apply(NEXT[choice])}
      aria-label={`Appearance: ${LABEL[choice]}. Click to change.`}
      className="label-micro h-7 rounded-xs border border-rule px-2 text-muted transition-colors hover:border-rule-strong hover:text-ink"
    >
      {LABEL[choice]}
    </button>
  );
}
