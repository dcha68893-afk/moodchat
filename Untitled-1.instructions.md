
109.93 KB •2,248 lines
•
Formatting may be inconsistent from source
 
 
 ObjectMultiplex - orphaned data for stream "app-init-liveness"
 ObjectMultiplex - orphaned data for stream "app-init-liveness"
 ObjectMultiplex - orphaned data for stream "background-liveness"
 ObjectMultiplex - orphaned data for stream "background-liveness"
 ObjectMultiplex - malformed chunk without name "[object Object]"
 ObjectMultiplex - malformed chunk without name "[object Object]"
 [chat.html] ✅ AppStorage ready, __kynParentReady = true
 [SettingsPropagation] ✅ Hooked into AppSettings
 [SettingsPropagation] Module loaded
 [SettingsModuleSubs] Module loaded
 [SettingsModuleSubs] ✅ Registered: friends
 [SettingsModuleSubs] ✅ Registered: calls
 [SettingsModuleSubs] ✅ Registered: groups
 [SettingsModuleSubs] ✅ Registered: status
 [AppCache] ✅ Cache ready, kyn:cacheReady dispatched
 [CacheUnified] ✅ Unified cache layer active — AppCache === KynectaCache
 [EventBus] ✅ Initialized
 [EventBus] ✅ Ready
 [Store] _hydrateStoreFromLocal complete
 [Store] _setupStorePersistence active
 [Store] ✅ Initialized (offline-first v2.2)
 [Store] ✅ Ready (offline-first v2.2)
 [Phase15] Delivery patch loaded ✅
 [CACHE] DB initialized
 [Realtime] ✅ Socket.IO compatible manager initialized (v3.1.0)
 [Realtime] ✅ Ready (Socket.IO compatible v3.3.0)
 [Realtime] 🔑 Connecting with token (first 20 chars): eyJhbGciOiJIUzI1NiIs... length: 256
 [Realtime] Connecting Socket.IO to https://moodchat-fy56.onrender.com
 [CACHE] Message local store booting
 [CACHE] Message local store ready
 [MsgQueue] ✅ Initialized {pending: 0}
 [MsgQueue] ✅ Ready
 [SyncEngine] ✅ Initialized
 [SyncEngine] ✅ Ready (auto-sync started)
 [MessageService] ✅ Ready (offline-first v2)
 [FriendService] ✅ Ready (v1.1.0 — silent-error fixes applied)
 [Sync] ✅ Manager initialized (offline-first v2.3)
 [Sync] ✅ Ready (offline-first v2.3)
 [OfflineQueue] ✅ Ready (offline-first v2.1)
 [SettingsManager] Constructor complete
 [SettingsManager] Module loaded
 [SessionManager] Initializing...
 [SessionManager] Loaded - Max accounts: 2
 [BackNav] ✅ Parent back navigation installed
 [GroupHdr] v1.0 loaded
 [SAIC] State transition: UNINITIALIZED -> INITIALIZING {timestamp: '2026-06-13T02:40:02.711Z', duration: 0, hasError: false}
 [API-CORE] Initializing API Gateway v24.0.4
 [SAIC] Stage environment: âœ“
 [ENV] ✅ Detected PRODUCTION environment from: moodfronted.onrender.com
 [SAIC] Stage baseUrl: âœ“
 [ENV] 📍 Using backend URL: https://moodchat-fy56.onrender.com/api (env: production)
 [SAIC] Stage storage: âœ“
 [SAIC] Stage origin: âœ“
 [SAIC] Stage token: âœ“
 [SAIC] Stage parentSync: âœ“
 [SAIC] Stage dependencies: âœ“
 [SAIC] Stage security: âœ“
 [SAIC] Stage endpoint: âœ“
 [SAIC] Stage selftest: âœ“
 [API-SECURITY] Directory traversal attempt blocked: /api/users/../config
 [API-SECURITY] Directory traversal attempt blocked: /api/users/%2e%2e/config
 [API-SECURITY] Cross-origin request blocked: https://evil.com/api/steal
 [TOKEN] Skipping storage clear - self-test mode active
 [API-CORE] âœ… Fully loaded {environment: 'production', baseUrl: 'https://moodchat-fy56.onrender.com/api', version: '24.0.4', state: 'INITIALIZING', stages: 10, …}
 [SAIC] Stage network: âœ“
 [SAIC] State transition: INITIALIZING -> READY {timestamp: '2026-06-13T02:40:02.726Z', duration: 15, hasError: false}
 [API-CORE] âœ… Initialized successfully {environment: 'production', baseUrl: 'https://moodchat-fy56.onrender.com/api', version: '24.0.4', state: 'READY', duration: 15, …}
 [Phase6Bootstrap] 🚀 MoodChat loading 35 modules from https://moodfronted.onrender.com/js/core/
 [KynectaChatSync] ✅ Loaded
 [KynectaLinkPreview] ✅ Loaded
 [KynectaVoiceRecorder] ✅ Loaded — waiting for core object
 [Navigation] Attaching navigation listeners...
 [Navigation] Found navigation elements: 12
 [Navigation] Setting up listener for element 0: messages nav-icon active
 [Navigation] Setting up listener for element 1: status nav-icon
 [Navigation] Setting up listener for element 2: group nav-icon
 [Navigation] Setting up listener for element 3: games nav-icon
 [Navigation] Setting up listener for element 4: calls nav-icon
 [Navigation] Setting up listener for element 5: settings nav-icon
 [Navigation] Setting up listener for element 6: tools nav-icon
 [Navigation] Setting up listener for element 7: messages mobile-nav-icon active
 [Navigation] Setting up listener for element 8: games mobile-nav-icon
 [Navigation] Setting up listener for element 9: undefined mobile-nav-icon nav-center-action
 [Navigation] Setting up listener for element 10: status mobile-nav-icon
 [Navigation] Setting up listener for element 11: tools mobile-nav-icon
 [SettingsManager] Loaded from knecta_settings_cache (AppSettings schema)
 [SettingsManager] BroadcastChannel ready
 [SettingsManager] Language → en
 [SettingsManager] Friend request UI → everyone
 [SettingsManager] Initialized for user: 1
 [SessionManager] Activity tracking enabled (throttled to 5s)
 [SessionManager] Session check started
 [SessionManager] ✅ Valid session restored for user: 1
 [Parent] ✅ Global kyn:* realtime bridge installed
 [SYNC START] messageSyncAll
 [KeepAlive] Ping sent, status: 200
 [chat.html] Profile role fetch failed: Failed to fetch
app.realtime.socket.js:518 [Realtime] Socket.IO connection error: xhr poll error
(anonymous) @ app.realtime.socket.js:518
(anonymous) @ index.mjs:136
value @ socket.js:439
(anonymous) @ index.mjs:136
value @ manager.js:213
(anonymous) @ index.mjs:136
value @ socket.js:541
(anonymous) @ index.mjs:136
value @ transport.js:38
(anonymous) @ polling.js:218
(anonymous) @ index.mjs:136
value @ polling.js:320
(anonymous) @ polling.js:294
setTimeout
(anonymous) @ polling.js:293
XMLHttpRequest.send
value @ polling.js:298
Request @ polling.js:237
value @ polling.js:190
value @ polling.js:215
value @ polling.js:96
value @ polling.js:126
(anonymous) @ index.mjs:136
value @ polling.js:352
(anonymous) @ polling.js:288
XMLHttpRequest.send
value @ polling.js:298
Request @ polling.js:237
value @ polling.js:190
value @ polling.js:215
value @ polling.js:96
value @ polling.js:56
value @ transport.js:46
value @ socket.js:170
Socket @ socket.js:111
value @ manager.js:108
Manager @ manager.js:39
lookup @ index.js:29
_connectSocketIO @ app.realtime.socket.js:478
_connectInternal @ app.realtime.socket.js:444
(anonymous) @ app.realtime.socket.js:282
connect @ app.realtime.socket.js:283
safeConnect @ app.realtime.socket.js:1715
_autoConnect @ app.realtime.socket.js:1821
await in _autoConnect
(anonymous) @ app.realtime.socket.js:1823
(anonymous) @ app.realtime.socket.js:2021
 [Realtime] WebSocket connection failed, working without real-time updates
 [Realtime] Reconnecting in 3399ms (attempt 1/20)
 [Phase15] KynectaRealtime hooks installed ✅
service-worker.js:808 [SW] v18.0.0 loaded - offline-first navigation active
service-worker.js:437 [SW] Installing v18.0.0 (network-first for all critical JS)
 [IdentityFoundation] ✅ Device dev_509f… FP 368a62e1…
 [IdentityFoundation] ✅ Ready
 [NetworkIntel] ✅ Started
 [NetworkIntel] ✅ Ready
 [RealtimeStab] ✅ Started
 [RealtimeStab] ✅ Ready
 [PersistenceStab] ✅ Initialized (version=4)
 [PersistenceStab] ✅ Ready
 [CacheFoundation] ✅ Initialized
 [CacheFoundation] ✅ Ready
 [PHASE10] DeletionRegistry ✅ active
 [QueueFoundation] ✅ Started
 [QueueFoundation] ✅ Ready
 [PresenceEngine] ✅ Started for user 1
 [PresenceEngine] ✅ Ready
 [NotifStab] Notification constructor patched for dedup
 [NotifStab] ✅ Initialized
 [NotifStab] ✅ Ready
 [Monitoring] ✅ Initialized
 [Monitoring] ✅ Ready — run __KynDiag() to print diagnostics
 [HybridTransport] ✅ Started — caps: {internetAvailable: true, lanAvailable: false, webRTCAvailable: true, serviceWorker: true, indexedDB: true, …}
 [HybridTransport] ✅ Ready
 [LAN] ✅ Ready
 [MeshRelay] ✅ Started
 [MeshRelay] ✅ Ready
 [LAN] Local IP: 192.168.80.1
 [LAN] ✅ Started — LAN: false
 [ReliableDelivery] ✅ Started
 [ReliableDelivery] ✅ Ready
 [RealtimeSync] ✅ Started
 [RealtimeSync] ✅ Ready
 [BGSync] ✅ Ready
 [BGSync] Service Worker sync registered: kyn-message-sync
 [BGSync] ✅ Started
 [CallState] ✅ Ready
 [DeviceMedia] ✅ Ready
 [PeerConn] ✅ Started
 [PeerConn] ✅ Ready
 [CallOrchestrator] ✅ Started
 [CallOrchestrator] ✅ Ready
 [GroupCall] ✅ Ready
 [CallRecovery] Attached
 [AdaptiveBR] ✅ Started
 [AdaptiveBR] ✅ Ready
 [LANCall] ✅ Started
 [LANCall] ✅ Ready
 [ChatSync] ✅ Loaded 0 pinned chats, 0 starred messages
 [Monitoring] NetworkMetricsCollector attached
 [Monitoring] ReconnectTracker attached
 [Monitoring] SyncFailureDetector attached
 [Monitoring] SocketMetricsMonitor attached
 [Monitoring] HydrationMetricsCollector attached
 [GroupOrchestrator] ✅ Started
 [GroupOrchestrator] ✅ Ready
 [GroupModeration] ✅ Started
 [SocialGraph] ✅ Started
 [GroupModeration] ✅ Ready
 [SocialGraph] ✅ Ready
 [GroupPresenceCache] ✅ Started
 [GroupPresenceCache] ✅ Ready
 [SocialNotif] ✅ Started
 [SocialNotif] ✅ Ready
 [StoryEngine] ✅ Ready
 [StoryEngine] Hydrated 0 active stories
 [StoryEngine] ✅ Started
 [Security] ✅ Ready
 [Security] ✅ Initialized — deviceId: dev_c827…
 [Reconnect] ✅ Started
 [Reconnect] ✅ Ready
 [DurableQueue] ✅ Ready
 [DurableQueue] ✅ Initialized — 0 ops loaded
 [BGReliability] BroadcastChannel initialized, tabId: tab_1781318405210_4kpk
 [BGReliability] ✅ Ready
 [BGReliability] SW ready: https://moodfronted.onrender.com/
 [BGReliability] ✅ Started — leader: false
 [ProductionMonitor] ✅ Started — run __MoodChatDiag() for full snapshot
 [ProductionMonitor] ✅ Ready — __MoodChatDiag() for full snapshot
 [CacheRepair] ✅ Ready
 [CacheRepair] ✅ Started
 [Phase6] ✅ Runtime Integration Validator ready
 [Phase10] TransportRuntime ✅ active — best: INTERNET
 [Phase6Bootstrap] ✅ Phase 10 production hardening modules loaded
 [MeshBridge] Registered device with relay: dev_b7fc3bb94a5a4bff
 [MeshBridge] ✅ Bridge installed for device dev_b7fc3bb94a5a4bff
 [MeshBridge] Waiting for MeshEngine…
 [Phase6Bootstrap] ✅ Mesh engine stack loaded (MeshCrypto + MeshTransport + MeshRouter + MeshEngine)
 [Phase6Bootstrap] ✅ Phase 11 Central Orchestration Runtime loaded
 [Phase6Bootstrap] ✅ 42/35 modules in 2698ms
 [OfflineQueue] setSendHandler registered (stub — handler stored but not used; delivery handled internally)
 [Phase6Bootstrap] OfflineQueue send handler wired
 [Phase6Bootstrap] Safety-wired 38 group+status+phase5 events
 [Phase6Bootstrap] Cross-module listeners wired
 [Phase10] TransportRuntime active — best: INTERNET
 [Phase10] LAN engine active — peers: 0
 [Phase10] All production hardening systems wired ✅
 [Phase11] CentralOrchestrationRuntime active ✅
 [Phase6Bootstrap] 🎉 MoodChat Phase 10 fully initialized — __MoodChatDiag() for diagnostics
 [COR] ✅ Canonical event wiring active
 [COR] ✅ LAN Activation Engine active
 [COR] ✅ Central Orchestration Runtime v11.0.0 active
 [MeshTransport] ✅ Transport layer initialised, deviceId: dev_b7fc3bb94a5a4bff
 [MeshRouter] ✅ Router ready, deviceId: dev_b7fc3bb94a5a4bff
 [MeshEngine] ✅ Initialised | Phase 4 | DeviceId: dev_b7fc3bb94a5a4bff
 [Parent] Failed to refresh call history: 
 [RealtimeStab] Attached to socket undefined
service-worker.js:469 [SW] Pre-cached 42/42 assets
service-worker.js:389 [SW] Cache hit: https://moodfronted.onrender.com/js/app.cache.js
 [Navigation] Navigation element clicked: status
 [Navigation] navigateToPage called with: status {}
 [Navigation] Page changed from messages to status
 [Navigation] Hiding all iframe containers...
 [Navigation] Hiding: messagesContent current classes: iframe-container
service-worker.js:389 [SW] Cache hit: https://moodfronted.onrender.com/css/suppress-webgl.css
 [Navigation] Hiding: statusContent current classes: iframe-container hidden
 [Navigation] Hiding: groupContent current classes: iframe-container hidden
 [Navigation] Hiding: friendsContent current classes: iframe-container hidden
 [Navigation] Hiding: callsContent current classes: iframe-container hidden
 [Navigation] Hiding: settingsContent current classes: iframe-container hidden
 [Navigation] Hiding: toolsContent current classes: iframe-container hidden
 [Navigation] Hiding: gamesContent current classes: iframe-container hidden
 [Navigation] Target element:  for page: status
 [Navigation] Target before removing hidden: iframe-container hidden
 [Navigation] Target after removing hidden: iframe-container
service-worker.js:389 [SW] Cache hit: https://moodfronted.onrender.com/group-core.js
service-worker.js:389 [SW] Cache hit: https://moodfronted.onrender.com/group-ui.js
service-worker.js:389 [SW] Cache hit: https://moodfronted.onrender.com/friend.css
service-worker.js:389 [SW] Cache hit: https://moodfronted.onrender.com/calls.css
service-worker.js:389 [SW] Cache hit: https://moodfronted.onrender.com/localStore.calls.js
service-worker.js:389 [SW] Cache hit: https://moodfronted.onrender.com/Tool.css
service-worker.js:389 [SW] Cache hit: https://moodfronted.onrender.com/Tool-core.js
service-worker.js:389 [SW] Cache hit: https://moodfronted.onrender.com/Tool-ui.js
service-worker.js:480 [SW] Activating v18.0.0
 
 
service-worker.js:488 [SW] Deleting old cache: kynecta-v3
service-worker.js:506 [SW] v18.0.0 activated — 9 client(s) notified
 
 
 
 
 
 
 
 
 [ScreenMgr] v4.0 loaded -- stale-proof, guard-protected
 [Realtime] Connecting Socket.IO to https://moodchat-fy56.onrender.com
 
 
 
 
 
 
 ObjectMultiplex - orphaned data for stream "app-init-liveness"
 ObjectMultiplex - orphaned data for stream "app-init-liveness"
 ObjectMultiplex - orphaned data for stream "background-liveness"
 ObjectMultiplex - orphaned data for stream "background-liveness"
 ObjectMultiplex - malformed chunk without name "[object Object]"
 ObjectMultiplex - malformed chunk without name "[object Object]"
