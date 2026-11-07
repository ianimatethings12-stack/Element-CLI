import { Effect, Option, Schema, Stream } from "effect"
import type { RouteDefaultsInput } from "../route/client.js"
import { Auth } from "../route/auth.js"
import type { ProviderPackage } from "../provider-package.js"
import { AIError, ProviderID, type ModelID } from "../schema/index.js"
import { Gemini } from "../protocols/gemini.js"
import { Endpoint } from "../route/endpoint.js"
import { Route } from "../route/client.js"
import {
  HttpTransport,
  type Transport,
  type TransportExecution,
  type TransportPrepareInput,
} from "../route/transport/index.js"
import { optionalNull, ProviderShared } from "../protocols/shared.js"

export const id = ProviderID.make("google-antigravity")
export const DEFAULT_BASE_URL = "https://daily-cloudcode-pa.googleapis.com/v1internal"

export type Config = RouteDefaultsInput & {
  readonly auth?: Auth.Definition
  readonly accessToken?: string
  readonly apiKey?: string
  readonly baseURL?: string
  readonly project?: string
  readonly providerOptions?: Gemini.ProviderOptionsInput
}

export type Settings = ProviderPackage.Settings &
  Gemini.ProviderOptionsInput & {
    readonly accessToken?: string
    readonly apiKey?: string
    readonly baseURL?: string
    readonly project?: string
  }

export const normalizeModelId = (modelID: string): string => {
  if (modelID.startsWith("gemini-3.8-flash")) return "gemini-3.8-flash-tiered"
  if (modelID === "claude-sonnet-4-5" || modelID === "claude-sonnet-4-5-thinking") return "claude-sonnet-4-6"
  if (modelID === "claude-opus-4-5-thinking") return "claude-opus-4-6-thinking"
  if (modelID === "gemini-3-pro-preview" || modelID === "gemini-3-pro-high" || modelID === "gemini-3-flash-preview") return "gemini-3.8-flash-tiered"
  if (modelID === "gemini-2.0-flash" || modelID === "gemini-2.0-flash-thinking" || modelID === "gemini-2.5-pro") return "gemini-2.5-flash"
  return modelID
}

export interface AntigravityBody {
  readonly model: string
  readonly project: string
  readonly request: unknown
}

const GeminiCheckpoint = Schema.Struct({
  candidates: optionalNull(
    Schema.Array(
      Schema.Struct({
        finishReason: optionalNull(Schema.String),
        continuationToken: optionalNull(Schema.String),
      }),
    ),
  ),
})
const decodeCheckpoint = Schema.decodeUnknownOption(GeminiCheckpoint)

class NextRequest {}

export interface Prepared {
  readonly http: HttpTransport.HttpPrepared<string>
  readonly input: TransportPrepareInput<unknown>
}

const sse = HttpTransport.sseJson.with<AntigravityBody>()

