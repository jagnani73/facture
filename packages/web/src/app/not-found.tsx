import Link from 'next/link';

import { buttonClasses } from '@/components/ui/primitives';

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center px-6 py-16">
      <p className="label-micro mb-4">Facture</p>
      <h1 className="font-serif text-3xl leading-tight">Nothing here.</h1>
      <p className="mt-3 text-sm text-muted">
        That reference is not in this book. It may have been sold, or the link may have been typed
        wrong.
      </p>
      <div className="mt-6">
        <Link href="/book" className={buttonClasses('secondary')}>
          Go to the book
        </Link>
      </div>
    </main>
  );
}