service-worker.js:389 [SW] Cache hit: https://moodfronted.onrender.com/js/settings-broadcast-listener.js
 ObjectMultiplex - orphaned data for stream "app-init-liveness"
 ObjectMultiplex - orphaned data for stream "app-init-liveness"
 ObjectMultiplex - orphaned data for stream "background-liveness"
 ObjectMultiplex - orphaned data for stream "background-liveness"
 ObjectMultiplex - malformed chunk without name "[object Object]"
 ObjectMultiplex - malformed chunk without name "[object Object]"
 [Phase6] Validation: 31/31 modules healthy, socket: ✅, repairs: 1
 [Phase6] Auto-repairs applied: socket:group_events_registered
 [Phase6] ✅ Runtime Integration Validator started
 ObjectMultiplex - orphaned data for stream "app-init-liveness"
 ObjectMultiplex - orphaned data for stream "app-init-liveness"
 ObjectMultiplex - orphaned data for stream "background-liveness"
 ObjectMultiplex - orphaned data for stream "background-liveness"
 ObjectMultiplex - malformed chunk without name "[object Object]"
 ObjectMultiplex - malformed chunk without name "[object Object]"
 ObjectMultiplex - orphaned data for stream "app-init-liveness"
 ObjectMultiplex - orphaned data for stream "app-init-liveness"
 ObjectMultiplex - orphaned data for stream "background-liveness"
 ObjectMultiplex - orphaned data for stream "background-liveness"
 ObjectMultiplex - malformed chunk without name "[object Object]"
 ObjectMultiplex - malformed chunk without name "[object Object]"
 [friend.html] API response normalizer shim active
 ObjectMultiplex - orphaned data for stream "app-init-liveness"
 ObjectMultiplex - orphaned data for stream "app-init-liveness"
 ObjectMultiplex - orphaned data for stream "background-liveness"
 ObjectMultiplex - orphaned data for stream "background-liveness"
 ObjectMultiplex - malformed chunk without name "[object Object]"
 ObjectMultiplex - malformed chunk without name "[object Object]"
 ObjectMultiplex - orphaned data for stream "app-init-liveness"
 ObjectMultiplex - orphaned data for stream "app-init-liveness"
 ObjectMultiplex - orphaned data for stream "background-liveness"
 ObjectMultiplex - orphaned data for stream "background-liveness"
 ObjectMultiplex - malformed chunk without name "[object Object]"
 ObjectMultiplex - malformed chunk without name "[object Object]"
 [Reconnect] Boot grace period ended
 ObjectMultiplex - orphaned data for stream "app-init-liveness"
 ObjectMultiplex - orphaned data for stream "app-init-liveness"
 ObjectMultiplex - orphaned data for stream "background-liveness"
 ObjectMultiplex - orphaned data for stream "background-liveness"
 ObjectMultiplex - malformed chunk without name "[object Object]"
 ObjectMultiplex - malformed chunk without name "[object Object]"
 ObjectMultiplex - orphaned data for stream "app-init-liveness"
 ObjectMultiplex - orphaned data for stream "app-init-liveness"
 ObjectMultiplex - orphaned data for stream "background-liveness"
 ObjectMultiplex - orphaned data for stream "background-liveness"
 ObjectMultiplex - malformed chunk without name "[object Object]"
 ObjectMultiplex - malformed chunk without name "[object Object]"
 [AppCache] ✅ Cache ready, kyn:cacheReady dispatched
 [KynectaVoiceRecorder] ✅ Loaded — waiting for core object
service-worker.js:389 [SW] Cache hit: https://moodfronted.onrender.com/css/vendor/spectrum.min.css
service-worker.js:389 [SW] Cache hit: https://moodfronted.onrender.com/css/vendor/pickr-nano.min.css
 [INIT MODULE] messages-iframe
 [AppCache] ✅ Cache ready, kyn:cacheReady dispatched
 [pwa-manager] SW_UPDATED received — version: 18.0.0
 [CACHE] DB initialized
 [GROUP.HTML BRIDGE] Early realtime bridge installed
service-worker.js:389 [SW] Cache hit: https://moodfronted.onrender.com/theme.colors.css
service-worker.js:389 [SW] Cache hit: https://moodfronted.onrender.com/css/vendor/video-js.min.css
 [CACHE] DB initialized
 [Realtime] ✅ Socket.IO compatible manager initialized (v3.1.0)
 [Realtime] Running in iframe — skipping direct Socket.IO connection, using parent bridge
 [Realtime] ✅ Ready (Socket.IO compatible v3.3.0)
 [CACHE] Message local store booting
 [CACHE] Message local store ready
 [MsgQueue] ✅ Initialized {pending: 0}
 [MsgQueue] ✅ Ready
 [GroupOS] ✅ _openGroupOSPanel installed
 [BackNav] ✅ Universal back navigation installed
 [BackNav] ✅ Universal back navigation installed
 [SettingsPropagation] ✅ Hooked into AppSettings
 [SettingsPropagation] Module loaded
 [SettingsModuleSubs] Module loaded
 [SyncEngine] ✅ Initialized
 [SyncEngine] ✅ Ready (auto-sync started)
 [MessageService] ✅ Ready (offline-first v2)
 [VoiceRecorder] ✅ Installed on core — startRecording() ready
 [CACHE] Groups local store ready
 [CACHE] Group local store ready
 [SettingsModuleSubs] ✅ Registered: friends
 [SettingsModuleSubs] ✅ Registered: calls
 [SettingsModuleSubs] ✅ Registered: groups
 [SettingsModuleSubs] ✅ Registered: status
 [LocalStore.Settings] ✅ Initialized — local-first settings store ready
 [SettingsSchema] ✅ Validator initialized
 [SettingsSync] ✅ v1.1 initialized
 [settings-core:patch] 🚀 v1.1 ready
 [Message HTML] Environment detected: render (moodfronted.onrender.com)
 [Message HTML] Parent communication initialized. Environment: render, Host: moodfronted.onrender.com
 [StatusCache] ✅ IndexedDB ready
 [StatusCache] ✅ IndexedDB initialised
 [SettingsManager] Constructor complete
 [SettingsManager] Module loaded
 [GroupOS] Loaded ✅ (P1/P2/P3 fixes applied)
 [GroupOSIntegration] ✅ Loaded
 [Phase6Bootstrap] 🚀 MoodChat loading 35 modules from https://moodfronted.onrender.com/js/core/
 [GCP] v4.2 ready
 [groups] Initializing - Version 9.0.1
 [groups] State: BOOT → INITIALIZING
 [groups] State: INITIALIZING → READY
 [groups] WAIT_PARENT - waiting for parent ready
 [MeshBridge] Registered device with relay: dev_b7fc3bb94a5a4bff
 [MeshBridge] ✅ Bridge installed for device dev_b7fc3bb94a5a4bff
 [MeshBridge] Waiting for MeshEngine…
 [BackNav] ✅ Universal back navigation installed
 [Phase15] Delivery patch loaded ✅
 [settings] 📦 OfflineQueue initialized, online: true, pending: 0
 [settings] 🚀 MessageTransport initializing []
 [settings] ✅ MessageTransport initialized []
 [settings] 🚀 API Gateway initializing []
 [settings] 🚀 SafeStorage initializing []
 [settings] ✅ SafeStorage initialized - Type: ['localStorage']
 [settings] 🚀 OriginAdapter initializing []
 [settings] ✅ OriginAdapter initialized []
 [settings] 🚀 IframeTransport initializing []
 [settings] ✅ IframeTransport initialized []
 [settings] 🚀 SessionClient initializing []
 [settings] ✅ SessionClient initialized []
 [settings] 🚀 ReliabilityEngine initializing []
 [settings] ✅ ReliabilityEngine initialized []
 [settings] 🚀 ReliabilityLayer initializing []
 [settings] ✅ ReliabilityLayer initialized []
 [settings] 🚀 MessageDispatcher initializing []
 [settings] ✅ MessageDispatcher initialized []
 [settings] 🚀 SecurityValidator initializing []
 [settings] ✅ SecurityValidator initialized []
 [settings] 🚀 ParentConnectionManager initializing []
 [settings] ✅ ParentConnectionManager initialized []
 [settings] 🚀 HandshakeManager initializing []
 [settings] ✅ HandshakeManager initialized []
 [settings] 🚀 ModuleLifecycleController initializing []
 [settings] ✅ ModuleLifecycleController initialized []
 [settings] 🚀 RecoveryManager initializing []
 [settings] ✅ RecoveryManager initialized []
 [settings] 🚀 NavigationGuard initializing []
 [settings] ✅ NavigationGuard initialized []
 [settings] 🚀 UIFailsafe initializing []
 [settings] ✅ UIFailsafe initialized []
 [settings] 🚀 MultiModuleCoordinator initializing []
 [settings] ✅ MultiModuleCoordinator initialized []
 [settings] 🚀 UIBridge initializing []
 [settings] ✅ UIBridge initialized []
 [settings] 🚀 ModuleCoreController initializing []
 [settings] ✅ ModuleCoreController initialized []
 [status-core] realtime kyn: bridge installed ✅
 [settings-ui:patch] ✅ v1.1 applied
 [AppCache] ✅ Cache ready, kyn:cacheReady dispatched
 [SyncEngine] ✅ Dependencies wired
 [SettingsManager] Loaded from knecta_settings_cache (AppSettings schema)
 [SettingsManager] BroadcastChannel ready
 [SettingsManager] Language → en
 [SettingsManager] Friend request UI → everyone
 [SettingsManager] Initialized for user: 1
 [pwa-manager] SW_UPDATED received — version: 18.0.0
 📝 Module registered: groups (Total: 1)
 [LOCAL SAVE] _kynecta_test_ test
 [LOCAL LOAD] kynecta_chats_cache_v8
 [INIT MODULE] messages
 [messages] 🚀 Messages Core v8.0.7 (Stabilized Protocol | Real Data Only | Session Validation | UI Enhanced | Demo Data Included | openChatWithUser Added | Pending Chat Handling)
 [messages] State: BOOT → INITIALIZING (start_sequence)
 [LOCAL SAVE] kynecta_user_cache_v8 {"id":1,"userId":1,"username":"Denis_1","displayName":"Denis_1","email":"chacha@gmail.com","firstName":"","lastName":"","role":"user","isAdmin":false}
 [LOCAL SAVE] kynecta_chats_cache_v8 {"conversations":[],"timestamp":1781318418019}
 [ChatManager] Set 0 unique conversations
 [messages] ✅ Bound to KynectaRealtime singleton events
 [messages] ✅ Initialized - waiting for parent activation and valid session
 [messages-core] ✅ Settings bootstrapped from cache
 [messagesUI] Lifecycle: INITIALIZING
 [2026-06-13T02:40:18.032Z] [UIStateManager] [INFO] Initialized 
 [CallHandler] Call handlers initialized
 [KynPatch v3.0] ✅ All runtime patches installed
 [KynPatch v4.0] ✅ Message visibility patch installed
 [KynectaE2E] ✅ Loaded — WebCrypto: true
 [KynectaVoiceRecorder] ✅ Loaded — waiting for core object
 [LinkPreview] ✅ Attached to #messageInput
 [KynectaLinkPreview] ✅ Loaded
 [ChatSync] ✅ Patches installed on messagesUI
 [KynectaChatSync] ✅ Loaded
 [KynectaVirtualScroll] ✅ Loaded
 [KynectaPushManager] ✅ Loaded
 [KynectaBackupManager] ✅ Loaded
 [Phase6Bootstrap] 🚀 MoodChat loading 35 modules from https://moodfronted.onrender.com/js/core/
 [MeshTransport] ✅ Transport layer initialised, deviceId: dev_b7fc3bb94a5a4bff
 [BackNav] ✅ Universal back navigation installed
 [BackNav] ✅ Universal back navigation installed
 [StatusWebSocket] ✅ Initialized via KynectaRealtime/wsService
 [CACHE] Group local store ready
 [UI] UIFailsafe: Initialized 
 [Phase6Bootstrap] 🚀 MoodChat loading 35 modules from https://moodfronted.onrender.com/js/core/
 [settings] 🚀 DOMContentLoaded - starting core initialization []
 [settings] 🚀 SecurityValidator initializing []
 [settings] ✅ SecurityValidator initialized []
 [settings] 🚀 ParentConnectionManager initializing []
 [settings] ✅ ParentConnectionManager initialized []
 [settings] 🚀 MessageDispatcher initializing []
 [settings] ✅ MessageDispatcher initialized []
 [settings] 🚀 ReliabilityLayer initializing []
 [settings] ✅ ReliabilityLayer initialized []
 [settings] 🚀 HandshakeManager initializing []
 [settings] ✅ HandshakeManager initialized []
 [settings] 🚀 SessionClient initializing []
 [settings] ✅ SessionClient initialized []
 [settings] 🚀 LifecycleController initializing []
 [settings] 📍 State: BOOT → INITIALIZING (component_init)
 [settings] 📍 State: INITIALIZING → WAITING_AUTH (auth_bypass)
 [settings] 📍 State: WAITING_AUTH → READY (auth_bypass)
 [settings] 📍 State: READY → WAIT_PARENT (auth_bypass)
 [settings] 📍 State: WAIT_PARENT → ACTIVE (standalone_mode)
 [settings] ✅ Standalone mode - state forced to ACTIVE
 [settings] ✅ LifecycleController initialized []
 [settings] ✅ Core initialized and active []
 [MessageUI] Setting up auto-open chat listener
 [friend.html] Bridging AppStorage from parent...
 [friend.html] ✅ AppStorage bridged from parent
 [Store] _hydrateStoreFromLocal complete
 [Store] _setupStorePersistence active
 [Store] ✅ Initialized (offline-first v2.2)
 [Store] ✅ Ready (offline-first v2.2)
 [Sync] ✅ Manager initialized (offline-first v2.3)
 [Sync] ✅ Ready (offline-first v2.3)
 [SettingsPropagation] ✅ Hooked into AppSettings
 [SettingsPropagation] Module loaded
 [settings] 📦 OfflineQueue initialized, online: true, pending: 0
 [settings] 🚀 MessageTransport initializing []
 [settings] ✅ MessageTransport initialized []
 [settings] 🚀 API Gateway initializing []
 [settings] 🚀 SafeStorage initializing []
 [settings] ✅ SafeStorage initialized - Type: ['localStorage']
 [settings] 🚀 OriginAdapter initializing []
 [settings] ✅ OriginAdapter initialized []
 [settings] 🚀 IframeTransport initializing []
 [settings] ✅ IframeTransport initialized []
 [settings] 🚀 SessionClient initializing []
 [settings] ✅ SessionClient initialized []
 [settings] 🚀 ReliabilityEngine initializing []
 [settings] ✅ ReliabilityEngine initialized []
 [settings] 🚀 ReliabilityLayer initializing []
 [settings] ✅ ReliabilityLayer initialized []
 [settings] 🚀 MessageDispatcher initializing []
 [settings] ✅ MessageDispatcher initialized []
 [settings] 🚀 SecurityValidator initializing []
 [settings] ✅ SecurityValidator initialized []
 [settings] 🚀 ParentConnectionManager initializing []
 [settings] ✅ ParentConnectionManager initialized []
 [settings] 🚀 HandshakeManager initializing []
 [settings] ✅ HandshakeManager initialized []
 [settings] 🚀 ModuleLifecycleController initializing []
 [settings] ✅ ModuleLifecycleController initialized []
 [settings] 🚀 RecoveryManager initializing []
 [settings] ✅ RecoveryManager initialized []
 [settings] 🚀 NavigationGuard initializing []
 [settings] ✅ NavigationGuard initialized []
 [settings] 🚀 UIFailsafe initializing []
 [settings] ✅ UIFailsafe initialized []
 [settings] 🚀 MultiModuleCoordinator initializing []
 [settings] ✅ MultiModuleCoordinator initialized []
 [settings] 🚀 UIBridge initializing []
 [settings] ✅ UIBridge initialized []
 [settings] 🚀 ModuleCoreController initializing []
 [settings] ✅ ModuleCoreController initialized []
 [Phase6Bootstrap] 🚀 MoodChat loading 35 modules from https://moodfronted.onrender.com/js/core/
 [settings-core:patch] ✅ SettingsState patched
 [settings-core:patch] ✅ Local settings applied on startup
 [settings-core] ✅ Cache-first settings loaded instantly
 [settings] 🚀 DOMContentLoaded - starting core initialization []
 [settings] 🚀 SecurityValidator initializing []
 [settings] ✅ SecurityValidator initialized []
 [settings] 🚀 ParentConnectionManager initializing []
 [settings] ✅ ParentConnectionManager initialized []
 [settings] 🚀 MessageDispatcher initializing []
 [settings] ✅ MessageDispatcher initialized []
 [settings] 🚀 ReliabilityLayer initializing []
 [settings] ✅ ReliabilityLayer initialized []
 [settings] 🚀 HandshakeManager initializing []
 [settings] ✅ HandshakeManager initialized []
 [settings] 🚀 SessionClient initializing []
 [settings] ✅ SessionClient initialized []
 [settings] 🚀 LifecycleController initializing []
 [settings] 📍 State: BOOT → INITIALIZING (component_init)
 [settings] 📍 State: INITIALIZING → WAITING_AUTH (auth_bypass)
 [settings] 📍 State: WAITING_AUTH → READY (auth_bypass)
 [settings] 📍 State: READY → WAIT_PARENT (auth_bypass)
 [settings] 📍 State: WAIT_PARENT → ACTIVE (standalone_mode)
 [settings] ✅ Standalone mode - state forced to ACTIVE
 [settings] ✅ LifecycleController initialized []
 [SettingsUI] 📂 Loading section: profile
 [settings] ✅ Core initialized and active []
 [SettingsUI] DOM loaded, initializing UI
 [SettingsUI] Core already ready, initializing immediately
 [SettingsUI] UI initialization complete
 [CACHE] DB initialized
 [marketplace-checkout.js] ✅ Complete checkout flow loaded — all buyer flows active
 [groups] State: WAIT_PARENT → ACTIVE (session valid)
 [MeshRouter] ✅ Router ready, deviceId: dev_b7fc3bb94a5a4bff
 [MeshEngine] ✅ Initialised | Phase 4 | DeviceId: dev_b7fc3bb94a5a4bff
 [pwa-manager] SW_UPDATED received — version: 18.0.0
 [SettingsPropagation] ✅ Hooked into AppSettings
 [SettingsPropagation] Module loaded
 [SettingsModuleSubs] Module loaded
 [AppCache] ✅ Cache ready, kyn:cacheReady dispatched
 [SettingsModuleSubs] Module loaded
 [CallLocalStore] ✅ Initialized (unified cache v2)
 [CallSession] ✅ Manager initialized
 [CallSession] ✅ Singleton ready
 [CallRetry] ✅ Initialized 
 [CallRetry] ✅ Engine ready
 [pwa-manager] SW_UPDATED received — version: 18.0.0
 [PushManager] ✅ Service Worker registered
 [STATUS DEBUG] Checking component loading...
 [STATUS DEBUG] StatusAPI available: true
 [STATUS DEBUG] StatusCache available: true
 [STATUS DEBUG] StatusWebSocket available: true
 [SettingsUI] Initializing UI components
 [SettingsUI] Core check - proceeding immediately
 [SettingsUI] UI initialization complete
 [SettingsUI] Loading profile section
 [SettingsUI] ✅ Successfully loaded section: profile
 [Phase15] KynectaRealtime hooks installed ✅
 [SettingsModuleSubs] ✅ Registered: friends
 [SettingsModuleSubs] ✅ Registered: calls
 [SettingsModuleSubs] ✅ Registered: groups
 [SettingsModuleSubs] ✅ Registered: status
 [CACHE] Friends local store booting
 [CACHE] Friends local store ready
 [SettingsModuleSubs] ✅ Registered: friends
 [SettingsModuleSubs] ✅ Registered: calls
 [SettingsModuleSubs] ✅ Registered: groups
 [SettingsModuleSubs] ✅ Registered: status
 [marketplace-seller.js v3] ✅ Loaded
 [marketplace-admin.js] ✅ Admin command center loaded — role: unknown
 [ui-fix] API base set to: https://moodfronted.onrender.com/api
 [marketplace-ui-fix.js] ✅ All forensic fixes installed
 [IdentityFoundation] ✅ Device dev_509f… FP 368a62e1…
 [IdentityFoundation] ✅ Ready
 [CACHE] DB initialized
 [FriendQueue] ✅ Initialized, pending items: 0
 [FriendQueue] ✅ Ready
 [FriendSync] ✅ Initialized
 [FriendSync] ✅ Ready
 [FriendService] ✅ Ready (v1.1.0 — silent-error fixes applied)
 [BackNav] ✅ Universal back navigation installed
 [IdentityFoundation] ✅ Device dev_509f… FP 368a62e1…
 [IdentityFoundation] ✅ Ready
 [FriendService] Initialized
 [FriendService] Service loaded - manual initialization only (friend-core.js handles data)
 [FriendService Integration] Initializing cross-module integration...
 [FriendService Integration] DISABLED - friend-core.js handles all friend data
 [FriendService Integration] Ready
 [FriendService Integration] FriendService available: true
 [FriendService Integration] FriendCore active: false
 [FriendService Integration] Legacy compatibility enabled
 [BackNav] ✅ Universal back navigation installed
 [Phase15] Delivery patch loaded ✅
 [Tools] 🔵 READY - SafeStorage initialized (proxy-based) 
 [Tools] 🔵 READY - Environment detected: RENDER_HOSTED 
 [TokenHarvest] ✅ Token found, length: 256
 [Tools] 🔵 READY - SecurityValidator initialized 
 [Tool-core] ✅ Settings bootstrapped from cache
 [FIX] Starting emergency click handler initialization
 [FIX] Handlers attached once
 [ToolPatch] Bootstrapping fixed tool system…
 [Tools] 🔴 ERROR - Authorized fetch blocked: no token 
 [ToolPatch] ✅ Bootstrap complete
 [ToolPatch] Tool manifest fetch failed (using cache): No authentication token
 [ToolPatch] ✅ Tool system ready — 0 tools loaded
 [ToolUIPatch] ✅ UI patch loaded
 [Phase6Bootstrap] 🚀 MoodChat loading 35 modules from https://moodfronted.onrender.com/js/core/
 [marketplace-advanced.js] ✅ All enterprise features active
 [Tools] 🚀 INIT - pageCore initialization started 
 [CallsCore] ℹ️ Environment detected: production 
 [CallsCore] 🔵 OriginSecurity initialized 
 [CallsCore] 🔵 SafeStorage initialized (proxy) 
 [CallsCore] 🔵 MessageRegistry initialized 
 [CallsCore] ℹ️ Message handler installed 
 [CallsCore] 🔵 IframeTransport initialized 
 [CallsCore] ℹ️ Initializing media manager 
 [CallsCore] ℹ️ WebRTC manager initialized 
 [calls][LIFECYCLE] 📊 BOOT → INITIALIZING
 [CallsCore] ℹ️ Calls State Governor initialized 
 [CallsCore] ℹ️ V5StateGovernor initialized (compatibility) 
 [CallsCore] 🔵 IframeSessionClient initialized {state: 'pending'}
 [CallsCore] 🔵 ReliabilityEngine initialized 
 [CallsCore] 🔵 RecoveryManager initialized 
 [CallsCore] ℹ️ Compatibility bridge: modern mode 
 [CallsCore] 🔵 MultiModuleCoordinator initialized 
 [CallsCore] 🔵 UIFailsafe initialized 
 [CallsCore] 🔵 NavigationGuard initialized 
 [CallsCore] 🔵 LifecycleController initialized 
 [CallsCore] 🔵 SessionPipeline initialized 
 [CallsCore] 🔵 UIBridge initialized 
 [CallsCore] ℹ️ ModuleCoreController starting initialization sequence 
 [CallsCore] ✅ ModuleCoreController initialization complete 
 [calls][LIFECYCLE] Starting initialization
 [calls] ℹ️ Initializing module 
 [calls][LIFECYCLE] 📊 INITIALIZING → READY (init_complete)
 [calls] ✅ READY 
 [calls][LIFECYCLE] ✅ CHILD_READY sent exactly once
 [calls][LIFECYCLE] 📊 READY → WAIT_PARENT (child_ready_sent)
 [calls] ✅ Initialization complete - state: WAIT_PARENT 
 [calls] ✅ Call event DOM bridge installed
 [CallsCore] ✅ Call core module loaded 
 [calls-core] ✅ Settings bootstrapped from cache
 [Calls UI][Early] OPEN_CALL_WITH_USER listener established
 [CallOverlayManager] Initialized. State: idle
 [CallOverlayManager] Module loaded. Global: window.CallOverlayManager ✓
 [calls-ui] callContainer dark-screen guard installed (v3 — no observer).
 [calls-ui] ✅ CALLS_IFRAME_READY sent to parent
 [CallOverlay] 3-state overlay system initialized
 [CallProfessionalFix] professional call fix installed
 [MasterFix] ✅ Core listener hooked
 [MasterFix] ✅ Master fix v3.0 booted
 [Phase6Bootstrap] 🚀 MoodChat loading 35 modules from https://moodfronted.onrender.com/js/core/
