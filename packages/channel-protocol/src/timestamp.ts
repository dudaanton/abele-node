import { z } from 'zod'

// Preserve the Zod 3 wire grammar, including optional seconds and the existing
// offset syntax. Zod 4's datetime format requires seconds and narrows offsets.
const date = String.raw`((\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\d|3[01])|(0[469]|11)-(0[1-9]|[12]\d|30)|(02)-(0[1-9]|1\d|2[0-8])))`
const time = String.raw`([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d+)?)?`
export const WireTimestampSchema = z
  .string()
  .max(16 * 1024 * 1024)
  .regex(new RegExp(`^${date}T${time}Z$`))
export const WireOffsetTimestampSchema = z
  .string()
  .max(16 * 1024 * 1024)
  .regex(new RegExp(`^${date}T${time}(Z|[+-]\\d{2}:?\\d{2})$`))
