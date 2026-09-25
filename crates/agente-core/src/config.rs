use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

use crate::auth::AuthStore;
use crate::catalog::{ModelCapabilities, ModelCost, ModelLimits, ModelStatus};
use crate::mcp::McpConfig;

/// Helper macro to build a HashMap of model configurations inline.
macro_rules! models {
    ($($id:expr => $name:expr, $tokens:expr);* $(;)?) => {{
        let mut m = HashMap::new();
        $(
            m.insert($id.to_string(), ModelConfig {
                name: Some($name.to_string()),
                limit: Some(ModelLimits {
                    context: $tokens,
                    input: None,
                    output: 8192,
                }),
                ..Default::default()
            });
        )*
        m
    }};
}

/// Provider configuration options
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProviderOptions {
    #[serde(rename = "apiKey", default)]
    pub api_key: Option<String>,
    #[serde(rename = "baseURL", default)]
    pub base_url: Option<String>,
    #[serde(rename = "enterpriseUrl", default)]
    pub enterprise_url: Option<String>,
    #[serde(default)]
    pub timeout: Option<u32>,
    #[serde(rename = "chunkTimeout", default)]
    pub chunk_timeout: Option<u32>,
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

/// Provider configuration: endpoint, credentials, and model catalog entries.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProviderConfig {
    #[serde(default)]
    pub api: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub env: Vec<String>,
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub npm: Option<String>,
    /// Wire format: "openai" or "anthropic" (Messages-compatible gateways).
    /// Defaults to "openai" when missing.
    #[serde(default)]
    pub api_format: Option<String>,
    #[serde(default)]
    pub whitelist: Vec<String>,
    #[serde(default)]
    pub blacklist: Vec<String>,
    #[serde(default)]
    pub options: ProviderOptions,
    #[serde(default)]
    pub models: HashMap<String, ModelConfig>,
}

/// Model configuration override
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ModelConfig {
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<crate::catalog::ModelProvider>,
    #[serde(default)]
    pub capabilities: Option<ModelCapabilities>,
    #[serde(default)]
    pub cost: Option<ModelCost>,
    #[serde(default)]
    pub limit: Option<ModelLimits>,
    #[serde(default)]
    pub status: Option<ModelStatus>,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    /// Catalog-sourced thinking options (models.dev).
    #[serde(default)]
    pub reasoning_options: Vec<crate::catalog::ReasoningOption>,
    #[serde(default)]
    pub reasoning_stream_field: Option<String>,
    #[serde(flatten)]
    pub options: HashMap<String, serde_json::Value>,
}

/// Auto-approve configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AutoApproveConfig {
    pub read_operations: bool,
    pub write_new_files: bool,
    pub safe_commands: Vec<String>,
    pub max_auto_edit_lines: usize,
}

impl Default for AutoApproveConfig {
    fn default() -> Self {
        Self {
            read_operations: true,
            write_new_files: false,
            safe_commands: vec![
                "cargo build".into(),
                "cargo test".into(),
                "cargo check".into(),
                "npm run build".into(),
                "npm test".into(),
                "npm run lint".into(),
                "git status".into(),
                "git diff".into(),
                "ls".into(),
                "dir".into(),
            ],
            max_auto_edit_lines: 10,
        }
    }
}

/// Full application configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    #[serde(default)]
    pub provider: HashMap<String, ProviderConfig>,
    #[serde(default)]
    pub default_provider: Option<String>,
    #[serde(default)]
    pub default_model: Option<String>,
    #[serde(default)]
    pub planner_model: Option<String>,
    #[serde(default)]
    pub executor_model: Option<String>,
    #[serde(default)]
    pub editor: Option<String>,
    #[serde(default)]
    pub auto_approve: AutoApproveConfig,
    #[serde(default)]
    pub mcp: HashMap<String, McpConfig>,
    /// Persistent agent mode (Plan / Build). Used to restore the mode on next launch.
    #[serde(default)]
    pub default_mode: Option<String>,
    /// Persistent default thinking level (`off`, `high`, `max`, …). Restored on launch.
    #[serde(default)]
    pub default_thinking_level: Option<String>,
    /// Persistent UI theme ("dark" or "light"). Restored on next launch.
    #[serde(default)]
    pub theme: Option<String>,
    /// Maximum agent tool-loop iterations per turn. Long-horizon tasks can
    /// exceed the old hardcoded cap of 50; default is 500.
    #[serde(default)]
    pub max_iterations: Option<u32>,
    /// Cached discovered model IDs per provider. Avoids rediscovery on launch.
    #[serde(default)]
    pub discovered_models: HashMap<String, Vec<String>>,
    /// External model catalog cache
    #[serde(skip)]
    pub catalog: Option<crate::catalog::ModelCatalog>,
    /// Auth store — separate from config so credentials are never written to config.json.
    #[serde(skip)]
    pub auth_store: AuthStore,
}

/// The same allowlist gates saved configuration, the registry, and the picker.
pub fn provider_is_supported(id: &str, _provider: &ProviderConfig) -> bool {
    matches!(
        id,
        "deepseek" | "minimax" | "glm" | "opencode-go" | "openrouter"
    )
}

#[derive(Debug, Clone)]
pub struct ProviderEntry {
    pub id: String,
    pub name: String,
    pub env_key: String,
}