export const transport: Transport<unknown, Prepared, unknown> = {
  id: "google-antigravity/sse",
  prepare: (input) => {
    const wrapped: AntigravityBody = {
      model: normalizeModelId(input.request.model.id),
      project: "aicode-consumers",
      request: input.body,
    }
    return sse
      .prepare({
        ...input,
        body: wrapped,
        encodeBody: (body) => JSON.stringify(body),
      })
      .pipe(Effect.map((http) => ({ http, input })))
  },
  execute: (prepared, request, runtime) =>
    Effect.gen(function* () {
      const route = request.model.route.id
      const label = `${request.model.provider}/${route}`
      const raw = new WeakMap<object, string>()
      const respond = (execution: TransportExecution<string>): Stream.Stream<unknown, AIError> =>
        Stream.suspend(() => {
          let token: string | undefined
          let finishReason: string | undefined
          let dropped: AIError | undefined
          return execution.frames.pipe(
            Stream.mapEffect((frame) =>
              ProviderShared.parseJson(route, frame, `Invalid ${label} stream event`).pipe(
                Effect.map((parsed) => {
                  if (typeof parsed === "object" && parsed !== null) raw.set(parsed, frame)
                  const candidateObj =
                    typeof parsed === "object" && parsed !== null && "response" in parsed
                      ? (parsed as { readonly response: unknown }).response
                      : parsed
                  if (typeof candidateObj === "object" && candidateObj !== null) {
                    raw.set(candidateObj, frame)
                  }
                  const candidate = Option.getOrUndefined(decodeCheckpoint(candidateObj))?.candidates?.[0]
                  token = candidate?.continuationToken ?? (candidate?.finishReason ? undefined : token)
                  finishReason = candidate?.finishReason ?? finishReason
                  return candidateObj
                }),
              ),
            ),
            Stream.catchIf(
              (error) => error.reason._tag === "Transport" && error.reason.code !== "Timeout",
              (error) => {
                dropped = error
                return Stream.empty
              },
            ),
            Stream.concat(
              Stream.suspend(() => {
                if (token !== undefined && (finishReason === undefined || finishReason === "CONTINUATION"))
                  return Stream.concat(Stream.succeed(new NextRequest()), next(token))
                if (dropped) return Stream.fail(dropped)
                if (finishReason === "CONTINUATION")
                  return Stream.fail(ProviderShared.eventError(label, "Gemini continued the response without a token"))
                return Stream.empty
              }),
            ),
          )
        })
      const next = (continuationToken: string) => {
        const nextInputBody =
          typeof prepared.input.body === "object" && prepared.input.body !== null
            ? { ...prepared.input.body, continuationToken }
            : { continuationToken }
        const wrapped: AntigravityBody = {
          model: normalizeModelId(request.model.id),
          project: "aicode-consumers",
          request: nextInputBody,
        }
        return Stream.unwrap(
          sse
            .prepare({
              ...prepared.input,
              body: wrapped,
              encodeBody: (body) => JSON.stringify(body),
            })
            .pipe(
              Effect.flatMap((continued) => sse.execute(continued, request, runtime)),
              Effect.map(respond),
            ),
        )
      }
      const executeWithOnboarding = Effect.gen(function* () {
        return yield* sse.execute(prepared.http, request, runtime)
      }).pipe(
        Effect.catchIf(
          (err) => {
            const msg = err instanceof Error ? err.message : String(err)
            return msg.includes("3501") || msg.includes("license") || msg.includes("SUBSCRIPTION_REQUIRED")
          },
          () =>
            Effect.gen(function* () {
              const authHeader = prepared.http.request.headers["authorization"]
              if (authHeader) {
                yield* Effect.tryPromise(() =>
                  fetch("https://daily-cloudcode-pa.googleapis.com/v1internal:onboardUser", {
                    method: "POST",
                    headers: {
                      authorization: authHeader,
                      "Content-Type": "application/json",
                      "User-Agent": "antigravity/1.0.0",
                      "X-Goog-Api-Client": "gl-node/1.0.0 gdcl/1.0.0",
                      "Client-Metadata": JSON.stringify({ ideType: "ANTIGRAVITY" }),
                    },
                    body: JSON.stringify({
                      tierId: "free-tier",
                      metadata: { ideType: "ANTIGRAVITY" },
                    }),
                  }).catch(() => null),
                ).pipe(Effect.orElseSucceed(() => null))
              }
              return yield* sse.execute(prepared.http, request, runtime)
            }),
        ),
      )
      const first = yield* executeWithOnboarding
      return {
        frames: respond(first),
        http: first.http,
        body: (frame) => (typeof frame === "object" && frame !== null ? raw.get(frame) : undefined),
      }
    }),
}

const resolveAuth = (options: {
  readonly accessToken?: string
  readonly apiKey?: string
  readonly auth?: Auth.Definition
}) => {
  if (options.auth) return options.auth
  const token = options.accessToken ?? options.apiKey
  if (token) return Auth.bearer(token)
  return Auth.none
}

const antigravityRoute = Route.make({
  id: "google-antigravity-gemini",
  provider: id,
  providerMetadataKey: "antigravity",
  protocol: Gemini.protocol,
  endpoint: Endpoint.path(() => ":streamGenerateContent?alt=sse", {
    baseURL: DEFAULT_BASE_URL,
  }),
  auth: Auth.none,
  transport,
})

export const routes = [antigravityRoute]

export const configure = (input: Config = {}) => {
  const { accessToken: _, apiKey: _apiKey, auth: _auth, baseURL, headers, ...rest } = input
  const route = antigravityRoute.with({
    ...rest,
    headers: {
      "X-Goog-Api-Client": "gl-node/1.0.0 gdcl/1.0.0",
      "Client-Metadata": JSON.stringify({ ideType: "ANTIGRAVITY" }),
      "User-Agent": "antigravity/1.0.0",
      ...headers,
    },
    endpoint: { baseURL: baseURL ?? DEFAULT_BASE_URL },
    auth: resolveAuth(input),
  })
  return {
    id,
    model: (modelID: string | ModelID) => route.model<Gemini.ProviderOptionsInput>({ id: modelID }),
    configure,
  }
}

export const provider = configure()
export const model: ProviderPackage.Definition<Settings, Gemini.ProviderOptionsInput>["model"] = (
  modelID,
  { accessToken, apiKey, baseURL, body, headers, ...providerOptions },
) =>
  configure({
    accessToken,
    apiKey,
    baseURL,
    headers,
    http: body === undefined ? undefined : { body },
    providerOptions,
  }).model(modelID)
