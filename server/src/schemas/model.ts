/**
 * Builders that make a Zod schema document itself consistently in the generated spec.
 *
 * Every model and every field gets a title ("account_id" becomes "Account Id"), except a field
 * that is a reference to another component, alone or `| null`. Every parameter is titled.
 * openapi-typescript turns these titles into the client's doc comments.
 */

import { z } from '@hono/zod-openapi'

/** Schemas registered as components, so fields that refer to them stay untitled. */
const components = new WeakSet<z.ZodType>()

/** Title case with underscores as spaces: "get_llm_status" -> "Get Llm Status". */
export function title(name: string): string {
  return name
    .toLowerCase()
    .replace(/(^|[^a-z])([a-z])/g, (_, before: string, letter: string) => before + letter.toUpperCase())
    .replaceAll('_', ' ')
}

/** Does this field refer to a component, directly or through optional, default, or `| null`? */
function refersToComponent(schema: z.ZodType): boolean {
  if (components.has(schema)) return true
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable || schema instanceof z.ZodDefault) {
    return refersToComponent(schema.def.innerType as z.ZodType)
  }
  if (schema instanceof z.ZodUnion) return (schema.def.options as z.ZodType[]).some(refersToComponent)
  if (schema instanceof z.ZodLazy) return refersToComponent(schema.def.getter() as z.ZodType)
  return false
}

function titled<S extends z.ZodRawShape>(shape: S, all: boolean): S {
  return Object.fromEntries(
    Object.entries(shape).map(([name, field]) => {
      const schema = field as z.ZodType
      return [name, all || !refersToComponent(schema) ? schema.openapi({ title: title(name) }) : schema]
    }),
  ) as unknown as S
}

function meta(name: string, description: string | undefined) {
  return description === undefined ? { title: name } : { title: name, description }
}

/** A string enum, registered as its own component. */
export function enumComponent<const T extends readonly [string, ...string[]]>(
  name: string,
  values: T,
  description?: string,
) {
  const schema = z.enum(values).openapi(name, meta(name, description))
  components.add(schema)
  return schema
}

/** A response model: extra keys are not forbidden. */
export function model<S extends z.ZodRawShape>(name: string, shape: S, description?: string) {
  const schema = z.object(titled(shape, false)).openapi(name, meta(name, description))
  components.add(schema)
  return schema
}

/** A request model: unknown keys are a validation error. */
export function requestModel<S extends z.ZodRawShape>(name: string, shape: S, description?: string) {
  const schema = z.strictObject(titled(shape, false)).openapi(name, meta(name, description))
  components.add(schema)
  return schema
}

/** Path or query parameters, each titled. */
export function params<S extends z.ZodRawShape>(shape: S) {
  return z.object(titled(shape, true))
}

/**
 * `X | null` written as `anyOf [X, null]`. Needed for components (`.nullable()` on
 * a component renders as `allOf`, which the client generator reads as non-null) and for dates
 * (`.nullable()` hoists `format` beside `type: [string, null]`, which changes the client's doc
 * comments).
 */
export function orNull<T extends z.ZodType>(schema: T) {
  return z.union([schema, z.null()])
}

/**
 * A component field with a default, documented as `{$ref, default}`.
 * (`.default()` on the component itself copies its component name to the wrapper, and
 * whichever the generator meets first becomes the component, default included.)
 */
export function refWithDefault<T extends z.ZodType>(schema: T, value: z.util.NoUndefined<z.output<T>>) {
  return z.lazy(() => schema).default(value as never)
}

/** A list response, titled "Response <Operation Id>". */
export function responseList<T extends z.ZodType>(item: T, operationId: string) {
  return z.array(item).openapi({ title: `Response ${title(operationId)}` })
}