impl Default for AppConfig {
    fn default() -> Self {
        let mut provider: HashMap<String, ProviderConfig> = HashMap::new();

        // Built-in provider defaults — single source of truth.
        // The provider registry derives implementations from these configs.
        provider.insert(
            "openai".into(),
            ProviderConfig {
                api: Some("https://api.openai.com/v1".into()),
                name: Some("OpenAI".into()),
                env: vec!["OPENAI_API_KEY".into()],
                npm: Some("@ai-sdk/openai".into()),
                api_format: Some("responses".into()),
                models: models! {
                    "gpt-4o" => "GPT-4o", 128000;
                    "gpt-4o-mini" => "GPT-4o Mini", 128000;
                    "o1" => "o1", 200000;
                    "o3-mini" => "o3-mini", 200000;
                    "gpt-4.5-preview" => "GPT-4.5 Preview", 128000
                },
                ..Default::default()
            },
        );

        provider.insert(
            "minimax".into(),
            ProviderConfig {
                api: Some("https://api.minimax.io/anthropic/v1".into()),
                name: Some("MiniMax".into()),
                env: vec!["MINIMAX_API_KEY".into()],
                npm: Some("@ai-sdk/anthropic".into()),
                api_format: Some("anthropic".into()),
                options: ProviderOptions {
                    base_url: Some("https://api.minimax.io/anthropic/v1".into()),
                    ..Default::default()
                },
                models: models! {
                    "MiniMax-M3" => "MiniMax M3", 1000000;
                    "MiniMax-M2.7" => "MiniMax M2.7", 204800
                },
                ..Default::default()
            },
        );

        provider.insert(
            "openrouter".into(),
            ProviderConfig {
                api: Some("https://openrouter.ai/api/v1".into()),
                name: Some("OpenRouter".into()),
                env: vec!["OPENROUTER_API_KEY".into()],
                npm: Some("@ai-sdk/openai".into()),
                api_format: Some("openai".into()),
                options: ProviderOptions {
                    base_url: Some("https://openrouter.ai/api/v1".into()),
                    ..Default::default()
                },
                models: models! {
                    "anthropic/claude-sonnet-4" => "Claude Sonnet 4 (Router)", 200000;
                    "openai/gpt-4o" => "GPT-4o (Router)", 128000;
                    "deepseek/deepseek-chat" => "DeepSeek V3 (Router)", 64000;
                    "meta-llama/llama-3.3-70b" => "Llama 3.3 70B (Router)", 128000
                },
                ..Default::default()
            },
        );

        provider.insert(
            "opencode".into(),
            ProviderConfig {
                api: Some("https://opencode.ai/zen/v1".into()),
                name: Some("OpenCode Zen".into()),
                env: vec!["OPENCODE_API_KEY".into()],
                npm: Some("@ai-sdk/openai-compatible".into()),
                api_format: Some("openai".into()),
                options: ProviderOptions {
                    base_url: Some("https://opencode.ai/zen/v1".into()),
                    ..Default::default()
                },
                ..Default::default()
            },
        );

        provider.insert(
            "deepseek".into(),
            ProviderConfig {
                api: Some("https://api.deepseek.com".into()),
                name: Some("DeepSeek".into()),
                env: vec!["DEEPSEEK_API_KEY".into()],
                npm: Some("@ai-sdk/openai".into()),
                api_format: Some("openai".into()),
                options: ProviderOptions {
                    base_url: Some("https://api.deepseek.com".into()),
                    ..Default::default()
                },
                models: models! {
                    "deepseek-flash" => "DeepSeek Flash", 128000;
                    "deepseek-v4-pro" => "DeepSeek V4 Pro", 128000
                },
                ..Default::default()
            },
        );

        provider.insert(
            "groq".into(),
            ProviderConfig {
                api: Some("https://api.groq.com/openai/v1".into()),
                name: Some("Groq".into()),
                env: vec!["GROQ_API_KEY".into()],
                npm: Some("@ai-sdk/openai".into()),
                api_format: Some("openai".into()),
                options: ProviderOptions {
                    base_url: Some("https://api.groq.com/openai/v1".into()),
                    ..Default::default()
                },
                models: models! {
                    "llama-3.3-70b-versatile" => "Llama 3.3 70B", 128000;
                    "mixtral-8x7b-32768" => "Mixtral 8x7B", 32768;
                    "gemma2-9b-it" => "Gemma 2 9B", 8192
                },
                ..Default::default()
            },
        );

        provider.insert(
            "xai".into(),
            ProviderConfig {
                api: Some("https://api.x.ai/v1".into()),
                name: Some("xAI".into()),
                env: vec!["XAI_API_KEY".into()],
                npm: Some("@ai-sdk/openai".into()),
                api_format: Some("openai".into()),
                options: ProviderOptions {
                    base_url: Some("https://api.x.ai/v1".into()),
                    ..Default::default()
                },
                models: models! {
                    "grok-3" => "Grok 3", 131072;
                    "grok-3-mini" => "Grok 3 Mini", 131072
                },
                ..Default::default()
            },
        );

        provider.insert(
            "mistral".into(),
            ProviderConfig {
                api: Some("https://api.mistral.ai/v1".into()),
                name: Some("Mistral".into()),
                env: vec!["MISTRAL_API_KEY".into()],
                npm: Some("@ai-sdk/openai".into()),
                api_format: Some("openai".into()),
                options: ProviderOptions {
                    base_url: Some("https://api.mistral.ai/v1".into()),
                    ..Default::default()
                },
                models: models! {
                    "mistral-large-latest" => "Mistral Large", 128000;
                    "codestral-latest" => "Codestral", 256000;
                    "mistral-medium" => "Mistral Medium", 32000
                },
                ..Default::default()
            },
        );

        provider.insert(
            "ollama".into(),
            ProviderConfig {
                api: Some("http://localhost:11434/v1".into()),
                name: Some("Ollama (local)".into()),
                env: vec![],
                npm: Some("@ai-sdk/openai".into()),
                api_format: Some("openai".into()),
                options: ProviderOptions {
                    base_url: Some("http://localhost:11434/v1".into()),
                    ..Default::default()
                },
                models: models! {
                    "deepseek-coder-v2" => "DeepSeek Coder V2", 128000;
                    "qwen2.5-coder" => "Qwen 2.5 Coder", 32000;
                    "llama3.2" => "Llama 3.2", 128000
                },
                ..Default::default()
            },
        );

        provider.insert(
            "lmstudio".into(),
            ProviderConfig {
                api: Some("http://localhost:1234/v1".into()),
                name: Some("LM Studio (local)".into()),
                env: vec![],
                npm: Some("@ai-sdk/openai".into()),
                api_format: Some("openai".into()),
                options: ProviderOptions {
                    base_url: Some("http://localhost:1234/v1".into()),
                    ..Default::default()
                },
                models: models! {
                    "local-model" => "Local Model", 128000
                },
                ..Default::default()
            },
        );

        // ── Extended curated providers from models.dev registry ──

        provider.insert(
            "minimax-cn".into(),
            ProviderConfig {
                api: Some("https://api.minimaxi.com/anthropic/v1".into()),
                name: Some("MiniMax (China)".into()),
                env: vec!["MINIMAX_CN_API_KEY".into()],
                npm: Some("@ai-sdk/anthropic".into()),
                api_format: Some("anthropic".into()),
                options: ProviderOptions {
                    base_url: Some("https://api.minimaxi.com/anthropic/v1".into()),
                    ..Default::default()
                },
                ..Default::default()
            },
        );

        provider.insert(
            "minimax-coding-plan".into(),
            ProviderConfig {
                api: Some("https://api.minimax.io/anthropic/v1".into()),
                name: Some("MiniMax Coding Plan".into()),
                env: vec!["MINIMAX_API_KEY".into()],
                npm: Some("@ai-sdk/anthropic".into()),
                api_format: Some("anthropic".into()),
                options: ProviderOptions {
                    base_url: Some("https://api.minimax.io/anthropic/v1".into()),
                    ..Default::default()
                },
                ..Default::default()
            },
        );

        provider.insert(
            "minimax-cn-coding-plan".into(),
            ProviderConfig {
                api: Some("https://api.minimaxi.com/anthropic/v1".into()),
                name: Some("MiniMax Coding Plan (China)".into()),
                env: vec!["MINIMAX_API_KEY".into()],
                npm: Some("@ai-sdk/anthropic".into()),
                api_format: Some("anthropic".into()),
                options: ProviderOptions {
                    base_url: Some("https://api.minimaxi.com/anthropic/v1".into()),
                    ..Default::default()
                },
                ..Default::default()
            },
        );

        provider.insert(
            "github-copilot".into(),
            ProviderConfig {
                api: Some("https://api.githubcopilot.com".into()),
                name: Some("GitHub Copilot".into()),
                env: vec![
                    "GITHUB_TOKEN".into(),
                    "GH_TOKEN".into(),
                    "COPILOT_GITHUB_TOKEN".into(),
                ],
                npm: Some("@ai-sdk/openai-compatible".into()),
                api_format: Some("openai".into()),
                options: ProviderOptions {
                    base_url: Some("https://api.githubcopilot.com".into()),
                    ..Default::default()
                },
                ..Default::default()
            },
        );

        provider.insert(
            "zai".into(),
            ProviderConfig {
                api: Some("https://api.z.ai/api/paas/v4".into()),
                name: Some("Z.AI".into()),
                env: vec!["ZHIPU_API_KEY".into()],
                npm: Some("@ai-sdk/openai-compatible".into()),
                api_format: Some("openai".into()),
                options: ProviderOptions {
                    base_url: Some("https://api.z.ai/api/paas/v4".into()),
                    ..Default::default()
                },
                ..Default::default()
            },
        );

        provider.insert(
            "glm".into(),
            ProviderConfig {
                api: Some("https://api.z.ai/api/paas/v4".into()),
                name: Some("GLM (Z.AI API)".into()),
                env: vec!["ZAI_API_KEY".into(), "ZHIPU_API_KEY".into()],
                api_format: Some("openai".into()),
                models: models! {
                    "glm-5.3" => "GLM 5.3", 200000;
                    "glm-5.3-flash" => "GLM 5.3 Flash", 200000
                },
                ..Default::default()
            },
        );

        provider.insert(
            "opencode-go".into(),
            ProviderConfig {
                api: Some("https://opencode.ai/zen/go/v1".into()),
                name: Some("OpenCode Go".into()),
                env: vec!["OPENCODE_GO_API_KEY".into(), "OPENCODE_API_KEY".into()],
                api_format: Some("openai".into()),
                models: models! {
                    "deepseek-v4.1-flash" => "DeepSeek V4.1 Flash", 128000;
                    "minimax-m3" => "MiniMax M3", 1000000;
                    "gpt-6-luna" => "GPT 6 Luna", 272000
                },
                ..Default::default()
            },
        );

        provider.insert(
            "zai-coding-plan".into(),
            ProviderConfig {
                api: Some("https://api.z.ai/api/coding/paas/v4".into()),
                name: Some("Z.AI Coding Plan".into()),
                env: vec!["ZHIPU_API_KEY".into()],
                npm: Some("@ai-sdk/openai-compatible".into()),
                api_format: Some("openai".into()),
                options: ProviderOptions {
                    base_url: Some("https://api.z.ai/api/coding/paas/v4".into()),
                    ..Default::default()
                },
                ..Default::default()
            },
        );

        provider.insert(
            "kimi-coding".into(),
            ProviderConfig {
                api: Some("https://api.kimi.com/coding".into()),
                name: Some("Kimi For Coding".into()),
                env: vec!["KIMI_API_KEY".into()],
                npm: Some("@ai-sdk/anthropic".into()),
                api_format: Some("anthropic".into()),
                options: ProviderOptions {
                    base_url: Some("https://api.kimi.com/coding".into()),
                    ..Default::default()
                },
                ..Default::default()
            },
        );

        provider.insert(
            "alibaba".into(),
            ProviderConfig {
                api: Some("https://dashscope-intl.aliyuncs.com/compatible-mode/v1".into()),
                name: Some("Alibaba".into()),
                env: vec!["DASHSCOPE_API_KEY".into()],
                npm: Some("@ai-sdk/openai-compatible".into()),
                api_format: Some("openai".into()),
                options: ProviderOptions {
                    base_url: Some("https://dashscope-intl.aliyuncs.com/compatible-mode/v1".into()),
                    ..Default::default()
                },
                ..Default::default()
            },
        );

        provider.insert(
            "alibaba-cn".into(),
            ProviderConfig {
                api: Some("https://dashscope.aliyuncs.com/compatible-mode/v1".into()),
                name: Some("Alibaba (China)".into()),
                env: vec!["DASHSCOPE_API_KEY".into()],
                npm: Some("@ai-sdk/openai-compatible".into()),
                api_format: Some("openai".into()),
                options: ProviderOptions {
                    base_url: Some("https://dashscope.aliyuncs.com/compatible-mode/v1".into()),
                    ..Default::default()
                },
                ..Default::default()
            },
        );

        provider.insert(
            "alibaba-coding-plan".into(),
            ProviderConfig {
                api: Some("https://coding-intl.dashscope.aliyuncs.com/v1".into()),
                name: Some("Alibaba Coding Plan".into()),
                env: vec!["ALIBABA_CODING_PLAN_API_KEY".into()],
                npm: Some("@ai-sdk/openai-compatible".into()),
                api_format: Some("openai".into()),
                options: ProviderOptions {
                    base_url: Some("https://coding-intl.dashscope.aliyuncs.com/v1".into()),
                    ..Default::default()
                },
                ..Default::default()
            },
        );

        provider.insert(
            "alibaba-coding-plan-cn".into(),
            ProviderConfig {
                api: Some("https://coding.dashscope.aliyuncs.com/v1".into()),
                name: Some("Alibaba Coding Plan (China)".into()),
                env: vec!["ALIBABA_CODING_PLAN_API_KEY".into()],
                npm: Some("@ai-sdk/openai-compatible".into()),
                api_format: Some("openai".into()),
                options: ProviderOptions {
                    base_url: Some("https://coding.dashscope.aliyuncs.com/v1".into()),
                    ..Default::default()
                },
                ..Default::default()
            },
        );

        provider.insert(
            "cerebras".into(),
            ProviderConfig {
                api: Some("https://api.cerebras.ai/v1".into()),
                name: Some("Cerebras".into()),
                env: vec!["CEREBRAS_API_KEY".into()],
                npm: Some("@ai-sdk/cerebras".into()),
                api_format: Some("openai".into()),
                options: ProviderOptions {
                    base_url: Some("https://api.cerebras.ai/v1".into()),
                    ..Default::default()
                },
                ..Default::default()
            },
        );

        provider.insert(
            "together".into(),
            ProviderConfig {
                api: Some("https://api.together.ai/v1".into()),
                name: Some("Together".into()),
                env: vec!["TOGETHER_API_KEY".into()],
                npm: Some("@ai-sdk/togetherai".into()),
                api_format: Some("openai".into()),
                options: ProviderOptions {
                    base_url: Some("https://api.together.ai/v1".into()),
                    ..Default::default()
                },
                ..Default::default()
            },
        );

        provider.insert(
            "fireworks".into(),
            ProviderConfig {
                api: Some("https://api.fireworks.ai/inference/v1".into()),
                name: Some("Fireworks".into()),
                env: vec!["FIREWORKS_API_KEY".into()],
                npm: Some("@ai-sdk/openai-compatible".into()),
                api_format: Some("openai".into()),
                options: ProviderOptions {
                    base_url: Some("https://api.fireworks.ai/inference/v1".into()),
                    ..Default::default()
                },
                ..Default::default()
            },
        );

        provider.insert(
            "perplexity".into(),
            ProviderConfig {
                api: Some("https://api.perplexity.ai".into()),
                name: Some("Perplexity".into()),
                env: vec!["PERPLEXITY_API_KEY".into()],
                npm: Some("@ai-sdk/perplexity".into()),
                api_format: Some("openai".into()),
                options: ProviderOptions {
                    base_url: Some("https://api.perplexity.ai".into()),
                    ..Default::default()
                },
                ..Default::default()
            },
        );

        provider.insert(
            "huggingface".into(),
            ProviderConfig {
                api: Some("https://router.huggingface.co/v1".into()),
                name: Some("Hugging Face".into()),
                env: vec!["HF_TOKEN".into()],
                npm: Some("@ai-sdk/openai-compatible".into()),
                api_format: Some("openai".into()),
                options: ProviderOptions {
                    base_url: Some("https://router.huggingface.co/v1".into()),
                    ..Default::default()
                },
                ..Default::default()
            },
        );

        provider.insert(
            "amazon-bedrock".into(),
            ProviderConfig {
                api: Some("https://bedrock-runtime.us-east-1.amazonaws.com".into()),
                name: Some("Amazon Bedrock".into()),
                env: vec![
                    "AWS_ACCESS_KEY_ID".into(),
                    "AWS_SECRET_ACCESS_KEY".into(),
                    "AWS_REGION".into(),
                    "AWS_BEARER_TOKEN_BEDROCK".into(),
                ],
                npm: Some("@ai-sdk/amazon-bedrock".into()),
                api_format: Some("openai".into()),
                options: ProviderOptions {
                    base_url: Some("https://bedrock-runtime.us-east-1.amazonaws.com".into()),
                    ..Default::default()
                },
                ..Default::default()
            },
        );

        provider.insert(
            "azure".into(),
            ProviderConfig {
                api: Some("https://api.openai.com/v1".into()),
                name: Some("Azure OpenAI".into()),
                env: vec!["AZURE_RESOURCE_NAME".into(), "AZURE_API_KEY".into()],
                npm: Some("@ai-sdk/azure".into()),
                api_format: Some("openai".into()),
                options: ProviderOptions {
                    base_url: Some("https://api.openai.com/v1".into()),
                    ..Default::default()
                },
                ..Default::default()
            },
        );

        provider.insert(
            "moonshotai".into(),
            ProviderConfig {
                api: Some("https://api.moonshot.ai/v1".into()),
                name: Some("Moonshot AI".into()),
                env: vec!["MOONSHOT_API_KEY".into()],
                npm: Some("@ai-sdk/openai-compatible".into()),
                api_format: Some("openai".into()),
                options: ProviderOptions {
                    base_url: Some("https://api.moonshot.ai/v1".into()),
                    ..Default::default()
                },
                ..Default::default()
            },
        );

        provider.insert(
            "nvidia".into(),
            ProviderConfig {
                api: Some("https://integrate.api.nvidia.com/v1".into()),
                name: Some("Nvidia".into()),
                env: vec!["NVIDIA_API_KEY".into()],
                npm: Some("@ai-sdk/openai-compatible".into()),
                api_format: Some("openai".into()),
                options: ProviderOptions {
                    base_url: Some("https://integrate.api.nvidia.com/v1".into()),
                    ..Default::default()
                },
                ..Default::default()
            },
        );

        provider.insert(
            "siliconflow".into(),
            ProviderConfig {
                api: Some("https://api.siliconflow.com/v1".into()),
                name: Some("SiliconFlow".into()),
                env: vec!["SILICONFLOW_API_KEY".into()],
                npm: Some("@ai-sdk/openai-compatible".into()),
                api_format: Some("openai".into()),
                options: ProviderOptions {
                    base_url: Some("https://api.siliconflow.com/v1".into()),
                    ..Default::default()
                },
                ..Default::default()
            },
        );

        provider.insert(
            "ant-ling".into(),
            ProviderConfig {
                api: Some("https://api.ant-ling.com/v1".into()),
                name: Some("Ant Ling".into()),
                env: vec!["ANT_LING_API_KEY".into()],
                npm: Some("@ai-sdk/openai-compatible".into()),
                api_format: Some("openai".into()),
                options: ProviderOptions {
                    base_url: Some("https://api.ant-ling.com/v1".into()),
                    ..Default::default()
                },
                ..Default::default()
            },
        );

        provider.insert(
            "baseten".into(),
            ProviderConfig {
                api: Some("https://inference.baseten.co/v1".into()),
                name: Some("Baseten".into()),
                env: vec!["BASETEN_API_KEY".into()],
                npm: Some("@ai-sdk/openai-compatible".into()),
                api_format: Some("openai".into()),
                options: ProviderOptions {
                    base_url: Some("https://inference.baseten.co/v1".into()),
                    ..Default::default()
                },
                ..Default::default()
            },
        );

        provider.insert(
            "qwen-token-plan".into(),
            ProviderConfig {
                api: Some(
                    "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1".into(),
                ),
                name: Some("Qwen Token Plan".into()),
                env: vec!["QWEN_TOKEN_PLAN_API_KEY".into()],
                npm: Some("@ai-sdk/openai-compatible".into()),
                api_format: Some("openai".into()),
                options: ProviderOptions {
                    base_url: Some(
                        "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1"
                            .into(),
                    ),
                    ..Default::default()
                },
                ..Default::default()
            },
        );

        provider.insert(
            "qwen-token-plan-cn".into(),
            ProviderConfig {
                api: Some(
                    "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1".into(),
                ),
                name: Some("Qwen Token Plan CN".into()),
                env: vec!["QWEN_TOKEN_PLAN_CN_API_KEY".into()],
                npm: Some("@ai-sdk/openai-compatible".into()),
                api_format: Some("openai".into()),
                options: ProviderOptions {
                    base_url: Some(
                        "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1".into(),
                    ),
                    ..Default::default()
                },
                ..Default::default()
            },
        );

        provider.insert(
            "vercel-ai-gateway".into(),
            ProviderConfig {
                api: Some("https://ai-gateway.vercel.sh".into()),
                name: Some("Vercel AI Gateway".into()),
                env: vec!["AI_GATEWAY_API_KEY".into()],
                npm: Some("@ai-sdk/anthropic".into()),
                api_format: Some("anthropic".into()),
                options: ProviderOptions {
                    base_url: Some("https://ai-gateway.vercel.sh".into()),
                    ..Default::default()
                },
                ..Default::default()
            },
        );

        provider.insert(
            "xiaomi".into(),
            ProviderConfig {
                api: Some("https://api.xiaomimimo.com/v1".into()),
                name: Some("Xiaomi".into()),
                env: vec!["XIAOMI_API_KEY".into()],
                npm: Some("@ai-sdk/openai-compatible".into()),
                api_format: Some("openai".into()),
                options: ProviderOptions {
                    base_url: Some("https://api.xiaomimimo.com/v1".into()),
                    ..Default::default()
                },
                ..Default::default()
            },
        );

        provider.insert(
            "xiaomi-token-plan-ams".into(),
            ProviderConfig {
                api: Some("https://token-plan-ams.xiaomimimo.com/v1".into()),
                name: Some("Xiaomi Token Plan AMS".into()),
                env: vec!["XIAOMI_TOKEN_PLAN_AMS_API_KEY".into()],
                npm: Some("@ai-sdk/openai-compatible".into()),
                api_format: Some("openai".into()),
                options: ProviderOptions {
                    base_url: Some("https://token-plan-ams.xiaomimimo.com/v1".into()),
                    ..Default::default()
                },
                ..Default::default()
            },
        );

        provider.insert(
            "xiaomi-token-plan-cn".into(),
            ProviderConfig {
                api: Some("https://token-plan-cn.xiaomimimo.com/v1".into()),
                name: Some("Xiaomi Token Plan CN".into()),
                env: vec!["XIAOMI_TOKEN_PLAN_CN_API_KEY".into()],
                npm: Some("@ai-sdk/openai-compatible".into()),
                api_format: Some("openai".into()),
                options: ProviderOptions {
                    base_url: Some("https://token-plan-cn.xiaomimimo.com/v1".into()),
                    ..Default::default()
                },
                ..Default::default()
            },
        );

        provider.insert(
            "xiaomi-token-plan-sgp".into(),
            ProviderConfig {
                api: Some("https://token-plan-sgp.xiaomimimo.com/v1".into()),
                name: Some("Xiaomi Token Plan SGP".into()),
                env: vec!["XIAOMI_TOKEN_PLAN_SGP_API_KEY".into()],
                npm: Some("@ai-sdk/openai-compatible".into()),
                api_format: Some("openai".into()),
                options: ProviderOptions {
                    base_url: Some("https://token-plan-sgp.xiaomimimo.com/v1".into()),
                    ..Default::default()
                },
                ..Default::default()
            },
        );

        provider.insert(
            "zai-coding-cn".into(),
            ProviderConfig {
                api: Some("https://open.bigmodel.cn/api/coding/paas/v4".into()),
                name: Some("Z.AI Coding CN".into()),
                env: vec!["ZAI_CODING_CN_API_KEY".into()],
                npm: Some("@ai-sdk/openai-compatible".into()),
                api_format: Some("openai".into()),
                options: ProviderOptions {
                    base_url: Some("https://open.bigmodel.cn/api/coding/paas/v4".into()),
                    ..Default::default()
                },
                ..Default::default()
            },
        );

        provider.insert(
            "moonshotai-cn".into(),
            ProviderConfig {
                api: Some("https://api.moonshot.cn/v1".into()),
                name: Some("Moonshot AI CN".into()),
                env: vec!["MOONSHOT_API_KEY".into()],
                npm: Some("@ai-sdk/openai-compatible".into()),
                api_format: Some("openai".into()),
                options: ProviderOptions {
                    base_url: Some("https://api.moonshot.cn/v1".into()),
                    ..Default::default()
                },
                ..Default::default()
            },
        );

        provider.retain(|id, config| provider_is_supported(id, config));

        Self {
            default_provider: Some("deepseek".into()),
            default_model: Some("deepseek-flash".into()),
            planner_model: Some("deepseek-flash".into()),
            executor_model: Some("deepseek-flash".into()),
            editor: None,
            auto_approve: AutoApproveConfig::default(),
            default_mode: Some("Build".into()),
            theme: None,
            max_iterations: None,
            default_thinking_level: None,
            discovered_models: HashMap::new(),
            provider,
            mcp: HashMap::new(),
            catalog: None,
            auth_store: AuthStore::default(),
        }
    }
}

