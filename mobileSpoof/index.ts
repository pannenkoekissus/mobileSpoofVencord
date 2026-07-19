/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { showNotification } from "@api/Notifications";
import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import definePlugin, { OptionType, StartAt } from "@utils/types";
import { waitFor } from "@webpack";
import { RestAPI } from "@webpack/common";

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
let uiInitTimeout: ReturnType<typeof setTimeout> | null = null;
let patchedModule: any = null;
let observer: MutationObserver | null = null;
let floatingContainer: HTMLDivElement | null = null;
let observerThrottle: ReturnType<typeof setTimeout> | null = null;
let QuestsStore: any = null;

// Task types that require a mobile device
const MOBILE_TASK_TYPES = ["WATCH_VIDEO_ON_MOBILE", "PLAY_ON_MOBILE", "STREAM_ON_MOBILE", "COMPLETE_ON_MOBILE"];

// ─── Quest Enrollment ─────────────────────────────────────────────────────────

async function enrollInQuest(questId: string, questName: string) {
    try {
        console.log("[MobileSpoof] Enrolling in quest:", questId, questName);
        const res = await RestAPI.post({ 
            url: `/quests/${questId}/enroll`,
            body: { location: 2 }
        });
        console.log("[MobileSpoof] Enroll response:", res?.status, res?.body);

        if (res?.ok || res?.status === 200 || res?.status === 201) {
            showNotification({
                title: "📱 Mobile Quest Started!",
                body: `Enrolled in "${questName}".`,
                color: "#3ba55c"
            });
            // Update UI and re-run store patch
            patchQuestsInStore();
            updateFloatingUI();
        } else {
            showNotification({
                title: "Enrollment Failed",
                body: `Status ${res?.status}: ${JSON.stringify(res?.body ?? {})}`,
                color: "#ed4245"
            });
        }
    } catch (e: any) {
        console.error("[MobileSpoof] Enroll error:", e);
        showNotification({
            title: "Enrollment Error",
            body: String(e?.message ?? e),
            color: "#ed4245"
        });
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

// ─── Floating UI ──────────────────────────────────────────────────────────────

function updateFloatingUI() {
    if (!floatingContainer) return;
    const wrapper = document.getElementById("vc-mobile-spoof-float");

    if (!QuestsStore) {
        if (wrapper) wrapper.style.display = "none";
        return;
    }

    const allQuests = [...(QuestsStore.quests?.values() ?? [])];

    // Detect mobile quests (original configs might have been patched, check both maps)
    const mobileQuests = allQuests.filter((q: any) => {
        const taskConfig = q?.config?.taskConfig ?? q?.config?.taskConfigV2;
        if (!taskConfig?.tasks) return false;
        return (
            taskConfig.tasks.WATCH_VIDEO_ON_MOBILE != null || 
            taskConfig.tasks.PLAY_ON_MOBILE != null ||
            // Or if we already patched it (we log it for the floating UI status)
            (q.config.platforms.includes(1) && (taskConfig.tasks.WATCH_VIDEO != null || taskConfig.tasks.PLAY_ON_DESKTOP != null))
        );
    });

    console.log("[MobileSpoof] Mobile quests found:", mobileQuests.length, "/", allQuests.length);

    if (mobileQuests.length === 0) {
        if (wrapper) wrapper.style.display = "none";
        return;
    }

    // Disconnect MutationObserver temporarily during DOM modification to prevent infinite self-triggers
    if (observer) observer.disconnect();

    // Build floating button HTML
    floatingContainer.innerHTML = "";
    if (wrapper) wrapper.style.display = "flex";

    for (const quest of mobileQuests) {
        const questId: string = quest.id;
        const questName: string =
            quest.config?.messages?.questName ??
            quest.config?.application?.name ??
            `Quest ${questId}`;
        const isEnrolled = !!quest.userStatus?.enrolledAt;
        const isCompleted = !!quest.userStatus?.completedAt;

        const btn = document.createElement("button");
        btn.style.cssText = `
            background: ${isCompleted ? "#23a55a" : isEnrolled ? "#5865f2" : "#ed4245"};
            color: white;
            border: none;
            border-radius: 4px;
            padding: 8px 12px;
            font-size: 13px;
            font-weight: 600;
            cursor: ${isEnrolled || isCompleted ? "default" : "pointer"};
            margin: 2px 0;
            font-family: inherit;
        `;
        btn.textContent = isCompleted
            ? `✅ ${questName}`
            : isEnrolled
                ? `📱 ${questName} (enrolled)`
                : `📱 Start: ${questName}`;

        if (!isEnrolled && !isCompleted) {
            btn.style.cursor = "pointer";
            btn.addEventListener("click", () => enrollInQuest(questId, questName));
        }
        floatingContainer.appendChild(btn);
    }

    // Re-observe the document body
    if (observer && document.body) {
        observer.observe(document.body, { childList: true, subtree: true });
    }
}

function createFloatingUI() {
    if (floatingContainer) return;

    const wrapper = document.createElement("div");
    wrapper.id = "vc-mobile-spoof-float";
    wrapper.style.cssText = `
        position: fixed;
        bottom: 60px;
        right: 16px;
        z-index: 9999;
        display: none;
        flex-direction: column;
        gap: 4px;
        pointer-events: all;
        background: rgba(30,31,34,0.95);
        border: 1px solid #5865f2;
        border-radius: 8px;
        padding: 10px;
        box-shadow: 0 4px 24px rgba(0,0,0,0.5);
        min-width: 220px;
        max-width: 320px;
    `;

    const label = document.createElement("div");
    label.style.cssText = "color: #b5bac1; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.8px; margin-bottom: 4px; font-family: inherit;";
    label.textContent = "📱 Mobile Quests";
    wrapper.appendChild(label);

    floatingContainer = document.createElement("div");
    floatingContainer.style.cssText = "display: flex; flex-direction: column; gap: 4px;";
    wrapper.appendChild(floatingContainer);

    document.body.appendChild(wrapper);
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
        // ── 1. WebSocket — patch Gateway IDENTIFY (mobile status dot) ─────────
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

        // ── 2. getSuperProperties — patch REST API mobile fingerprint ─────────
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

        // ── 3. QuestsStore — wait for load and retrieve ──────────────────────
        waitFor(["getQuest", "quests"], store => {
            if (!originalWsSend) return;
            QuestsStore = store;
            patchQuestsInStore();
            updateFloatingUI();
        });

        // ── 4. Floating UI & Patch loop ──────────────────────────────────────
        observer = new MutationObserver(() => {
            if (observerThrottle) clearTimeout(observerThrottle);
            observerThrottle = setTimeout(() => {
                patchQuestsInStore();
                updateFloatingUI();
            }, 500);
        });

        const initUI = () => {
            if (!document.body) {
                uiInitTimeout = setTimeout(initUI, 100);
                return;
            }
            createFloatingUI();
            patchQuestsInStore();
            updateFloatingUI();
            observer!.observe(document.body, { childList: true, subtree: true });
        };
        initUI();
    },

    stop() {
        if (uiInitTimeout) { clearTimeout(uiInitTimeout); uiInitTimeout = null; }
        if (originalWsSend) { WebSocket.prototype.send = originalWsSend; originalWsSend = null; }
        if (patchedModule) {
            if (originalGetSuperProperties) { patchedModule.getSuperProperties = originalGetSuperProperties; originalGetSuperProperties = null; }
            if (originalGetSuperPropertiesBase64) { patchedModule.getSuperPropertiesBase64 = originalGetSuperPropertiesBase64; originalGetSuperPropertiesBase64 = null; }
            patchedModule = null;
        }
        if (observer) { observer.disconnect(); observer = null; }
        document.getElementById("vc-mobile-spoof-float")?.remove();
        floatingContainer = null;
        QuestsStore = null;
    }
});