service-worker.js:389 [SW] Cache hit: https://moodfronted.onrender.com/js/api.messages.js
 [pwa-manager] SW_UPDATED received — version: 18.0.0
 📝 Module registered: calls (Total: 2)
 [Tool-ui] Force binding all UI events...
 [Tool-ui] Force binding all UI events...
 [Tools][Lifecycle] BOOT → INITIALIZING module_start
 [Tools] 🚀 INIT - Tools module booting 
 [Tools] 🔵 READY - UI events bound 
 [Tools] 🔵 READY - UIBridge initialized 
 [Tools][Lifecycle] INITIALIZING → READY setup_complete
 [Tools] 📤 SENDING - CHILD_READY sent 
 [Tools][Lifecycle] READY → WAIT_PARENT child_ready_sent
 [Tools] ⚪ INFO - Waiting for parent ready signal (WAIT_PARENT) 
 [pwa-manager] SW_UPDATED received — version: 18.0.0
 📝 Module registered: tools (Total: 3)
 [SAIC] State transition: UNINITIALIZED -> INITIALIZING {timestamp: '2026-06-13T02:40:20.546Z', duration: 0, hasError: false}
 [API-CORE] Initializing API Gateway v24.0.4
 [SAIC] Stage environment: âœ“
 [ENV] ✅ Detected PRODUCTION environment from: moodfronted.onrender.com
 [SAIC] Stage environment: âœ“
 [SAIC] Stage baseUrl: âœ“
 [ENV] 📍 Using backend URL: https://moodchat-fy56.onrender.com/api (env: production)
 [SAIC] Stage baseUrl: âœ“
 [SAIC] Stage storage: âœ“
 [SAIC] Stage storage: âœ“
 [SAIC] Stage origin: âœ“
 [SAIC] Stage origin: âœ“
 [SAIC] Stage token: âœ“
 [SAIC] Stage token: âœ“
 [SAIC] Stage parentSync: âœ“
 [SAIC] Stage parentSync: âœ“
 [SAIC] Stage dependencies: âœ“
 [SAIC] Stage dependencies: âœ“
 [SAIC] Stage security: âœ“
 [SAIC] Stage security: âœ“
 [SAIC] Stage endpoint: âœ“
 [SAIC] Stage endpoint: âœ“
 [SAIC] Stage selftest: âœ“
 [TOKEN] Skipping storage clear - self-test mode active
 [ENV] ✅ Detected PRODUCTION environment from: moodfronted.onrender.com
 [API-CORE] âœ… Fully loaded {environment: 'production', baseUrl: 'https://moodchat-fy56.onrender.com/api', version: '24.0.4', state: 'INITIALIZING', stages: 10, …}
 [SAIC] Stage selftest: âœ“
 [SAIC] Stage network: âœ“
 [SAIC] Stage network: âœ“
 [SAIC] State transition: INITIALIZING -> READY {timestamp: '2026-06-13T02:40:20.574Z', duration: 28, hasError: false}
 [API-CORE] âœ… Initialized successfully {environment: 'production', baseUrl: 'https://moodchat-fy56.onrender.com/api', version: '24.0.4', state: 'READY', duration: 29, …}
 [Phase6Bootstrap] 🚀 MoodChat loading 35 modules from https://moodfronted.onrender.com/js/core/
 [IdentityFoundation] ✅ Device dev_509f… FP 368a62e1…
 [IdentityFoundation] ✅ Ready
 [CallsCore] ℹ️ Parent origin locked {origin: 'https://moodfronted.onrender.com'}
 [calls][SessionClient] Valid session received: {authenticated: true, userId: 1, sessionId: 1781318420639}
 [calls][SessionClient] Valid session received: {authenticated: true, userId: 1, sessionId: 1781318420640}
 [calls][handleParentReady] Session data received: {hasPayload: true, hasSessionInPayload: true, hasDirectSession: false, sessionDataKeys: Array(7)}
 [calls][handleParentReady] Formatted session: {hasToken: true, userId: 1, authenticated: true, sessionId: 1}
 [calls][applySession] Processing session: {hasToken: true, userId: 1, hasUserObject: true, sessionDataKeys: Array(6)}
 [calls][LIFECYCLE] Valid session applied: {authenticated: true, userId: 1, sessionId: 1}
 [calls][LIFECYCLE] 📊 WAIT_PARENT → ACTIVE (valid_session_received_after_parent_ready)
 [calls][LIFECYCLE] Module ACTIVE — safe zone entered
 [calls][LIFECYCLE] UI initialized safely
 [calls][LIFECYCLE] ✅ Module activated after valid session received
 [calls][LIFECYCLE] Already in state ACTIVE, ignoring transition
 [calls][LIFECYCLE] Module ACTIVE — safe zone entered
 [calls][LIFECYCLE] UI initialized safely
 [calls][LIFECYCLE] ✅ PARENT_READY processed, module ACTIVE with valid session
 [Tools][DirectListener] Received: SESSION_DATA {type: 'SESSION_DATA', id: 'session_1781318420472_tools', source: 'parent', target: 'tools', payload: {…}, …}
 [Tools][DirectListener] Processing SESSION_DATA directly
 [Tools][DirectListener] Found session data: {userId: 1, hasToken: true}
 [Tools][SessionWrapper] Processing session: {userId: 1, hasToken: true}
 [Tools][SessionWrapper] Session accepted, userId: 1
 [Tools][DirectListener] Session accepted, activating module
 [Tools][Lifecycle] WAIT_PARENT → ACTIVE direct_session_received
 [Tools][Lifecycle] Module ACTIVE - all systems go
 [Tools] 🔵 READY - Heartbeat responder ready 
 [safeApiCall] → GET /api/marketplace/listings?page=1&limit=20 null
 [secureApiCall] GET https://moodchat-fy56.onrender.com/api/tools/marketplace/listings?page=1&limit=20 
 [ToolPatch] Bootstrapping fixed tool system…
 [ToolPatch] ✅ Bootstrap complete
 [safeApiCall] → GET /api/marketplace/wishlist null
 [secureApiCall] GET https://moodchat-fy56.onrender.com/api/tools/marketplace/wishlist 
 [safeApiCall] → GET /api/marketplace/categories null
 [secureApiCall] GET https://moodchat-fy56.onrender.com/api/tools/marketplace/categories 
 [safeApiCall] → GET /api/marketplace/products?page=1&limit=40&sort=newest null
 [secureApiCall] GET https://moodchat-fy56.onrender.com/api/tools/marketplace/products?page=1&limit=40&sort=newest 
 [Tools][DirectListener] Received: AUTH_READY {type: 'AUTH_READY', id: 'auth_ready_1781318420472_tools', source: 'parent', target: 'tools', payload: {…}, …}
 [Tools][DirectListener] Processing AUTH_READY directly
 [Tools][DirectListener] Found session in AUTH_READY: {userId: 1, hasToken: true}
 [Tools][SessionWrapper] Processing session: {userId: 1, hasToken: true}
 [Tools][SessionWrapper] Session accepted, userId: 1
 [Tools][DirectListener] Received: PARENT_READY {type: 'PARENT_READY', id: 'parent_ready_1781318420472_tools', source: 'parent', target: 'tools', payload: {…}, …}
 [Tool-ui] Force binding complete - bound 18 elements
 [Tool-ui] Force binding complete - bound 18 elements
 [friends] 🔵 READY - FriendCacheManager initialized
 [friend-core] ✅ Settings bootstrapped from cache
 [pwa-manager] SW_UPDATED received — version: 18.0.0
 [IdentityFoundation] ✅ Device dev_509f… FP 368a62e1…
 [IdentityFoundation] ✅ Ready
