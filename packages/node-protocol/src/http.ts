/** Saved HTTP requests of a project and sending them from the node (`http.v1.*`). Requests and
 * environments are files in the project's `.abele/requests/`; what was sent and what came back is
 * kept beside them, keys blanked before anything is written. Owner-only: reading the project's
 * files does not give the right to send, and a provider session on the node has neither. */
import { z } from 'zod'

const id = z.string().min(1).max(128)
/** A request by its path in the requests folder: `Orders/Create order.http`. */
const requestId = z
  .string()
  .min(1)
  .max(512)
  .regex(/^(?![./])(?!.*\/\.)(?!.*\.\.)[^\\:*?"<>|\0]+\.http$/)
const collection = z
  .string()
  .max(256)
  .regex(/^(?![./])(?!.*\/\.)(?!.*\.\.)[^\\:*?"<>|\0]*$/)
const envName = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/)
const sendId = z.string().regex(/^s[0-9a-z]{6,40}$/)

export const HTTP_VERSION = 1 as const
export const HTTP_V1_CAPABILITY = {
  status: 'supported' as const,
  evidence:
    'requests-as-files; environments; send-and-poll; history-on-node; keys-per-send-never-written; optional-into-recording; owner-only',
}

export const HttpMethodSchema = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])
export type HttpMethodName = z.infer<typeof HttpMethodSchema>

export const HttpPairSchema = z
  .object({
    key: z.string().max(1024),
    value: z.string().max(64 * 1024),
    /** Kept in the request, not sent. */
    off: z.boolean().optional(),
  })
  .strict()
export type HttpPairDoc = z.infer<typeof HttpPairSchema>

export const HttpRequestDocSchema = z
  .object({
    name: z.string().min(1).max(200),
    method: HttpMethodSchema,
    /** As written, `{{variables}}` and `${abele_key:name}` left in. No query: that is `params`. */
    url: z.string().max(8192),
    params: z.array(HttpPairSchema).max(256),
    headers: z.array(HttpPairSchema).max(256),
    body: z
      .object({ format: z.enum(['json', 'text', 'form']), text: z.string().max(1024 * 1024) })
      .strict()
      .optional(),
    /** Plugin scripts by name, run before it goes and after it comes back. */
    scripts: z
      .object({ before: z.string().max(200).optional(), after: z.string().max(200).optional() })
      .strict(),
    checks: z.array(z.string().min(1).max(512)).max(64),
  })
  .strict()
export type HttpRequestDoc = z.infer<typeof HttpRequestDocSchema>

export const HttpLastSchema = z
  .object({
    status: z.number().int().optional(),
    failed: z.boolean().optional(),
    unknown: z.boolean().optional(),
  })
  .strict()

export const HttpRequestSummarySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    method: HttpMethodSchema,
    url: z.string(),
    last: HttpLastSchema.optional(),
  })
  .strict()

export const HttpVarSchema = z
  .object({
    key: z.string().min(1).max(256),
    /** None for a secret: its value lives in memory only, given with each send. */
    value: z
      .string()
      .max(64 * 1024)
      .optional(),
    /** A token from an answer: never written, blanked wherever it shows. */
    secret: z.boolean().optional(),
    off: z.boolean().optional(),
  })
  .strict()
export type HttpVar = z.infer<typeof HttpVarSchema>

export const HttpEnvironmentSchema = z
  .object({
    name: envName,
    vars: z.array(HttpVarSchema).max(256),
    /** Adds `X-Abele-Step` to what is sent into a recording, so a record point can take it. */
    step_header: z.boolean().optional(),
    /** Values from `<name>.local.json`, which stays on this machine and out of git. */
    local: z.array(z.string()).optional(),
  })
  .strict()
export type HttpEnvironmentDoc = z.infer<typeof HttpEnvironmentSchema>

export const HttpResponseSchema = z
  .object({
    status: z.number().int(),
    reason: z.string(),
    ms: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
    headers: z.array(z.object({ key: z.string(), value: z.string() }).strict()),
    /** The start of the body; the rest is read with `http.v1.body`. */
    body: z.string(),
    /** More of the body is on the node than came here. */
    more: z.boolean().optional(),
    /** The body was longer than the node keeps, and was cut. */
    cut: z.boolean().optional(),
  })
  .strict()
export type HttpResponseDoc = z.infer<typeof HttpResponseSchema>

