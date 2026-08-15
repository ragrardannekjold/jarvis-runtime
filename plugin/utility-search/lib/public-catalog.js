export const PUBLIC_CATALOG = {
  schema_version: 1,
  updated_at: "2026-08-15T10:44:50Z",
  utilities: [
    {
      id: "jarvis.utility_search",
      name: "Jarvis Utility Search",
      description: "Searches a sanitized public utility catalog, ranks zero-incremental-cost options, and returns a policy-aware launch descriptor.",
      url: "https://github.com/ragrardannekjold/jarvis-runtime/tree/main/plugin/utility-search",
      aliases: ["utility search", "utility launcher", "пошук утиліт", "лаунчер утиліт", "пошуковий механізм"],
      intents: ["find utility", "select tool", "route task", "знайти утиліту", "підібрати плагін"],
      capabilities: ["utility discovery", "plugin routing", "zero cost gate", "policy aware safe reroute", "launch descriptor"],
      launch: {
        kind: "mcp_tool",
        target: "Jarvis Utility Search",
        tool: "search",
        notes: "Use search, then fetch, then prepare_launch after deployment evidence passes. prepare_launch always runs policy-aware preflight; it can infer a bounded set of high-signal restricted cyber techniques from the legitimate objective and safe-reroute automatically, while explicit classification remains available when inference is insufficient."
      },
      fallback_ids: ["google_drive.search", "github.repo_ops", "chatgpt.web_search"],
      failure_domain: "jarvis_runtime",
      failure_scope: "internal",
      resilience: {
        criticality: "research",
        min_external_failure_domains: 3,
        min_internal_reserves: 1,
        freshness_required: true,
        freshness_max_seconds: 21600,
        readback_required: true,
        internal_reserves: [
          {
            id: "bundled_public_catalog",
            kind: "bundled_snapshot",
            failure_domain: "local_runtime"
          }
        ]
      },
      cost: { class: "included", max_usd_per_run: 0 },
      risk: { mode: "read_only", confirmation_required: false },
      status: { enabled: false, health: "not_deployed", lifecycle: "TESTED_NOT_DEPLOYED" },
      deployment: {
        health_url: null,
        mcp_url: null,
        verified_at: null,
        external_health_verified: false,
        mcp_initialize_verified: false,
        tool_call_verified: false,
        readback_sha256: null,
        evidence_source: "GitHub Actions Utility Search Self-Test run 31863971774 succeeded on main commit 4d5ebe5f58b4ff6b0d41877721a86ad6f6e4d02d and verifies local/runtime-CI search, fallback, local/Vercel policy-preflight parity, automatic high-signal policy-risk inference, safe reroute without restricted-route retry, deploy-contract checks, external-E2E verifier contract, and Vercel read-only routing. Dedicated external E2E still has zero runs; external health/MCP/tool-call readback remains unverified."
      },
      visibility: "plugin",
      priority: 100
    },
    {
      id: "github.repo_ops",
      name: "GitHub Repository Operations",
      description: "Searches and inspects repositories, files, issues, and pull requests through the connected GitHub plugin.",
      url: "https://github.com/ragrardannekjold/jarvis-command-center",
      aliases: ["github", "git", "гітхаб", "репозиторій", "repository", "pull request", "pr"],
      intents: ["repository work", "code search", "issue triage", "pull request", "робота з github"],
      capabilities: ["repository search", "file search", "pull request operations", "issue operations", "branch operations"],
      launch: {
        kind: "chat_plugin",
        target: "GitHub",
        tool: "search",
        notes: "Use the connected GitHub plugin; write actions remain explicit and scoped."
      },
      failure_domain: "github",
      failure_scope: "external",
      cost: { class: "included", max_usd_per_run: 0 },
      risk: { mode: "controlled_write", confirmation_required: true },
      status: { enabled: true, health: "healthy" },
      visibility: "plugin",
      priority: 95
    },
    {
      id: "airtable.record_search",
      name: "Airtable Record Search",
      description: "Searches records and inspects structured tables in connected Airtable bases through native connector tools.",
      url: "https://airtable.com/",
      aliases: ["airtable", "record search", "task queue", "structured records", "ейр тейбл", "таблиця задач"],
      intents: ["search records", "inspect task queue", "structured state lookup", "find table data", "пошук записів"],
      capabilities: ["base discovery", "table schema inspection", "record search", "structured filters", "read-only state lookup"],
      launch: {
        kind: "chat_plugin",
        target: "Airtable",
        tool: "search_records",
        notes: "Default to read-only discovery/search. Resolve base/table identifiers through connected metadata tools before record search; writes require a separate scoped capability and explicit state ownership."
      },
      fallback_ids: ["google_drive.search", "github.repo_ops"],
      failure_domain: "airtable",
      failure_scope: "external",
      cost: { class: "included", max_usd_per_run: 0 },
      risk: { mode: "read_only", confirmation_required: false },
      status: { enabled: true, health: "healthy" },
      visibility: "plugin",
      priority: 94
    },
    {
      id: "vercel.project_ops",
      name: "Vercel Project Operations",
      description: "Inspects connected Vercel projects, deployments, build/runtime logs, and platform documentation through structured connector tools.",
      url: "https://vercel.com/",
      aliases: ["vercel", "deployment", "hosting", "deploy logs", "vercel project", "верцель", "деплой"],
      intents: ["inspect deployment", "find hosting project", "deployment logs", "vercel documentation", "перевірити деплой"],
      capabilities: ["project discovery", "deployment inspection", "build logs", "runtime logs", "platform documentation"],
      launch: {
        kind: "chat_plugin",
        target: "Vercel",
        tool: "list_projects",
        notes: "Default to read-only project/deployment inspection. Do not use the context-bound zero-argument deploy action unless the intended project/source binding is independently proven."
      },
      fallback_ids: ["github.repo_ops", "chatgpt.web_search"],
      failure_domain: "vercel",
      failure_scope: "external",
      cost: { class: "included", max_usd_per_run: 0 },
      risk: { mode: "read_only", confirmation_required: false },
      status: { enabled: true, health: "healthy" },
      visibility: "plugin",
      priority: 93
    },
    {
      id: "google_drive.search",
      name: "Google Drive Search",
      description: "Searches connected Google Drive files and durable registry or recovery snapshots when a primary utility-search execution surface is unavailable.",
      url: "https://drive.google.com/",
      aliases: ["google drive", "drive search", "диск", "google диск", "registry snapshot", "recovery snapshot"],
      intents: ["find file", "search registry snapshot", "search recovery snapshot", "fallback utility discovery", "пошук файлу"],
      capabilities: ["file search", "document discovery", "registry snapshot search", "recovery snapshot search"],
      launch: {
        kind: "chat_plugin",
        target: "Google Drive",
        tool: "search",
        notes: "Use connected Drive search as an independent read-only fallback; do not infer file contents from metadata-only hits."
      },
      failure_domain: "google",
      failure_scope: "external",
      cost: { class: "included", max_usd_per_run: 0 },
      risk: { mode: "read_only", confirmation_required: false },
      status: { enabled: true, health: "healthy" },
      visibility: "plugin",
      priority: 92
    },
    {
      id: "gmail.message_search",
      name: "Gmail Message Search",
      description: "Searches the connected Gmail mailbox through structured read-only message and message-ID search without changing mail state.",
      url: "https://mail.google.com/",
      aliases: ["gmail", "email search", "mail search", "inbox search", "пошта", "пошук листів"],
      intents: ["search email", "find message", "inspect inbox", "find correspondence", "пошук пошти"],
      capabilities: ["message search", "message id search", "gmail query operators", "read-only inbox lookup"],
      launch: {
        kind: "chat_plugin",
        target: "Gmail",
        tool: "search_emails",
        notes: "Default to read-only Gmail search. Search operators belong in the Gmail query; any send, draft, archive, delete or label mutation remains a separate explicitly scoped action and is not implied by this adapter."
      },
      failure_domain: "google",
      failure_scope: "external",
      cost: { class: "included", max_usd_per_run: 0 },
      risk: { mode: "read_only", confirmation_required: false },
      status: { enabled: true, health: "healthy" },
      visibility: "plugin",
      priority: 91
    },
    {
      id: "canva.design_search",
      name: "Canva Design Search",
      description: "Searches the user's existing Canva designs through a structured read-only design lookup without creating or editing designs.",
      url: "https://www.canva.com/",
      aliases: ["canva", "canva search", "design search", "presentation search", "пошук canva", "пошук дизайнів"],
      intents: ["find canva design", "search existing design", "find presentation", "design lookup", "знайти дизайн"],
      capabilities: ["existing design search", "presentation discovery", "owned/shared design lookup", "read-only design metadata search"],
      launch: {
        kind: "chat_plugin",
        target: "Canva",
        tool: "search-designs",
        notes: "Read-only lookup of existing designs only. Do not use this adapter for templates, generation, autofill, copying, creation, or editing; those require separately scoped Canva actions."
      },
      failure_domain: "canva",
      failure_scope: "external",
      cost: { class: "included", max_usd_per_run: 0 },
      risk: { mode: "read_only", confirmation_required: false },
      status: { enabled: true, health: "healthy" },
      visibility: "plugin",
      priority: 90.5
    },
    {
      id: "wix.site_list",
      name: "Wix Site List",
      description: "Lists the user's existing Wix sites through the dedicated structured read-only site-listing connector without creating, publishing, or mutating sites.",
      url: "https://www.wix.com/",
      aliases: ["wix", "wix sites", "site list", "website list", "список wix", "сайти wix"],
      intents: ["list wix sites", "find wix site", "inspect wix sites", "site lookup", "знайти сайт wix"],
      capabilities: ["existing site listing", "site metadata lookup", "account site discovery", "read-only site inventory"],
      launch: {
        kind: "chat_plugin",
        target: "Wix",
        tool: "ListWixSites",
        notes: "Read-only listing of existing Wix sites only. Do not use this adapter for site creation, publication, content mutation, settings changes, uploads, or any write operation; those require separately scoped Wix actions."
      },
      failure_domain: "wix",
      failure_scope: "external",
      cost: { class: "included", max_usd_per_run: 0 },
      risk: { mode: "read_only", confirmation_required: false },
      status: { enabled: true, health: "healthy" },
      visibility: "plugin",
      priority: 90.25
    },
    {
      id: "openai.developers",
      name: "OpenAI Developers",
      description: "Uses current OpenAI developer guidance for MCP, Apps SDK, Agents SDK, API integration, and troubleshooting.",
      url: "https://developers.openai.com/",
      aliases: ["openai developers", "apps sdk", "mcp", "plugin builder", "openai docs", "розробка плагіна"],
      intents: ["build chatgpt plugin", "openai development", "mcp development", "plugin compatibility"],
      capabilities: ["plugin architecture", "mcp server", "tool schemas", "openai documentation", "api troubleshooting"],
      launch: {
        kind: "chat_plugin",
        target: "OpenAI Developers",
        tool: "build-chatgpt-app",
        notes: "Prefer current official OpenAI documentation before code changes."
      },
      failure_domain: "openai",
      failure_scope: "external",
      cost: { class: "included", max_usd_per_run: 0 },
      risk: { mode: "read_only", confirmation_required: false },
      status: { enabled: true, health: "healthy" },
      visibility: "plugin",
      priority: 90
    },
    {
      id: "chatgpt.web_search",
      name: "ChatGPT Web Search",
      description: "Searches current public web sources when freshness or external verification is required.",
      url: "https://chatgpt.com/",
      aliases: ["web search", "internet search", "пошук в інтернеті", "веб пошук", "latest"],
      intents: ["current information", "external verification", "fresh research", "актуальні дані"],
      capabilities: ["web search", "source verification", "current information", "citations", "passive public-source OSINT/CYBINT fallback"],
      launch: {
        kind: "chat_capability",
        target: "Web Search",
        notes: "Use when current or externally verifiable information is required, including lawful passive public-source safe-reroute work."
      },
      failure_domain: "openai",
      failure_scope: "external",
      cost: { class: "included", max_usd_per_run: 0 },
      risk: { mode: "read_only", confirmation_required: false },
      status: { enabled: true, health: "healthy" },
      visibility: "plugin",
      priority: 85
    }
  ]
};