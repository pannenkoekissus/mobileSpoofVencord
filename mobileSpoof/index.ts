/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { showNotification } from "@api/Notifications";
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
        restartNeeded: true
    }
});

// ─── State ────────────────────────────────────────────────────────────────────

let originalWsSend: typeof WebSocket.prototype.send | null = null;
let originalGetSuperProperties: any = null;
let originalGetSuperPropertiesBase64: any = null;
let patchedModule: any = null;
let observer: MutationObserver | null = null;

// ─── Internal Module Access ───────────────────────────────────────────────────

function getInternalModules() {
    try {
        const wpChunk = (window as any).webpackChunkdiscord_app;
        if (!wpChunk) return null;
        const wpRequire = wpChunk.push([[Symbol()], {}, (r: any) => r]);
        wpChunk.pop();
        const modules = Object.values(wpRequire.c) as any[];
        return {
            QuestsStore: modules.find(x => x?.exports?.Z?.__proto__?.getQuest)?.exports?.Z,
            api: modules.find(x => x?.exports?.tn?.get)?.exports?.tn,
        };
    } catch (e) {
        console.error("[MobileSpoof] Failed to access internal modules:", e);
        return null;
    }
}

// ─── Mobile Super-Properties Header ─────────────────────────────────────────

function getMobileSuperPropertiesBase64(): string {
    const isIOS = settings.store.mobilePlatform === "iOS";
    const props = isIOS ? {
        os: "iOS",
        browser: "Discord iOS",
        device: "iPhone14,2",
        system_locale: "en-US",
        client_version: "337.0",
        release_channel: "stable",
        os_version: "17.5",
        client_build_number: 337000,
        client_event_source: null
    } : {
        os: "Android",
        browser: "Discord Android",
        device: "Pixel 8",
        system_locale: "en-US",
        client_version: "337.10",
        release_channel: "googleRelease",
        os_version: "34",
        client_build_number: 337010,
        client_event_source: null
    };
    return btoa(unescape(encodeURIComponent(JSON.stringify(props))));
}

// ─── Quest Enrollment ─────────────────────────────────────────────────────────

async function enrollInQuest(questId: string) {
    try {
        // Enroll directly via fetch with mobile X-Super-Properties
        // This bypasses the UI's platform check entirely
        const superProps = getMobileSuperPropertiesBase64();
        const response = await fetch(`https://discord.com/api/v9/quests/${questId}/enroll`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Super-Properties": superProps,
                "Authorization": (document.cookie.match(/token=([^;]+)/) || [])[1] || ""
            }
        });

        if (response.ok) {
            showNotification({
                title: "Mobile Quest Started!",
                body: "Successfully enrolled in the mobile quest. Reload Discord to see the updated status.",
                color: "#3ba55c"
            });
        } else {
            const err = await response.json().catch(() => ({}));
            showNotification({
                title: "Enrollment Failed",
                body: `Error ${response.status}: ${JSON.stringify(err)}`,
                color: "#ed4245"
            });
        }
    } catch (e: any) {
        showNotification({
            title: "Enrollment Error",
            body: String(e?.message ?? e),
            color: "#ed4245"
        });
    }
}

// ─── DOM Button Injection ──────────────────────────────────────────────────────

function addMobileStartButtons() {
    const mods = getInternalModules();
    if (!mods?.QuestsStore) return;

    const quests = [...(mods.QuestsStore.quests?.values() ?? [])];
    const mobileQuests = quests.filter((q: any) => {
        const platforms: number[] | undefined = q?.config?.platforms;
        // 1 = Desktop, 2 = Android, 3 = iOS
        return Array.isArray(platforms) && !platforms.includes(1);
    });

    // For each mobile-only quest, find its card in the DOM and inject a button
    for (const quest of mobileQuests) {
        const questId: string = quest.id;
        const questName: string = quest.config?.messages?.questName ?? quest.config?.application?.name ?? "Mobile Quest";
        const isEnrolled = !!quest.userStatus?.enrolledAt;

        // Look for existing spoof buttons to avoid duplicates
        if (document.querySelector(`#mobile-spoof-btn-${questId}`)) continue;

        // Find the quest heading controls or any quest card container
        const headingControls = document.querySelectorAll('div[class*="headingControls"]');
        const footers = document.querySelectorAll('div[class*="contentFooterButtonCont"]');

        const containers = [...headingControls, ...footers];
        for (const container of containers) {
            if (document.querySelector(`#mobile-spoof-btn-${questId}`)) break;

            const btn = document.createElement("button");
            btn.id = `mobile-spoof-btn-${questId}`;
            btn.className = container.querySelector("button")?.className ?? "vc-mobile-start-btn";
            btn.style.cssText = "border: 1px solid #5865f2; margin-left: 8px;";
            btn.innerText = isEnrolled ? "📱 Enrolled" : "📱 Start Mobile";
            btn.title = `Force-enroll in "${questName}" as a mobile user`;

            if (!isEnrolled) {
                btn.addEventListener("click", () => enrollInQuest(questId));
            }

            container.insertBefore(btn, container.firstChild);
        }
    }
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

export default definePlugin({
    name: "MobileSpoof",
    description: "Makes Discord think you are on mobile — shows mobile status indicator and allows mobile-only quests.",
    tags: ["Utility", "Privacy"],
    authors: [Devs.Ven],
    settings,
    startAt: StartAt.Init,

    start() {
        // ── 1. WebSocket.send — patch Gateway IDENTIFY (mobile status dot) ────
        originalWsSend = WebSocket.prototype.send;
        WebSocket.prototype.send = function (this: WebSocket, data: any) {
            if (typeof data === "string") {
                try {
                    const isGateway = typeof this.url === "string" &&
                        (this.url.includes("gateway.discord.gg") || this.url.includes("gateway"));
                    if (isGateway) {
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

        // ── 2. Patch internal getSuperProperties so all REST calls use mobile ─
        waitFor(["getSuperProperties", "getSuperPropertiesBase64"], mod => {
            if (!originalWsSend) return;
            patchedModule = mod;
            originalGetSuperProperties = mod.getSuperProperties;
            originalGetSuperPropertiesBase64 = mod.getSuperPropertiesBase64;

            mod.getSuperProperties = function () {
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

            mod.getSuperPropertiesBase64 = function () {
                const props = mod.getSuperProperties.apply(this, arguments);
                return btoa(unescape(encodeURIComponent(JSON.stringify(props))));
            };
        });

        // ── 3. MutationObserver — inject "Start Mobile" button on quest page ──
        observer = new MutationObserver(() => {
            if (document.title.toLowerCase().includes("quest")) {
                addMobileStartButtons();
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
    },

    stop() {
        if (originalWsSend) {
            WebSocket.prototype.send = originalWsSend;
            originalWsSend = null;
        }
        if (patchedModule) {
            if (originalGetSuperProperties) {
                patchedModule.getSuperProperties = originalGetSuperProperties;
                originalGetSuperProperties = null;
            }
            if (originalGetSuperPropertiesBase64) {
                patchedModule.getSuperPropertiesBase64 = originalGetSuperPropertiesBase64;
                originalGetSuperPropertiesBase64 = null;
            }
            patchedModule = null;
        }
        if (observer) {
            observer.disconnect();
            observer = null;
        }
        // Clean up injected buttons
        document.querySelectorAll("[id^='mobile-spoof-btn-']").forEach(el => el.remove());
    }
});
