import { eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { characters } from '../db/schema/index.js';
import { assertDefined } from './assertDefined.js';

export interface CreateCharacterInput {
  bookId: string;
  name: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

export class CharacterRepository {
  constructor(private readonly db: Database) {}

  async create(input: CreateCharacterInput) {
    const [row] = await this.db.insert(characters).values(input).returning();
    return assertDefined(row, 'CharacterRepository.create');
  }

  async findById(characterId: string) {
    const [row] = await this.db.select().from(characters).where(eq(characters.id, characterId));
    return row ?? null;
  }

  async listByBook(bookId: string) {
    return this.db.select().from(characters).where(eq(characters.bookId, bookId));
  }
}