impl AppConfig {
    /// Resolved tool-loop iteration cap for a single turn.
    /// Defaults to 500 — generous enough for long-horizon tasks while still
    /// acting as a safety valve against pathological tool-calling loops.
    pub fn max_iterations(&self) -> u32 {
        self.max_iterations.unwrap_or(500)
    }
}

impl AppConfig {
    /// Load global and project configuration without refreshing the model
    /// catalog. Project switches use the already-loaded catalog so changing
    /// tabs can never block on network access or inherit the previous
    /// workspace's overrides.
    pub fn load_for_project(
        project_dir: &str,
        catalog: Option<crate::catalog::ModelCatalog>,
    ) -> Self {
        let mut config = Self {
            auth_store: AuthStore::load(),
            ..Self::default()
        };
        if let Some(catalog) = catalog {
            config.merge_catalog(&catalog);
        }
        if let Some(path) = Self::global_config_path() {
            if let Ok(content) = std::fs::read_to_string(path) {
                if let Ok(loaded) = serde_json::from_str::<AppConfig>(&content) {
                    config = config.merge(loaded);
                }
            }
        }
        let path = PathBuf::from(project_dir).join("agente.json");
        if let Ok(content) = std::fs::read_to_string(path) {
            if let Ok(loaded) = serde_json::from_str::<AppConfig>(&content) {
                config = config.merge(loaded);
            }
        }
        config
    }

