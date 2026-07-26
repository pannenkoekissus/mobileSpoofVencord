/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import definePlugin, { OptionType, StartAt } from "@utils/types";
import { waitFor } from "@webpack";

// ─── Settings ────────────────────────────────────────────────────────────────

const settings = definePluginSettings({
    mobilePlatform: {
        type: OptionType.SELECT,
        description: "The mobile platform to spoof. Requires Discord reload to take effect.",
        options: [
            { label: "Android", value: "Android", default: true },
            { label: "iOS", value: "iOS" }
        ],
        restartNeeded: false
    }
});

// ─── State ────────────────────────────────────────────────────────────────────

let originalWsSend: typeof WebSocket.prototype.send | null = null;
let originalGetSuperProperties: any = null;
let originalGetSuperPropertiesBase64: any = null;
let patchedModule: any = null;
let observer: MutationObserver | null = null;
let observerThrottle: ReturnType<typeof setTimeout> | null = null;
let QuestsStore: any = null;

// The live gateway WebSocket — captured automatically via the send hook.
let gatewaySocket: WebSocket | null = null;
// Set to true when a reconnect is requested but the socket isn't captured yet.
let pendingReconnect = false;

// ─── Gateway Reconnect Helper ─────────────────────────────────────────────────

function injectInvalidSession(ws: WebSocket) {
    // Inject a fake "Invalid Session" (op 9, d: false).
    // Discord's handler clears the session and sends a fresh IDENTIFY (op 2)
    // on reconnect — our send patch then adds mobile properties.
    ws.dispatchEvent(new MessageEvent("message", {
        data: JSON.stringify({ op: 9, d: false })
    }));
    console.log("[MobileSpoof] Injected op 9 — Discord will reconnect with fresh IDENTIFY.");
}

function forceGatewayReconnect() {
    if (gatewaySocket?.readyState === WebSocket.OPEN) {
        injectInvalidSession(gatewaySocket);
    } else {
        // Socket not captured yet (plugin just started mid-session).
        // The send hook will fire the injection the next time Discord sends
        // anything on the gateway (heartbeat every ~41s, usually much sooner).
        console.log("[MobileSpoof] Socket not ready — will reconnect on next gateway send.");
        pendingReconnect = true;
    }
}

// ─── Quest Store Patching (Converts Mobile tasks to Desktop tasks) ─────────────

