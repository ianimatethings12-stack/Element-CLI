import type { IntegrationOAuthMethodRegistration } from "@opencode/plugin/effect/integration"
import { define } from "@opencode/plugin/effect/plugin"
import { Deferred, Effect, Schema, Semaphore, Stream } from "effect"
import type { Server, ServerResponse } from "node:http"
import child_process from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { App } from "../../app.js"
import { Credential } from "../../credential.js"
import { Bus } from "../../bus.js"
import { Integration } from "../../integration.js"
import { Model } from "../../model.js"
import { OauthCallbackPage } from "../../oauth/page.js"
import { Provider } from "../../provider.js"
import type { PluginInternal } from "../internal.js"

export const clientID = process.env.ANTIGRAVITY_CLIENT_ID ?? "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com"
export const clientSecret = process.env.ANTIGRAVITY_CLIENT_SECRET ?? ""
export const authURL = "https://accounts.google.com/o/oauth2/v2/auth"
export const tokenURL = "https://oauth2.googleapis.com/token"
export const loadCodeAssistURL = "https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist"
export const fetchAvailableModelsURL = "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels"
export const onboardUserURL = "https://daily-cloudcode-pa.googleapis.com/v1internal:onboardUser"
export const scopes = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
].join(" ")

const providerID = Provider.ID.make("google-antigravity")
const integrationID = Integration.ID.make("google-antigravity")
const oauthMethodID = Integration.MethodID.make("antigravity-oauth")
const headlessMethodID = Integration.MethodID.make("antigravity-code")
const importMethodID = Integration.MethodID.make("antigravity-local")

type Pkce = {
  verifier: string
  challenge: string
}

type TokenResponse = {
  access_token: string
  refresh_token?: string
  expires_in?: number
  token_type?: string
  scope?: string
}

const CodeAssistResponseSchema = Schema.Struct({
  cloudaicompanionProject: Schema.optional(Schema.String),
  projectId: Schema.optional(Schema.String),
  currentTier: Schema.optional(
    Schema.Struct({
      id: Schema.optional(Schema.String),
      name: Schema.optional(Schema.String),
    }),
  ),
})

function request<A>(url: string, init: RequestInit) {
  return Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(url, { ...init, signal })
      if (!response.ok) {
        const body = await response.text().catch(() => "")
        throw new Error(`Google token/API request failed (${response.status}): ${body || response.statusText}`)
      }
      return response.json() as Promise<A>
    },
    catch: (cause) => (cause instanceof Error ? cause : new Error("Network request to Google failed", { cause })),
  })
}

function exchange(code: string, redirectUri: string, verifier: string, app: App.Info) {
  return request<TokenResponse>(tokenURL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": App.useragent(app),
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientID,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }).toString(),
  })
}

export function refreshTokens(value: Credential.OAuth, app: App.Info) {
  return Effect.gen(function* () {
    if (!value.refresh) {
      return yield* Effect.fail(
        new Error("This Antigravity connection does not have a refresh token. Please sign in again."),
      )
    }
    const tokens = yield* request<TokenResponse>(tokenURL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": App.useragent(app),
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: clientID,
        client_secret: clientSecret,
        refresh_token: value.refresh,
      }).toString(),
    })
    yield* onboardUser(tokens.access_token).pipe(Effect.orElseSucceed(() => "aicode-consumers"))
    return Credential.OAuth.make({
      type: "oauth",
      methodID: value.methodID,
      refresh: tokens.refresh_token ?? value.refresh,
      access: tokens.access_token,
      expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
      metadata: value.metadata,
    })
  })
}

export function onboardUser(accessToken: string, tierId = "free-tier"): Effect.Effect<string, never, never> {
  return request<{ cloudaicompanionProject?: { id?: string }; response?: { cloudaicompanionProject?: { id?: string } } }>(
    onboardUserURL,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "User-Agent": "antigravity/1.0.0",
        "X-Goog-Api-Client": "gl-node/1.0.0 gdcl/1.0.0",
        "Client-Metadata": JSON.stringify({ ideType: "ANTIGRAVITY" }),
      },
      body: JSON.stringify({
        tierId,
        metadata: { ideType: "ANTIGRAVITY" },
      }),
    },
  ).pipe(
    Effect.map((res) => res.response?.cloudaicompanionProject?.id ?? res.cloudaicompanionProject?.id ?? "aicode-consumers"),
    Effect.orElseSucceed(() => "aicode-consumers"),
  )
}

