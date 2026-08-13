export const PUBLIC_CATALOG = {
  schema_version: 1,
  updated_at: "2026-08-13T16:40:00Z",
  utilities: [
    {
      id: "jarvis.utility_search",
      name: "Jarvis Utility Search",
      description: "Searches a sanitized public utility catalog, ranks zero-incremental-cost options, and returns a launch descriptor.",
      url: "https://github.com/ragrardannekjold/jarvis-runtime/tree/main/plugin/utility-search",
      aliases: ["utility search", "utility launcher", "пошук утиліт", "лаунчер утиліт", "пошуковий механізм"],
      intents: ["find utility", "select tool", "route task", "знайти утиліту", "підібрати плагін"],
      capabilities: ["utility discovery", "plugin routing", "zero cost gate", "launch descriptor"],
      launch: {
        kind: "mcp_tool",
        target: "Jarvis Utility Search",
        tool: "search",
        notes: "Use search, then fetch, then prepare_launch."
      },
      cost: { class: "included", max_usd_per_run: 0 },
      risk: { mode: "read_only", confirmation_required: false },
      status: { enabled: true, health: "healthy" },
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
      cost: { class: "included", max_usd_per_run: 0 },
      risk: { mode: "controlled_write", confirmation_required: true },
      status: { enabled: true, health: "healthy" },
      visibility: "plugin",
      priority: 95
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
      capabilities: ["web search", "source verification", "current information", "citations"],
      launch: {
        kind: "chat_capability",
        target: "Web Search",
        notes: "Use when current or externally verifiable information is required."
      },
      cost: { class: "included", max_usd_per_run: 0 },
      risk: { mode: "read_only", confirmation_required: false },
      status: { enabled: true, health: "healthy" },
      visibility: "plugin",
      priority: 85
    }
  ]
};