status-api.js:293 [StatusAPI] getFriendsStatuses error: HTTP 503
getFriendsStatuses @ status-api.js:293
await in getFriendsStatuses
_fetchFriendStatusesDirect @ status-ui.js:478
(anonymous) @ status-ui.js:7779
setTimeout
(anonymous) @ status-ui.js:7777
 [status-ui] No friend statuses returned from API
 [Tool-ui] Force binding all UI events...
 [Tool-ui] Force binding all UI events...
 [settings] ✅ Valid SESSION_DATA applied
 [settings] ✅ AUTH_READY received
 [settings] 🚀 Starting background tasks
 [settings] 📥 PARENT_READY received with session
 [settings] 📥 PARENT_READY with duplicate session ignored
 [PARENT-SYNC] Parent ready signal received
 [PARENT-SYNC] Parent ready signal received
 [PARENT-SYNC] Parent ready signal received
 [settings] ✅ Valid SESSION_DATA applied
 [settings] ✅ AUTH_READY received
 [settings] 🚀 Starting background tasks
 [settings] 📥 PARENT_READY received with session
 [settings] 📥 PARENT_READY with duplicate session ignored
 [settings] ✅ AUTH_READY received
 [Tools][DirectListener] Received: SESSION_DATA {type: 'SESSION_DATA', id: 'session_1781318420745_tool', source: 'parent', target: 'tool', payload: {…}, …}
 [Tools][DirectListener] Processing SESSION_DATA directly
 [Tools][DirectListener] Found session data: {userId: 1, hasToken: true}
 [Tools][SessionWrapper] Processing session: {userId: 1, hasToken: true}
 [Tools][SessionWrapper] Session accepted, userId: 1
 [Tools][DirectListener] Received: AUTH_READY {type: 'AUTH_READY', id: 'auth_ready_1781318420745_tool', source: 'parent', target: 'tool', payload: {…}, …}
 [Tools][DirectListener] Processing AUTH_READY directly
 [Tools][DirectListener] Found session in AUTH_READY: {userId: 1, hasToken: true}
 [Tools][SessionWrapper] Processing session: {userId: 1, hasToken: true}
 [Tools][SessionWrapper] Session accepted, userId: 1
 [Tools][DirectListener] Received: PARENT_READY {type: 'PARENT_READY', id: 'parent_ready_1781318420745_tool', source: 'parent', target: 'tool', payload: {…}, …}
 [Tools][DirectListener] Received: SESSION_DATA {type: 'SESSION_DATA', id: 'session_1781318420745_marketplace', source: 'parent', target: 'marketplace', payload: {…}, …}
 [Tools][DirectListener] Processing SESSION_DATA directly
 [Tools][DirectListener] Found session data: {userId: 1, hasToken: true}
 [Tools][SessionWrapper] Processing session: {userId: 1, hasToken: true}
 [Tools][SessionWrapper] Session accepted, userId: 1
 [Tools][DirectListener] Received: AUTH_READY {type: 'AUTH_READY', id: 'auth_ready_1781318420745_marketplace', source: 'parent', target: 'marketplace', payload: {…}, …}
 [Tools][DirectListener] Processing AUTH_READY directly
 [Tools][DirectListener] Found session in AUTH_READY: {userId: 1, hasToken: true}
 [Tools][SessionWrapper] Processing session: {userId: 1, hasToken: true}
 [Tools][SessionWrapper] Session accepted, userId: 1
 [Tools][DirectListener] Received: PARENT_READY {type: 'PARENT_READY', id: 'parent_ready_1781318420745_marketplace', source: 'parent', target: 'marketplace', payload: {…}, …}
 [calls] 📤 REGISTER_MODULE {messageId: 'msg_h07xsp8s4zc_1781318420983', requestId: 'req_67c3va3a4bv_1781318420983'}
 [calls] ✅ REGISTER_MODULE sent
 [safeApiCall] → GET /api/marketplace/wishlist null
 [secureApiCall] GET https://moodchat-fy56.onrender.com/api/tools/marketplace/wishlist 
 [safeApiCall] → GET /api/marketplace/categories null
 [secureApiCall] GET https://moodchat-fy56.onrender.com/api/tools/marketplace/categories 
 [safeApiCall] → GET /api/marketplace/products?page=1&limit=40&sort=newest null
 [secureApiCall] GET https://moodchat-fy56.onrender.com/api/tools/marketplace/products?page=1&limit=40&sort=newest 
 [Tool-ui] Force binding all UI events...
 [SessionManager] Setting valid session {userId: 1}
 [messages] ✅ [SessionManager] ✅ Session established {authenticated: true, userId: 1}
 [UIStateManager] SessionUpdated event: {detail: {…}, isValid: true, userId: 1, authenticated: true}
 [messagesUI] Lifecycle: ACTIVE
 [messagesUI] Core not ACTIVE yet, polling until ready...
 [SessionManager] Session set in state INITIALIZING — fast-promoting to ACTIVE
 [messages] State: INITIALIZING → ACTIVE (session_set_early_promote)
 [messages] ✅ Module ACTIVE - ready for user interaction
 [messages] ℹ️ [UIBridge] ℹ️ UI listeners attached 
 [messages] ✅ [UI] ✅ UI initialized 
 [ChatManager] 📤 Fetching conversations from backend
 [FriendManager] 📤 Fetching friends from backend
 [messages] ✅ [DataFlow] ✅ Data flow started 
 [messages] PARENT_READY received (state: ACTIVE)
 [messages] Session provided in PARENT_READY, userId: 1
 [messages] PARENT_READY received while already ACTIVE — refreshing data
 [settings] 📥 AUTH_READY []
 [RealtimeStab] postMessage storm detected: "API_REQUEST" (5 in 2000ms)
 [settings] 📥 PARENT_READY []
 [calls][SessionClient] Valid session received: {authenticated: true, userId: 1, sessionId: 1781318421140}
 [calls][SessionClient] Valid session received: {authenticated: true, userId: 1, sessionId: 1781318421141}
 [calls][SessionClient] Valid session received: {authenticated: true, userId: 1, sessionId: 1781318421142}
 [calls][SessionClient] Valid session received: {authenticated: true, userId: 1, sessionId: 1781318421143}
 [calls][SessionClient] Valid session received: {authenticated: true, userId: 1, sessionId: 1781318421144}
 [calls][SessionClient] Valid session received: {authenticated: true, userId: 1, sessionId: 1781318421144}
 [RealtimeStab] postMessage storm detected: "API_REQUEST" (6 in 2000ms)
 [settings] 📥 AUTH_READY []
 [RealtimeStab] postMessage storm detected: "API_REQUEST" (7 in 2000ms)
 [RealtimeStab] postMessage storm detected: "API_REQUEST" (8 in 2000ms)
 [RealtimeStab] postMessage storm detected: "API_REQUEST" (9 in 2000ms)
 [RealtimeStab] postMessage storm detected: "API_REQUEST" (10 in 2000ms)
 [RealtimeStab] postMessage storm detected: "API_REQUEST" (11 in 2000ms)
 [settings] 📥 PARENT_READY []
 [Tool-ui] Force binding all UI events...
 [Tools] Force binding all UI events (direct DOM)
 [Tools] Direct DOM binding complete
 [settings] 📥 AUTH_READY []
 [settings] 📥 PARENT_READY []
 [Calls UI] Received CONTACTS_UPDATE: 0 contacts
 [Tools][DirectListener] Received: SESSION_DATA {type: 'SESSION_DATA', id: 'session_1781318421030_tools', source: 'parent', target: 'tools', payload: {…}, …}
 [Tools][DirectListener] Processing SESSION_DATA directly
 [Tools][DirectListener] Found session data: {userId: 1, hasToken: true}
 [Tools][SessionWrapper] Processing session: {userId: 1, hasToken: true}
 [Tools][SessionWrapper] Session accepted, userId: 1
 [Tools][DirectListener] Received: AUTH_READY {type: 'AUTH_READY', id: 'auth_ready_1781318421030_tools', source: 'parent', target: 'tools', payload: {…}, …}
 [Tools][DirectListener] Processing AUTH_READY directly
 [Tools][DirectListener] Found session in AUTH_READY: {userId: 1, hasToken: true}
 [Tools][SessionWrapper] Processing session: {userId: 1, hasToken: true}
 [Tools][SessionWrapper] Session accepted, userId: 1
 [Tools][DirectListener] Received: PARENT_READY {type: 'PARENT_READY', id: 'parent_ready_1781318421030_tools', source: 'parent', target: 'tools', payload: {…}, …}
 [Tool-ui] Force binding complete - bound 18 elements
 [RealtimeStab] postMessage storm detected: "API_REQUEST" (12 in 2000ms)
 [RealtimeStab] postMessage storm detected: "API_REQUEST" (13 in 2000ms)
 [UIFailsafe] Forcing UI enable
 [Tool-ui] Force binding complete - bound 18 elements
 [Calls UI] Requesting friends list from parent
 [Tool-ui] Force binding all UI events...
 [Tool-ui] Force binding all UI events...
 [Tool-ui] Force binding complete - bound 18 elements
 [UI] UIFailsafe: UI enabled (ACTIVE state) 
 [messagesUI] Triggering real data fetch from backend
 [Tool-ui] Force binding complete - bound 18 elements
 [Calls UI] Received CONTACTS_UPDATE: 0 contacts
 [Tools][DirectListener] Received: SESSION_DATA {type: 'SESSION_DATA', id: 'session_1781318421397_tools', source: 'parent', target: 'tools', payload: {…}, …}
 [Tools][DirectListener] Processing SESSION_DATA directly
 [Tools][DirectListener] Found session data: {userId: 1, hasToken: true}
 [Tools][SessionWrapper] Processing session: {userId: 1, hasToken: true}
 [Tools][SessionWrapper] Session accepted, userId: 1
 [Tools][DirectListener] Received: AUTH_READY {type: 'AUTH_READY', id: 'auth_ready_1781318421397_tools', source: 'parent', target: 'tools', payload: {…}, …}
 [Tools][DirectListener] Processing AUTH_READY directly
 [Tools][DirectListener] Found session in AUTH_READY: {userId: 1, hasToken: true}
 [Tools][SessionWrapper] Processing session: {userId: 1, hasToken: true}
 [Tools][SessionWrapper] Session accepted, userId: 1
 [Tools][DirectListener] Received: PARENT_READY {type: 'PARENT_READY', id: 'parent_ready_1781318421397_tools', source: 'parent', target: 'tools', payload: {…}, …}
 [calls][SessionClient] Valid session received: {authenticated: true, userId: 1, sessionId: 1781318421456}
 [calls][SessionClient] Valid session received: {authenticated: true, userId: 1, sessionId: 1781318421457}
 [Calls UI] Received FRIENDS_LIST_UPDATE: 0 friends
 [RealtimeStab] postMessage storm detected: "API_REQUEST" (14 in 2000ms)
 [LocalStoreTools] ✅ Cache hydrated
 [ToolRegistry] ✅ Initialized — 0 tools registered
 [RealtimeStab] postMessage storm detected: "ECOM_CART_UPDATE" (5 in 2000ms)
 [RealtimeStab] postMessage storm detected: "TOOLS_CART_COUNT" (5 in 2000ms)
 [Tool-ui] Force binding complete - bound 18 elements
 [Tool-ui] Force binding complete - bound 18 elements
 [SYNC START] messageSyncAll
 [Tool-ui] Force binding all UI events...
 [Calls UI] Received CONTACTS_UPDATE: 0 contacts
 [Tool-ui] Force binding complete - bound 18 elements
 [Tool-ui] Force binding all UI events...
 [Tool-ui] Force binding complete - bound 18 elements
 [ChatSync] ✅ Loaded 0 pinned chats, 0 starred messages
 [Tool-ui] Force binding all UI events...
 [Tool-ui] Force binding complete - bound 18 elements
 [ToolPatch] Tool manifest fetch failed (using cache): HTTP error 503
 [ToolPatch] ✅ Tool system ready — 0 tools loaded
status-api.js:293 [StatusAPI] getFriendsStatuses error: HTTP 503
getFriendsStatuses @ status-api.js:293
await in getFriendsStatuses
_fetchFriendStatusesDirect @ status-ui.js:478
setTimeout
_earlyFetch @ status-ui.js:601
_authReadyListener @ status-ui.js:607
postMessage
sendSessionToModule @ chat.html:3901
(anonymous) @ chat.html:4079
sendToAllModulesIfNeeded @ chat.html:4076
(anonymous) @ chat.html:4976
postMessage
_initParentMessageListeners @ api.core.js:2304
initializeGateway @ api.core.js:6520
(anonymous) @ api.core.js:6921
(anonymous) @ api.core.js:7171
 [status-ui] No friend statuses returned from API
 [secureApiCall] ← 503 /api/tools/marketplace/categories
 [secureApiCall] Server error 503 for /api/tools/marketplace/categories — checking cache
Tools.html:17 [secureApiCall] ERROR GET /api/tools/marketplace/categories Internal server error
console.error @ Tools.html:17
secureApiCall @ Tool-core.js:5764
await in secureApiCall
safeApiCall @ Tool-core.js:5810
window._ecomApiCall @ Tool-core.js:8068
_api @ marketplace-ecommerce.js:111
loadCategories @ marketplace-ecommerce.js:193
initEcommerceMarketplace @ marketplace-ecommerce.js:1314
await in initEcommerceMarketplace
tryInit @ marketplace-ecommerce.js:1343
_triggerEcomInit @ Tool-core.js:7838
onModuleActive @ Tool-core.js:4172
transitionTo @ Tool-core.js:195
directSessionListener @ Tool-core.js:4507
postMessage
sendSessionToModule @ chat.html:3901
(anonymous) @ chat.html:4948
postMessage
sendChildReady @ Tool-core.js:4132
initializeModule @ Tool-core.js:4615
(anonymous) @ Tool-core.js:7595
setTimeout
(anonymous) @ Tool-core.js:7591
 [secureApiCall] ← 503 /api/tools/marketplace/listings?page=1&limit=20
 [secureApiCall] Server error 503 for /api/tools/marketplace/listings?page=1&limit=20 — checking cache
Tools.html:17 [secureApiCall] ERROR GET /api/tools/marketplace/listings?page=1&limit=20 Internal server error
console.error @ Tools.html:17
secureApiCall @ Tool-core.js:5764
await in secureApiCall
safeApiCall @ Tool-core.js:5810
loadListings @ Tool-core.js:3205
initialize @ Tool-core.js:3184
onModuleActive @ Tool-core.js:4170
transitionTo @ Tool-core.js:195
directSessionListener @ Tool-core.js:4507
postMessage
sendSessionToModule @ chat.html:3901
(anonymous) @ chat.html:4948
postMessage
sendChildReady @ Tool-core.js:4132
initializeModule @ Tool-core.js:4615
(anonymous) @ Tool-core.js:7595
setTimeout
(anonymous) @ Tool-core.js:7591
 [messages] 📥 API_RESPONSE received: req_wazt3d40g6i_1781318421425
message.html:56 [messages] API request failed: Network request failed
console.error @ message.html:56
handleApiResponse @ messages-core.js:674
_handleIncomingMessage @ messages-core.js:1805
(anonymous) @ messages-core.js:1754
setTimeout
(anonymous) @ messages-core.js:1754
postMessage
(anonymous) @ chat.html:5441
postMessage
(anonymous) @ messages-core.js:625
makeApiRequest @ messages-core.js:562
_fetchAllUsersAsFallback @ messages-core.js:4011
(anonymous) @ messages-ui.js?v=3:1810
Promise.then
_triggerRealDataFetch @ messages-ui.js?v=3:1804
poll @ messages-ui.js?v=3:1748
setTimeout
_triggerRealDataFetch @ messages-ui.js?v=3:1770
_updateLifecycleUI @ messages-ui.js?v=3:1660
(anonymous) @ messages-ui.js?v=3:2078
queueAction @ messages-ui.js?v=3:610
(anonymous) @ messages-ui.js?v=3:2006
setSession @ messages-core.js:1615
_handleSessionData @ messages-core.js:1982
_handleIncomingMessage @ messages-core.js:1825
(anonymous) @ messages-core.js:1754
setTimeout
(anonymous) @ messages-core.js:1754
postMessage
sendSessionToModule @ chat.html:3901
(anonymous) @ chat.html:4079
sendToAllModulesIfNeeded @ chat.html:4076
(anonymous) @ chat.html:4976
postMessage
_initParentMessageListeners @ api.core.js:2304
initializeGateway @ api.core.js:6520
(anonymous) @ api.core.js:6921
(anonymous) @ api.core.js:7171
 [FriendManager] /users endpoint failed: Network request failed
 [RealtimeStab] postMessage storm detected: "API_REQUEST" (15 in 2000ms)
service-worker.js:389 [SW] Cache hit: https://moodfronted.onrender.com/js/core/identity/IdentityFoundationLayer.js
 [IdentityFoundation] ✅ Device dev_509f… FP 368a62e1…
 [IdentityFoundation] ✅ Ready
 [secureApiCall] ← 503 /api/tools/marketplace/categories
 [secureApiCall] Server error 503 for /api/tools/marketplace/categories — checking cache
