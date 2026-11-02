# Provider routing and caching

The Rust core resolves transport policy for generation, model metadata, and thinking requests. The TUI and Desktop share this result. Built-in defaults live in `crates/agente-core/providers/*.toml`; overrides go in `~/.agente/config.json` or the project's `agente.json`.

## Choosing a route

Desktop offers **OpenCode Go** (`opencode-go`, subscription) and **OpenCode**
(`opencode`, Zen/pay-as-you-go) separately, each with its own configuration and
key entry. Go uses `/zen/go/v1`; OpenCode uses `/zen/v1`. Both send the stable
`x-opencode-session` header. Endpoint identification checks Go's path before
the shared `opencode.ai` host, so a pasted Zen endpoint cannot inherit Go policy.

Model routes resolve in this order:

1. Explicit model configuration: `provider.<provider>.models.<model>.provider.api_format`.
2. Explicit protocol metadata from the provider's live discovery response.
3. Explicit model protocol metadata from models.dev.
4. Documented `transport.model_routes` defaults, overlaid with configuration.
5. The provider's `api_format`, when `transport.require_model_route` is false or unset.

Supported formats are `openai` (Chat Completions), `anthropic` (Messages), `responses`, and `google`. Existing model `provider.npm` metadata is also recognized.

OpenCode Go requires model-specific routes because its gateway serves several protocols. Its `/models` response determines membership; the documented route defaults include LongCat. A newly discovered model without a route remains listed, and selecting it produces a configuration error before an HTTP completion request. Add its documented protocol without changing Rust code:

```json
{
  "provider": {
    "opencode-go": {
      "models": {
        "new-model-id": {
          "provider": { "api_format": "openai" },
          "options": { "cache_control": false }
        }
      }
    }
  }
}
```

The model ID above is illustrative: use an ID returned by the provider and the protocol it documents. Alternatively, put route defaults in `transport.model_routes`. Explicit model, live, and catalog metadata still take precedence over that map. Configuration survives catalog refresh and registry rebuilds. Desktop aliases of the same endpoint carry the core's resolved route and cache override; a separate OpenAI compatibility endpoint retains its configured protocol. Endpoint and authentication protections still apply.

`models.info` and discovery rows expose additive `transport` metadata: `ready`, `api_format`, `base_url`, `cache_control`, `error`, and the resolved `policy`. Clients can display unresolved models without guessing their protocol. Desktop aliases of the same endpoint retain this policy, including session cache-key overrides.

## Cache policy

Explicit model `options.cache_control: true|false` wins over cache rules; live metadata wins over catalog metadata. Existing provider options are still merged as request defaults. Otherwise, the first matching `transport.cache.rules` entry wins, then `transport.cache.breakpoints`, then the protocol default: Messages enables annotations and other formats disable them. Annotations are supported by the Messages and Chat Completions request builders.

Stable routing headers are also data: `transport.cache.session_header` names the
header carrying the conversation UUID (`x-opencode-session` for Go,
`x-session-id` for OpenRouter). Every completion dialect uses the same header;
discovery uses a process UUID. Set it to an empty string to disable it. Custom
providers can declare their own header without adding Rust branches.

OpenRouter's documented Claude and Gemini exceptions live in its provider TOML. OpenCode Go's policy enables a stable session `prompt_cache_key` on every route; a model's explicit `prompt_cache_key` remains unchanged. Both behaviors are overridable:

```json
{
  "provider": {
    "openrouter": {
      "transport": {
        "cache": {
          "breakpoints": false,
          "rules": [
            { "model_prefix": "anthropic/", "format": "openai", "breakpoints": true }
          ]
        }
      }
    },
    "opencode-go": {
      "transport": {
        "model_routes": { "new-model-id": "responses" },
        "cache": { "prompt_cache_key": false }
      }
    }
  }
}
```

A rule can match `model` (exact API model ID), `model_prefix`, and `format`; specified conditions must all match. A configured `breakpoints` value clears inherited rules, and a nonempty configured rule list replaces them. Route maps merge by model ID. Unset fields retain documented defaults.

Agente retains the complete request before inserting cache markers into a separate copy. If it inserted markers and an HTTP 400 or 422 explicitly rejects the `cache_control` parameter as unsupported, it retries the original request once. Tool schemas, tool inputs, continuation blocks, user annotations, content shapes, authentication, session identity, and generation settings stay intact. A mention of caching alone does not trigger a retry. Authentication errors, rate limits, server errors, network failures, cancellation, and stream errors keep their normal handling.

## Billing policy

A gateway's reported charge is not always the whole charge. OpenRouter's
`usage.cost` is what the call cost including upstream inference; only when the
user brings their own provider key (BYOK) does the upstream provider bill them
separately, and OpenRouter then reports that part in
`usage.cost_details.upstream_inference_cost`.

