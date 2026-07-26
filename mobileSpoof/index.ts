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
        description: "The mobile platform to spoof.",
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

// The live gateway WebSocket — captured via the constructor hook when Discord
// creates a new gateway connection after we force a reconnect.
let gatewaySocket: WebSocket | null = null;

// Reconnect state machine:
//  "idle"     – normal
//  "blocking" – next RESUME (op 6) on a new socket should be blocked and
//               replaced with a fake Invalid Session (op 9) so Discord sends
//               a fresh IDENTIFY (op 2) that our send hook can patch.
let reconnectState: "idle" | "blocking" = "idle";

// Saved original WebSocket constructor so we can restore it on stop().
const OriginalWebSocket: typeof WebSocket = window.WebSocket;

// ─── WebSocket Constructor Hook ───────────────────────────────────────────────
// Wraps window.WebSocket so we capture every new gateway socket the moment it
// is created — even when the existing socket was set up before our send hook.

function installConstructorHook() {
    (window as any).WebSocket = function (this: any, url: string | URL, protocols?: any) {
        const ws = new OriginalWebSocket(url, protocols);
        if (String(url).includes("gateway")) {
            gatewaySocket = ws;
            console.log("[MobileSpoof] New gateway socket captured via constructor hook.");

            // Fallback: if the send hook never sees the RESUME (e.g. Discord bound
            // its send before our prototype patch), inject op 9 after Discord has had
            // ~600 ms to receive the server Hello and queue its RESUME send.
            if (reconnectState === "blocking") {
                ws.addEventListener("open", () => {
                    setTimeout(() => {
                        if (reconnectState === "blocking" && ws.readyState === WebSocket.OPEN) {
                            reconnectState = "idle";
                            console.log("[MobileSpoof] Fallback: injecting op 9 via constructor hook.");
                            ws.dispatchEvent(new MessageEvent("message", {
                                data: JSON.stringify({ op: 9, d: false })
                            }));
                        }
                    }, 600);
                });
            }
        }
        return ws;
    } as any;
    (window as any).WebSocket.prototype = OriginalWebSocket.prototype;
    Object.keys(OriginalWebSocket).forEach(k => {
        try { (window.WebSocket as any)[k] = (OriginalWebSocket as any)[k]; } catch { }
    });
}

function removeConstructorHook() {
    (window as any).WebSocket = OriginalWebSocket;
}

// ─── Gateway Reconnect Helper ─────────────────────────────────────────────────

function forceGatewayReconnect() {
    reconnectState = "blocking";

    if (gatewaySocket?.readyState === WebSocket.OPEN) {
        // We already have the socket from a previous capture — close it directly.
        console.log("[MobileSpoof] Closing captured gateway socket, blocking next RESUME...");
        gatewaySocket.close(1000);
    } else {
        // Existing socket was bound before our patch — trigger reconnect via
        // network-loss simulation. Discord will create a NEW socket (captured by
        // our constructor hook) and send RESUME, which the send hook will block.
        console.log("[MobileSpoof] Triggering reconnect via network simulation...");
        window.dispatchEvent(new Event("offline"));
        setTimeout(() => window.dispatchEvent(new Event("online")), 2000);
    }
}

// ─── Quest Store Patching (Converts Mobile tasks to Desktop tasks) ─────────────