export function discoverCodeAssist(accessToken: string, app: App.Info) {
  return request<unknown>(loadCodeAssistURL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "User-Agent": "antigravity/1.0.0",
      "X-Goog-Api-Client": "gl-node/1.0.0 gdcl/1.0.0",
      "Client-Metadata": JSON.stringify({ ideType: "ANTIGRAVITY" }),
    },
    body: JSON.stringify({}),
  }).pipe(
    Effect.map((res) => {
      const decoded = Schema.decodeUnknownOption(CodeAssistResponseSchema)(res)
      if (decoded._tag === "Some") {
        const projectID = decoded.value.cloudaicompanionProject ?? decoded.value.projectId ?? "aicode-consumers"
        const tierName: string | undefined = decoded.value.currentTier?.name
        return { projectID, tierName }
      }
      return { projectID: "aicode-consumers", tierName: undefined }
    }),
    Effect.orElseSucceed(() => ({ projectID: "aicode-consumers", tierName: undefined })),
  )
}

async function generatePKCE(): Promise<Pkce> {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
  const bytes = new Uint8Array(43)
  crypto.getRandomValues(bytes)
  const verifier = Array.from(bytes, (byte) => chars[byte % chars.length]).join("")
  const challenge = base64UrlEncode(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)))
  return { verifier, challenge }
}

function randomValue() {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)).buffer)
}

function base64UrlEncode(buffer: ArrayBuffer) {
  return Buffer.from(buffer).toString("base64url")
}

function listen(server: Server) {
  return Effect.callback<number, Error>((resume) => {
    const onError = (error: Error) => resume(Effect.fail(error))
    server.once("error", onError)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError)
      const address = server.address()
      if (!address || typeof address === "string") return resume(Effect.fail(new Error("Missing OAuth callback port")))
      resume(Effect.succeed(address.port))
    })
  })
}

const browserSignIn = (app: App.Info) =>
  ({
    integrationID,
    method: {
      id: oauthMethodID,
      type: "oauth",
      label: "Log in via browser",
    },
    authorize: () =>
      Effect.gen(function* () {
        const pkce = yield* Effect.promise(generatePKCE)
        const state = randomValue()
        const received = yield* Deferred.make<{ code: string; response: ServerResponse }, Error>()
        const { createServer } = yield* Effect.promise(() => import("node:http"))

        const server = createServer((request, response) => {
          const url = new URL(request.url ?? "/", "http://127.0.0.1")
          if (url.pathname !== "/callback" && url.pathname !== "/auth/callback") {
            response.writeHead(404).end("Not found")
            return
          }
          const error = url.searchParams.get("error_description") ?? url.searchParams.get("error")
          const code = url.searchParams.get("code")
          if (error) {
            Effect.runFork(Deferred.fail(received, new Error(error)))
            response
              .writeHead(400, { "Content-Type": "text/html" })
              .end(OauthCallbackPage.error(error, { provider: "Antigravity" }))
            return
          }
          if (!code || url.searchParams.get("state") !== state) {
            const message = code ? "Invalid OAuth state" : "Missing authorization code"
            Effect.runFork(Deferred.fail(received, new Error(message)))
            response
              .writeHead(400, { "Content-Type": "text/html" })
              .end(OauthCallbackPage.error(message, { provider: "Antigravity" }))
            return
          }
          if (!Effect.runSync(Deferred.succeed(received, { code, response }))) {
            response.writeHead(409).end("OAuth callback already received")
          }
        })

        const port = yield* listen(server)
        yield* Effect.addFinalizer(() => Effect.sync(() => server.close()))
        const redirect = `http://127.0.0.1:${port}/callback`
        const local = yield* checkLocalAntigravity().pipe(Effect.orElseSucceed(() => undefined))
        const params: Record<string, string> = {
          client_id: clientID,
          response_type: "code",
          redirect_uri: redirect,
          code_challenge_method: "S256",
          code_challenge: pkce.challenge,
          scope: scopes,
          state,
          access_type: "offline",
          prompt: "consent",
        }
        if (local?.metadata && typeof local.metadata === "object" && "email" in local.metadata && local.metadata.email) {
          params.login_hint = local.metadata.email as string
        }
        const url = `${authURL}?${new URLSearchParams(params)}`

        return {
          mode: "auto" as const,
          url,
          instructions: "Complete authorization in your browser. This window will close automatically.",
          callback: Effect.gen(function* () {
            const result = yield* Deferred.await(received)
            const respond = (error?: string) =>
              Effect.sync(() =>
                result.response
                  .writeHead(error ? 400 : 200, { "Content-Type": "text/html" })
                  .end(
                    error
                      ? OauthCallbackPage.error(
                          error.includes("3501") || error.includes("license")
                            ? "Error #3501: You do not have an Enterprise license for this account. If you are a personal user, please sign in with your personal Google account (@gmail.com) or use 'Import from local Antigravity (keyring)'."
                            : error,
                          { provider: "Antigravity" },
                        )
                      : OauthCallbackPage.success({ provider: "Antigravity" }),
                  ),
              )
            return yield* Effect.gen(function* () {
              const tokens = yield* exchange(result.code, redirect, pkce.verifier, app)
              yield* onboardUser(tokens.access_token).pipe(Effect.orElseSucceed(() => "aicode-consumers"))
              const discovery = yield* discoverCodeAssist(tokens.access_token, app)
              return Credential.OAuth.make({
                type: "oauth",
                methodID: oauthMethodID,
                refresh: tokens.refresh_token ?? "",
                access: tokens.access_token,
                expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
                metadata: {
                  source: "browser",
                  clientID,
                  projectID: discovery.projectID,
                  tierName: discovery.tierName,
                },
              })
            }).pipe(
              Effect.tap(() => respond()),
              Effect.tapError((err) => respond(err instanceof Error ? err.message : "Antigravity sign-in failed")),
              Effect.onInterrupt(() => Effect.sync(() => result.response.destroy())),
            )
          }),
        }
      }),
    refresh: (value) => refreshTokens(value, app),
  }) satisfies IntegrationOAuthMethodRegistration