    pub fn load(project_dir: &str) -> Self {
        let mut config = Self {
            auth_store: AuthStore::load(),
            ..Self::default()
        };

        // models.dev catalog: cache first, then network. Authoritative source for
        // context windows / capabilities / **reasoning_options** (thinking levels).
        let cached = crate::catalog::ModelCatalog::load_from_cache().and_then(|catalog| {
            if catalog.is_stale_for_thinking() {
                tracing::warn!(
                    reasoning_models = catalog.reasoning_model_count(),
                    "Cached models.dev catalog lacks reasoning_options; re-fetching"
                );
                crate::catalog::ModelCatalog::invalidate_cache();
                None
            } else {
                Some(catalog)
            }
        });

        if let Some(catalog) = cached {
            tracing::info!(
                providers = catalog.providers.len(),
                models = catalog.model_count(),
                reasoning_options = catalog.reasoning_options_count(),
                "Loaded model catalog from cache"
            );
            config.merge_catalog(&catalog);
        } else {
            let try_fetch = std::thread::spawn(|| {
                let rt = match tokio::runtime::Runtime::new() {
                    Ok(rt) => rt,
                    Err(e) => {
                        eprintln!("agente: catalog runtime error: {e}");
                        return None;
                    }
                };
                rt.block_on(async {
                    match crate::catalog::ModelCatalog::fetch().await {
                        Ok(catalog) => {
                            if let Err(e) = catalog.save_to_cache() {
                                eprintln!("agente: failed to cache model catalog: {e}");
                            }
                            eprintln!(
                                "agente: models.dev loaded ({} models, {} with reasoning_options)",
                                catalog.model_count(),
                                catalog.reasoning_options_count()
                            );
                            Some(catalog)
                        }
                        Err(e) => {
                            eprintln!("agente: failed to fetch models.dev catalog: {e}");
                            None
                        }
                    }
                })
            });
            match try_fetch.join() {
                Ok(Some(catalog)) => {
                    tracing::info!(
                        providers = catalog.providers.len(),
                        models = catalog.model_count(),
                        reasoning_options = catalog.reasoning_options_count(),
                        "Fetched and merged models.dev catalog"
                    );
                    config.merge_catalog(&catalog);
                }
                Ok(None) => {
                    tracing::warn!(
                        "No models.dev catalog available; using built-in provider model lists only"
                    );
                }
                Err(_) => {
                    tracing::warn!("Model catalog fetch thread panicked");
                }
            }
        }

        // Load user config from home
        if let Some(home_config) = Self::global_config_path() {
            if home_config.exists() {
                if let Ok(content) = std::fs::read_to_string(&home_config) {
                    if let Ok(loaded) = serde_json::from_str::<AppConfig>(&content) {
                        config = config.merge(loaded);
                    }
                }
            }
        }

        // Load project config (overrides global)
        let project_config = PathBuf::from(project_dir).join("agente.json");
        if project_config.exists() {
            if let Ok(content) = std::fs::read_to_string(&project_config) {
                if let Ok(loaded) = serde_json::from_str::<AppConfig>(&content) {
                    config = config.merge(loaded);
                }
            }
        }

        config
    }

