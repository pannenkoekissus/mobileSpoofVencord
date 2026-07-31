/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType, StartAt } from "@utils/types";
import { waitFor, findByProps } from "@webpack";
import { FluxDispatcher } from "@webpack/common";

// ─── Settings ────────────────────────────────────────────────────────────────

const settings = definePluginSettings({
    mobilePlatform: {
        type: OptionType.SELECT,
        description: "The mobile platform to spoof.",
        options: [
            { label: "Android", value: "Android", default: true },
            { label: "iOS", value: "iOS" }
        ],
        restartNeeded: true
    }
});

function getMobileSuperProperties(isIOS: boolean) {
    if (isIOS) {
        return {
            os: "iOS",
            browser: "Discord iOS",
            device: "iPhone",
            system_locale: "en-US",
            client_version: "237.0",
            client_build_number: 337000,
            release_channel: "stable"
        };
    } else {
        return {
            os: "Android",
            browser: "Discord Android",
            device: "Android",
            system_locale: "en-US",
            client_version: "237.10",
            client_build_number: 337010,
            release_channel: "googleRelease"
        };
    }
}

// ─── Global Mobile Properties Sanitizer ───────────────────────────────────────
// Strips ALL desktop / Windows / Electron metadata that causes Discord's Gateway
// presence backend to flag the session as a Desktop client.

(window as any).__getMobileProps = function (origProps: any) {
    const isIOS = settings.store?.mobilePlatform === "iOS";
    const mobile = getMobileSuperProperties(isIOS);

    console.log("[MobileSpoof] Spoofing properties payload!");

    return {
        $os: mobile.os,
        $browser: mobile.browser,
        $device: mobile.device,
        $system_locale: "en-US",
        $has_client_mods: false,
        os: mobile.os,
        browser: mobile.browser,
        device: mobile.device,
        system_locale: "en-US",
        client_version: mobile.client_version,
        client_build_number: mobile.client_build_number,
        release_channel: mobile.release_channel
    };
};

(window as any).__getMobilePropsBase64 = function (origBase64: any) {
    try {
        const props = (window as any).__getMobileProps({});
        return btoa(unescape(encodeURIComponent(JSON.stringify(props))));
    } catch {
        return origBase64;
    }
};

// ─── State ────────────────────────────────────────────────────────────────────

let observer: MutationObserver | null = null;
let observerThrottle: ReturnType<typeof setTimeout> | null = null;
let QuestsStore: any = null;

function checkAndForceReconnect() {
    const gatewayStore = findByProps("getSocket");
    if (!gatewayStore) return;

    const socket = gatewayStore.getSocket?.();
    if (!socket) return;

    // If the server thinks we are a desktop client, our spoof hasn't taken effect on this session.
    // This happens if the session was RESUMED (e.g. via Ctrl+R) instead of a fresh IDENTIFY.
    console.log("[MobileSpoof] Forcing clean IDENTIFY reconnect...");
    try {
        if (typeof socket._handleInvalidSession === "function") {
            socket._handleInvalidSession(false);
        }
    } catch (e) {
        console.error("[MobileSpoof] Reconnect error:", e);
    }
}

function onConnectionOpen() {
    // Wait a bit for sessions to populate after connection
    setTimeout(checkAndForceReconnect, 3000);
}

// ─── Quest Store Patching ─────────────────────────────────────────────────────

function patchQuestsInStore() {
    if (!QuestsStore || !QuestsStore.quests) return;
    for (const quest of QuestsStore.quests.values()) {
        if (quest.config && Array.isArray(quest.config.platforms)) {
            if (!quest.config.platforms.includes(1)) {
                quest.config.platforms.push(1);
            }
        }
        const taskConfig = quest.config?.taskConfig ?? quest.config?.taskConfigV2;
        if (taskConfig?.tasks) {
            if (taskConfig.tasks.WATCH_VIDEO_ON_MOBILE && !taskConfig.tasks.WATCH_VIDEO) {
                taskConfig.tasks.WATCH_VIDEO = taskConfig.tasks.WATCH_VIDEO_ON_MOBILE;
                delete taskConfig.tasks.WATCH_VIDEO_ON_MOBILE;
            }
            if (taskConfig.tasks.PLAY_ON_MOBILE && !taskConfig.tasks.PLAY_ON_DESKTOP) {
                taskConfig.tasks.PLAY_ON_DESKTOP = taskConfig.tasks.PLAY_ON_MOBILE;
                delete taskConfig.tasks.PLAY_ON_MOBILE;
            }
        }
    }
    try { QuestsStore.emitChange(); } catch { }
}

// ─── Plugin Definition ────────────────────────────────────────────────────────

export default definePlugin({
    name: "MobileSpoof",
    description: "Makes Discord think you are on mobile — shows mobile status indicator and allows mobile-only quests.",
    tags: ["Utility", "Privacy"],
    authors: ["pannenkoekissus"],
    settings,

    // Patch super properties and Gateway IDENTIFY directly inside the identify() method
    patches: [
        {
            find: '"[IDENTIFY]"',
            replacement: {
                match: /properties:([a-zA-Z0-9_$]+),presence:/,
                replace: "properties:window.__getMobileProps?window.__getMobileProps($1):$1,presence:"
            }
        }
    ],

    startAt: StartAt.Init,

    start() {
        waitFor(["getQuest", "quests"], store => {
            QuestsStore = store;
            patchQuestsInStore();
        });

        setTimeout(() => checkAndForceReconnect(), 20000);

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
    },

    stop() {
        if (observer) { observer.disconnect(); observer = null; }
        if (observerThrottle) { clearTimeout(observerThrottle); observerThrottle = null; }
        QuestsStore = null;

        FluxDispatcher.unsubscribe("CONNECTION_OPEN", onConnectionOpen);
        FluxDispatcher.unsubscribe("SESSIONS_REPLACE", checkAndForceReconnect);

        // Revert to desktop presence
        const gatewayStore = findByProps("getSocket");
        if (gatewayStore) {
            const socket = gatewayStore.getSocket?.();
            if (socket && typeof socket._handleInvalidSession === "function") {
                socket._handleInvalidSession(false);
            }
        }
        console.log("[MobileSpoof] Plugin stopped. Gateway reconnected to return to Desktop presence.");
    }
});
