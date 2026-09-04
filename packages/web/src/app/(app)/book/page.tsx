import type { Metadata } from 'next';

import { BookView } from '@/components/views/book-view';

export const metadata: Metadata = {
  title: 'The book',
  description: 'Every invoice you are owed, with what it is worth today beside it.',
};

export default function BookPage() {
  return <BookView />;
}