    /// Save config to `~/.agente/config.json`.
    /// Auth keys are **not** written — they live in `~/.agente/auth.json`.
    pub fn save(&self) -> std::io::Result<()> {
        Self::save_to(self, None)
    }

    /// Save config to both the global path and the workspace `<project_dir>/agente.json`.
    /// The workspace copy is a mirror that overrides the global on next load.
    pub fn save_to_workspace(&self, project_dir: &str) -> std::io::Result<()> {
        Self::save_to(self, Some(project_dir))
    }

    fn save_to(&self, project_dir: Option<&str>) -> std::io::Result<()> {
        let mut stripped = self.strip_secrets();
        // `strip_secrets` drops the catalog handle, so pass ours in.
        stripped.strip_catalog_derived(self.catalog.as_ref());
        let content = serde_json::to_string_pretty(&stripped)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;

        // Always write global first.
        if let Some(global_path) = Self::global_config_path() {
            if let Some(parent) = global_path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(&global_path, &content)?;
        }

        // Mirror to workspace if given.
        if let Some(dir) = project_dir {
            let workspace_path = PathBuf::from(dir).join("agente.json");
            if let Some(parent) = workspace_path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(&workspace_path, &content)?;
        }

        Ok(())
    }

    /// Drop model entries that a fresh catalog merge would recreate verbatim.
    ///
    /// [`Self::merge_catalog`] copies every models.dev entry for a connectable
    /// provider into `provider[id].models`. Persisting those copies made the
    /// on-disk config **4.4 MB** — rewritten in full, to two locations, on every
    /// `/model`, `/theme` or provider connect — and let stale rows outlive
    /// [`crate::catalog::ModelCatalog::invalidate_cache`], since a reload merged
    /// them back as if the user had authored them.
    ///
    /// The catalog is re-merged from its own cache on every load, so the copies
    /// carry no information. Anything the user authored or overrode differs from
    /// the catalog value and is kept; if either side fails to serialize we cannot
    /// prove the entry is redundant, so it stays.
    fn strip_catalog_derived(&mut self, catalog: Option<&crate::catalog::ModelCatalog>) {
        let Some(catalog) = catalog else {
            return;
        };
        for (id, provider) in self.provider.iter_mut() {
            let Some(catalog_provider) = catalog.providers.get(id) else {
                continue;
            };
            provider.models.retain(|model_id, model| {
                let Some(catalog_model) = catalog_provider.models.get(model_id) else {
                    return true;
                };
                let derived = model_config_from_catalog(catalog_model);
                match (serde_json::to_value(model), serde_json::to_value(&derived)) {
                    (Ok(saved), Ok(derived)) => saved != derived,
                    _ => true,
                }
            });
        }
        // Provider level: `merge` re-inserts every provider row stored in a
        // persisted file, so shells copied by older catalog merges (the live
        // `agente.json` once held 187 providers / 3000+ models) resurrect on
        // every load and the model loop above can never remove them — it only
        // trims *models* inside catalog-known providers. Drop whole shells
        // that carry no user authorship. `api`/`name`/`env`/`npm`/`api_format`
        // are deliberately NOT signals: `merge_catalog` fills those itself.
        // Everything a user action writes survives: connect stores
        // `options.base_url` (`add_provider_with_key`, key lives in auth.json),
        // hand-added models/whitelists/extras keep their provider, and
        // built-ins always stay (the connect dialog lists them).
        let builtin = Self::default();
        self.provider.retain(|id, provider| {
            if builtin.provider.contains_key(id) {
                return true;
            }
            provider.options.api_key.is_some()
                || provider.options.base_url.is_some()
                || provider.options.enterprise_url.is_some()
                || provider.options.timeout.is_some()
                || provider.options.chunk_timeout.is_some()
                || !provider.options.extra.is_empty()
                || !provider.whitelist.is_empty()
                || !provider.blacklist.is_empty()
                || !provider.models.is_empty()
        });
    }

    /// Replace catalog-derived data while retaining explicitly configured models.
    pub fn refresh_catalog(&mut self, catalog: &crate::catalog::ModelCatalog) {
        let previous = self.catalog.clone();
        self.strip_catalog_derived(previous.as_ref());
        let builtin = Self::default();
        let overrides: HashMap<_, _> = self
            .provider
            .iter()
            .map(|(id, provider)| {
                let mut models = provider.models.clone();
                models.retain(|model_id, model| {
                    let default = builtin
                        .provider
                        .get(id)
                        .and_then(|p| p.models.get(model_id));
                    default.is_none_or(|default| {
                        serde_json::to_value(default).ok() != serde_json::to_value(model).ok()
                    })
                });
                (id.clone(), models)
            })
            .collect();
        self.merge_catalog(catalog);
        for (id, models) in overrides {
            if let Some(provider) = self.provider.get_mut(&id) {
                provider.models.extend(models);
            }
        }
    }

    /// Merge models.dev metadata into **existing** connectable providers only.
    ///
    /// The full catalog is kept on `self.catalog` for context windows / capabilities
    /// lookup. We intentionally do **not** register every models.dev gateway as a
    /// first-class provider — that flooded the connect UI with hundreds of entries.
    fn merge_catalog(&mut self, catalog: &crate::catalog::ModelCatalog) {
        self.catalog = Some(catalog.clone());

        for (id, provider) in &catalog.providers {
            let Some(existing) = self.provider.get_mut(id) else {
                continue;
            };

            // Empty-string `api` in config means "unknown" (many generated configs
            // store an empty placeholder) — let the catalog fill it.
            if existing.api.as_deref().is_none_or(str::is_empty) && !provider.api.is_empty() {
                existing.api = Some(provider.api.clone());
            }
            if existing.name.is_none() {
                existing.name = Some(provider.name.clone());
            }
            if existing.env.is_empty() && !provider.env.is_empty() {
                existing.env = provider.env.clone();
            }
            if existing.npm.is_none() && !provider.npm.is_empty() {
                existing.npm = Some(provider.npm.clone());
            }
            if existing.api_format.is_none() {
                existing.api_format = Some(infer_api_format_from_npm(&provider.npm));
            }
            for (model_id, model) in &provider.models {
                // Catalog data is authoritative over built-in placeholders.
                existing
                    .models
                    .insert(model_id.clone(), model_config_from_catalog(model));
            }
        }
    }

    pub fn merge(mut self, other: AppConfig) -> Self {
        for (k, v) in other.provider {
            if let Some(existing) = self.provider.get_mut(&k) {
                if v.api.is_some() {
                    existing.api = v.api;
                }
                if v.name.is_some() {
                    existing.name = v.name;
                }
                if !v.env.is_empty() {
                    existing.env = v.env;
                }
                if v.id.is_some() {
                    existing.id = v.id;
                }
                if v.npm.is_some() {
                    existing.npm = v.npm;
                }
                if v.api_format.is_some() {
                    existing.api_format = v.api_format;
                }
                if !v.whitelist.is_empty() {
                    existing.whitelist = v.whitelist;
                }
                if !v.blacklist.is_empty() {
                    existing.blacklist = v.blacklist;
                }
                if v.options.api_key.is_some() {
                    existing.options.api_key = v.options.api_key;
                }
                if v.options.base_url.is_some() {
                    existing.options.base_url = v.options.base_url;
                }
                if v.options.enterprise_url.is_some() {
                    existing.options.enterprise_url = v.options.enterprise_url;
                }
                if v.options.timeout.is_some() {
                    existing.options.timeout = v.options.timeout;
                }
                if v.options.chunk_timeout.is_some() {
                    existing.options.chunk_timeout = v.options.chunk_timeout;
                }
                if !v.options.extra.is_empty() {
                    existing.options.extra.extend(v.options.extra);
                }
                if !v.models.is_empty() {
                    existing.models.extend(v.models);
                }
            } else {
                self.provider.insert(k, v);
            }
        }
        for (k, v) in other.mcp {
            self.mcp.insert(k, v);
        }
        if other.default_provider.is_some() {
            self.default_provider = other.default_provider;
        }
        if other.default_model.is_some() {
            self.default_model = other.default_model;
        }
        if other.planner_model.is_some() {
            self.planner_model = other.planner_model;
        }
        if other.executor_model.is_some() {
            self.executor_model = other.executor_model;
        }
        if other.editor.is_some() {
            self.editor = other.editor;
        }
        if other.default_mode.is_some() {
            self.default_mode = other.default_mode;
        }
        if other.default_thinking_level.is_some() {
            self.default_thinking_level = other.default_thinking_level;
        }
        if !other.discovered_models.is_empty() {
            for (k, v) in other.discovered_models {
                self.discovered_models.insert(k, v);
            }
        }
        self.auto_approve = other.auto_approve;
        self
    }

