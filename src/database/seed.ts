import { hash } from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { users } from './schema';

const DEFAULT_DATABASE_URL =
  'postgresql://postgres:postgres@localhost:5432/matchmaker';

async function seed(): Promise<void> {
  const connectionString = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
  const client = postgres(connectionString, {
    max: 1,
    prepare: false,
  });

  const db = drizzle(client, { schema: { users } });

  try {
    const demoEmail = 'demo@matchmaker.local';

    const [existingUser] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, demoEmail))
      .limit(1);

    if (existingUser) {
      console.log('Seed skipped: demo user already exists.');
      return;
    }

    const passwordHash = await hash('Password123!', 12);

    await db.insert(users).values({
      email: demoEmail,
      passwordHash,
      firstName: 'Demo',
      lastName: 'User',
      birthDate: '1998-01-01',
      gender: 'other',
      bio: 'Initial seeded account for local development.',
      referralCode: 'DEMO0001',
    });

    console.log('Seed complete: demo user created.');
  } finally {
    await client.end();
  }
}

void seed();
