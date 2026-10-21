import { z } from 'zod'

export const QuestionnaireQuestionSchema = z
  .object({
    question: z.string().min(1).max(4096),
    options: z.array(z.string().min(1).max(4096)).max(50).default([]),
    type: z.enum(['input', 'single', 'multi']).optional(),
    allow_custom: z.boolean().optional(),
  })
  .strict()
export const QuestionnaireQuestionsSchema = z
  .array(QuestionnaireQuestionSchema)
  .min(1)
  .max(20)
  .refine((q) => JSON.stringify(q).length <= 16384)
export const QuestionnaireAnswerSchema = z.union([
  z.string().min(1).max(4096),
  z.array(z.string().min(1).max(4096)).min(1).max(50),
])
export const QuestionnaireAnswersSchema = z
  .array(QuestionnaireAnswerSchema)
  .min(1)
  .max(20)
  .refine((a) => JSON.stringify(a).length <= 16384)
export type QuestionnaireAnswer = z.infer<typeof QuestionnaireAnswerSchema>