    /// Resolve API key with full fallback chain:
    /// 1. Auth store (`~/.agente/auth.json`)
    /// 2. Config `options.api_key`
    /// 3. Environment variables declared in config
    /// 4. Fallback `{PROVIDER}_API_KEY` convention
    pub fn resolve_api_key(&self, provider_id: &str) -> Option<String> {
        // 1. Auth store (preferred — separate from config)
        if let Some(key) = self.auth_store.get_key(provider_id) {
            return Some(key);
        }

        if let Some(provider) = self.provider.get(provider_id) {
            // 2. Check options.api_key from config
            if let Some(key) = &provider.options.api_key {
                if !key.is_empty() {
                    return Some(key.clone());
                }
            }

            // 3. Check env vars in order
            for env_key in &provider.env {
                if let Ok(val) = std::env::var(env_key) {
                    if !val.is_empty() {
                        return Some(val);
                    }
                }
            }

            // 4. Fallback to {PROVIDER}_API_KEY convention
            let fallback = format!("{}_API_KEY", provider_id.to_uppercase().replace('-', "_"));
            if let Ok(val) = std::env::var(&fallback) {
                if !val.is_empty() {
                    return Some(val);
                }
            }
        }

        None
    }

    pub fn resolve_base_url(&self, provider_id: &str) -> Option<String> {
        let env_key = format!("{}_BASE_URL", provider_id.to_uppercase().replace('-', "_"));
        if let Ok(val) = std::env::var(&env_key) {
            if !val.is_empty() {
                return Some(crate::util::expand_env_templates(&val));
            }
        }

        if let Some(provider) = self.provider.get(provider_id) {
            if let Some(url) = &provider.options.base_url {
                if !url.is_empty() {
                    return Some(crate::util::expand_env_templates(url));
                }
            }
            if let Some(url) = &provider.api {
                if !url.is_empty() {
                    return Some(crate::util::expand_env_templates(url));
                }
            }
        }

        None
    }

    pub fn has_api_key(&self, provider_id: &str) -> bool {
        self.resolve_api_key(provider_id).is_some()
    }

    pub fn provider_entries(&self) -> Vec<ProviderEntry> {
        let mut entries = Vec::new();

        for (id, provider) in &self.provider {
            if !provider_is_supported(id, provider) {
                continue;
            }
            let name = provider.name.as_ref().unwrap_or(id).clone();
            let env_key = provider.env.first().cloned().unwrap_or_default();

            entries.push(ProviderEntry {
                id: id.clone(),
                name,
                env_key,
            });
        }

        entries
    }

    /// Add or update a provider and persist both config and auth.
    /// The API key is stored in `~/.agente/auth.json`, never in config.
    /// Existing provider metadata (api_format, models, etc.) is preserved.
    pub fn add_provider_with_key(
        &mut self,
        provider_name: &str,
        base_url: String,
        api_key: String,
    ) {
        let env_key = format!("{}_API_KEY", provider_name.to_uppercase().replace('-', "_"));

        // Merge with existing config if present
        let config = if let Some(existing) = self.provider.get(provider_name) {
            ProviderConfig {
                name: existing.name.clone().or_else(|| Some(provider_name.into())),
                api: Some(base_url.clone()),
                env: if existing.env.is_empty() {
                    vec![env_key.clone()]
                } else {
                    existing.env.clone()
                },
                id: existing.id.clone(),
                npm: existing.npm.clone(),
                api_format: existing.api_format.clone(),
                whitelist: existing.whitelist.clone(),
                blacklist: existing.blacklist.clone(),
                options: ProviderOptions {
                    base_url: Some(base_url),
                    api_key: None, // never store in config
                    enterprise_url: existing.options.enterprise_url.clone(),
                    timeout: existing.options.timeout,
                    chunk_timeout: existing.options.chunk_timeout,
                    extra: existing.options.extra.clone(),
                },
                models: existing.models.clone(),
            }
        } else {
            ProviderConfig {
                name: Some(provider_name.into()),
                api: Some(base_url.clone()),
                env: vec![env_key.clone()],
                api_format: Some("openai".into()),
                options: ProviderOptions {
                    base_url: Some(base_url),
                    ..Default::default()
                },
                ..Default::default()
            }
        };

        self.provider.insert(provider_name.to_string(), config);
        self.auth_store.set_key(provider_name, api_key);

        // Persist both files
        if let Err(e) = self.auth_store.save() {
            tracing::warn!(error = %e, "Failed to save auth store");
        }
        if let Err(e) = self.save() {
            tracing::warn!(error = %e, "Failed to save config");
        }
    }

    /// Update the cached default provider/model and persist to the workspace mirror.
    /// Use this for state mutations that originate from TUI interactions.
    pub fn set_defaults(&mut self, provider: Option<String>, model: Option<String>) {
        if let Some(p) = provider {
            if !p.is_empty() {
                self.default_provider = Some(p);
            }
        }
        if let Some(m) = model {
            if !m.is_empty() {
                self.default_model = Some(m);
            }
        }
    }

    pub fn resolve_editor(&self) -> String {
        if let Some(editor) = &self.editor {
            if !editor.is_empty() {
                return editor.clone();
            }
        }
        if let Ok(editor) = std::env::var("EDITOR") {
            return editor;
        }
        if let Ok(visual) = std::env::var("VISUAL") {
            return visual;
        }
        if cfg!(target_os = "windows") {
            "notepad".to_string()
        } else {
            "vim".to_string()
        }
    }

    pub fn get_provider_name(&self, provider_id: &str) -> String {
        self.provider
            .get(provider_id)
            .and_then(|p| p.name.clone())
            .unwrap_or_else(|| provider_id.to_string())
    }

    /// Return a copy of this config with secrets stripped for serialization.
    fn strip_secrets(&self) -> Self {
        let mut provider = self.provider.clone();
        for pc in provider.values_mut() {
            pc.options.api_key = None;
        }
        Self {
            provider,
            default_provider: self.default_provider.clone(),
            default_model: self.default_model.clone(),
            planner_model: self.planner_model.clone(),
            executor_model: self.executor_model.clone(),
            max_iterations: self.max_iterations,
            editor: self.editor.clone(),
            auto_approve: self.auto_approve.clone(),
            default_mode: self.default_mode.clone(),
            theme: self.theme.clone(),
            default_thinking_level: self.default_thinking_level.clone(),
            discovered_models: self.discovered_models.clone(),
            mcp: self.mcp.clone(),
            catalog: None,
            auth_store: AuthStore::default(),
        }
    }

    /// Global config path: `~/.agente/config.json`.
    pub fn global_config_path() -> Option<PathBuf> {
        Some(Self::config_dir()?.join("config.json"))
    }

    /// Root of the global config/auth store.
    ///
    /// `AGENTE_CONFIG_DIR` redirects it so a test run never writes the
    /// developer's own `~/.agente/config.json` — several TUI key-handling tests
    /// reach `persist_config()` and used to rewrite it for real.
    pub fn config_dir() -> Option<PathBuf> {
        if let Some(dir) = std::env::var_os("AGENTE_CONFIG_DIR") {
            return Some(PathBuf::from(dir));
        }
        dirs::home_dir().map(|h| h.join(".agente"))
    }
}

fn model_config_from_catalog(model: &crate::catalog::CatalogModel) -> ModelConfig {
    ModelConfig {
        name: Some(model.name.clone()),
        provider: model.provider.clone(),
        capabilities: Some(model.capabilities.clone()),
        cost: Some(model.cost.clone()),
        limit: Some(model.limit.clone()),
        status: Some(model.status.clone()),
        headers: model.headers.clone(),
        reasoning_options: model.reasoning_options.clone(),
        reasoning_stream_field: model.reasoning_stream_field.clone(),
        options: model.options.clone(),
    }
}