const manualCodeSignIn = (app: App.Info) =>
  ({
    integrationID,
    method: {
      id: headlessMethodID,
      type: "oauth",
      label: "Sign in with Google (Manual Code)",
    },
    authorize: () =>
      Effect.gen(function* () {
        const pkce = yield* Effect.promise(generatePKCE)
        const state = randomValue()
        const redirect = "urn:ietf:wg:oauth:2.0:oob"
        const url = `${authURL}?${new URLSearchParams({
          client_id: clientID,
          response_type: "code",
          redirect_uri: redirect,
          code_challenge_method: "S256",
          code_challenge: pkce.challenge,
          scope: scopes,
          state,
          access_type: "offline",
          prompt: "consent",
        })}`

        return {
          mode: "code" as const,
          url,
          instructions:
            "Open the URL above in your browser to sign in to Google, then copy and paste the code displayed.",
          callback: (code: string) =>
            Effect.gen(function* () {
              const tokens = yield* exchange(code.trim(), redirect, pkce.verifier, app)
              yield* onboardUser(tokens.access_token).pipe(Effect.orElseSucceed(() => "aicode-consumers"))
              const discovery = yield* discoverCodeAssist(tokens.access_token, app)
              return Credential.OAuth.make({
                type: "oauth",
                methodID: headlessMethodID,
                refresh: tokens.refresh_token ?? "",
                access: tokens.access_token,
                expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
                metadata: {
                  source: "manual",
                  clientID,
                  projectID: discovery.projectID,
                  tierName: discovery.tierName,
                },
              })
            }),
        }
      }),
    refresh: (value) => refreshTokens(value, app),
  }) satisfies IntegrationOAuthMethodRegistration

export function makeAntigravityModel(
  idStr: string,
  name: string,
  contextLimit: number,
  outputLimit: number,
  family = "gemini",
): Model.Info {
  const id = Model.ID.make(idStr)
  return Model.Info.make({
    ...Model.Info.default(providerID, id),
    id,
    modelID: id,
    providerID,
    family: Model.Family.make(family),
    name,
    package: "@opencode/ai/providers/antigravity",
    limit: { context: contextLimit, output: outputLimit },
    capabilities: {
      tools: true,
      input: ["text", "image"],
      output: ["text"],
    },
    variants: [],
    time: { released: 0 },
    cost: [],
  })
}