Tools.html:17 [secureApiCall] ERROR GET /api/tools/marketplace/categories Internal server error
console.error @ Tools.html:17
secureApiCall @ Tool-core.js:5764
await in secureApiCall
safeApiCall @ Tool-core.js:5810
window._ecomApiCall @ Tool-core.js:8068
_api @ marketplace-ecommerce.js:111
loadCategories @ marketplace-ecommerce.js:193
initEcommerceMarketplace @ marketplace-ecommerce.js:1314
await in initEcommerceMarketplace
tryInit @ marketplace-ecommerce.js:1343
setTimeout
_onSess @ marketplace-ecommerce.js:1358
postMessage
sendSessionToModule @ chat.html:3927
(anonymous) @ chat.html:4948
postMessage
sendChildReady @ Tool-core.js:4132
initializeModule @ Tool-core.js:4615
(anonymous) @ Tool-core.js:7595
setTimeout
(anonymous) @ Tool-core.js:7591
 [secureApiCall] ← 503 /api/tools/marketplace/wishlist
 [secureApiCall] Server error 503 for /api/tools/marketplace/wishlist — checking cache
Tools.html:17 [secureApiCall] ERROR GET /api/tools/marketplace/wishlist Internal server error
console.error @ Tools.html:17
secureApiCall @ Tool-core.js:5764
await in secureApiCall
safeApiCall @ Tool-core.js:5810
window._ecomApiCall @ Tool-core.js:8068
_api @ marketplace-ecommerce.js:111
syncFromServer @ marketplace-ecommerce.js:659
initEcommerceMarketplace @ marketplace-ecommerce.js:1306
await in initEcommerceMarketplace
tryInit @ marketplace-ecommerce.js:1343
_triggerEcomInit @ Tool-core.js:7838
onModuleActive @ Tool-core.js:4172
transitionTo @ Tool-core.js:195
directSessionListener @ Tool-core.js:4507
postMessage
sendSessionToModule @ chat.html:3901
(anonymous) @ chat.html:4948
postMessage
sendChildReady @ Tool-core.js:4132
initializeModule @ Tool-core.js:4615
(anonymous) @ Tool-core.js:7595
setTimeout
(anonymous) @ Tool-core.js:7591
 [messages] 📥 API_RESPONSE received: req_c3hy3v8qd_1781318422669
message.html:56 [messages] API request failed: Network request failed
console.error @ message.html:56
handleApiResponse @ messages-core.js:674
_handleIncomingMessage @ messages-core.js:1805
(anonymous) @ messages-core.js:1754
setTimeout
(anonymous) @ messages-core.js:1754
postMessage
(anonymous) @ chat.html:5441
postMessage
(anonymous) @ messages-core.js:625
makeApiRequest @ messages-core.js:562
_fetchAllUsersAsFallback @ messages-core.js:4020
await in _fetchAllUsersAsFallback
(anonymous) @ messages-ui.js?v=3:1810
Promise.then
_triggerRealDataFetch @ messages-ui.js?v=3:1804
poll @ messages-ui.js?v=3:1748
setTimeout
_triggerRealDataFetch @ messages-ui.js?v=3:1770
_updateLifecycleUI @ messages-ui.js?v=3:1660
(anonymous) @ messages-ui.js?v=3:2078
queueAction @ messages-ui.js?v=3:610
(anonymous) @ messages-ui.js?v=3:2006
setSession @ messages-core.js:1615
_handleSessionData @ messages-core.js:1982
_handleIncomingMessage @ messages-core.js:1825
(anonymous) @ messages-core.js:1754
setTimeout
(anonymous) @ messages-core.js:1754
postMessage
sendSessionToModule @ chat.html:3901
(anonymous) @ chat.html:4079
sendToAllModulesIfNeeded @ chat.html:4076
(anonymous) @ chat.html:4976
postMessage
_initParentMessageListeners @ api.core.js:2304
initializeGateway @ api.core.js:6520
(anonymous) @ api.core.js:6921
(anonymous) @ api.core.js:7171
 [FriendManager] /users/all endpoint failed: Network request failed
 [FriendManager] No users found in fallback fetch
 [secureApiCall] ← 503 /api/tools/marketplace/products?page=1&limit=40&sort=newest
 [secureApiCall] Server error 503 for /api/tools/marketplace/products?page=1&limit=40&sort=newest — checking cache
Tools.html:17 [secureApiCall] ERROR GET /api/tools/marketplace/products?page=1&limit=40&sort=newest Internal server error
console.error @ Tools.html:17
secureApiCall @ Tool-core.js:5764
await in secureApiCall
safeApiCall @ Tool-core.js:5810
window._ecomApiCall @ Tool-core.js:8068
_api @ marketplace-ecommerce.js:111
loadProducts @ marketplace-ecommerce.js:160
initEcommerceMarketplace @ marketplace-ecommerce.js:1315
await in initEcommerceMarketplace
tryInit @ marketplace-ecommerce.js:1343
_triggerEcomInit @ Tool-core.js:7838
onModuleActive @ Tool-core.js:4172
transitionTo @ Tool-core.js:195
directSessionListener @ Tool-core.js:4507
postMessage
sendSessionToModule @ chat.html:3901
(anonymous) @ chat.html:4948
postMessage
sendChildReady @ Tool-core.js:4132
initializeModule @ Tool-core.js:4615
(anonymous) @ Tool-core.js:7595
setTimeout
(anonymous) @ Tool-core.js:7591
 [messages] 📥 API_RESPONSE received: req_vrbp0cjssxr_1781318421096
message.html:56 [messages] API request failed: Network request failed
console.error @ message.html:56
handleApiResponse @ messages-core.js:674
_handleIncomingMessage @ messages-core.js:1805
(anonymous) @ messages-core.js:1754
setTimeout
(anonymous) @ messages-core.js:1754
postMessage
(anonymous) @ chat.html:5441
postMessage
(anonymous) @ messages-core.js:625
makeApiRequest @ messages-core.js:562
fetchConversations @ messages-core.js:2673
fetchConversations @ messages-core.js:5091
startDataFlow @ messages-core.js:6296
setSession @ messages-core.js:1640
_handleSessionData @ messages-core.js:1982
_handleIncomingMessage @ messages-core.js:1825
(anonymous) @ messages-core.js:1754
setTimeout
(anonymous) @ messages-core.js:1754
postMessage
sendSessionToModule @ chat.html:3901
(anonymous) @ chat.html:4079
sendToAllModulesIfNeeded @ chat.html:4076
(anonymous) @ chat.html:4976
postMessage
_initParentMessageListeners @ api.core.js:2304
initializeGateway @ api.core.js:6520
(anonymous) @ api.core.js:6921
(anonymous) @ api.core.js:7171
message.html:56 [ChatManager] Failed to fetch conversations: Error: Network request failed
    at handleApiResponse (messages-core.js:675:32)
    at Object._handleIncomingMessage (messages-core.js:1805:9)
    at messages-core.js:1754:39
console.error @ message.html:56
fetchConversations @ messages-core.js:2704
await in fetchConversations
fetchConversations @ messages-core.js:5091
startDataFlow @ messages-core.js:6296
setSession @ messages-core.js:1640
_handleSessionData @ messages-core.js:1982
_handleIncomingMessage @ messages-core.js:1825
(anonymous) @ messages-core.js:1754
setTimeout
(anonymous) @ messages-core.js:1754
postMessage
sendSessionToModule @ chat.html:3901
(anonymous) @ chat.html:4079
sendToAllModulesIfNeeded @ chat.html:4076
(anonymous) @ chat.html:4976
postMessage
_initParentMessageListeners @ api.core.js:2304
initializeGateway @ api.core.js:6520
(anonymous) @ api.core.js:6921
(anonymous) @ api.core.js:7171
 [status-ui] Core not ready — falling back to direct API fetch for status creation
 [STATUS FLOW] API → request sending
 [secureApiCall] ← 503 /api/tools/marketplace/wishlist
 [secureApiCall] Server error 503 for /api/tools/marketplace/wishlist — checking cache
Tools.html:17 [secureApiCall] ERROR GET /api/tools/marketplace/wishlist Internal server error
console.error @ Tools.html:17
secureApiCall @ Tool-core.js:5764
await in secureApiCall
safeApiCall @ Tool-core.js:5810
window._ecomApiCall @ Tool-core.js:8068
_api @ marketplace-ecommerce.js:111
syncFromServer @ marketplace-ecommerce.js:659
initEcommerceMarketplace @ marketplace-ecommerce.js:1306
await in initEcommerceMarketplace
tryInit @ marketplace-ecommerce.js:1343
setTimeout
_onSess @ marketplace-ecommerce.js:1358
postMessage
sendSessionToModule @ chat.html:3927
(anonymous) @ chat.html:4948
postMessage
sendChildReady @ Tool-core.js:4132
initializeModule @ Tool-core.js:4615
(anonymous) @ Tool-core.js:7595
setTimeout
(anonymous) @ Tool-core.js:7591
 [Tool-ui] Force binding all UI events...
 [secureApiCall] ← 503 /api/tools/marketplace/products?page=1&limit=40&sort=newest
 [secureApiCall] Server error 503 for /api/tools/marketplace/products?page=1&limit=40&sort=newest — checking cache
Tools.html:17 [secureApiCall] ERROR GET /api/tools/marketplace/products?page=1&limit=40&sort=newest Internal server error
console.error @ Tools.html:17
secureApiCall @ Tool-core.js:5764
await in secureApiCall
safeApiCall @ Tool-core.js:5810
window._ecomApiCall @ Tool-core.js:8068
_api @ marketplace-ecommerce.js:111
loadProducts @ marketplace-ecommerce.js:160
initEcommerceMarketplace @ marketplace-ecommerce.js:1315
await in initEcommerceMarketplace
tryInit @ marketplace-ecommerce.js:1343
setTimeout
_onSess @ marketplace-ecommerce.js:1358
postMessage
sendSessionToModule @ chat.html:3927
(anonymous) @ chat.html:4948
postMessage
sendChildReady @ Tool-core.js:4132
initializeModule @ Tool-core.js:4615
(anonymous) @ Tool-core.js:7595
setTimeout
(anonymous) @ Tool-core.js:7591
service-worker.js:808 [SW] v18.0.0 loaded - offline-first navigation active
 [calls.html] SW registered. Scope: https://moodfronted.onrender.com/
 [friend.html] SW registered. Scope: https://moodfronted.onrender.com/
service-worker.js:437 [SW] Installing v18.0.0 (network-first for all critical JS)
 [ToolPatch] Tool manifest fetch failed (using cache): HTTP error 503
status-api.js:205 [STATUS FLOW] API → ERROR: Failed to fetch
createStatus @ status-api.js:205
await in createStatus
handlePostStatus @ status-ui.js:6273
 [Tool-ui] Force binding complete - bound 18 elements
 [messages] 📥 API_RESPONSE received: req_70b5we69z72_1781318421097
message.html:56 [messages] API request failed: Network request failed
console.error @ message.html:56
handleApiResponse @ messages-core.js:674
_handleIncomingMessage @ messages-core.js:1805
(anonymous) @ messages-core.js:1754
setTimeout
(anonymous) @ messages-core.js:1754
postMessage
(anonymous) @ chat.html:5441
postMessage
(anonymous) @ messages-core.js:625
makeApiRequest @ messages-core.js:562
fetchFriends @ messages-core.js:3970
startDataFlow @ messages-core.js:6308
setSession @ messages-core.js:1640
_handleSessionData @ messages-core.js:1982
_handleIncomingMessage @ messages-core.js:1825
(anonymous) @ messages-core.js:1754
setTimeout
(anonymous) @ messages-core.js:1754
postMessage
sendSessionToModule @ chat.html:3901
(anonymous) @ chat.html:4079
sendToAllModulesIfNeeded @ chat.html:4076
(anonymous) @ chat.html:4976
postMessage
_initParentMessageListeners @ api.core.js:2304
initializeGateway @ api.core.js:6520
(anonymous) @ api.core.js:6921
(anonymous) @ api.core.js:7171
message.html:56 [FriendManager] Failed to fetch friends: Error: Network request failed
    at handleApiResponse (messages-core.js:675:32)
    at Object._handleIncomingMessage (messages-core.js:1805:9)
    at messages-core.js:1754:39
console.error @ message.html:56
fetchFriends @ messages-core.js:3992
await in fetchFriends
startDataFlow @ messages-core.js:6308
setSession @ messages-core.js:1640
_handleSessionData @ messages-core.js:1982
_handleIncomingMessage @ messages-core.js:1825
(anonymous) @ messages-core.js:1754
setTimeout
(anonymous) @ messages-core.js:1754
postMessage
sendSessionToModule @ chat.html:3901
(anonymous) @ chat.html:4079
sendToAllModulesIfNeeded @ chat.html:4076
(anonymous) @ chat.html:4976
postMessage
_initParentMessageListeners @ api.core.js:2304
initializeGateway @ api.core.js:6520
(anonymous) @ api.core.js:6921
(anonymous) @ api.core.js:7171
 [Tool-ui] Force binding all UI events...
 [Tool-ui] Force binding complete - bound 18 elements
 [settings] ✅ Background tasks completed
 [Tool-ui] Force binding all UI events...
service-worker.js:469 [SW] Pre-cached 42/42 assets
 [Tool-ui] Force binding complete - bound 18 elements
 [IdentityFoundation] ✅ Device dev_509f… FP 368a62e1…
 [IdentityFoundation] ✅ Ready
 [NetworkIntel] ✅ Started
 [NetworkIntel] ✅ Ready
 [IdentityFoundation] ✅ Device dev_509f… FP 368a62e1…
 [IdentityFoundation] ✅ Ready
 [NetworkIntel] ✅ Started
 [NetworkIntel] ✅ Ready
 [settings] ✅ Background tasks completed
 [NetworkIntel] ✅ Started
 [NetworkIntel] ✅ Ready
 [NetworkIntel] ✅ Started
 [NetworkIntel] ✅ Ready
 [NetworkIntel] ✅ Started
 [NetworkIntel] ✅ Ready
 [NetworkIntel] ✅ Started
 [NetworkIntel] ✅ Ready
 [Tool-ui] Force binding all UI events...
 [Tool-ui] Force binding complete - bound 18 elements
service-worker.js:389 [SW] Cache hit: https://moodfronted.onrender.com/js/core/network/NetworkIntelligenceManager.js
 [NetworkIntel] ✅ Started
 [NetworkIntel] ✅ Ready
 [RealtimeStab] ✅ Started
 [RealtimeStab] ✅ Ready
 [RealtimeStab] ✅ Started
 [RealtimeStab] ✅ Ready
 [Tool-ui] Force binding all UI events...
 [status-ui] Core not ready — falling back to direct API fetch for status creation
 [STATUS FLOW] API → request sending
 [RealtimeStab] ✅ Started
 [RealtimeStab] ✅ Ready
 [RealtimeStab] ✅ Started
 [RealtimeStab] ✅ Ready
 [Tool-ui] Force binding complete - bound 18 elements
 [Tools] 🔴 ERROR - loadListings failed: Internal server error {context: ''}
 [RealtimeStab] ✅ Started
 [RealtimeStab] ✅ Ready
status-api.js:205 [STATUS FLOW] API → ERROR: Failed to fetch
createStatus @ status-api.js:205
await in createStatus
handlePostStatus @ status-ui.js:6273
 [PersistenceStab] ✅ Initialized (version=4)
 [PersistenceStab] ✅ Ready
 [RealtimeStab] ✅ Started
 [RealtimeStab] ✅ Ready
 [RealtimeStab] ✅ Started
 [RealtimeStab] ✅ Ready
 [PersistenceStab] ✅ Initialized (version=4)
 [PersistenceStab] ✅ Ready
 [PersistenceStab] ✅ Initialized (version=4)
 [PersistenceStab] ✅ Ready
 [PersistenceStab] ✅ Initialized (version=4)
 [PersistenceStab] ✅ Ready
 [Tool-ui] Force binding all UI events...
 [Realtime] Connecting Socket.IO to https://moodchat-fy56.onrender.com
 [PersistenceStab] ✅ Initialized (version=4)
 [PersistenceStab] ✅ Ready
 [Tools] ✅ SUCCESS - pageCore initialization complete 
 [pageCore] UI initialized v7.1
 [Tool-ui.js] Resilient UI controller ready v7.1 (Handshake aligned - Simplified)
 [Tool-ui] Force binding all UI events...
 [CacheFoundation] ✅ Initialized
 [CacheFoundation] ✅ Ready
 [PHASE10] DeletionRegistry ✅ active
 [PersistenceStab] ✅ Initialized (version=4)
 [PersistenceStab] ✅ Ready
 [Tool-ui] Force binding complete - bound 18 elements
 [CacheFoundation] ✅ Initialized
 [CacheFoundation] ✅ Ready
 [PHASE10] DeletionRegistry ✅ active
 [safeApiCall] → GET /api/marketplace/listings null
 [secureApiCall] GET https://moodchat-fy56.onrender.com/api/tools/marketplace/listings 
 [safeApiCall] → GET /api/marketplace/spotlight null
 [secureApiCall] GET https://moodchat-fy56.onrender.com/api/tools/marketplace/spotlight 
 [PersistenceStab] ✅ Initialized (version=4)
 [PersistenceStab] ✅ Ready
 [Tool-ui] Force binding complete - bound 18 elements
 [CacheFoundation] ✅ Initialized
 [CacheFoundation] ✅ Ready
 [PHASE10] DeletionRegistry ✅ active
 [CacheFoundation] ✅ Initialized
 [CacheFoundation] ✅ Ready
 [PHASE10] DeletionRegistry ✅ active
 [secureApiCall] ← 503 /api/tools/marketplace/listings
 [secureApiCall] Server error 503 for /api/tools/marketplace/listings — checking cache