/// Infer API format from the npm package name used by the provider.
fn infer_api_format_from_npm(npm: &str) -> String {
    use crate::providers::ApiFormat;
    match ApiFormat::from_npm(npm).unwrap_or_default() {
        ApiFormat::Anthropic => "anthropic",
        ApiFormat::Responses => "responses",
        ApiFormat::Google => "google",
        ApiFormat::OpenAI => "openai",
    }
    .into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_config_default() {
        let config = AppConfig::default();
        assert!(config.default_provider.is_some());
        assert!(config.default_model.is_some());
        assert!(!config.provider.is_empty());
    }

    #[test]
    fn retired_providers_are_hidden_even_in_saved_config() {
        let mut config = AppConfig::default();
        for id in ["anthropic", "google", "gemini"] {
            assert!(!config.provider.contains_key(id));
            config.provider.insert(id.into(), ProviderConfig::default());
        }
        config.provider.insert(
            "legacy-google".into(),
            ProviderConfig {
                api_format: Some("gemini".into()),
                ..Default::default()
            },
        );
        let entries = config.provider_entries();
        for id in ["anthropic", "google", "gemini", "legacy-google"] {
            assert!(!entries.iter().any(|entry| entry.id == id));
        }
        assert!(entries.iter().any(|entry| entry.id == "minimax"));
        let registry = crate::providers::ProviderRegistry::from_config(&config);
        for id in ["anthropic", "google", "gemini", "legacy-google"] {
            assert!(registry.get(id).is_none());
        }
    }

    #[test]
    fn test_provider_entries() {
        let config = AppConfig::default();
        let entries = config.provider_entries();
        assert!(!entries.is_empty());
        assert!(entries.iter().any(|e| e.id == "openrouter"));
    }

    #[test]
    fn test_resolve_base_url() {
        let config = AppConfig::default();
        let url = config.resolve_base_url("openrouter");
        assert!(url.is_some());
        assert!(url.unwrap().starts_with("http"));
    }

    #[test]
    fn test_resolve_editor_default() {
        let config = AppConfig::default();
        let editor = config.resolve_editor();
        assert!(!editor.is_empty());
    }

    #[test]
    fn test_get_provider_name() {
        let config = AppConfig::default();
        let name = config.get_provider_name("openrouter");
        assert_eq!(name, "OpenRouter");
    }

    #[test]
    fn test_get_provider_name_unknown() {
        let config = AppConfig::default();
        let name = config.get_provider_name("unknown_provider");
        assert_eq!(name, "unknown_provider");
    }

    #[test]
    fn test_auto_approve_default() {
        let config = AutoApproveConfig::default();
        assert!(config.read_operations);
        assert!(!config.write_new_files);
        assert!(!config.safe_commands.is_empty());
        assert_eq!(config.max_auto_edit_lines, 10);
    }

    #[test]
    fn test_strip_secrets() {
        let mut config = AppConfig::default();
        config
            .provider
            .get_mut("openrouter")
            .unwrap()
            .options
            .api_key = Some("secret".into());
        let stripped = config.strip_secrets();
        assert!(stripped.provider["openrouter"].options.api_key.is_none());
    }

    #[test]
    fn test_set_defaults_ignores_empty_values() {
        let mut config = AppConfig {
            default_provider: Some("openai".into()),
            default_model: Some("gpt-4o".into()),
            ..AppConfig::default()
        };
        config.set_defaults(Some(String::new()), Some(String::new()));
        assert_eq!(config.default_provider.as_deref(), Some("openai"));
        assert_eq!(config.default_model.as_deref(), Some("gpt-4o"));
        config.set_defaults(
            Some("anthropic".into()),
            Some("claude-sonnet-4-20250514".into()),
        );
        assert_eq!(config.default_provider.as_deref(), Some("anthropic"));
        assert_eq!(
            config.default_model.as_deref(),
            Some("claude-sonnet-4-20250514")
        );
    }

    #[test]
    fn test_default_mode_round_trips_via_serde() {
        let mut config = AppConfig {
            default_mode: Some("Build".into()),
            ..AppConfig::default()
        };
        config
            .discovered_models
            .insert("openai".into(), vec!["gpt-4o".into(), "gpt-4o-mini".into()]);
        let json = serde_json::to_string(&config.strip_secrets()).unwrap();
        let parsed: AppConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.default_mode.as_deref(), Some("Build"));
        assert_eq!(
            parsed.discovered_models.get("openai").unwrap(),
            &vec!["gpt-4o".to_string(), "gpt-4o-mini".to_string()]
        );
    }

    #[test]
    fn default_providers_are_the_five_supported_services() {
        let config = AppConfig::default();
        let ids: Vec<String> = config
            .provider_entries()
            .into_iter()
            .map(|p| p.id)
            .collect();
        assert_eq!(ids.len(), 5);
        for id in ["deepseek", "minimax", "glm", "opencode-go", "openrouter"] {
            assert!(ids.iter().any(|p| p == id), "missing provider {id}");
        }
    }

    #[test]
    fn catalog_replaces_placeholder_models() {
        use crate::catalog::{
            CatalogModel, ModelCapabilities, ModelCost, ModelLimits, ModelStatus,
        };

        let mut config = AppConfig::default();
        let mut models = HashMap::new();
        models.insert(
            "gpt-4o".to_string(),
            CatalogModel {
                provider: None,
                id: "gpt-4o".to_string(),
                provider_id: "openrouter".to_string(),
                name: "GPT-4o Real".to_string(),
                family: None,
                capabilities: ModelCapabilities::default(),
                cost: ModelCost::default(),
                limit: ModelLimits::default(),
                status: ModelStatus::Active,
                api_id: "gpt-4o-real".to_string(),
                reasoning_options: Vec::new(),
                reasoning_stream_field: None,
                headers: HashMap::new(),
                options: HashMap::new(),
                variants: HashMap::new(),
            },
        );
        let mut catalog = crate::catalog::ModelCatalog::default();
        catalog.providers.insert(
            "openrouter".to_string(),
            crate::catalog::CatalogProvider {
                id: "openrouter".to_string(),
                name: "OpenAI".to_string(),
                env: vec!["OPENAI_API_KEY".to_string()],
                api: "https://api.openai.com/v1".to_string(),
                npm: "@ai-sdk/openai".to_string(),
                models,
                whitelist: Vec::new(),
                blacklist: Vec::new(),
            },
        );

        config.merge_catalog(&catalog);
        assert_eq!(
            config.provider["openrouter"].models["gpt-4o"]
                .name
                .as_deref(),
            Some("GPT-4o Real")
        );
    }

    #[test]
    fn merge_catalog_does_not_add_unknown_providers() {
        use crate::catalog::{
            CatalogModel, ModelCapabilities, ModelCost, ModelLimits, ModelStatus,
        };

        let mut config = AppConfig::default();
        let before = config.provider.len();
        let mut models = HashMap::new();
        models.insert(
            "obscure-model".to_string(),
            CatalogModel {
                provider: None,
                id: "obscure-model".to_string(),
                provider_id: "some-random-gateway".to_string(),
                name: "Obscure".to_string(),
                family: None,
                capabilities: ModelCapabilities::default(),
                cost: ModelCost::default(),
                limit: ModelLimits {
                    context: 99_000,
                    input: None,
                    output: 4096,
                },
                status: ModelStatus::Active,
                api_id: "obscure-model".to_string(),
                reasoning_options: Vec::new(),
                reasoning_stream_field: None,
                headers: HashMap::new(),
                options: HashMap::new(),
                variants: HashMap::new(),
            },
        );
        let mut catalog = crate::catalog::ModelCatalog::default();
        catalog.providers.insert(
            "some-random-gateway".to_string(),
            crate::catalog::CatalogProvider {
                id: "some-random-gateway".to_string(),
                name: "Random Gateway".to_string(),
                env: vec!["RANDOM_API_KEY".to_string()],
                api: "https://example.com/v1".to_string(),
                npm: "@ai-sdk/openai".to_string(),
                models,
                whitelist: Vec::new(),
                blacklist: Vec::new(),
            },
        );

        config.merge_catalog(&catalog);
        assert_eq!(config.provider.len(), before);
        assert!(!config.provider.contains_key("some-random-gateway"));
        assert!(config.catalog.is_some());
        assert!(config
            .catalog
            .as_ref()
            .unwrap()
            .find_model("some-random-gateway", "obscure-model")
            .is_some());
    }

    /// A merged catalog must not reach disk. The live `agente.json` in this
    /// repo was 4,488,530 bytes because `merge_catalog` copied every models.dev
    /// entry into `provider[id].models` and `save_to` serialized all of it —
    /// twice, on every `/model`, `/theme` or provider connect.
    #[test]
    fn saved_config_does_not_carry_the_merged_catalog() {
        use crate::catalog::{
            CatalogModel, CatalogProvider, ModelCapabilities, ModelCatalog, ModelCost, ModelLimits,
            ModelStatus,
        };

        let catalog_model = |id: &str| CatalogModel {
            provider: None,
            id: id.to_string(),
            provider_id: "openrouter".to_string(),
            name: format!("Model {id}"),
            family: None,
            capabilities: ModelCapabilities::default(),
            cost: ModelCost::default(),
            limit: ModelLimits::default(),
            status: ModelStatus::Active,
            api_id: id.to_string(),
            reasoning_options: Vec::new(),
            reasoning_stream_field: None,
            headers: HashMap::new(),
            options: HashMap::new(),
            variants: HashMap::new(),
        };

        let models: HashMap<String, CatalogModel> = (0..2_000)
            .map(|i| {
                let id = format!("model-{i}");
                (id.clone(), catalog_model(&id))
            })
            .collect();

        let mut catalog = ModelCatalog::default();
        catalog.providers.insert(
            "openrouter".to_string(),
            CatalogProvider {
                id: "openrouter".to_string(),
                name: "OpenAI".to_string(),
                env: vec!["OPENAI_API_KEY".to_string()],
                api: "https://api.openai.com/v1".to_string(),
                npm: "@ai-sdk/openai".to_string(),
                models,
                whitelist: Vec::new(),
                blacklist: Vec::new(),
            },
        );

        let mut config = AppConfig::default();
        config.merge_catalog(&catalog);
        let merged = serde_json::to_string(&config.strip_secrets()).unwrap();
        assert!(
            merged.len() > 200_000,
            "fixture should reproduce the blow-up, got {} bytes",
            merged.len()
        );

        // What `save_to` actually writes.
        let mut persisted = config.strip_secrets();
        persisted.strip_catalog_derived(config.catalog.as_ref());
        let written = serde_json::to_string(&persisted).unwrap();
        assert!(
            written.len() < 64 * 1024,
            "persisted config must stay small, got {} bytes",
            written.len()
        );
        // The built-in placeholder models from `AppConfig::default()` are not
        // catalog-derived and legitimately stay; none of the 2,000 catalog
        // rows may.
        let leaked: Vec<_> = persisted.provider["openrouter"]
            .models
            .keys()
            .filter(|id| id.starts_with("model-"))
            .collect();
        assert!(
            leaked.is_empty(),
            "catalog-derived models must not be persisted, leaked {}",
            leaked.len()
        );
    }

    /// Stripping is by value, not by key: an entry the user actually changed
    /// differs from the catalog row and has to survive the save.
    #[test]
    fn user_overrides_survive_catalog_stripping() {
        use crate::catalog::{
            CatalogModel, CatalogProvider, ModelCapabilities, ModelCatalog, ModelCost, ModelLimits,
            ModelStatus,
        };

        let mut models = HashMap::new();
        models.insert(
            "gpt-4o".to_string(),
            CatalogModel {
                provider: None,
                id: "gpt-4o".to_string(),
                provider_id: "openrouter".to_string(),
                name: "GPT-4o".to_string(),
                family: None,
                capabilities: ModelCapabilities::default(),
                cost: ModelCost::default(),
                limit: ModelLimits::default(),
                status: ModelStatus::Active,
                api_id: "gpt-4o".to_string(),
                reasoning_options: Vec::new(),
                reasoning_stream_field: None,
                headers: HashMap::new(),
                options: HashMap::new(),
                variants: HashMap::new(),
            },
        );
        let mut catalog = ModelCatalog::default();
        catalog.providers.insert(
            "openrouter".to_string(),
            CatalogProvider {
                id: "openrouter".to_string(),
                name: "OpenAI".to_string(),
                env: vec!["OPENAI_API_KEY".to_string()],
                api: "https://api.openai.com/v1".to_string(),
                npm: "@ai-sdk/openai".to_string(),
                models,
                whitelist: Vec::new(),
                blacklist: Vec::new(),
            },
        );

        let mut config = AppConfig::default();
        config.merge_catalog(&catalog);
        // The user renames the model in their own config.
        config
            .provider
            .get_mut("openrouter")
            .unwrap()
            .models
            .get_mut("gpt-4o")
            .unwrap()
            .name = Some("My GPT".to_string());

        let mut persisted = config.strip_secrets();
        persisted.strip_catalog_derived(config.catalog.as_ref());
        assert_eq!(
            persisted.provider["openrouter"].models["gpt-4o"]
                .name
                .as_deref(),
            Some("My GPT"),
            "a user-edited model entry must not be stripped"
        );
    }

    /// Provider-level strip: stale shells copied by older catalog merges (no
    /// key, no URL, no custom models) are dropped, while user-connected
    /// providers and hand-added models survive. Regression test for the live
    /// `agente.json` that held 187 providers / 3000+ models: `merge`
    /// re-inserts every persisted row on load, so model-level stripping alone
    /// could never shrink it.
    #[test]
    fn stale_provider_shells_are_stripped_connected_ones_survive() {
        use crate::catalog::{
            CatalogModel, CatalogProvider, ModelCapabilities, ModelCatalog, ModelCost, ModelLimits,
            ModelStatus,
        };

        let catalog_model = CatalogModel {
            provider: None,
            id: "some-model".to_string(),
            provider_id: "venice".to_string(),
            name: "Some Model".to_string(),
            family: None,
            capabilities: ModelCapabilities::default(),
            cost: ModelCost::default(),
            limit: ModelLimits::default(),
            status: ModelStatus::Active,
            api_id: "some-model".to_string(),
            reasoning_options: Vec::new(),
            reasoning_stream_field: None,
            headers: HashMap::new(),
            options: HashMap::new(),
            variants: HashMap::new(),
        };
        let mut catalog = ModelCatalog::default();
        catalog.providers.insert(
            "venice".to_string(),
            CatalogProvider {
                id: "venice".to_string(),
                name: "Venice".to_string(),
                env: vec!["VENICE_API_KEY".to_string()],
                api: String::new(),
                npm: String::new(),
                models: [("some-model".to_string(), catalog_model.clone())]
                    .into_iter()
                    .collect(),
                whitelist: Vec::new(),
                blacklist: Vec::new(),
            },
        );

        let mut config = AppConfig::default();
        for id in ["venice", "my-local", "custom"] {
            assert!(
                !config.provider.contains_key(id),
                "{id} must not be a built-in (else this test proves nothing)"
            );
        }
        config.merge_catalog(&catalog);
        // Stale shell: catalog-identical model plus catalog-fill metadata
        // (`api`/`name`/`env`/`npm`), but no authorship signal.
        config.provider.insert(
            "venice".into(),
            ProviderConfig {
                api: Some(String::new()),
                name: Some("Venice AI".to_string()),
                env: vec!["VENICE_API_KEY".to_string()],
                npm: Some("venice-ai-sdk-provider".to_string()),
                api_format: Some("openai".to_string()),
                models: [(
                    "some-model".to_string(),
                    model_config_from_catalog(&catalog_model),
                )]
                .into_iter()
                .collect(),
                ..Default::default()
            },
        );
        // User-connected custom endpoint: `add_provider_with_key` stores the
        // URL in `options.base_url` (the key itself lives in auth.json).
        config.provider.insert(
            "my-local".into(),
            ProviderConfig {
                options: ProviderOptions {
                    base_url: Some("http://localhost:11434/v1".to_string()),
                    ..Default::default()
                },
                ..Default::default()
            },
        );
        // Hand-added model unknown to the catalog.
        config.provider.insert(
            "custom".into(),
            ProviderConfig {
                models: [(
                    "my-llama".to_string(),
                    ModelConfig {
                        name: Some("My Llama".to_string()),
                        ..Default::default()
                    },
                )]
                .into_iter()
                .collect(),
                ..Default::default()
            },
        );

        let mut persisted = config.strip_secrets();
        persisted.strip_catalog_derived(config.catalog.as_ref());
        assert!(
            !persisted.provider.contains_key("venice"),
            "stale shell with no authorship signal must be dropped"
        );
        assert!(
            persisted.provider.contains_key("my-local"),
            "connected custom endpoint must survive"
        );
        assert!(
            persisted.provider["custom"].models.contains_key("my-llama"),
            "hand-added model must survive"
        );
        // Built-ins always stay, and the serialized form stays small.
        assert!(persisted.provider.contains_key("openrouter"));
        let written = serde_json::to_string(&persisted).unwrap();
        assert!(
            written.len() < 256 * 1024,
            "persisted config must stay small, got {} bytes",
            written.len()
        );
    }
}