That contract is data, not a provider branch — `transport.billing.byok`:

```json
{
  "provider": {
    "openrouter": { "transport": { "billing": { "byok": true } } }
  }
}
```

Default is `false`, which bills `usage.cost` once and ignores the upstream
figure. Setting it adds the two (a BYOK call is paid twice: the gateway's fee
plus the provider's own charge). A truthy value can only be turned **on** from
configuration; a provider spec that already sets it is never overridden to
`false` by a config that omits the field. Whatever a provider does not report
falls back to the models.dev price as an estimate (`~` in the UIs).

OpenCode's subscription accounting is separate from its balance charge:
`usage.cost: 0` on Go means no extra balance charge. For a reported
`opencode.billing_source` of `go`, `go-plus`, or `go-teams`, Agente records
`opencode.allowance` as usage consumed. If that amount is missing, it uses
`opencode.list_cost` as an estimate, then the catalog fallback; it never treats
the subscription's zero balance charge as a free call. `opencode.estimated`
also marks provider-supplied BYOK estimates. The normalization is shared by
Chat, Messages, Responses and Gemini adapters. See the
[OpenCode accounting contract](https://opencode.ai/v2/docs/console/api/inference#cost).


## Official provider audit (2026-10-02)

Cache availability and minimum sizes vary by model and backend. Preserve the
system prefix, sorted tools, complete conversation history, native reasoning
blocks and signatures. Cache annotations are applied to a request copy; they
never mutate persisted messages. Generated Plan instructions are replaced once
per turn and cleared in Build, including repeated footers in older sessions.

| Provider / protocol | Connection and cache behavior | Primary documentation |
| --- | --- | --- |
| OpenCode Go | Use each model's documented Chat, Messages or Responses route. Send Agente's own user agent and stable conversation header. | [Go](https://opencode.ai/docs/go/) |
| OpenRouter | Chat gateway or explicit model route. Stable `x-session-id` supports sticky routing; Claude/Gemini marker rules remain in TOML. | [Caching](https://openrouter.ai/docs/guides/best-practices/prompt-caching) |
| DeepSeek | Chat Completions, automatic prefix caching. Read hit/miss fields without sending Anthropic markers. | [Context caching](https://api-docs.deepseek.com/guides/kv_cache/) |
| Z.AI / GLM | Chat Completions with bearer authentication; automatic caching reports cached tokens in prompt details. | [API](https://docs.z.ai/api-reference/llm/chat-completion), [caching](https://docs.z.ai/guides/capabilities/cache) |
| MiniMax | Native Messages endpoint or its separately configured Chat compatibility endpoint. Automatic caching is the default; documented M2 models enable explicit markers through a TOML rule. M3 currently uses automatic caching. | [Messages](https://platform.minimax.io/docs/api-reference/text-anthropic-api), [automatic caching](https://platform.minimax.io/docs/api-reference/text-prompt-caching), [explicit caching](https://platform.minimax.io/docs/api-reference/anthropic-api-compatible-cache) |
| OpenAI Chat / Responses | Implicit prefix caching; optional stable cache keys. Model-specific lifetime controls are explicit options, not injected globally. | [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching) |
| Anthropic Messages | Explicit `cache_control` boundaries with separate read/write usage. Preserve ordered signed thinking and tool blocks. | [Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) |
| Google generateContent | Native Google request/authentication and thought signatures. Implicit caching needs no Anthropic markers; explicit caches use `cachedContent` objects. | [Generate Content caching](https://ai.google.dev/gemini-api/docs/generate-content/caching?hl=en) |
| Ollama | OpenAI compatibility supports Chat and stateless Responses; keep unsupported provider-specific flags out of requests. | [Compatibility](https://docs.ollama.com/api/openai-compatibility) |
| llama.cpp | OpenAI-compatible server; KV prefix reuse is server-managed (`cache_prompt` defaults true). Do not force a shared slot across conversations. | [Server reference](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md) |
| LM Studio | Local OpenAI Chat/tools compatibility; cache behavior belongs to the loaded runtime. | [Tools compatibility](https://lmstudio.ai/docs/developer/openai-compat/tools) |
| Custom endpoints | Declare the actual protocol, routes and optional cache policy in configuration. Credentials stay in the authentication store; no provider-name conditional is needed for session headers. | The configured endpoint's own contract |

The direct OpenAI/Anthropic/Google rows describe supported wire protocols, not
new entries in Agente's offered-provider list. Adding/removing a built-in
provider remains a spec file plus its `SOURCES` registration. Nothing in this
optimization changes provider membership or the user's chosen thinking level.
