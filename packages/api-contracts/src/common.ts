import { z } from '@hono/zod-openapi';

export const ProblemSchema = z
  .object({
    type: z.string(),
    title: z.string(),
    status: z.number().int(),
    code: z.string(),
    requestId: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi('Problem', { description: 'RFC 9457 problem details.' });

export const problemResponse = {
  description: 'RFC 9457 problem details',
  content: { 'application/problem+json': { schema: ProblemSchema } },
} as const;

/** Keyset pagination. See docs/api/conventions.md. */
export const page = <T extends z.ZodType>(item: T) => z.object({ data: z.array(item), nextCursor: z.string().nullable() });

export const PaginationQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