Tools.html:17 [secureApiCall] ERROR GET /api/tools/marketplace/listings Internal server error
console.error @ Tools.html:17
secureApiCall @ Tool-core.js:5764
await in secureApiCall
safeApiCall @ Tool-core.js:5810
loadListingsFromBackend @ Tool-core.js:6036
(anonymous) @ Tool-ui.js:971
setTimeout
progressiveEnhancement @ Tool-ui.js:968
init @ Tool-ui.js:3944
await in init
(anonymous) @ Tool-ui.js:4025
 [secureApiCall] ← 503 /api/tools/marketplace/spotlight
 [secureApiCall] Server error 503 for /api/tools/marketplace/spotlight — checking cache
Tools.html:17 [secureApiCall] ERROR GET /api/tools/marketplace/spotlight Internal server error
console.error @ Tools.html:17
secureApiCall @ Tool-core.js:5764
await in secureApiCall
safeApiCall @ Tool-core.js:5810
loadSpotlightListingsFromBackend @ Tool-core.js:6058
(anonymous) @ Tool-ui.js:974
setTimeout
progressiveEnhancement @ Tool-ui.js:968
init @ Tool-ui.js:3944
await in init
(anonymous) @ Tool-ui.js:4025
 [CacheFoundation] ✅ Initialized
 [CacheFoundation] ✅ Ready
 [PHASE10] DeletionRegistry ✅ active
 [CacheFoundation] ✅ Initialized
 [CacheFoundation] ✅ Ready
 [PHASE10] DeletionRegistry ✅ active
 [CacheFoundation] ✅ Initialized
 [CacheFoundation] ✅ Ready
 [PHASE10] DeletionRegistry ✅ active
 [QueueFoundation] ✅ Started
 [QueueFoundation] ✅ Ready
 [QueueFoundation] ✅ Started
 [QueueFoundation] ✅ Ready
 [QueueFoundation] ✅ Started
 [QueueFoundation] ✅ Ready
 [QueueFoundation] ✅ Started
 [QueueFoundation] ✅ Ready
 [QueueFoundation] ✅ Started
 [QueueFoundation] ✅ Ready
 [QueueFoundation] ✅ Started
 [QueueFoundation] ✅ Ready
 [QueueFoundation] ✅ Started
 [QueueFoundation] ✅ Ready
 [Tools] 🔵 READY - User settings loaded from storage 
 [PresenceEngine] ✅ Started for user 1
 [PresenceEngine] ✅ Ready
 [PresenceEngine] ✅ Started for user 1
 [PresenceEngine] ✅ Ready
 [PresenceEngine] ✅ Started for user 1
 [PresenceEngine] ✅ Ready
 [PresenceEngine] ✅ Started for user 1
 [PresenceEngine] ✅ Ready
 [PresenceEngine] ✅ Started for user 1
 [PresenceEngine] ✅ Ready
 [PresenceEngine] ✅ Started for user 1
 [PresenceEngine] ✅ Ready
 [NotifStab] Notification constructor patched for dedup
 [NotifStab] ✅ Initialized
 [NotifStab] ✅ Ready
 [PresenceEngine] ✅ Started for user 1
 [PresenceEngine] ✅ Ready
 [Tools] 🔵 READY - MarketplaceCore ready 
 [NotifStab] Notification constructor patched for dedup
 [NotifStab] ✅ Initialized
 [NotifStab] ✅ Ready
 [NotifStab] Notification constructor patched for dedup
 [NotifStab] ✅ Initialized
 [NotifStab] ✅ Ready
 [NotifStab] Notification constructor patched for dedup
 [NotifStab] ✅ Initialized
 [NotifStab] ✅ Ready
 [NotifStab] Notification constructor patched for dedup
 [NotifStab] ✅ Initialized
 [NotifStab] ✅ Ready
 [Monitoring] ✅ Initialized
 [Monitoring] ✅ Ready — run __KynDiag() to print diagnostics
 [NotifStab] Notification constructor patched for dedup
 [NotifStab] ✅ Initialized
 [NotifStab] ✅ Ready
service-worker.js:389 [SW] Cache hit: https://moodfronted.onrender.com/js/core/monitoring/MonitoringFoundation.js
 [Monitoring] ✅ Initialized
 [Monitoring] ✅ Ready — run __KynDiag() to print diagnostics
 [Monitoring] ✅ Initialized
 [Monitoring] ✅ Ready — run __KynDiag() to print diagnostics
 [NotifStab] Notification constructor patched for dedup
 [NotifStab] ✅ Initialized
 [NotifStab] ✅ Ready
 [Monitoring] ✅ Initialized
 [Monitoring] ✅ Ready — run __KynDiag() to print diagnostics
 [Monitoring] ✅ Initialized
 [Monitoring] ✅ Ready — run __KynDiag() to print diagnostics
 [Monitoring] ✅ Initialized
 [Monitoring] ✅ Ready — run __KynDiag() to print diagnostics
 [status-ui] Core not ready — falling back to direct API fetch for status creation
 [STATUS FLOW] API → request sending
 [Monitoring] ✅ Initialized
 [Monitoring] ✅ Ready — run __KynDiag() to print diagnostics
 [Monitoring] NetworkMetricsCollector attached
 [Monitoring] NetworkMetricsCollector attached
 [Monitoring] NetworkMetricsCollector attached
 [Monitoring] NetworkMetricsCollector attached
 [HybridTransport] ✅ Started — caps: {internetAvailable: true, lanAvailable: false, webRTCAvailable: true, serviceWorker: true, indexedDB: true, …}
 [HybridTransport] ✅ Ready
 [Monitoring] SyncFailureDetector attached
 [Monitoring] NetworkMetricsCollector attached
 [HybridTransport] ✅ Started — caps: {internetAvailable: true, lanAvailable: false, webRTCAvailable: true, serviceWorker: true, indexedDB: true, …}
 [HybridTransport] ✅ Ready
status-api.js:205 [STATUS FLOW] API → ERROR: Failed to fetch
createStatus @ status-api.js:205
await in createStatus
handlePostStatus @ status-ui.js:6273
 [Monitoring] SyncFailureDetector attached
 [Monitoring] SocketMetricsMonitor attached
 [Monitoring] SyncFailureDetector attached
 [loadListingsFromBackend] Server fetch failed, using cache: Internal server error
 [Monitoring] SyncFailureDetector attached
 [HybridTransport] ✅ Started — caps: {internetAvailable: true, lanAvailable: false, webRTCAvailable: true, serviceWorker: true, indexedDB: true, …}
 [HybridTransport] ✅ Ready
 [Monitoring] NetworkMetricsCollector attached
 [Monitoring] SocketMetricsMonitor attached
 [Monitoring] HydrationMetricsCollector attached
 [Monitoring] SocketMetricsMonitor attached
 [Monitoring] SyncFailureDetector attached
 [Monitoring] SocketMetricsMonitor attached
 [Monitoring] NetworkMetricsCollector attached
 [HybridTransport] ✅ Started — caps: {internetAvailable: true, lanAvailable: false, webRTCAvailable: true, serviceWorker: true, indexedDB: true, …}
 [HybridTransport] ✅ Ready
 [Monitoring] HydrationMetricsCollector attached
 [Monitoring] HydrationMetricsCollector attached
 [Monitoring] SocketMetricsMonitor attached
 [Monitoring] HydrationMetricsCollector attached
 [Monitoring] SyncFailureDetector attached
 [HybridTransport] ✅ Started — caps: {internetAvailable: true, lanAvailable: false, webRTCAvailable: true, serviceWorker: true, indexedDB: true, …}
 [HybridTransport] ✅ Ready
 [Monitoring] HydrationMetricsCollector attached
 [LAN] ✅ Ready
 [Monitoring] SyncFailureDetector attached
 [Monitoring] SocketMetricsMonitor attached
 [HybridTransport] ✅ Started — caps: {internetAvailable: true, lanAvailable: false, webRTCAvailable: true, serviceWorker: true, indexedDB: true, …}
 [HybridTransport] ✅ Ready
 [LAN] Local IP: 192.168.80.1
 [LAN] ✅ Started — LAN: false
 [Monitoring] SocketMetricsMonitor attached
 [Monitoring] HydrationMetricsCollector attached
 [HybridTransport] ✅ Started — caps: {internetAvailable: true, lanAvailable: false, webRTCAvailable: true, serviceWorker: true, indexedDB: true, …}
 [HybridTransport] ✅ Ready
 [Monitoring] HydrationMetricsCollector attached
 [LAN] ✅ Ready
 [LAN] Local IP: 192.168.80.1
 [LAN] ✅ Started — LAN: false
 [LAN] ✅ Ready
 [LAN] Local IP: 192.168.80.1
 [LAN] ✅ Started — LAN: false
 [LAN] ✅ Ready
 [LAN] Local IP: 192.168.80.1
 [LAN] ✅ Started — LAN: false
 [LAN] ✅ Ready
 [LAN] Local IP: 192.168.80.1
 [LAN] ✅ Started — LAN: false
 [MeshRelay] ✅ Started
 [MeshRelay] ✅ Ready
 [LAN] ✅ Ready
 [LAN] Local IP: 192.168.80.1
 [LAN] ✅ Started — LAN: false
 [MeshRelay] ✅ Started
 [MeshRelay] ✅ Ready
 [LAN] ✅ Ready
 [LAN] Local IP: 192.168.80.1
 [LAN] ✅ Started — LAN: false
 [MeshRelay] ✅ Started
 [MeshRelay] ✅ Ready
 [MeshRelay] ✅ Started
 [MeshRelay] ✅ Ready
 [MeshRelay] ✅ Started
 [MeshRelay] ✅ Ready
 [MeshRelay] ✅ Started
 [MeshRelay] ✅ Ready
 [MeshRelay] ✅ Started
 [MeshRelay] ✅ Ready
 [OfflineQueue] ✅ Ready
 [OfflineQueue] ✅ Initialized — 0 queued
 [OfflineQueue] ✅ Ready
 [OfflineQueue] ✅ Initialized — 0 queued
 [OfflineQueue] ✅ Ready
 [OfflineQueue] ✅ Initialized — 0 queued
 [OfflineQueue] ✅ Ready
 [OfflineQueue] ✅ Initialized — 0 queued
 [OfflineQueue] ✅ Ready
 [OfflineQueue] ✅ Initialized — 0 queued
 [OfflineQueue] ✅ Ready
 [OfflineQueue] ✅ Initialized — 0 queued
 [ReliableDelivery] ✅ Started
 [ReliableDelivery] ✅ Ready
 [OfflineQueue] ✅ Ready
 [OfflineQueue] ✅ Initialized — 0 queued
service-worker.js:389 [SW] Cache hit: https://moodfronted.onrender.com/js/core/realtime/ReliableDeliveryEngine.js
 [ReliableDelivery] ✅ Started
 [ReliableDelivery] ✅ Ready
 [ReliableDelivery] ✅ Started
 [ReliableDelivery] ✅ Ready
 [ReliableDelivery] ✅ Started
 [ReliableDelivery] ✅ Ready
 [ReliableDelivery] ✅ Started
 [ReliableDelivery] ✅ Ready
 [ReliableDelivery] ✅ Started
 [ReliableDelivery] ✅ Ready
 [ReliableDelivery] ✅ Started
 [ReliableDelivery] ✅ Ready
 [RealtimeSync] ✅ Started
 [RealtimeSync] ✅ Ready
 [RealtimeSync] ✅ Started
 [RealtimeSync] ✅ Ready
 [RealtimeSync] ✅ Started
 [RealtimeSync] ✅ Ready
 [RealtimeSync] ✅ Started
 [RealtimeSync] ✅ Ready
 [RealtimeSync] ✅ Started
 [RealtimeSync] ✅ Ready
 [RealtimeSync] ✅ Started
 [RealtimeSync] ✅ Ready
 [BGSync] ✅ Ready
 [BGSync] Service Worker sync registered: kyn-message-sync
 [BGSync] ✅ Started
service-worker.js:744 [SW] Background sync event: kyn-message-sync
 [RealtimeSync] ✅ Started
 [RealtimeSync] ✅ Ready
 [BGSync] ✅ Ready
 [BGSync] Service Worker sync registered: kyn-message-sync
service-worker.js:744 [SW] Background sync event: kyn-message-sync
 [BGSync] ✅ Started
 [BGSync] ✅ Ready
 [BGSync] Service Worker sync registered: kyn-message-sync
 [BGSync] ✅ Started
service-worker.js:744 [SW] Background sync event: kyn-message-sync
 [BGSync] ✅ Ready
 [BGSync] Service Worker sync registered: kyn-message-sync
 [BGSync] ✅ Started
service-worker.js:744 [SW] Background sync event: kyn-message-sync
 [BGSync] ✅ Ready
 [BGSync] Service Worker sync registered: kyn-message-sync
service-worker.js:744 [SW] Background sync event: kyn-message-sync
 [BGSync] ✅ Started
 [BGSync] ✅ Ready
 [BGSync] Service Worker sync registered: kyn-message-sync
 [BGSync] ✅ Started
service-worker.js:744 [SW] Background sync event: kyn-message-sync
 [BGSync] ✅ Ready
 [BGSync] Service Worker sync registered: kyn-message-sync
 [BGSync] ✅ Started
service-worker.js:744 [SW] Background sync event: kyn-message-sync
 [CallState] ✅ Ready
 [CallState] ✅ Ready
 [CallState] ✅ Ready
 [CallState] ✅ Ready
 [CallState] ✅ Ready
 [CallState] ✅ Ready
 [CallState] ✅ Ready
 [DeviceMedia] ✅ Ready
 [DeviceMedia] ✅ Ready
 [DeviceMedia] ✅ Ready
 [DeviceMedia] ✅ Ready
 [DeviceMedia] ✅ Ready
 [DeviceMedia] ✅ Ready
 [DeviceMedia] ✅ Ready
 [PeerConn] ✅ Started
 [PeerConn] ✅ Ready
 [PeerConn] ✅ Started
 [PeerConn] ✅ Ready
 [PeerConn] ✅ Started
 [PeerConn] ✅ Ready
 [BGSync] Service Worker sync registered: kyn-message-sync
 [BGSync] Service Worker sync registered: kyn-message-sync
 [BGSync] Service Worker sync registered: kyn-message-sync
 [BGSync] Service Worker sync registered: kyn-message-sync
 [BGSync] Service Worker sync registered: kyn-message-sync
 [BGSync] Service Worker sync registered: kyn-message-sync
 [BGSync] Service Worker sync registered: kyn-message-sync
 [PeerConn] ✅ Started
 [PeerConn] ✅ Ready