export const defaultModels: Model.Info[] = [
  makeAntigravityModel("gemini-3.8-flash-high", "Gemini 3.8 Flash (High)", 1_000_000, 65_536, "gemini"),
  makeAntigravityModel("gemini-3.8-flash-medium", "Gemini 3.8 Flash (Medium)", 1_000_000, 65_536, "gemini"),
  makeAntigravityModel("gemini-3.8-flash-low", "Gemini 3.8 Flash (Low)", 1_000_000, 65_536, "gemini"),
  makeAntigravityModel("claude-sonnet-4-6", "Claude Sonnet 4.6 (Thinking)", 200_000, 64_000, "claude"),
  makeAntigravityModel("claude-opus-4-6-thinking", "Claude Opus 4.6 (Thinking)", 200_000, 64_000, "claude"),
  makeAntigravityModel("gpt-oss-120b-medium", "GPT-OSS 120B (Medium)", 128_000, 32_768, "gpt"),
  makeAntigravityModel("gemini-3-flash", "Gemini 3 Flash (Antigravity)", 1_000_000, 65_536, "gemini"),
  makeAntigravityModel("gemini-2.5-flash", "Gemini 2.5 Flash (Antigravity)", 1_000_000, 65_536, "gemini"),
]

export function parseAgyModelsOutput(output: string): Model.Info[] {
  const lines = output.split(/\r?\n/)
  const models: Model.Info[] = []
  const seen = new Set<string>()

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.toLowerCase().startsWith("fetching")) continue
    const parts = trimmed.split("\t")
    const id = parts[0]?.trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    const rawName = parts[1]?.trim() || id
    const name = rawName.includes("(") ? rawName : `${rawName} (Antigravity)`

    let family = "gemini"
    let contextLimit = 1_000_000
    let outputLimit = 65_536

    if (id.includes("claude")) {
      family = "claude"
      contextLimit = 200_000
      outputLimit = 64_000
    } else if (id.includes("gpt")) {
      family = "gpt"
      contextLimit = 128_000
      outputLimit = 32_768
    }

    models.push(makeAntigravityModel(id, name, contextLimit, outputLimit, family))
  }

  return models
}

let agyCache: { models: Model.Info[]; time: number } | undefined

export function fetchAgyCliModels(): Effect.Effect<Model.Info[], never> {
  return Effect.tryPromise({
    try: async () => {
      if (agyCache && Date.now() - agyCache.time < 60_000) {
        return agyCache.models
      }
      const binary = process.platform === "win32" ? "agy.exe" : "agy"
      const home = os.homedir()
      const candidates = [
        path.join(process.env.LOCALAPPDATA ?? "", "agy", "bin", binary),
        path.join(home, ".gemini", "bin", binary),
        path.join(home, ".gemini", "antigravity-cli", "bin", binary),
        binary,
      ].filter((p) => p === binary || fs.existsSync(p))

      for (const candidate of candidates) {
        try {
          const proc = Bun.spawn([candidate, "models"], {
            stdout: "pipe",
            stderr: "pipe",
          })
          const textPromise = new Response(proc.stdout).text()
          const timeoutPromise = new Promise<string>((_, reject) => setTimeout(() => { proc.kill(); reject(new Error("timeout")) }, 10_000))
          const text = await Promise.race([textPromise, timeoutPromise])
          await proc.exited
          const parsed = parseAgyModelsOutput(text)
          if (parsed.length > 0) {
            agyCache = { models: parsed, time: Date.now() }
            return parsed
          }
        } catch {
          // continue checking other candidates
        }
      }
      return []
    },
    catch: () => [],
  }).pipe(Effect.orElseSucceed(() => [] as Model.Info[]))
}