export const HttpOutcomeSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('sending') }).strict(),
  z.object({ state: z.literal('answered'), response: HttpResponseSchema }).strict(),
  /** It never reached the server. */
  z.object({ state: z.literal('failed'), reason: z.string() }).strict(),
  /** No answer in time, or the line went mid-way: it may have gone through. Never sent again. */
  z
    .object({ state: z.literal('unknown'), reason: z.string(), after_ms: z.number().int() })
    .strict(),
])
export type HttpOutcomeDoc = z.infer<typeof HttpOutcomeSchema>

export const HttpSendSummarySchema = z
  .object({
    id: z.string(),
    at: z.string(),
    environment: z.string().optional(),
    method: HttpMethodSchema,
    url: z.string(),
    status: z.number().int().optional(),
    failed: z.boolean().optional(),
    unknown: z.boolean().optional(),
    ms: z.number().int().optional(),
    bytes: z.number().int().optional(),
    /** Sent into a recording: the run and its step. */
    run: z.object({ run_id: z.string(), step: z.string().optional() }).strict().optional(),
  })
  .strict()
export type HttpSendSummary = z.infer<typeof HttpSendSummarySchema>

export const HttpSendStatusSchema = z
  .object({
    send: HttpSendSummarySchema,
    outcome: HttpOutcomeSchema,
    /** Steps the record points took while it was out, when it went into a recording. */
    code_steps: z.number().int().optional(),
  })
  .strict()

const project = { project_id: id }

export const HttpMethodSchemas = {
  'http.v1.list': z.object(project).strict(),
  'http.v1.request.get': z.object({ ...project, id: requestId }).strict(),
  /** Writes the request at `id`; `from` moves it there from another path (a rename). */
  'http.v1.request.save': z
    .object({
      ...project,
      id: requestId,
      request: HttpRequestDocSchema,
      from: requestId.optional(),
      /** Refuses to write over a request already there. */
      create: z.boolean().optional(),
    })
    .strict(),
  'http.v1.request.delete': z.object({ ...project, id: requestId }).strict(),
  'http.v1.collection.create': z.object({ ...project, name: collection.min(1) }).strict(),
  'http.v1.env.get': z.object({ ...project, name: envName }).strict(),
  'http.v1.env.save': z
    .object({ ...project, environment: HttpEnvironmentSchema.omit({ local: true }) })
    .strict(),
  'http.v1.env.delete': z.object({ ...project, name: envName }).strict(),
  /** Sends one request as the plugin made it: variables put in, keys given by value for this send
   * only. Answers at once; `http.v1.send.status` follows it. */
  'http.v1.send': z
    .object({
      ...project,
      request_id: requestId.optional(),
      environment: envName.optional(),
      method: HttpMethodSchema,
      url: z
        .string()
        .min(1)
        .max(16 * 1024),
      headers: z
        .array(z.object({ key: z.string().min(1).max(1024), value: z.string().max(64 * 1024) }))
        .max(256),
      body: z
        .string()
        .max(4 * 1024 * 1024)
        .optional(),
      /** Values to blank wherever they show: keys and secret variables. Never written. */
      secrets: z
        .array(
          z
            .string()
            .min(1)
            .max(64 * 1024)
        )
        .max(64),
      timeout_ms: z.number().int().min(1000).max(300_000).optional(),
      /** Into the recording of this debugger session. */
      debug_session_id: id.optional(),
      step_header: z.boolean().optional(),
    })
    .strict(),
  'http.v1.send.status': z.object({ ...project, send_id: sendId }).strict(),
  'http.v1.history': z
    .object({ ...project, id: requestId, limit: z.number().int().min(1).max(200).optional() })
    .strict(),
  /** One page of a kept answer's body. */
  'http.v1.body': z
    .object({ ...project, send_id: sendId, from: z.number().int().min(0).optional() })
    .strict(),
} as const
export type HttpMethodNameV1 = keyof typeof HttpMethodSchemas

export const HttpListResultSchema = z
  .object({
    folder: z.string(),
    collections: z.array(
      z.object({ name: z.string(), requests: z.array(HttpRequestSummarySchema) }).strict()
    ),
    environments: z.array(z.string()),
  })
  .strict()
export const HttpBodyPageSchema = z
  .object({ text: z.string(), next: z.number().int().optional(), bytes: z.number().int() })
  .strict()
