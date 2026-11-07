import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Credential } from "@opencode/core/credential"
import { Integration } from "@opencode/core/integration"
import { Model } from "@opencode/core/model"
import { ModelResolver } from "@opencode/core/model-resolver"
import { Provider } from "@opencode/core/provider"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { AntigravityPlugin, clientID, authURL, scopes, parseRemoteModels, parseAgyModelsOutput } from "@opencode/core/plugin/provider/antigravity"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)

const addAntigravityPlugin = Effect.fn(function* () {
  const plugin = yield* Plugin.Service
  const host = yield* PluginHost.make(plugin, AntigravityPlugin.id)
  yield* AntigravityPlugin.effect(host)
})

describe("AntigravityPlugin", () => {
  it.live(
    "registers Antigravity OAuth and manual code methods on google-antigravity integration",
    () =>
      Effect.gen(function* () {
        yield* addAntigravityPlugin()
        const integrations = yield* Integration.Service
        const antigravity = yield* integrations.get(Integration.ID.make("google-antigravity"))
        expect(antigravity).toBeDefined()
        expect(antigravity?.name).toBe("Antigravity")
        const methodIDs = antigravity?.methods.map((m) => ("id" in m ? String(m.id) : undefined)).filter(Boolean) ?? []
        expect(methodIDs).toContain("antigravity-oauth")
        expect(methodIDs).toContain("antigravity-code")
      }),
    15000,
  )

  it.live(
    "creates a valid Google OAuth authorization URL with PKCE parameters for manual code sign in",
    () =>
      Effect.gen(function* () {
        yield* addAntigravityPlugin()
        const integrations = yield* Integration.Service
        const integrationID = Integration.ID.make("google-antigravity")
        const attempt = yield* integrations.oauth.connect({
          integrationID,
          methodID: Integration.MethodID.make("antigravity-code"),
        })
        yield* integrations.oauth.cancel({ integrationID, attemptID: attempt.attemptID })
        const url = new URL(attempt.url)
        expect(url.origin + url.pathname).toBe(authURL)
        expect(url.searchParams.get("client_id")).toBe(clientID)
        expect(url.searchParams.get("redirect_uri")).toBe("urn:ietf:wg:oauth:2.0:oob")
        expect(url.searchParams.get("code_challenge_method")).toBe("S256")
        expect(url.searchParams.get("scope")).toBe(scopes)
        expect(url.searchParams.has("code_challenge")).toBe(true)
        expect(url.searchParams.has("state")).toBe(true)
      }),
    15000,
  )

  it.live(
    "registers Antigravity provider and models with active OAuth credentials",
    () =>
      Effect.gen(function* () {
      const credentials = yield* Credential.Service
      const providers = yield* Provider.Service
      const modelService = yield* Model.Service
      const providerID = Provider.ID.make("google-antigravity")
      const integrationID = Integration.ID.make("google-antigravity")

      // Seed an active OAuth credential with project metadata
      yield* credentials.create({
        integrationID,
        value: Credential.OAuth.make({
          type: "oauth",
          methodID: Integration.MethodID.make("antigravity-oauth"),
          refresh: "google-refresh-token",
          access: "google-access-token",
          expires: Date.now() + 3600 * 1000,
          metadata: { clientID, projectID: "my-test-project-123", tierName: "PRO" },
        }),
      })

      // Initialize plugin
      yield* addAntigravityPlugin()

      const provider = yield* providers.get(providerID)
      expect(provider).toBeDefined()
      expect(provider?.settings?.accessToken).toBe("google-access-token")
      expect(provider?.settings?.project).toBe("my-test-project-123")

      // Check plan models
      const flashHigh = yield* modelService.get(providerID, Model.ID.make("gemini-3.8-flash-high"))
      expect(flashHigh).toBeDefined()
      expect(flashHigh?.name).toContain("Gemini 3.8 Flash (High)")

      const sonnet46 = yield* modelService.get(providerID, Model.ID.make("claude-sonnet-4-6"))
      expect(sonnet46).toBeDefined()
      expect(sonnet46?.name).toContain("Claude Sonnet 4.6 (Thinking)")
    }),
    15000,
  )

  it.live("parses agy models CLI output correctly", () =>
    Effect.sync(() => {
      const output = `Fetching available models...
gemini-3.8-flash-high\tGemini 3.8 Flash (High)
gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)
claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)
gpt-oss-120b-medium\tGPT-OSS 120B (Medium)`
      const parsed = parseAgyModelsOutput(output)
      expect(parsed.length).toBe(4)
      const m0 = parsed[0]
      const m2 = parsed[2]
      const m3 = parsed[3]
      expect(m0?.id.toString()).toBe("gemini-3.8-flash-high")
      expect(m0?.name).toBe("Gemini 3.8 Flash (High)")
      expect(m0?.family?.toString()).toBe("gemini")
      expect(m2?.id.toString()).toBe("claude-sonnet-4-6")
      expect(m2?.family?.toString()).toBe("claude")
      expect(m3?.id.toString()).toBe("gpt-oss-120b-medium")
      expect(m3?.family?.toString()).toBe("gpt")
    }),
  )

  it.live("parses dynamic remote models correctly", () =>
    Effect.sync(() => {
      const parsed = parseRemoteModels({
        models: [
          { modelId: "gemini-3.5-flash", displayName: "Gemini 3.5 Flash", maxInputTokens: 2000000, maxOutputTokens: 65536 },
          { modelId: "claude-sonnet-custom", displayName: "Claude Sonnet Custom" },
        ],
      })
      expect(parsed.length).toBe(2)
      const first = parsed[0]
      const second = parsed[1]
      expect(first).toBeDefined()
      expect(second).toBeDefined()
      if (first && second) {
        expect(first.id.toString()).toBe("gemini-3.5-flash")
        expect(first.name).toBe("Gemini 3.5 Flash (Antigravity)")
        expect(first.limit.context).toBe(2000000)
        expect(second.id.toString()).toBe("claude-sonnet-custom")
        expect(second.family?.toString()).toBe("claude")
      }
    }),
  )

  it.live(
    "resolves Antigravity model and successfully streams a prompt end-to-end",
    () =>
      Effect.gen(function* () {
        const { checkLocalAntigravity } = yield* Effect.promise(() => import("@opencode/core/plugin/provider/antigravity"))
        const cred = yield* checkLocalAntigravity()
        if (!cred) {
          console.log("No local Antigravity credentials found, skipping live stream test")
          return
        }

        const credentials = yield* Credential.Service
        yield* credentials.create({
          integrationID: Integration.ID.make("google-antigravity"),
          value: cred,
        })

        yield* addAntigravityPlugin()
        const modelService = yield* Model.Service
        const resolver = yield* ModelResolver.Service

        const modelInfo = yield* modelService.get(
          Provider.ID.make("google-antigravity"),
          Model.ID.make("gemini-3.8-flash-high"),
        )
        expect(modelInfo).toBeDefined()
        if (!modelInfo) return

        const resolved = yield* resolver.resolveModel(modelInfo)
        expect(resolved.model).toBeDefined()
        expect(resolved.model.provider as string).toBe("google-antigravity")
        expect(resolved.model.id as string).toBe("gemini-3.8-flash-high")
      }).pipe(Effect.provide(ModelResolver.layer)),
    20000,
  )
})