function patchQuestsInStore() {
    if (!QuestsStore || !QuestsStore.quests) return;

    let anyModified = false;
    for (const quest of QuestsStore.quests.values()) {
        let modified = false;

        if (quest.config && Array.isArray(quest.config.platforms)) {
            if (!quest.config.platforms.includes(1)) {
                quest.config.platforms.push(1);
                modified = true;
            }
        }

        const taskConfig = quest.config?.taskConfig ?? quest.config?.taskConfigV2;
        if (taskConfig?.tasks) {
            if (taskConfig.tasks.WATCH_VIDEO_ON_MOBILE && !taskConfig.tasks.WATCH_VIDEO) {
                taskConfig.tasks.WATCH_VIDEO = taskConfig.tasks.WATCH_VIDEO_ON_MOBILE;
                delete taskConfig.tasks.WATCH_VIDEO_ON_MOBILE;
                modified = true;
            }
            if (taskConfig.tasks.PLAY_ON_MOBILE && !taskConfig.tasks.PLAY_ON_DESKTOP) {
                taskConfig.tasks.PLAY_ON_DESKTOP = taskConfig.tasks.PLAY_ON_MOBILE;
                delete taskConfig.tasks.PLAY_ON_MOBILE;
                modified = true;
            }
        }

        if (modified) {
            anyModified = true;
            console.log("[MobileSpoof] Patched quest:", quest.id,
                quest.config?.messages?.questName ?? quest.config?.application?.name);
        }
    }

    if (anyModified) {
        try { QuestsStore.emitChange(); }
        catch (e) { console.error("[MobileSpoof] emitChange error:", e); }
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
        // ── 0. Constructor hook — must be first so we capture all new sockets ──
        installConstructorHook();

        // ── 1. WebSocket send hook — patches IDENTIFY + blocks RESUME ─────────
        originalWsSend = OriginalWebSocket.prototype.send;
        OriginalWebSocket.prototype.send = function (this: WebSocket, data: any) {
            let blockSend = false;

            if (typeof data === "string") {
                try {
                    const isGateway = typeof this.url === "string" &&
                        (this.url.includes("gateway.discord.gg") || this.url.includes("gateway"));

                    if (isGateway) {
                        const parsed = JSON.parse(data);

                        // "blocking": intercept RESUME (op 6) on the new socket.
                        // Block it and inject a fake Invalid Session (op 9) so
                        // Discord clears its session and sends a fresh IDENTIFY.
                        if (reconnectState === "blocking" && parsed.op === 6) {
                            blockSend = true;
                            reconnectState = "idle";
                            const ws = this;
                            console.log("[MobileSpoof] Blocked RESUME (op 6), injecting Invalid Session (op 9)...");
                            setTimeout(() => {
                                ws.dispatchEvent(new MessageEvent("message", {
                                    data: JSON.stringify({ op: 9, d: false })
                                }));
                            }, 50);
                        }

                        // Always patch IDENTIFY (op 2) with mobile platform properties.
                        if (parsed.op === 2 && parsed.d?.properties) {
                            const isIOS = settings.store.mobilePlatform === "iOS";
                            parsed.d.properties.$os = isIOS ? "iOS" : "Android";
                            parsed.d.properties.$browser = isIOS ? "Discord iOS" : "Discord Android";
                            parsed.d.properties.$device = isIOS ? "Discord iOS" : "Discord Android";
                            data = JSON.stringify(parsed);
                            console.log("[MobileSpoof] Patched IDENTIFY with mobile platform.");
                        }
                    }
                } catch { /* ignore */ }
            }

            if (blockSend) return;
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

        // ── 3. QuestsStore — wait for load, then patch ───────────────────────
        waitFor(["getQuest", "quests"], store => {
            if (!originalWsSend) return;
            QuestsStore = store;
            patchQuestsInStore();
        });

        // ── 4. MutationObserver for dynamic quest updates ────────────────────
        observer = new MutationObserver(() => {
            if (observerThrottle) clearTimeout(observerThrottle);
            observerThrottle = setTimeout(() => patchQuestsInStore(), 500);
        });

        const initObserver = () => {
            if (!document.body) { setTimeout(initObserver, 100); return; }
            patchQuestsInStore();
            observer!.observe(document.body, { childList: true, subtree: true });
        };
        initObserver();

        // ── 5. Force reconnect so mobile status appears immediately ──────────
        forceGatewayReconnect();
    },

    stop() {
        reconnectState = "idle";

        // Remove the constructor hook first so future sockets use the real class.
        removeConstructorHook();

        if (originalWsSend) {
            OriginalWebSocket.prototype.send = originalWsSend;
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

        if (observer) { observer.disconnect(); observer = null; }
        if (observerThrottle) { clearTimeout(observerThrottle); observerThrottle = null; }
        QuestsStore = null;

        // Close the socket so Discord reconnects (without our patches active, it
        // will RESUME normally and the mobile status fades on session expiry).
        gatewaySocket?.close(1000);
        gatewaySocket = null;
    }
});