function patchQuestsInStore() {
    if (!QuestsStore || !QuestsStore.quests) return;

    let anyModified = false;
    for (const quest of QuestsStore.quests.values()) {
        let modified = false;

        // 1. Ensure platform 1 (Desktop) is supported so card is not locked/hidden
        if (quest.config && Array.isArray(quest.config.platforms)) {
            if (!quest.config.platforms.includes(1)) {
                quest.config.platforms.push(1);
                modified = true;
            }
        }

        // 2. Map mobile task types to desktop task types so UI renders official buttons
        const taskConfig = quest.config?.taskConfig ?? quest.config?.taskConfigV2;
        if (taskConfig?.tasks) {
            // Video task mapping
            if (taskConfig.tasks.WATCH_VIDEO_ON_MOBILE && !taskConfig.tasks.WATCH_VIDEO) {
                taskConfig.tasks.WATCH_VIDEO = taskConfig.tasks.WATCH_VIDEO_ON_MOBILE;
                delete taskConfig.tasks.WATCH_VIDEO_ON_MOBILE;
                modified = true;
            }
            // Game activity task mapping
            if (taskConfig.tasks.PLAY_ON_MOBILE && !taskConfig.tasks.PLAY_ON_DESKTOP) {
                taskConfig.tasks.PLAY_ON_DESKTOP = taskConfig.tasks.PLAY_ON_MOBILE;
                delete taskConfig.tasks.PLAY_ON_MOBILE;
                modified = true;
            }
        }

        if (modified) {
            anyModified = true;
            console.log("[MobileSpoof] Patched quest to desktop type in store:", quest.id,
                quest.config?.messages?.questName ?? quest.config?.application?.name);
        }
    }

    if (anyModified) {
        try {
            // Trigger Flux store update so React UI refreshes and shows official buttons
            QuestsStore.emitChange();
        } catch (e) {
            console.error("[MobileSpoof] emitChange error:", e);
        }
    }
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

export default definePlugin({
    name: "MobileSpoof",
    description: "Makes Discord think you are on mobile — shows mobile status indicator and allows mobile-only quests.",
    tags: ["Utility", "Privacy"],
    authors: ["pannenkoekissus"],
    settings,
    startAt: StartAt.Init,

    start() {
        // ── 1. WebSocket — patch Gateway IDENTIFY + capture socket reference ──
        originalWsSend = WebSocket.prototype.send;
        WebSocket.prototype.send = function (this: WebSocket, data: any) {
            if (typeof data === "string") {
                try {
                    const isGateway = typeof this.url === "string" &&
                        (this.url.includes("gateway.discord.gg") || this.url.includes("gateway"));
                    if (isGateway) {
                        // Capture the live gateway socket whenever Discord sends on it
                        gatewaySocket = this;

                        // If a reconnect was requested before we had the socket, fire it now
                        if (pendingReconnect) {
                            pendingReconnect = false;
                            setTimeout(() => injectInvalidSession(this), 0);
                        }

                        const parsed = JSON.parse(data);
                        if (parsed.op === 2 && parsed.d?.properties) {
                            const isIOS = settings.store.mobilePlatform === "iOS";
                            parsed.d.properties.$os = isIOS ? "iOS" : "Android";
                            parsed.d.properties.$browser = isIOS ? "Discord iOS" : "Discord Android";
                            parsed.d.properties.$device = isIOS ? "Discord iOS" : "Discord Android";
                            data = JSON.stringify(parsed);
                        }
                    }
                } catch { /* ignore */ }
            }
            return originalWsSend!.call(this, data);
        };

        // ── 2. getSuperProperties — patch REST API mobile fingerprint ─────────
        waitFor(["getSuperProperties", "getSuperPropertiesBase64"], mod => {
            if (!originalWsSend) return;
            patchedModule = mod;
            originalGetSuperProperties = mod.getSuperProperties;
            originalGetSuperPropertiesBase64 = mod.getSuperPropertiesBase64;

            const patchedGetSuperProperties = function () {
                const props = originalGetSuperProperties.apply(this, arguments);
                const isIOS = settings.store.mobilePlatform === "iOS";
                props.os = isIOS ? "iOS" : "Android";
                props.browser = isIOS ? "Discord iOS" : "Discord Android";
                props.device = isIOS ? "Discord iOS" : "Discord Android";
                props.client_build_number = isIOS ? 337000 : 337010;
                props.client_version = isIOS ? "337.0" : "337.10";
                props.release_channel = isIOS ? "stable" : "googleRelease";
                return props;
            };

            const patchedGetSuperPropertiesBase64 = function () {
                const props = patchedGetSuperProperties.apply(this, arguments);
                return btoa(unescape(encodeURIComponent(JSON.stringify(props))));
            };

            try {
                Object.defineProperty(mod, "getSuperProperties", {
                    value: patchedGetSuperProperties,
                    configurable: true,
                    writable: true
                });
                Object.defineProperty(mod, "getSuperPropertiesBase64", {
                    value: patchedGetSuperPropertiesBase64,
                    configurable: true,
                    writable: true
                });
            } catch (e) {
                mod.getSuperProperties = patchedGetSuperProperties;
                mod.getSuperPropertiesBase64 = patchedGetSuperPropertiesBase64;
            }
        });

        // ── 3. QuestsStore — wait for load and retrieve ──────────────────────
        waitFor(["getQuest", "quests"], store => {
            if (!originalWsSend) return;
            QuestsStore = store;
            patchQuestsInStore();
        });

        // ── 4. Observation Loop for dynamic Quests updates ──────────────────
        observer = new MutationObserver(() => {
            if (observerThrottle) clearTimeout(observerThrottle);
            observerThrottle = setTimeout(() => {
                patchQuestsInStore();
            }, 500);
        });

        const initObserver = () => {
            if (!document.body) {
                setTimeout(initObserver, 100);
                return;
            }
            patchQuestsInStore();
            observer!.observe(document.body, { childList: true, subtree: true });
        };
        initObserver();

        // ── 5. Force reconnect so mobile status appears immediately ──────────
        forceGatewayReconnect();
    },

    stop() {
        // Trigger reconnect BEFORE removing the send hook so the socket ref is still valid
        forceGatewayReconnect();
        gatewaySocket = null;
        pendingReconnect = false;

        if (originalWsSend) {
            WebSocket.prototype.send = originalWsSend;
            originalWsSend = null;
        }

        if (patchedModule) {
            try {
                if (originalGetSuperProperties) {
                    Object.defineProperty(patchedModule, "getSuperProperties", {
                        value: originalGetSuperProperties,
                        configurable: true,
                        writable: true
                    });
                }
                if (originalGetSuperPropertiesBase64) {
                    Object.defineProperty(patchedModule, "getSuperPropertiesBase64", {
                        value: originalGetSuperPropertiesBase64,
                        configurable: true,
                        writable: true
                    });
                }
            } catch (e) {
                if (originalGetSuperProperties) patchedModule.getSuperProperties = originalGetSuperProperties;
                if (originalGetSuperPropertiesBase64) patchedModule.getSuperPropertiesBase64 = originalGetSuperPropertiesBase64;
            }
            originalGetSuperProperties = null;
            originalGetSuperPropertiesBase64 = null;
            patchedModule = null;
        }

        if (observer) {
            observer.disconnect();
            observer = null;
        }
        if (observerThrottle) {
            clearTimeout(observerThrottle);
            observerThrottle = null;
        }
        QuestsStore = null;
    }
});
