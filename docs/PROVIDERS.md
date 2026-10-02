# Provider routing and caching

The Rust core resolves transport policy for generation, model metadata, and thinking requests. The TUI and Desktop share this result. Built-in defaults live in `crates/agente-core/providers/*.toml`; overrides go in `~/.agente/config.json` or the project's `agente.json`.

## Choosing a route

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

`models.info` and discovery rows expose additive `transport` metadata: `ready`, `api_format`, `base_url`, `cache_control`, and `error`. Clients can display unresolved models without guessing their protocol.

## Cache policy

Explicit model `options.cache_control: true|false` wins over cache rules; live metadata wins over catalog metadata. Existing provider options are still merged as request defaults. Otherwise, the first matching `transport.cache.rules` entry wins, then `transport.cache.breakpoints`, then the protocol default: Messages enables annotations and other formats disable them. Annotations are supported by the Messages and Chat Completions request builders.

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