export function parseRemoteModels(res: unknown): Model.Info[] {
  if (!res || typeof res !== "object") return []
  const obj = res as Record<string, unknown>
  const rawList = Array.isArray(res)
    ? res
    : Array.isArray(obj.models)
      ? obj.models
      : Array.isArray(obj.availableModels)
        ? obj.availableModels
        : typeof obj.models === "object" && obj.models !== null
          ? Object.entries(obj.models).map(([k, v]) => ({ modelId: k, ...(typeof v === "object" && v !== null ? v : {}) }))
          : []

  const list: Model.Info[] = []
  const seen = new Set<string>()

  for (const item of rawList) {
    if (!item || typeof item !== "object") continue
    const m = item as Record<string, unknown>
    const id = String(m.modelId ?? m.id ?? m.name ?? "").trim()
    if (!id || seen.has(id)) continue
    if (id.startsWith("tab_") || id.startsWith("chat_")) continue
    seen.add(id)
    const displayName = String(m.displayName ?? m.title ?? m.name ?? id)
    const contextLimit =
      typeof m.contextLimit === "number"
        ? m.contextLimit
        : typeof m.maxInputTokens === "number"
          ? m.maxInputTokens
          : 1_000_000
    const outputLimit =
      typeof m.outputLimit === "number"
        ? m.outputLimit
        : typeof m.maxOutputTokens === "number"
          ? m.maxOutputTokens
          : 65_536
    const familyStr = id.includes("claude") ? "claude" : "gemini"
    list.push(
      makeAntigravityModel(
        id,
        displayName.includes("(") ? displayName : `${displayName} (Antigravity)`,
        contextLimit,
        outputLimit,
        familyStr,
      ),
    )
  }
  return list
}

export function fetchAvailableModels(accessToken: string, app: App.Info) {
  return request<unknown>(fetchAvailableModelsURL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "User-Agent": "antigravity/1.0.0",
      "X-Goog-Api-Client": "gl-node/1.0.0 gdcl/1.0.0",
      "Client-Metadata": JSON.stringify({ ideType: "ANTIGRAVITY" }),
    },
    body: JSON.stringify({}),
  }).pipe(
    Effect.map((res) => parseRemoteModels(res)),
    Effect.catch((cause) =>
      Effect.logWarning("Failed to fetch dynamic models from Google Antigravity", { cause }).pipe(
        Effect.as([] as Model.Info[]),
      ),
    ),
  )
}


