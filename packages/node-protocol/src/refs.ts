import { z } from 'zod'
/** Literal refs only, never option strings or revision expressions. */
export const RepositoryRefSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/)
  .refine(
    (v) =>
      !v.includes('..') &&
      !v.includes('//') &&
      !v.endsWith('/') &&
      !v.endsWith('.') &&
      v.split('/').every((p) => !p.startsWith('.') && !p.endsWith('.lock'))
  )
