'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  { href: '/book', label: 'The book' },
  { href: '/mandates', label: 'Mandates' },
] as const;

export function SiteNav() {
  const pathname = usePathname();

  return (
    <nav className="flex items-center gap-1" aria-label="Main">
      {LINKS.map((link) => {
        const active = pathname === link.href || pathname.startsWith(`${link.href}/`);
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={active ? 'page' : undefined}
            className={[
              'rounded-xs px-2.5 py-1.5 text-sm transition-colors',
              active ? 'text-ink' : 'text-muted hover:text-ink',
            ].join(' ')}
          >
            {link.label}
            {active ? (
              <span aria-hidden className="mt-1 block h-px w-full bg-accent" />
            ) : (
              <span aria-hidden className="mt-1 block h-px w-full bg-transparent" />
            )}
          </Link>
        );
      })}
    </nav>
  );
}