export const checkLocalAntigravity = (app?: App.Info) =>
  Effect.gen(function* () {
  if (process.platform === "win32") {
    const credJson = yield* Effect.try(() => {
      const psScript = `
$src = @'
using System;
using System.Runtime.InteropServices;
public class CR {
  [DllImport("Advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool R(string t, int tp, int f, out IntPtr p);
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct C {
    public int F, T;
    public string TN, CM;
    public long LW;
    public int S;
    public IntPtr B;
    public int P, AC;
    public IntPtr A;
    public string TA, UN;
  }
  public static string G(string t) {
    IntPtr p;
    if (R(t, 1, 0, out p)) {
      C c = (C)Marshal.PtrToStructure(p, typeof(C));
      byte[] b = new byte[c.S];
      Marshal.Copy(c.B, b, 0, c.S);
      return System.Text.Encoding.UTF8.GetString(b);
    }
    return "";
  }
}
'@
Add-Type -TypeDefinition $src
[CR]::G('gemini:antigravity')
`
      const b64 = Buffer.from(psScript, "utf16le").toString("base64")
      return child_process.execSync(
        `powershell -NoProfile -NonInteractive -EncodedCommand ${b64}`,
        { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"], timeout: 3000 },
      ).trim()
    }).pipe(Effect.orElseSucceed(() => undefined))

    if (!credJson) return undefined
    try {
      const parsed = JSON.parse(credJson)
      const token = parsed?.token
      if (token?.access_token) {
        const expiry = token.expiry ? new Date(token.expiry).getTime() : Date.now() + 3600 * 1000
        const cred = Credential.OAuth.make({
          type: "oauth",
          methodID: importMethodID,
          refresh: token.refresh_token ?? "",
          access: token.access_token,
          expires: expiry,
          metadata: {
            source: "local_keyring",
            clientID,
            projectID: "aicode-consumers",
            email: parsed.id_token_email,
          },
        })
        if (app && cred.refresh && cred.expires <= Date.now() + 5 * 60 * 1000) {
          return yield* refreshTokens(cred, app).pipe(Effect.orElseSucceed(() => cred))
        }
        return cred
      }
    } catch {
      return undefined
    }
  }
  return undefined
})


const importSignIn = (app: App.Info) =>
  ({
    integrationID,
    method: {
      id: importMethodID,
      type: "oauth",
      label: "Import from local Antigravity (keyring)",
    },
    authorize: () =>
      Effect.gen(function* () {
        const local = yield* checkLocalAntigravity(app)
        if (!local) {
          return yield* Effect.fail(
            new Error(
              "No Antigravity login found in Windows Credential Manager. Please make sure Antigravity is installed and logged in on this machine.",
            ),
          )
        }
        return {
          mode: "auto" as const,
          url: "",
          instructions: "Importing credentials from local Antigravity keyring...",
          callback: Effect.succeed(local),
        }
      }),
    refresh: (value) => refreshTokens(value, app),
  }) satisfies IntegrationOAuthMethodRegistration

export const AntigravityPlugin = define({
  id: "opencode.provider.google.antigravity",
  effect: Effect.fn(function* (ctx) {
    const bus = yield* Bus.Service
    const loading = Semaphore.makeUnsafe(1)
    let activeOAuth: Credential.OAuth | undefined
    let currentModels: Model.Info[] = defaultModels

    const load = Effect.fn("AntigravityPlugin.load")(function* () {
      const connection = yield* ctx.integration.connection.active(integrationID)
      const credential = connection
        ? yield* ctx.integration.connection.resolve(connection).pipe(Effect.orElseSucceed(() => undefined))
        : undefined

      if (credential?.type === "oauth" && (credential.methodID === oauthMethodID || credential.methodID === headlessMethodID || credential.methodID === importMethodID)) {
        activeOAuth = credential
        yield* onboardUser(credential.access).pipe(Effect.orElseSucceed(() => "aicode-consumers"))

        const agyModels = yield* fetchAgyCliModels()
        if (agyModels.length > 0) {
          currentModels = agyModels
          return
        }

        const remote = yield* fetchAvailableModels(credential.access, ctx.app)
        if (remote.length > 0) {
          const remoteIds = new Set(remote.map((m) => m.id.toString()))
          currentModels = [...remote, ...defaultModels.filter((m) => !remoteIds.has(m.id.toString()))]
          return
        }

        currentModels = defaultModels
        return
      }

      const local = yield* checkLocalAntigravity(ctx.app)
      if (local) {
        activeOAuth = local
        yield* onboardUser(local.access).pipe(Effect.orElseSucceed(() => "aicode-consumers"))
        const agyModels = yield* fetchAgyCliModels()
        if (agyModels.length > 0) {
          currentModels = agyModels
          return
        }
        const remote = yield* fetchAvailableModels(local.access, ctx.app)
        if (remote.length > 0) {
          const remoteIds = new Set(remote.map((m) => m.id.toString()))
          currentModels = [...remote, ...defaultModels.filter((m) => !remoteIds.has(m.id.toString()))]
          return
        }
        currentModels = defaultModels
        return
      }

      activeOAuth = undefined
      currentModels = defaultModels
    })

    yield* ctx.integration.transform((editor) => {
      editor.update(integrationID, (integration) => {
        integration.name = "Antigravity"
      })
      editor.method.update(importSignIn(ctx.app))
      editor.method.update(browserSignIn(ctx.app))
      editor.method.update(manualCodeSignIn(ctx.app))
    })

    yield* load()

    yield* ctx.provider.transform((providers) => {
      const existing = providers.get(providerID)
      const metadata = activeOAuth?.metadata as { projectID?: string; tierName?: string } | undefined
      const projectID = metadata?.projectID ?? "aicode-consumers"

      if (!existing) {
        providers.add({
          info: {
            ...Provider.Info.empty(providerID),
            name: "Antigravity",
            package: "@opencode/ai/providers/antigravity",
            activation: "auto",
            settings: {
              accessToken: activeOAuth?.access,
              project: projectID,
            },
          },
          models: currentModels,
        })
        return
      }

      providers.update(providerID, (provider) => {
        provider.name = "Antigravity"
        provider.settings = Provider.mergeOverlay(provider.settings, {
          accessToken: activeOAuth?.access,
          project: projectID,
        })
      })
      providers.models.set(providerID, currentModels)
    })

    const reload = () => loading.withPermit(load().pipe(Effect.andThen(ctx.provider.reload())))
    yield* bus.subscribe(Credential.Event.Switched).pipe(
      Stream.filter((event) => event.data.integrationID === integrationID),
      Stream.runForEach(reload),
      Effect.forkScoped({ startImmediately: true }),
    )
  }),
} satisfies PluginInternal.InternalPlugin)