service-worker.js:744 [SW] Background sync event: kyn-message-sync
 [PeerConn] ✅ Started
 [PeerConn] ✅ Ready
 [PeerConn] ✅ Started
 [PeerConn] ✅ Ready
 [PeerConn] ✅ Started
 [PeerConn] ✅ Ready
 [CallOrchestrator] ✅ Started
 [CallOrchestrator] ✅ Ready
 [CallOrchestrator] ✅ Started
 [CallOrchestrator] ✅ Ready
 [CallOrchestrator] ✅ Started
 [CallOrchestrator] ✅ Ready
 [CallOrchestrator] ✅ Started
 [CallOrchestrator] ✅ Ready
 [CallOrchestrator] ✅ Started
 [CallOrchestrator] ✅ Ready
 [CallOrchestrator] ✅ Started
 [CallOrchestrator] ✅ Ready
 [CallOrchestrator] ✅ Started
 [CallOrchestrator] ✅ Ready
 [GroupCall] ✅ Ready
 [GroupCall] ✅ Ready
 [GroupCall] ✅ Ready
 [GroupCall] ✅ Ready
 [GroupCall] ✅ Ready
 [GroupCall] ✅ Ready
 [GroupCall] ✅ Ready
 [CallRecovery] Attached
 [AdaptiveBR] ✅ Started
 [AdaptiveBR] ✅ Ready
 [CallRecovery] Attached
 [AdaptiveBR] ✅ Started
 [AdaptiveBR] ✅ Ready
 [CallRecovery] Attached
 [AdaptiveBR] ✅ Started
 [AdaptiveBR] ✅ Ready
 [CallRecovery] Attached
 [AdaptiveBR] ✅ Started
 [AdaptiveBR] ✅ Ready
 [CallRecovery] Attached
 [AdaptiveBR] ✅ Started
 [AdaptiveBR] ✅ Ready
 [CallRecovery] Attached
 [AdaptiveBR] ✅ Started
 [AdaptiveBR] ✅ Ready
 [CallRecovery] Attached
 [AdaptiveBR] ✅ Started
 [AdaptiveBR] ✅ Ready
 [LANCall] ✅ Started
 [LANCall] ✅ Ready
 [LANCall] ✅ Started
 [LANCall] ✅ Ready
 [LANCall] ✅ Started
 [LANCall] ✅ Ready
 [LANCall] ✅ Started
 [LANCall] ✅ Ready
 [LANCall] ✅ Started
 [LANCall] ✅ Ready
 [GroupOrchestrator] ✅ Ready
 [LANCall] ✅ Started
 [LANCall] ✅ Ready
 [LANCall] ✅ Started
 [LANCall] ✅ Ready
 [GroupOrchestrator] ✅ Ready
 [GroupOrchestrator] ✅ Ready
 [GroupOrchestrator] ✅ Started
 [GroupOrchestrator] ✅ Ready
 [GroupOrchestrator] ✅ Ready
 [GroupOrchestrator] ✅ Ready
 [GroupModeration] ✅ Started
 [SocialGraph] ✅ Started
 [GroupModeration] ✅ Ready
 [SocialGraph] ✅ Ready
 [GroupOrchestrator] ✅ Ready
 [GroupModeration] ✅ Started
 [SocialGraph] ✅ Started
 [GroupModeration] ✅ Ready
 [SocialGraph] ✅ Ready
 [GroupModeration] ✅ Started
 [SocialGraph] ✅ Started
 [GroupModeration] ✅ Ready
 [SocialGraph] ✅ Ready
 [GroupModeration] ✅ Started
 [SocialGraph] ✅ Started
 [GroupModeration] ✅ Ready
 [SocialGraph] ✅ Ready
 [GroupModeration] ✅ Started
 [SocialGraph] ✅ Started
 [GroupModeration] ✅ Ready
 [SocialGraph] ✅ Ready
 [GroupModeration] ✅ Started
 [SocialGraph] ✅ Started
 [GroupModeration] ✅ Ready
 [SocialGraph] ✅ Ready
 [GroupPresenceCache] ✅ Ready
 [GroupModeration] ✅ Started
 [SocialGraph] ✅ Started
 [GroupModeration] ✅ Ready
 [SocialGraph] ✅ Ready
 [GroupPresenceCache] ✅ Ready
 [Realtime] Connecting Socket.IO to https://moodchat-fy56.onrender.com
 [Realtime] Max consecutive errors reached — entering DEGRADED mode
 [Realtime] DEGRADED — will attempt recovery in 60s
 [GroupPresenceCache] ✅ Ready
 [GroupPresenceCache] ✅ Started
 [GroupPresenceCache] ✅ Ready
 [GroupPresenceCache] ✅ Ready
 [GroupPresenceCache] ✅ Ready
 [SocialNotif] ✅ Started
 [SocialNotif] ✅ Ready
 [GroupPresenceCache] ✅ Ready
 [SocialNotif] ✅ Started
 [SocialNotif] ✅ Ready
service-worker.js:389 [SW] Cache hit: https://moodfronted.onrender.com/js/core/groups/SocialNotificationEngine.js
 [SocialNotif] ✅ Started
 [SocialNotif] ✅ Ready
 [SocialNotif] ✅ Started
 [SocialNotif] ✅ Ready
 [SocialNotif] ✅ Started
 [SocialNotif] ✅ Ready
 [SocialNotif] ✅ Started
 [SocialNotif] ✅ Ready
 [SocialNotif] ✅ Started
 [SocialNotif] ✅ Ready
 [StoryEngine] ✅ Ready
 [StoryEngine] Hydrated 0 active stories
 [StoryEngine] ✅ Started
 [StoryEngine] ✅ Ready
 [StoryEngine] Hydrated 0 active stories
 [StoryEngine] ✅ Started
 [StoryEngine] ✅ Ready
 [StoryEngine] Hydrated 0 active stories
 [StoryEngine] ✅ Started
 [StoryEngine] ✅ Ready
 [StoryEngine] Hydrated 0 active stories
 [StoryEngine] ✅ Started
 [StoryEngine] ✅ Ready
 [StoryEngine] Hydrated 0 active stories
 [StoryEngine] ✅ Started
 [StoryEngine] ✅ Ready
 [StoryEngine] Hydrated 0 active stories
 [StoryEngine] ✅ Started
 [Security] ✅ Ready
 [Security] ✅ Initialized — deviceId: dev_c827…
 [StoryEngine] ✅ Ready
 [StoryEngine] Hydrated 0 active stories
 [StoryEngine] ✅ Started
 [Security] ✅ Ready
 [Security] ✅ Initialized — deviceId: dev_c827…
 [Security] ✅ Ready
 [Security] ✅ Initialized — deviceId: dev_c827…
 [Security] ✅ Ready
 [Security] ✅ Initialized — deviceId: dev_c827…
 [Security] ✅ Ready
 [Security] ✅ Initialized — deviceId: dev_c827…
 [Security] ✅ Ready
 [Security] ✅ Initialized — deviceId: dev_c827…
 [Security] ✅ Ready
 [Security] ✅ Initialized — deviceId: dev_c827…
 [Reconnect] ✅ Ready
 [Reconnect] ✅ Ready
 [Reconnect] ✅ Ready
 [Reconnect] ✅ Ready
 [Reconnect] ✅ Started
 [Reconnect] ✅ Ready
 [Reconnect] ✅ Ready
 [Reconnect] ✅ Ready
 [DurableQueue] ✅ Ready
 [DurableQueue] ✅ Initialized — 0 ops loaded
 [DurableQueue] ✅ Ready
 [DurableQueue] ✅ Initialized — 0 ops loaded
 [DurableQueue] ✅ Ready
 [DurableQueue] ✅ Initialized — 0 ops loaded
 [DurableQueue] ✅ Ready
 [DurableQueue] ✅ Initialized — 0 ops loaded
 [DurableQueue] ✅ Ready
 [DurableQueue] ✅ Initialized — 0 ops loaded
 [SessionManager] ✅ Session loaded instantly, userId: 1
 [DurableQueue] ✅ Ready
 [DurableQueue] ✅ Initialized — 0 ops loaded
 [DurableQueue] ✅ Ready
 [DurableQueue] ✅ Initialized — 0 ops loaded
 [BGReliability] BroadcastChannel initialized, tabId: tab_1781318464390_u6vj
 [BGReliability] ✅ Ready
 [BGReliability] SW ready: https://moodfronted.onrender.com/
 [BGReliability] ✅ Started — leader: false
 [BGReliability] BroadcastChannel initialized, tabId: tab_1781318464510_t4ne
 [BGReliability] ✅ Ready
 [BGReliability] SW ready: https://moodfronted.onrender.com/
 [BGReliability] ✅ Started — leader: false
 [BGReliability] BroadcastChannel initialized, tabId: tab_1781318464601_x1xo
 [BGReliability] ✅ Ready
 [BGReliability] SW ready: https://moodfronted.onrender.com/
 [BGReliability] ✅ Started — leader: false
 [BGReliability] BroadcastChannel initialized, tabId: tab_1781318464696_c7a1
 [BGReliability] ✅ Ready
 [BGReliability] SW ready: https://moodfronted.onrender.com/
 [BGReliability] ✅ Started — leader: false
 [BGReliability] BroadcastChannel initialized, tabId: tab_1781318464805_pnnj
 [BGReliability] ✅ Ready
 [BGReliability] SW ready: https://moodfronted.onrender.com/
 [BGReliability] ✅ Started — leader: false
 [BGReliability] BroadcastChannel initialized, tabId: tab_1781318464907_8nt0
 [BGReliability] ✅ Ready
 [BGReliability] SW ready: https://moodfronted.onrender.com/
 [BGReliability] ✅ Started — leader: false
 [BGReliability] BroadcastChannel initialized, tabId: tab_1781318465008_lep9
 [BGReliability] ✅ Ready
 [BGReliability] SW ready: https://moodfronted.onrender.com/
 [BGReliability] ✅ Started — leader: false
 [ProductionMonitor] ✅ Ready — __MoodChatDiag() for full snapshot
 [ProductionMonitor] ✅ Ready — __MoodChatDiag() for full snapshot
 [ProductionMonitor] ✅ Ready — __MoodChatDiag() for full snapshot
 [ProductionMonitor] ✅ Ready — __MoodChatDiag() for full snapshot
 [ProductionMonitor] ✅ Ready — __MoodChatDiag() for full snapshot
 [ProductionMonitor] ✅ Ready — __MoodChatDiag() for full snapshot
 [ProductionMonitor] ✅ Ready — __MoodChatDiag() for full snapshot
 [CacheRepair] ✅ Ready
 [CacheRepair] ✅ Started
 [CacheRepair] ✅ Ready
 [CacheRepair] ✅ Started
 [CacheRepair] ✅ Ready
 [CacheRepair] ✅ Started
 [CacheRepair] ✅ Ready
 [CacheRepair] ✅ Started
 [CacheRepair] ✅ Ready
 [CacheRepair] ✅ Started
 [CacheRepair] ✅ Ready
 [CacheRepair] ✅ Started
 [CacheRepair] ✅ Ready
 [CacheRepair] ✅ Started
 [Phase6] ✅ Runtime Integration Validator ready
 [Phase6] ✅ Runtime Integration Validator ready
 [Phase6] ✅ Runtime Integration Validator ready
 [Phase6] ✅ Runtime Integration Validator ready
 [Phase6] ✅ Runtime Integration Validator ready
 [Phase6] ✅ Runtime Integration Validator ready
 [Phase10] TransportRuntime ✅ active — best: INTERNET
 [Phase6Bootstrap] ✅ Phase 10 production hardening modules loaded
 [Phase6] ✅ Runtime Integration Validator ready
service-worker.js:389 [SW] Cache hit: https://moodfronted.onrender.com/mesh/mesh-crypto.js
service-worker.js:389 [SW] Cache hit: https://moodfronted.onrender.com/mesh/mesh-transport.js
service-worker.js:389 [SW] Cache hit: https://moodfronted.onrender.com/mesh/mesh-router.js
service-worker.js:389 [SW] Cache hit: https://moodfronted.onrender.com/mesh/mesh-engine.js
service-worker.js:389 [SW] Cache hit: https://moodfronted.onrender.com/mesh/mesh-messages-bridge.js
 [MeshBridge] ✅ Bridge installed for device dev_b7fc3bb94a5a4bff
 [MeshBridge] Waiting for MeshEngine…
 [Phase6Bootstrap] ✅ Mesh engine stack loaded (MeshCrypto + MeshTransport + MeshRouter + MeshEngine)
 [Phase10] TransportRuntime ✅ active — best: INTERNET
 [Phase6Bootstrap] ✅ Phase 10 production hardening modules loaded
 [MeshBridge] ✅ Bridge installed for device dev_b7fc3bb94a5a4bff
 [MeshBridge] Waiting for MeshEngine…
 [Phase6Bootstrap] ✅ Mesh engine stack loaded (MeshCrypto + MeshTransport + MeshRouter + MeshEngine)
 [Phase10] TransportRuntime ✅ active — best: INTERNET
 [Phase6Bootstrap] ✅ Phase 10 production hardening modules loaded
 [MeshBridge] ✅ Bridge installed for device dev_b7fc3bb94a5a4bff
 [MeshBridge] Waiting for MeshEngine…
 [Phase6Bootstrap] ✅ Mesh engine stack loaded (MeshCrypto + MeshTransport + MeshRouter + MeshEngine)
 [Phase10] TransportRuntime ✅ active — best: INTERNET
 [Phase6Bootstrap] ✅ Phase 10 production hardening modules loaded
 [MeshBridge] ✅ Bridge installed for device dev_b7fc3bb94a5a4bff
 [MeshBridge] Waiting for MeshEngine…
 [Phase6Bootstrap] ✅ Mesh engine stack loaded (MeshCrypto + MeshTransport + MeshRouter + MeshEngine)
 [Phase10] TransportRuntime ✅ active — best: INTERNET
 [Phase6Bootstrap] ✅ Phase 10 production hardening modules loaded
 [Phase6Bootstrap] ℹ️ MeshCrypto already loaded — skipping MESH_MODULES (iframe guard)
 [Phase10] TransportRuntime ✅ active — best: INTERNET
 [Phase6Bootstrap] ✅ Phase 10 production hardening modules loaded
 [MeshTransport] ✅ Transport layer initialised, deviceId: dev_b7fc3bb94a5a4bff
 [MeshRouter] ✅ Router ready, deviceId: dev_b7fc3bb94a5a4bff
 [MeshEngine] ✅ Initialised | Phase 4 | DeviceId: dev_b7fc3bb94a5a4bff
 [Phase6Bootstrap] ✅ Phase 11 Central Orchestration Runtime loaded
 [Phase6Bootstrap] ✅ 42/35 modules in 52337ms
 [Phase6Bootstrap] OfflineQueue send handler wired
 [Phase6Bootstrap] Cross-module listeners wired
 [Phase10] TransportRuntime active — best: INTERNET
 [Phase10] LAN engine active — peers: 0
 [Phase10] All production hardening systems wired ✅
 [Phase11] CentralOrchestrationRuntime active ✅
 [Phase6] ℹ️  Running in child iframe (bridge mode) — full validation skipped. Bridge ready: true
 [Phase6Bootstrap] 🎉 MoodChat Phase 10 fully initialized — __MoodChatDiag() for diagnostics
 [Phase6] ✅ Runtime Integration Validator started (bridge/iframe mode)
 [Phase10] TransportRuntime ✅ active — best: INTERNET
 [Phase6Bootstrap] ✅ Phase 10 production hardening modules loaded
 [Phase6Bootstrap] ✅ Phase 11 Central Orchestration Runtime loaded
 [Phase6Bootstrap] ✅ 42/35 modules in 49642ms
 [Phase6Bootstrap] OfflineQueue send handler wired
 [Phase6Bootstrap] Cross-module listeners wired
 [Phase10] TransportRuntime active — best: INTERNET
 [Phase10] LAN engine active — peers: 0
 [Phase10] All production hardening systems wired ✅
 [Phase11] CentralOrchestrationRuntime active ✅
 [Phase6] ℹ️  Running in child iframe (bridge mode) — full validation skipped. Bridge ready: true
 [Phase6Bootstrap] 🎉 MoodChat Phase 10 fully initialized — __MoodChatDiag() for diagnostics
 [Phase6] ✅ Runtime Integration Validator started (bridge/iframe mode)
 [Phase6Bootstrap] ✅ Phase 11 Central Orchestration Runtime loaded
 [Phase6Bootstrap] ✅ 42/35 modules in 51710ms
 [Phase6Bootstrap] OfflineQueue send handler wired
 [Phase6Bootstrap] Cross-module listeners wired
 [Phase10] TransportRuntime active — best: INTERNET
 [Phase10] LAN engine active — peers: 0
 [Phase10] All production hardening systems wired ✅
 [Phase11] CentralOrchestrationRuntime active ✅
 [Phase6] ℹ️  Running in child iframe (bridge mode) — full validation skipped. Bridge ready: true
 [Phase6Bootstrap] 🎉 MoodChat Phase 10 fully initialized — __MoodChatDiag() for diagnostics
 [Phase6] ✅ Runtime Integration Validator started (bridge/iframe mode)
 [Phase6Bootstrap] ✅ Phase 11 Central Orchestration Runtime loaded
 [Phase6Bootstrap] ✅ 42/35 modules in 50397ms
 [Phase6Bootstrap] OfflineQueue send handler wired
 [Phase6Bootstrap] Cross-module listeners wired
 [Phase10] TransportRuntime active — best: INTERNET
 [Phase10] LAN engine active — peers: 0
 [Phase10] All production hardening systems wired ✅
 [Phase11] CentralOrchestrationRuntime active ✅
 [Phase6] ℹ️  Running in child iframe (bridge mode) — full validation skipped. Bridge ready: true
 [Phase6Bootstrap] 🎉 MoodChat Phase 10 fully initialized — __MoodChatDiag() for diagnostics
 [Phase6] ✅ Runtime Integration Validator started (bridge/iframe mode)
 [BGSync] SW registered: https://moodfronted.onrender.com/
 [BGSync] SW registered: https://moodfronted.onrender.com/
 [BGSync] SW registered: https://moodfronted.onrender.com/
 [BGSync] SW registered: https://moodfronted.onrender.com/
 [MeshTransport] ✅ Transport layer initialised, deviceId: dev_b7fc3bb94a5a4bff
 [MeshTransport] ✅ Transport layer initialised, deviceId: dev_b7fc3bb94a5a4bff
 [MeshTransport] ✅ Transport layer initialised, deviceId: dev_b7fc3bb94a5a4bff
 [Reconnect] Boot grace period ended
 [Reconnect] Boot grace period ended
 [Reconnect] Boot grace period ended
 [Reconnect] Boot grace period ended
 [Reconnect] Boot grace period ended
 [Reconnect] Boot grace period ended
 [MeshRouter] ✅ Router ready, deviceId: dev_b7fc3bb94a5a4bff
 [MeshEngine] ✅ Initialised | Phase 4 | DeviceId: dev_b7fc3bb94a5a4bff
 [MeshRouter] ✅ Router ready, deviceId: dev_b7fc3bb94a5a4bff
 [MeshEngine] ✅ Initialised | Phase 4 | DeviceId: dev_b7fc3bb94a5a4bff
 [MeshRouter] ✅ Router ready, deviceId: dev_b7fc3bb94a5a4bff
 [MeshEngine] ✅ Initialised | Phase 4 | DeviceId: dev_b7fc3bb94a5a4bff
 [MeshBridge] ✅ Bridge installed for device dev_b7fc3bb94a5a4bff
 [MeshBridge] Waiting for MeshEngine…
 [Phase6Bootstrap] ✅ Mesh engine stack loaded (MeshCrypto + MeshTransport + MeshRouter + MeshEngine)
 [MeshBridge] ✅ Bridge installed for device dev_b7fc3bb94a5a4bff
 [MeshBridge] Waiting for MeshEngine…
 [Phase6Bootstrap] ✅ Mesh engine stack loaded (MeshCrypto + MeshTransport + MeshRouter + MeshEngine)
