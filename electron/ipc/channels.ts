export const IPC = {
    // models
    GET_MODELS: 'get-models',
    GET_MODELS_WITH_STATUS: 'get-models-with-status',
    GET_MODEL_SETTINGS: 'get-model-settings',
    UPDATE_PROVIDER_CONFIG: 'update-provider-config',
    UPDATE_MODEL_OVERRIDE: 'update-model-override',
    SET_DEFAULT_MODELS: 'set-default-models',
    RELOAD_MODELS: 'reload-models',

    // settings
    SETTINGS_GET: 'settings:get',
    SETTINGS_UPDATE_APP: 'settings:update-app',
    SETTINGS_GET_MODEL_DEFAULT_PARAMS: 'settings:get-model-default-params',
    SETTINGS_SET_MODEL_DEFAULT_PARAMS: 'settings:set-model-default-params',
    SETTINGS_UPSERT_MODEL_OVERRIDE: 'settings:upsert-model-override',
    SETTINGS_UPSERT_STRATEGY_OVERRIDE: 'settings:upsert-strategy-override',
    SETTINGS_SET_TOOL_ENABLED: 'settings:set-tool-enabled',
    SETTINGS_SET_TOOL_PERMISSION: 'settings:set-tool-permission',
    SETTINGS_EXPORT: 'settings:export',
    SETTINGS_IMPORT: 'settings:import',
    SETTINGS_GET_PROVIDERS_CONFIG: 'settings:get-providers-config',
    SETTINGS_SET_PROVIDER_CONFIG: 'settings:set-provider-config',
    SETTINGS_CHECK_PROVIDER: 'settings:check-provider',
    SETTINGS_TEST_PROVIDER_MODEL: 'settings:test-provider-model',
    SETTINGS_LIST_MODELS: 'settings:list-models',
    SETTINGS_ADD_PROVIDER_MODEL: 'settings:add-provider-model',
    SETTINGS_UPDATE_PROVIDER_MODEL: 'settings:update-provider-model',
    SETTINGS_DELETE_PROVIDER_MODEL: 'settings:delete-provider-model',
    SETTINGS_SET_MODEL_OVERRIDE: 'settings:set-model-override',
    SETTINGS_RESET_MODEL_OVERRIDE: 'settings:reset-model-override',
    SETTINGS_RESET_API_HOST: 'settings:reset-api-host',
    SETTINGS_REFRESH_PROVIDER_MODELS: 'settings:refresh-provider-models',
    MODELS_UPDATED: 'models-updated',

    // conversations
    CREATE_CONVERSATION: 'create-conversation',
    GET_ALL_CONVERSATIONS: 'get-all-conversations',
    DELETE_CONVERSATION: 'delete-conversation',
    RESET_CONVERSATION_HISTORY: 'reset-conversation-history',
    RENAME_CONVERSATION: 'rename-conversation',
    UPDATE_CONVERSATION_MODEL: 'update-conversation-model',
    CONVERSATION_TITLE_UPDATED: 'conversation-title-updated',

    // messages & items
    GET_MESSAGES: 'get-messages',
    GET_CHAT_ITEMS: 'get-chat-items',
    SEND_MESSAGE: 'send-message',
    ATTACHMENT_PREPARE: 'attachment:prepare',

    // turns / generation
    REGENERATE: 'regenerate-message',
    REWRITE_FROM_TURN: 'rewrite-from-turn',
    SWITCH_MODEL: 'switch-model',
    GET_TURN_ANSWERS: 'get-turn-answers',
    SET_CONVERSATION_STRATEGY: 'set-conversation-strategy',
    CANCEL_STRATEGY_REPLAY: 'cancel-strategy-replay',
    CONVERSATION_UPDATE_STRATEGY: 'conversation:update-strategy',
    STRATEGIES_LIST: 'strategies:list',
    STRATEGIES_GET_ACTIVE: 'strategies:getActive',
    STRATEGIES_SWITCH: 'strategies:switch',
    STRATEGIES_GET_PREFS: 'strategies:getPrefs',
    STRATEGIES_SET_PREFS: 'strategies:setPrefs',
    STRATEGIES_GET_USAGE_COUNTS: 'strategies:getUsageCounts',
    STRATEGIES_GET_PARAMS: 'strategies:getParams',
    STRATEGIES_SET_PARAMS: 'strategies:setParams',
    STRATEGIES_DISABLE: 'strategies:disable',
    STRATEGIES_UNINSTALL: 'strategies:uninstall',
    STRATEGY_DEV_COMPILE_AND_TEST: 'strategy-dev:compile-and-test',
    STRATEGY_DEV_SAVE: 'strategy-dev:save',
    STRATEGY_DEV_RELOAD: 'strategy-dev:reload',
    STRATEGY_DEV_GET_SNAPSHOT: 'strategy-dev:get-snapshot',
    STRATEGY_DEV_OPEN_CHAT: 'strategy-dev:open-chat',
    STRATEGY_DEV_OPEN_SOURCE_FOLDER: 'strategy-dev:open-source-folder',
    STRATEGY_DEV_RECORD_TEST: 'strategy-dev:record-test',
    STRATEGY_DEV_REMOVE: 'strategy-dev:remove',
    STRATEGY_DEV_EVENT: 'strategy-dev:event',

    // data & privacy
    OPEN_USER_DATA_PATH: 'data:open-user-data-path',
    GET_USER_DATA_PATH: 'data:get-user-data-path',
    OPEN_STRATEGIES_PATH: 'data:open-strategies-path',
    OPEN_EXTERNAL_URL: 'data:open-external-url',
    SET_THEME_SOURCE: 'app:set-theme-source',
    RESET_STRATEGIES: 'data:reset-strategies',
    CLEAR_CACHE: 'data:clear-cache',

    // stream
    STREAM_STARTED: 'llm-stream-started',
    STREAM_CHUNK: 'llm-stream-chunk',
    STREAM_DONE: 'llm-stream-done',
    ABORT_STREAM: 'abort-stream',
    IS_CONV_BUSY: 'is-conversation-busy',
    UPDATE_READY: 'update-ready',
    UPDATE_RESTART: 'update-restart',

    STRATEGY_REPLAY_STARTED: 'strategy-replay-started',
    STRATEGY_REPLAY_PROGRESS: 'strategy-replay-progress',
    STRATEGY_REPLAY_DONE: 'strategy-replay-done',

    // memory cloud
    // Deprecated legacy memoryCloud:* channels (kept for compatibility; prefer memory:* assets APIs)
    MEMORY_CLOUD_LIST:   'memoryCloud:list',
    MEMORY_CLOUD_UPLOAD: 'memoryCloud:upload',
    MEMORY_CLOUD_UPDATE: 'memoryCloud:update',
    MEMORY_CLOUD_DELETE: 'memoryCloud:delete',
    MEMORY_CLOUD_PIN:    'memoryCloud:pin',
    MEMORY_CLOUD_UNPIN:  'memoryCloud:unpin',
    MEMORY_CLOUD_REORDER:'memoryCloud:reorder',
    MEMORY_CLOUD_IS_ENABLED: 'memoryCloud:isEnabled',

    MEMORY_INGEST_DOCUMENT: 'memory:ingest-document',
    MEMORY_INGEST_PROGRESS: 'memory:ingest-progress',
    MEMORY_ASSET_LIST: 'memory:asset-list',
    MEMORY_ASSET_READ: 'memory:asset-read',
    MEMORY_ASSET_DELETE: 'memory:asset-delete',
    MEMORY_ASSET_OPEN: 'memory:asset-open',
    MEMORY_ASSET_REVEAL: 'memory:asset-reveal',

    // tools
    TOOL_LIST_SERVERS: 'tools:list-servers',
    TOOL_UPSERT_SERVER: 'tools:upsert-server',
    TOOL_SET_SERVER_ENABLED: 'tools:set-server-enabled',
    TOOL_DELETE_SERVER: 'tools:delete-server',
    TOOL_TEST_SERVER: 'tools:test-server',
    TOOL_GET_SETTINGS: 'tools:get-settings',
    TOOL_SET_BUILTIN_ENABLED: 'tools:set-builtin-enabled',
    TOOL_SET_PERMISSION: 'tools:set-permission',
    TOOL_LIST_BUILTINS: 'tools:list-builtins',
    TOOL_UPDATE_SETTINGS: 'tools:update-settings',

    // web search
    WEBSEARCH_FETCH_HTML: 'webSearch:fetchHtml',

    // debug
    DEBUG_EXPORT_LOGS: 'debug.exportLogs',
} as const;

export type AllowedChannel = typeof IPC[keyof typeof IPC]
