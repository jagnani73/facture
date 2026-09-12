import type { Metadata } from 'next';

import { ProfileView } from '@/components/views/profile-view';

export const metadata: Metadata = {
  title: 'Your profile',
  description: 'What this venue calls you, and what a counterparty reads off the chain.',
};

export default function ProfilePage() {
  return <ProfileView />;
}