service-worker.js:389 [SW] Cache hit: https://moodfronted.onrender.com/js/core/orchestration/CentralOrchestrationRuntime.js
 [Phase6Bootstrap] ✅ Phase 11 Central Orchestration Runtime loaded
 [Phase6Bootstrap] ✅ 42/35 modules in 51395ms
 [Phase6Bootstrap] OfflineQueue send handler wired
 [Phase6Bootstrap] Cross-module listeners wired
 [Phase10] TransportRuntime active — best: INTERNET
 [Phase10] LAN engine active — peers: 0
 [Phase10] All production hardening systems wired ✅
 [Phase11] CentralOrchestrationRuntime active ✅
 [Phase6] ℹ️  Running in child iframe (bridge mode) — full validation skipped. Bridge ready: true
 [Phase6Bootstrap] 🎉 MoodChat Phase 10 fully initialized — __MoodChatDiag() for diagnostics
 [Phase6] ✅ Runtime Integration Validator started (bridge/iframe mode)
 [Phase6Bootstrap] ✅ Phase 11 Central Orchestration Runtime loaded
 [Phase6Bootstrap] ✅ 42/35 modules in 52781ms
 [Phase6Bootstrap] OfflineQueue send handler wired
 [Phase6Bootstrap] Cross-module listeners wired
 [Phase10] TransportRuntime active — best: INTERNET
 [Phase10] LAN engine active — peers: 0
 [Phase10] All production hardening systems wired ✅
 [Phase11] CentralOrchestrationRuntime active ✅
 [Phase6] ℹ️  Running in child iframe (bridge mode) — full validation skipped. Bridge ready: true
 [Phase6Bootstrap] 🎉 MoodChat Phase 10 fully initialized — __MoodChatDiag() for diagnostics
 [Phase6] ✅ Runtime Integration Validator started (bridge/iframe mode)
 [BGSync] SW registered: https://moodfronted.onrender.com/
 [calls][SessionClient] Valid session received: {authenticated: true, userId: 1, sessionId: 1781318471118}
 [calls][SessionClient] Valid session received: {authenticated: true, userId: 1, sessionId: 1781318471120}
 [BGSync] SW registered: https://moodfronted.onrender.com/
 [Phase6Bootstrap] ✅ Phase 11 Central Orchestration Runtime loaded
 [Phase6Bootstrap] ✅ 37/35 modules in 53096ms
 [Phase6Bootstrap] OfflineQueue send handler wired
 [Phase6Bootstrap] Safety-wired 38 group+status+phase5 events
 [Phase6Bootstrap] Cross-module listeners wired
 [Phase10] TransportRuntime active — best: INTERNET
 [Phase10] LAN engine active — peers: 0
 [Phase10] All production hardening systems wired ✅
 [Phase11] CentralOrchestrationRuntime active ✅
 [Phase6] ℹ️  Running in child iframe (bridge mode) — full validation skipped. Bridge ready: true
 [Phase6Bootstrap] 🎉 MoodChat Phase 10 fully initialized — __MoodChatDiag() for diagnostics
 [Phase6] ✅ Runtime Integration Validator started (bridge/iframe mode)
 [BGSync] SW registered: https://moodfronted.onrender.com/
 [BGSync] SW registered: https://moodfronted.onrender.com/
 [PushManager] SW updated — reloading
 [calls.html] SW controller changed — reload suppressed to protect call state
 [MeshTransport] ✅ Transport layer initialised, deviceId: dev_b7fc3bb94a5a4bff
 [MeshTransport] ✅ Transport layer initialised, deviceId: dev_b7fc3bb94a5a4bff
 [Calls UI] Received CONTACTS_UPDATE: 0 contacts
 [MeshRouter] ✅ Router ready, deviceId: dev_b7fc3bb94a5a4bff
 [MeshEngine] ✅ Initialised | Phase 4 | DeviceId: dev_b7fc3bb94a5a4bff
 [MeshRouter] ✅ Router ready, deviceId: dev_b7fc3bb94a5a4bff
 [MeshEngine] ✅ Initialised | Phase 4 | DeviceId: dev_b7fc3bb94a5a4bff
 [calls.html] SW controller changed — reload suppressed to protect call state
ReconnectOrchestrator.js:182 [Reconnect] Boot grace period ended
app.realtime.socket.js:48 [Realtime] Reconnecting in 3093ms (attempt 1/20)
app.realtime.socket.js:48 [BGSync] Network restored (was offline 0s)
app.realtime.socket.js:48 [BGSync] Returning after 66s — full recovery
app.realtime.socket.js:48 [Reconnect] State: DISCONNECTED → RECONNECTING
app.realtime.socket.js:48 [Reconnect] Retry in 1114ms (attempt 1)
app.realtime.socket.js:48 [BGReliability] Tab visible after 66s
app.realtime.socket.js:48 [BGSync] Network restored (was offline 0s)
app.realtime.socket.js:48 [BGSync] Returning after 66s — full recovery
app.realtime.socket.js:48 [Reconnect] State: DISCONNECTED → RECONNECTING
app.realtime.socket.js:48 [Reconnect] Retry in 1198ms (attempt 1)
app.realtime.socket.js:48 [BGReliability] Tab visible after 0s
BackgroundSyncService.js:146 [BGSync] Network restored (was offline 0s)
BackgroundSyncService.js:218 [BGSync] Returning after 66s — full recovery
BackgroundReliabilityService.js:300 [BGReliability] Tab visible after 0s
BackgroundSyncService.js:146 [BGSync] Network restored (was offline 0s)
BackgroundSyncService.js:218 [BGSync] Returning after 66s — full recovery
BackgroundReliabilityService.js:300 [BGReliability] Tab visible after 0s
BackgroundSyncService.js:146 [BGSync] Network restored (was offline 0s)
BackgroundSyncService.js:218 [BGSync] Returning after 66s — full recovery
BackgroundReliabilityService.js:300 [BGReliability] Tab visible after 0s
BackgroundSyncService.js:146 [BGSync] Network restored (was offline 0s)
BackgroundSyncService.js:218 [BGSync] Returning after 66s — full recovery
BackgroundReliabilityService.js:300 [BGReliability] Tab visible after 0s
BackgroundSyncService.js:146 [BGSync] Network restored (was offline 0s)
BackgroundSyncService.js:218 [BGSync] Returning after 66s — full recovery
BackgroundReliabilityService.js:300 [BGReliability] Tab visible after 0s
BackgroundSyncService.js:146 [BGSync] Network restored (was offline 0s)
BackgroundSyncService.js:218 [BGSync] Returning after 66s — full recovery
BackgroundReliabilityService.js:300 [BGReliability] Tab visible after 0s
settings-ui.js:911 [SettingsUI] 📂 Loading section: profile
settings-ui.js:211 [SettingsUI] Loading profile section
settings-ui.js:966 [SettingsUI] ✅ Successfully loaded section: profile
calls.html:4266 [MasterFix] Iframe became visible — screens restored
app.realtime.socket.js:48 [Realtime] Connecting Socket.IO to https://moodchat-fy56.onrender.com
app.realtime.socket.js:48 [Realtime] ✅ Socket.IO connected successfully, sid: DsANfq0d7toLjnzzAAAB
app.realtime.socket.js:48 [Realtime] ✅ Message bridge listeners registered
app.realtime.socket.js:48 [Realtime] ✅ Emitted join_user_room for userId: 1
app.realtime.socket.js:48 [Realtime] ✅ Server confirmed authentication: {userId: 1, authenticated: true, timestamp: 1781318513515}
app.realtime.socket.js:48 [Realtime] ✅ Re-joined user rooms after auth confirmation, userId: 1
BackgroundSyncService.js:105 [BGSync] Hidden for 49s — triggering recovery
BackgroundSyncService.js:105 [BGSync] Hidden for 49s — triggering recovery
BackgroundSyncService.js:105 [BGSync] Hidden for 50s — triggering recovery
app.realtime.socket.js:48 [BGSync] Hidden for 50s — triggering recovery
BackgroundSyncService.js:105 [BGSync] Hidden for 50s — triggering recovery
BackgroundSyncService.js:105 [BGSync] Hidden for 50s — triggering recovery
BackgroundSyncService.js:105 [BGSync] Hidden for 50s — triggering recovery
app.realtime.socket.js:48 [Navigation] Navigation element clicked: tools
app.realtime.socket.js:48 [Navigation] navigateToPage called with: tools {}
app.realtime.socket.js:48 [Navigation] Page changed from status to tools
app.realtime.socket.js:48 [Navigation] Hiding all iframe containers...
app.realtime.socket.js:48 [Navigation] Hiding: messagesContent current classes: iframe-container hidden
app.realtime.socket.js:48 [Navigation] Hiding: statusContent current classes: iframe-container
app.realtime.socket.js:48 [Navigation] Hiding: groupContent current classes: iframe-container hidden
app.realtime.socket.js:48 [Navigation] Hiding: friendsContent current classes: iframe-container hidden
app.realtime.socket.js:48 [Navigation] Hiding: callsContent current classes: iframe-container hidden
app.realtime.socket.js:48 [Navigation] Hiding: settingsContent current classes: iframe-container hidden
app.realtime.socket.js:48 [Navigation] Hiding: toolsContent current classes: iframe-container hidden
app.realtime.socket.js:48 [Navigation] Hiding: gamesContent current classes: iframe-container hidden
app.realtime.socket.js:48 [Navigation] Target element: <div id=​"toolsContent" class=​"iframe-container hidden">​…​</div>​ for page: tools
app.realtime.socket.js:48 [Navigation] Target before removing hidden: iframe-container hidden
app.realtime.socket.js:48 [Navigation] Target after removing hidden: iframe-container
Tool-core.js:4442 [Tools][DirectListener] Received: SESSION_DATA {type: 'SESSION_DATA', id: 'session_1781318516627_tools', source: 'parent', target: 'tools', payload: {…}, …}
Tool-core.js:4447 [Tools][DirectListener] Processing SESSION_DATA directly
Tool-core.js:4468 [Tools][DirectListener] Found session data: {userId: 1, hasToken: true}
Tool-core.js:1474 [Tools][SessionWrapper] Processing session: {userId: 1, hasToken: true}
Tool-core.js:1531 [Tools][SessionWrapper] Session accepted, userId: 1
Tool-core.js:4442 [Tools][DirectListener] Received: AUTH_READY {type: 'AUTH_READY', id: 'auth_ready_1781318516627_tools', source: 'parent', target: 'tools', payload: {…}, …}
Tool-core.js:4519 [Tools][DirectListener] Processing AUTH_READY directly
Tool-core.js:4541 [Tools][DirectListener] Found session in AUTH_READY: {userId: 1, hasToken: true}
Tool-core.js:1474 [Tools][SessionWrapper] Processing session: {userId: 1, hasToken: true}
Tool-core.js:1531 [Tools][SessionWrapper] Session accepted, userId: 1
Tool-core.js:4442 [Tools][DirectListener] Received: PARENT_READY {type: 'PARENT_READY', id: 'parent_ready_1781318516627_tools', source: 'parent', target: 'tools', payload: {…}, …}
app.realtime.socket.js:48 [Navigation] Navigation element clicked: messages
app.realtime.socket.js:48 [Navigation] navigateToPage called with: messages {}
app.realtime.socket.js:48 [Navigation] Page changed from tools to messages
app.realtime.socket.js:48 [Navigation] Hiding: statusContent current classes: iframe-container hidden
app.realtime.socket.js:48 [Navigation] Hiding: toolsContent current classes: iframe-container
app.realtime.socket.js:48 [Navigation] Target element: <div id=​"messagesContent" class=​"iframe-container hidden">​…​</div>​ for page: messages
app.realtime.socket.js:48 [messages] Duplicate PARENT_READY ignored
app.realtime.socket.js:48 [SessionManager] ✅ Session loaded instantly, userId: 1
app.realtime.socket.js:48 [BGSync] Hidden for 75s — triggering recovery
app.realtime.socket.js:48 [Navigation] Navigation element clicked: undefined
app.realtime.socket.js:48 [Navigation] navigateToPage called with: calls {}
app.realtime.socket.js:48 [Navigation] Page changed from messages to calls
app.realtime.socket.js:48 [Navigation] Hiding all iframe containers...
app.realtime.socket.js:48 [Navigation] Hiding: messagesContent current classes: iframe-container
app.realtime.socket.js:48 [Navigation] Hiding: statusContent current classes: iframe-container hidden
app.realtime.socket.js:48 [Navigation] Hiding: groupContent current classes: iframe-container hidden
app.realtime.socket.js:48 [Navigation] Hiding: friendsContent current classes: iframe-container hidden
app.realtime.socket.js:48 [Navigation] Hiding: callsContent current classes: iframe-container hidden
app.realtime.socket.js:48 [Navigation] Hiding: settingsContent current classes: iframe-container hidden
app.realtime.socket.js:48 [Navigation] Hiding: toolsContent current classes: iframe-container hidden
app.realtime.socket.js:48 [Navigation] Hiding: gamesContent current classes: iframe-container hidden
app.realtime.socket.js:48 [Navigation] Target element: <div id=​"callsContent" class=​"iframe-container hidden">​…​</div>​ for page: calls
app.realtime.socket.js:48 [Navigation] Target before removing hidden: iframe-container hidden
app.realtime.socket.js:48 [Navigation] Target after removing hidden: iframe-container
calls-ui.js:9478 [Calls UI] Received CONTACTS_UPDATE: 0 contacts
calls-core.js:1116 [calls][SessionClient] Valid session received: {authenticated: true, userId: 1, sessionId: 1781318532669}
calls-core.js:1116 [calls][SessionClient] Valid session received: {authenticated: true, userId: 1, sessionId: 1781318532669}
calls-ui.js:9478 [Calls UI] Received CONTACTS_UPDATE: 0 contacts
calls.html:4266 [MasterFix] Iframe became visible — screens restored
app.realtime.socket.js:48 [Navigation] navigateToPage called with: group {}
app.realtime.socket.js:48 [Navigation] Page changed from calls to group
app.realtime.socket.js:48 [Navigation] Hiding: messagesContent current classes: iframe-container hidden
app.realtime.socket.js:48 [Navigation] Hiding: callsContent current classes: iframe-container
app.realtime.socket.js:48 [Navigation] Target element: <div id=​"groupContent" class=​"iframe-container">​…​</div>​ for page: group
friendSync.engine.js:119 [FriendSync] Starting full sync…